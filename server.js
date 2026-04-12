// ============================================================
// server.js — Servidor Express principal
// Serve os arquivos estáticos + rotas da API do Mercado Livre
// Suporta duas contas ML com alternância em tempo real
// ============================================================

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');

// ── Log ao vivo (aba Conexão) ─────────────────────────────────

const logBuffer = [];          // últimas 300 entradas em memória
const sseClients = new Set();  // clientes SSE conectados

function addLog(msg, tipo = 'info') {
  const entry = { ts: Date.now(), msg, tipo };
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer.shift();
  console.log(`[${tipo.toUpperCase()}] ${msg}`);
  // Envia em tempo real para todos os clientes SSE conectados
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch {}
  }
}

// ── Middleware ────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers de persistência ───────────────────────────────────

function loadData() {
  let raw = {};
  if (fs.existsSync(DATA_FILE)) {
    try { raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  // Migração do formato antigo (flat) para novo (multi-conta)
  if (!raw.contas) {
    const c1 = {};
    for (const k of ['client_id','client_secret','access_token','refresh_token','user_id']) {
      if (raw[k]) c1[k] = raw[k];
    }
    if (raw.pause_dates) c1.pause_dates = raw.pause_dates;
    raw = { conta_ativa: '1', contas: { '1': c1, '2': {} } };
    fs.writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2));
  }
  raw.conta_ativa     = raw.conta_ativa || '1';
  raw.contas          = raw.contas      || {};
  raw.contas['1']     = raw.contas['1'] || {};
  raw.contas['2']     = raw.contas['2'] || {};
  return raw;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(() => {});
}

// Retorna as credenciais da conta atualmente ativa
function contaAtiva(data) {
  return data.contas[data.conta_ativa] || {};
}

// ── Persistência via Railway Environment Variables ────────────

async function syncRailwayEnvVars(data) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) { console.warn('[sync] RAILWAY_TOKEN não configurado — tokens não serão persistidos entre deploys'); return; }
  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  if (!projectId || !environmentId || !serviceId) { console.warn('[sync] RAILWAY_PROJECT_ID/ENVIRONMENT_ID/SERVICE_ID ausentes'); return; }

  const variables = { ML_CONTA_ATIVA: data.conta_ativa || '1' };
  for (const num of ['1', '2']) {
    const c = data.contas[num] || {};
    if (c.client_id)     variables[`ML_CLIENT_ID_${num}`]     = c.client_id;
    if (c.client_secret) variables[`ML_CLIENT_SECRET_${num}`] = c.client_secret;
    if (c.access_token)  variables[`ML_ACCESS_TOKEN_${num}`]  = c.access_token;
    if (c.refresh_token) variables[`ML_REFRESH_TOKEN_${num}`] = c.refresh_token;
    if (c.user_id)       variables[`ML_USER_ID_${num}`]       = String(c.user_id);
  }

  try {
    await axios.post(
      'https://backboard.railway.app/graphql/v2',
      {
        query: `mutation Upsert($input: VariableCollectionUpsertInput!) {
          variableCollectionUpsert(input: $input)
        }`,
        variables: { input: { projectId, environmentId, serviceId, variables } },
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );
    console.log('[sync] Tokens salvos nas env vars do Railway com sucesso.');
  } catch (e) {
    console.error('[sync] Erro ao salvar tokens no Railway:', e.message);
  }
}

function initFromEnvVars() {
  const data = loadData();
  let changed = false;

  if (!data.conta_ativa && process.env.ML_CONTA_ATIVA) {
    data.conta_ativa = process.env.ML_CONTA_ATIVA;
    changed = true;
  }

  // Formato novo: ML_CLIENT_ID_1, ML_CLIENT_ID_2, etc.
  for (const num of ['1', '2']) {
    const c = data.contas[num] || {};
    const map = {
      client_id:     `ML_CLIENT_ID_${num}`,
      client_secret: `ML_CLIENT_SECRET_${num}`,
      access_token:  `ML_ACCESS_TOKEN_${num}`,
      refresh_token: `ML_REFRESH_TOKEN_${num}`,
      user_id:       `ML_USER_ID_${num}`,
    };
    for (const [key, envKey] of Object.entries(map)) {
      if (!c[key] && process.env[envKey]) {
        c[key] = process.env[envKey];
        changed = true;
      }
    }
    data.contas[num] = c;
  }

  // Formato antigo (pré-multi-conta): ML_CLIENT_ID, ML_ACCESS_TOKEN, etc. → conta 1
  const oldMap = {
    client_id:     'ML_CLIENT_ID',
    client_secret: 'ML_CLIENT_SECRET',
    access_token:  'ML_ACCESS_TOKEN',
    refresh_token: 'ML_REFRESH_TOKEN',
    user_id:       'ML_USER_ID',
  };
  const c1 = data.contas['1'];
  for (const [key, envKey] of Object.entries(oldMap)) {
    if (!c1[key] && process.env[envKey]) {
      c1[key] = process.env[envKey];
      changed = true;
    }
  }

  if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

initFromEnvVars();

// Log de diagnóstico na inicialização
(function logStartupState() {
  const data = loadData();
  const railwayOk = !!(process.env.RAILWAY_TOKEN && process.env.RAILWAY_PROJECT_ID);
  addLog(`🚀 Servidor iniciado`, 'info');
  addLog(`Railway env vars: ${railwayOk ? 'configuradas ✅' : 'AUSENTES — tokens serão perdidos ao redeployar ⚠️'}`, railwayOk ? 'ok' : 'warn');
  for (const num of ['1', '2']) {
    const c = data.contas[num] || {};
    const temToken = !!c.access_token;
    const temRefresh = !!c.refresh_token;
    addLog(`Conta ${num}: access_token=${temToken ? 'presente' : 'AUSENTE'}, refresh_token=${temRefresh ? 'presente' : 'AUSENTE'}`, temToken ? 'ok' : 'warn');
  }
})();

// Busca nickname das contas conectadas que ainda não têm o campo salvo
async function fetchMissingNicknames() {
  const data = loadData();
  let changed = false;
  for (const num of ['1', '2']) {
    const c = data.contas[num];
    if (c && c.access_token && !c.nickname) {
      try {
        const resp = await axios.get('https://api.mercadolibre.com/users/me', {
          headers: { Authorization: `Bearer ${c.access_token}` },
          timeout: 8000,
        });
        c.nickname = resp.data.nickname;
        changed = true;
      } catch {}
    }
  }
  if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

fetchMissingNicknames();

// ── Rotas: conta ativa ────────────────────────────────────────

app.get('/api/conta/ativa', (req, res) => {
  const data = loadData();
  res.json({
    conta_ativa: data.conta_ativa,
    contas: {
      '1': { nickname: data.contas['1']?.nickname || null },
      '2': { nickname: data.contas['2']?.nickname || null },
    },
  });
});

app.post('/api/conta/ativa', (req, res) => {
  const { conta } = req.body;
  if (!['1', '2'].includes(conta)) return res.status(400).json({ error: 'Conta inválida' });
  const data = loadData();
  data.conta_ativa = conta;
  saveData(data);
  res.json({ ok: true });
});

// ── Rotas de configuração ─────────────────────────────────────

app.get('/api/config', (req, res) => {
  const data  = loadData();
  const num   = req.query.conta || data.conta_ativa;
  const c     = data.contas[num] || {};
  const { client_secret, ...safe } = c;
  res.json({ ...safe, conta_ativa: data.conta_ativa });
});

app.post('/api/config', (req, res) => {
  const { client_id, client_secret, access_token, refresh_token, conta } = req.body;
  const data = loadData();
  const num  = conta || data.conta_ativa;
  if (!data.contas[num]) data.contas[num] = {};
  const c = data.contas[num];
  if (client_id     !== undefined) c.client_id     = client_id;
  if (client_secret !== undefined) c.client_secret = client_secret;
  if (access_token  !== undefined) c.access_token  = access_token;
  if (refresh_token !== undefined) c.refresh_token = refresh_token;
  saveData(data);
  res.json({ ok: true });
});

// ── Rotas OAuth ───────────────────────────────────────────────

app.get('/api/ml/auth', (req, res) => {
  const data  = loadData();
  const num   = req.query.conta || data.conta_ativa;
  const c     = data.contas[num] || {};
  if (!c.client_id) return res.redirect('/app.html?tab=config&error=sem_client_id');
  const callback = `${req.protocol}://${req.get('host')}/api/ml/callback`;
  const url = `https://auth.mercadolivre.com.br/authorization`
    + `?response_type=code`
    + `&client_id=${c.client_id}`
    + `&redirect_uri=${encodeURIComponent(callback)}`
    + `&state=${num}`
    + `&scope=offline_access+read_listings+write_listings+read_orders+write_orders+read_shipping+write_shipping+read_product_ads`;
  res.redirect(url);
});

app.get('/api/ml/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/app.html?tab=config&error=auth_cancelado');

  const data     = loadData();
  const num      = state || data.conta_ativa;
  const c        = data.contas[num] || {};
  // Força HTTPS no Railway (req.protocol pode retornar 'http' atrás do proxy)
  const proto    = req.get('x-forwarded-proto') || req.protocol;
  const callback = `${proto}://${req.get('host')}/api/ml/callback`;

  addLog(`OAuth callback recebido — conta ${num}, redirect_uri: ${callback}`, 'info');

  if (!c.client_secret) {
    return res.redirect('/app.html?tab=config&error=auth_falhou&detalhe=' +
      encodeURIComponent('Client Secret não encontrado. Salve as credenciais antes de conectar.'));
  }

  try {
    const resp = await axios.post(
      'https://api.mercadolibre.com/oauth/token',
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     c.client_id,
        client_secret: c.client_secret,
        code,
        redirect_uri:  callback,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    c.access_token    = resp.data.access_token;
    c.refresh_token   = resp.data.refresh_token;
    c.token_expires_at = Date.now() + ((resp.data.expires_in || 21600) - 300) * 1000;
    c.user_id         = resp.data.user_id;
    addLog(`✅ Token obtido com sucesso — conta ${num} (user_id: ${c.user_id})`, 'ok');
    // Busca o nickname para exibir no seletor de conta
    try {
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 8000,
      });
      c.nickname = me.data.nickname;
      addLog(`👤 Nickname obtido: ${c.nickname}`, 'ok');
    } catch (e) {
      addLog(`⚠️ Não foi possível obter nickname: ${e.message}`, 'warn');
    }
    data.contas[num] = c;
    saveData(data);
    addLog(`💾 Credenciais salvas — redirecionando para o painel`, 'ok');
    res.redirect(`/app.html?tab=conexao&connected=true&conta=${num}`);
  } catch (err) {
    const detalhe = JSON.stringify(err.response?.data || err.message);
    addLog(`❌ Erro no token exchange: ${detalhe}`, 'erro');
    res.redirect(`/app.html?tab=conexao&error=auth_falhou&detalhe=${encodeURIComponent(detalhe)}`);
  }
});

// ── Rotas de dados ML ─────────────────────────────────────────

async function refreshToken(data, num) {
  const c = data.contas[num];
  if (!c.client_id || !c.client_secret || !c.refresh_token) throw new Error('Credenciais insuficientes para refresh');
  const resp = await axios.post(
    'https://api.mercadolibre.com/oauth/token',
    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  c.access_token    = resp.data.access_token;
  c.refresh_token   = resp.data.refresh_token;
  // expires_in vem em segundos (normalmente 21600 = 6h); guarda com 5min de margem
  c.token_expires_at = Date.now() + ((resp.data.expires_in || 21600) - 300) * 1000;
  saveData(data);
  addLog(`🔄 Token da conta ${num} renovado automaticamente`, 'ok');
  return c;
}

// Retorna o token válido, renovando automaticamente se necessário
async function getToken(data, num) {
  const c = data.contas[num];
  if (!c || !c.access_token) throw new Error('Não conectado');
  const expira = c.token_expires_at || 0;
  if (Date.now() < expira) return c.access_token; // ainda válido
  if (!c.refresh_token) throw new Error('Token expirado e sem refresh_token. Reconecte a conta.');
  const renovado = await refreshToken(data, num);
  return renovado.access_token;
}

// Na inicialização, tenta renovar tokens expirados de todas as contas
(async () => {
  try {
    const data = loadData();
    for (const num of ['1', '2']) {
      const c = data.contas[num];
      if (!c || !c.refresh_token) continue;
      const expira = c.token_expires_at || 0;
      if (Date.now() >= expira) {
        try {
          await refreshToken(data, num);
          console.log(`[init] Token da conta ${num} renovado na inicialização.`);
        } catch (e) {
          console.warn(`[init] Falha ao renovar token da conta ${num}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[init] Erro na renovação inicial de tokens:', e.message);
  }
})();

// Renova tokens a cada 5 horas (evita expiração)
setInterval(async () => {
  try {
    const data = loadData();
    for (const num of ['1', '2']) {
      const c = data.contas[num];
      if (!c || !c.refresh_token) continue;
      const expira = c.token_expires_at || 0;
      if (Date.now() >= expira) {
        try { await refreshToken(data, num); } catch (e) {
          addLog(`❌ Falha ao renovar token conta ${num}: ${e.message}`, 'erro');
        }
      }
    }
  } catch {}
}, 5 * 60 * 60 * 1000);

// ── Rotas da aba Conexão ──────────────────────────────────────

// SSE — stream de logs em tempo real
app.get('/api/conexao/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Envia histórico de logs existentes
  for (const entry of logBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// Status de conexão da conta (sem chamada externa)
app.get('/api/conexao/status', (req, res) => {
  const data = loadData();
  const num  = req.query.conta || '1';
  const c    = data.contas[num] || {};
  const agora = Date.now();
  const expira = c.token_expires_at || 0;
  res.json({
    connected:    !!c.access_token,
    nickname:     c.nickname || null,
    hasRefresh:   !!c.refresh_token,
    tokenExpired: agora > expira,
    expiresIn:    expira > agora ? Math.round((expira - agora) / 60000) + ' min' : 'expirado',
  });
});

app.get('/api/ml/status', (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ connected: false });
  res.json({ connected: true, nickname: c.nickname || null });
});

app.get('/api/ml/store', async (req, res) => {
  const data = loadData();
  let c      = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  const fetchStore = async (token) => {
    const r = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.data;
  };

  try {
    const user = await fetchStore(c.access_token);
    res.json({ name: user.nickname, id: user.id, country: user.country_id });
  } catch {
    if (c.refresh_token) {
      try {
        c = await refreshToken(data, data.conta_ativa);
        const user = await fetchStore(c.access_token);
        res.json({ name: user.nickname, id: user.id, country: user.country_id });
      } catch {
        res.json({ error: 'Sessão expirada. Reconecte na aba Configurações.' });
      }
    } else {
      res.json({ error: 'Erro ao buscar loja. Verifique a conexão.' });
    }
  }
});

// ── Helper compartilhado ──────────────────────────────────────

function extrairSku(body) {
  if (body.seller_custom_field) return body.seller_custom_field;
  const attrItem = (body.attributes || []).find(a => a.id === 'SELLER_SKU');
  if (attrItem && attrItem.value_name) return attrItem.value_name;
  if (body.variations && body.variations.length > 0) {
    for (const v of body.variations) {
      if (v.seller_custom_field) return v.seller_custom_field;
      const attrVar = (v.attributes || []).find(a => a.id === 'SELLER_SKU');
      if (attrVar && attrVar.value_name) return attrVar.value_name;
    }
  }
  return '—';
}

app.get('/api/ml/estoque', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  let c      = data.contas[num];
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  if (!c.user_id) {
    try {
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${c.access_token}` },
      });
      c.user_id = me.data.id;
      saveData(data);
    } catch {
      return res.json({ error: 'Não foi possível identificar o usuário.' });
    }
  }

  const limit = 50;

  function extrairSkuLocal(body) {
    if (body.seller_custom_field) return body.seller_custom_field;
    const attrItem = (body.attributes || []).find(a => a.id === 'SELLER_SKU');
    if (attrItem && attrItem.value_name) return attrItem.value_name;
    if (body.variations && body.variations.length > 0) {
      for (const v of body.variations) {
        if (v.seller_custom_field) return v.seller_custom_field;
        const attrVar = (v.attributes || []).find(a => a.id === 'SELLER_SKU');
        if (attrVar && attrVar.value_name) return attrVar.value_name;
      }
    }
    return '—';
  }

  const DEPOSITO_LABEL = {
    fulfillment:   'Full',
    self_service:  'Próprio',
    cross_docking: 'Flex',
    xd_drop_off:   'Próprio',
  };

  try {
    const todosIds = [];
    for (const status of ['active', 'paused', 'closed']) {
      let offset = 0;
      while (true) {
        const searchResp = await axios.get(
          `https://api.mercadolibre.com/users/${c.user_id}/items/search`,
          {
            params: { status, offset, limit },
            headers: { Authorization: `Bearer ${c.access_token}` },
          }
        );
        const ids = searchResp.data.results || [];
        todosIds.push(...ids);
        if (ids.length < limit) break;
        offset += limit;
        if (offset >= 1000) break;
      }
    }

    if (!todosIds.length) return res.json({ items: [], total: 0 });

    const detalhes = [];
    for (let i = 0; i < todosIds.length; i += 20) {
      const chunk = todosIds.slice(i, i + 20);
      const resp  = await axios.get('https://api.mercadolibre.com/items', {
        params: {
          ids:        chunk.join(','),
          attributes: 'id,title,permalink,seller_custom_field,available_quantity,variations,shipping,attributes,status,last_updated',
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
      });
      detalhes.push(...resp.data);
    }

    const pauseDates = c.pause_dates || {};
    const agora      = new Date().toISOString();
    let pauseChanged = false;

    const items = detalhes
      .filter(r => r.code === 200)
      .map(r => {
        const logisticType = r.body.shipping?.logistic_type || 'self_service';
        const mlb          = r.body.id;
        const status       = r.body.status;

        if (status === 'paused') {
          if (!pauseDates[mlb]) { pauseDates[mlb] = agora; pauseChanged = true; }
        } else {
          if (pauseDates[mlb]) { delete pauseDates[mlb]; pauseChanged = true; }
        }

        return {
          mlb,
          titulo:        r.body.title,
          permalink:     r.body.permalink || null,
          sku:           extrairSkuLocal(r.body),
          estoque:       r.body.available_quantity ?? 0,
          status,
          pausadoDesde:  status === 'paused' ? (pauseDates[mlb] || agora) : null,
          deposito:      logisticType,
          depositoLabel: DEPOSITO_LABEL[logisticType] || logisticType,
          variacoes:     (r.body.variations || []).map(v => ({
            id:     v.id,
            nome:   (v.attribute_combinations || []).map(a => a.value_name).join(' / ') || `Var. ${v.id}`,
            estoque: v.available_quantity ?? 0,
          })),
        };
      });

    if (pauseChanged) {
      c.pause_dates = pauseDates;
      saveData(data);
    }

    res.json({ items, total: items.length });
  } catch (err) {
    console.error('Erro ao buscar estoque:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar anúncios. Tente novamente.' });
  }
});

app.get('/api/ml/vendas30dias', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)      return res.json({ error: 'user_id não encontrado' });

  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const vendasPorItem = {};
  let offset = 0;
  const limit = 50;

  try {
    while (true) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:                    c.user_id,
          'order.status':            'paid',
          'order.date_created.from': from,
          sort:                      'date_desc',
          offset,
          limit,
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 10000,
      });

      const orders = resp.data.results || [];
      const total  = resp.data.paging?.total || 0;

      for (const order of orders) {
        for (const oi of (order.order_items || [])) {
          const id  = oi.item.id;
          const qty = oi.quantity || 1;
          vendasPorItem[id] = (vendasPorItem[id] || 0) + qty;
        }
      }

      if (orders.length < limit) break;
      offset += limit;
      if (offset >= total || offset >= 2000) break;
    }
    res.json(vendasPorItem);
  } catch (err) {
    console.error('Erro ao buscar vendas:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar vendas.' });
  }
});

app.get('/api/ml/vendas-etiquetas', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)      return res.json({ error: 'user_id não encontrado' });

  const LABEL_STATUSES   = new Set(['handling', 'ready_to_ship']);
  // Substatuses onde a etiqueta está de fato gerada e disponível para baixar
  const LABEL_SUBSTATUSES = new Set(['ready_to_print', 'printed']);

  try {
    const todasOrdens = [];
    let offset = 0;
    const limit = 50;
    while (true) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:         c.user_id,
          'order.status': 'paid',
          sort:           'date_desc',
          offset,
          limit,
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 15000,
      });
      const orders = resp.data.results || [];
      todasOrdens.push(...orders);
      if (orders.length < limit || todasOrdens.length >= 200) break;
      offset += limit;
    }

    // Filtra ordens com shipment, excluindo Full já no nível da ordem quando possível
    const comShipment = todasOrdens.filter(o =>
      o.shipping && o.shipping.id &&
      o.shipping.logistic_type !== 'fulfillment' &&
      o.shipping.mode !== 'fulfillment'
    );

    const resultado = [];
    for (let i = 0; i < comShipment.length; i += 10) {
      const lote = comShipment.slice(i, i + 10);
      const detalhes = await Promise.all(
        lote.map(async (order) => {
          try {
            const r = await axios.get(
              `https://api.mercadolibre.com/shipments/${order.shipping.id}`,
              { headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 8000 }
            );
            return { order, shipment: r.data };
          } catch {
            return { order, shipment: null };
          }
        })
      );
      resultado.push(...detalhes);
    }

    const SUBSTATUS_LABEL = { ready_to_print: 'Baixar', printed: 'Baixar novamente' };
    const STATUS_PT = { handling: 'Preparando', ready_to_ship: 'Aguardando coleta' };

    const isFull = (s) => s && (
      s.logistic_type === 'fulfillment' ||
      s.logistic_type === 'fulfillment_reverse' ||
      (s.logistic_type || '').includes('fulfillment')
    );

    const filtradas = resultado.filter(({ shipment }) =>
      shipment &&
      LABEL_STATUSES.has(shipment.status) &&
      LABEL_SUBSTATUSES.has(shipment.substatus) &&
      !isFull(shipment)
    );

    // Coleta todos os MLBs únicos para buscar thumbnail e SKU em lote
    const todosMLBs = [...new Set(
      filtradas.flatMap(({ order }) => (order.order_items || []).map(i => i.item.id))
    )];

    const itemMap = {};
    for (let i = 0; i < todosMLBs.length; i += 20) {
      const chunk = todosMLBs.slice(i, i + 20);
      try {
        const r = await axios.get('https://api.mercadolibre.com/items', {
          params:  { ids: chunk.join(','), attributes: 'id,thumbnail,permalink,seller_custom_field,pictures,variations,attributes' },
          headers: { Authorization: `Bearer ${c.access_token}` },
          timeout: 10000,
        });
        for (const entry of r.data) {
          if (entry.code === 200) {
            const b   = entry.body;
            const sku = extrairSku(b);
            // thumbnail já é uma URL direta; pictures[0] pode precisar de request extra
            let thumb = b.thumbnail || null;
            // O ML retorna thumbnail em baixa resolução com "-I.jpg" — troca por "-O.jpg" para melhor qualidade
            if (thumb) thumb = thumb.replace(/-[A-Z]\.jpg/, '-O.jpg');
            itemMap[b.id] = {
              thumbnail: thumb,
              sku:       sku !== '—' ? sku : null,
              permalink: b.permalink || null,
            };
          }
        }
      } catch {}
    }

    // Agrupa por shipmentId (um shipment pode ter múltiplas orders / itens)
    const porShipment = new Map();
    for (const { order, shipment } of filtradas) {
      const sid = String(shipment.id);
      if (!porShipment.has(sid)) {
        porShipment.set(sid, {
          orderId:     order.id,
          data:        order.date_created,
          comprador:   order.buyer?.nickname || '—',
          shipmentId:  shipment.id,
          conta:       data.conta_ativa,
          status:      shipment.status,
          statusLabel: STATUS_PT[shipment.status] || shipment.status,
          acaoLabel:   SUBSTATUS_LABEL[shipment.substatus] || 'Baixar',
          itensLista:  [],
        });
      }
      const grupo = porShipment.get(sid);
      for (const i of (order.order_items || [])) {
        const extra = itemMap[i.item.id] || {};
        grupo.itensLista.push({
          titulo:     i.item.title,
          sku:        extra.sku || '—',
          thumbnail:  extra.thumbnail || null,
          permalink:  extra.permalink || null,
          quantidade: i.quantity || 1,
        });
      }
    }
    // Pedidos atendidos ficam salvos com dados completos — não dependem da API
    const atendidasMap = new Map((c.atendidas_dados || []).map(v => [String(v.shipmentId), v]));

    // Pendentes: da API, excluindo os já atendidos
    const pendentes = [...porShipment.values()]
      .filter(v => !atendidasMap.has(String(v.shipmentId)))
      .map(v => ({ ...v, atendida: false }));

    // Atualiza os dados salvos dos atendidos com info mais recente se ainda estiver na API
    atendidasMap.forEach((salvo, sid) => {
      if (porShipment.has(sid)) atendidasMap.set(sid, { ...porShipment.get(sid), atendida: true });
    });

    const atendidas = [...atendidasMap.values()].map(v => ({ ...v, atendida: true }));
    const vendas = [...pendentes, ...atendidas];

    res.json({ vendas });
  } catch (err) {
    console.error('Erro ao buscar vendas com etiqueta:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar vendas.' });
  }
});

app.post('/api/vendas/atendida', (req, res) => {
  const { shipmentId, venda } = req.body;
  if (!shipmentId) return res.json({ error: 'shipmentId obrigatório' });
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c) return res.json({ error: 'Conta não encontrada' });
  if (!c.atendidas_dados) c.atendidas_dados = [];
  const sid = String(shipmentId);
  const existente = c.atendidas_dados.find(v => String(v.shipmentId) === sid);
  // Se venda veio com dados usa eles; senão mantém os dados já salvos
  const dadosFinal = venda || existente || null;
  c.atendidas_dados = c.atendidas_dados.filter(v => String(v.shipmentId) !== sid);
  if (dadosFinal) c.atendidas_dados.push({ ...dadosFinal, atendida: true, atendidaEm: existente?.atendidaEm || new Date().toISOString() });
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/vendas/atendida', (req, res) => {
  const { shipmentId } = req.body;
  if (!shipmentId) return res.json({ error: 'shipmentId obrigatório' });
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c) return res.json({ error: 'Conta não encontrada' });
  c.atendidas_dados = (c.atendidas_dados || []).filter(v => String(v.shipmentId) !== String(shipmentId));
  saveData(data);
  res.json({ ok: true });
});


app.get('/api/ml/ads-roas', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)            return res.json({ error: 'user_id não encontrado. Reconecte a conta.' });

  const headers   = { Authorization: `Bearer ${c.access_token}` };
  const today     = new Date().toISOString().split('T')[0];
  const dateBegin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    // 1. Busca todos os ads do seller (paginado)
    const todosAds = [];
    let offset = 0;
    while (true) {
      const r = await axios.get('https://api.mercadolibre.com/advertising/product_ads/ads/search', {
        params: { seller_id: c.user_id, limit: 50, offset }, headers, timeout: 12000,
      });
      const results = r.data.results || [];
      todosAds.push(...results);
      if (results.length < 50 || todosAds.length >= 500) break;
      offset += 50;
    }

    // 2. Coleta campaign_ids únicos (com campaign_id > 0)
    const campIds = [...new Set(
      todosAds.filter(a => a.campaign_id > 0).map(a => a.campaign_id)
    )];

    if (!campIds.length) return res.json({ itens: [], aviso: 'Nenhuma campanha ativa encontrada.' });

    // 3. Busca detalhes, métricas e ads de cada campanha em paralelo
    const campResults = await Promise.all(campIds.map(async (campId) => {
      try {
        const [detResp, metResp] = await Promise.all([
          axios.get(`https://api.mercadolibre.com/advertising/product_ads/campaigns/${campId}`, { headers, timeout: 10000 }),
          axios.get(`https://api.mercadolibre.com/advertising/product_ads/campaigns/${campId}/metrics`, {
            params: { date_from: dateBegin, date_to: today }, headers, timeout: 10000,
          }),
        ]);
        // Filtra os ads desta campanha a partir da lista completa (o filtro campaign_id da API não funciona)
        const adsDestaCamp = todosAds.filter(a => a.campaign_id === campId);
        return { campId, det: detResp.data, met: metResp.data, ads: adsDestaCamp };
      } catch { return null; }
    }));

    // 4. Monta tabela — uma linha por campanha
    const itens = campResults
      .filter(r => r && r.met?.cost > 0)
      .map(({ campId, det, met, ads }) => {
        const adsDestaCamp = ads;
        const vistos = new Set();
        const titulos = adsDestaCamp
          .filter(a => { if (vistos.has(a.id)) return false; vistos.add(a.id); return true; })
          .map(a => a.title)
          .join(' | ');
        const cost            = Number(met.cost)         || 0;
        const revenue         = Number(met.amount_total) || 0;
        const units           = Number(met.sold_quantity_total) || Number(met.sold_items_quantity_total) || 0;
        const roasEntregando  = cost > 0 ? revenue / cost : null;
        const custoPorUnidade = units > 0 ? cost / units  : null;
        const adsListaDedup = [];
        const vistosLista = new Set();
        adsDestaCamp.forEach(a => {
          if (!vistosLista.has(a.id)) { vistosLista.add(a.id); adsListaDedup.push({ id: a.id, title: a.title || '—' }); }
        });
        return {
          campId:         String(campId),
          campanha:       det.name || String(campId),
          targetRoas:     det.roas_target  ?? null,
          acosTarget:     det.acos_target  ?? null,
          roasEntregando,
          custoPorUnidade,
          cost,
          revenue,
          units,
          clicks:         Number(met.clicks)     || 0,
          impressions:    Number(met.impressions) || 0,
          tacos:          Number(met.tacos)       || 0,
          titulos,
          qtdAnuncios:    adsListaDedup.length,
          adsLista:       adsListaDedup,
        };
      });

    res.json({ itens });
  } catch (err) {
    console.error('Erro ads-roas:', err.response?.data || err.message);
    const d = err.response?.data;
    res.json({ error: d?.message || d?.error || 'Erro ao buscar dados de ads.', detalhe: JSON.stringify(d) });
  }
});

// DEBUG — explora API de Ads
app.get('/api/ml/debug-ads', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ error: 'Não conectado' });

  const headers = { Authorization: `Bearer ${c.access_token}` };
  const result  = {};

  const tryGet = async (label, url, params = {}) => {
    try {
      const r = await axios.get(url, { headers, params, timeout: 10000 });
      result[label] = { status: r.status, data: r.data };
    } catch (e) {
      result[label] = { status: e.response?.status, error: e.response?.data || e.message };
    }
  };

  // Busca o primeiro item ativo para ter MLBs reais
  let primeiroMlb = req.query.mlb;
  if (!primeiroMlb && c.user_id) {
    try {
      const itemsResp = await axios.get(`https://api.mercadolibre.com/users/${c.user_id}/items/search`, {
        params: { status: 'active', limit: 1 }, headers, timeout: 8000,
      });
      primeiroMlb = itemsResp.data.results?.[0];
    } catch {}
  }

  result['_mlb_usado'] = primeiroMlb || 'nenhum';

  // Busca catalog_product_id e family_id do item
  let catalogId = null, familyId = null;
  if (primeiroMlb) {
    try {
      const itemR = await axios.get(`https://api.mercadolibre.com/items/${primeiroMlb}`, {
        params: { attributes: 'id,catalog_product_id,family_id,parent_item_id,variations' },
        headers, timeout: 8000,
      });
      catalogId = itemR.data.catalog_product_id || null;
      familyId  = itemR.data.family_id || itemR.data.variations?.[0]?.id || null;
      result['_catalog_product_id'] = catalogId || 'nenhum';
      result['_family_id']          = familyId  || 'nenhum';
    } catch {}
  }

  const today     = new Date().toISOString().split('T')[0];
  const dateBegin = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Busca ads do seller
  let adIds = [];
  try {
    const adsResp = await axios.get('https://api.mercadolibre.com/advertising/product_ads/ads/search', {
      params: { seller_id: c.user_id, limit: 5 }, headers, timeout: 10000,
    });
    adIds = (adsResp.data.results || []).filter(a => a.campaign_id > 0).map(a => a.id).slice(0, 3);
    result['_ad_ids_encontrados'] = adIds;
  } catch (e) {
    result['_ad_ids_encontrados'] = 'erro: ' + e.message;
  }

  const campId = 356092603; // campaign_id real encontrado

  // Métricas por campanha
  await tryGet('camp_metrics',           `https://api.mercadolibre.com/advertising/product_ads/campaigns/${campId}/metrics`, { date_from: dateBegin, date_to: today });
  await tryGet('camp_metrics_agg',       `https://api.mercadolibre.com/advertising/product_ads/campaigns/${campId}/metrics`, { date_from: dateBegin, date_to: today, aggregation: 'total' });

  // Métricas pelo seller direto
  await tryGet('seller_metrics',         'https://api.mercadolibre.com/advertising/product_ads/metrics', { seller_id: c.user_id, date_from: dateBegin, date_to: today });

  // Métricas de ads com item_id em vez de ids
  if (adIds.length) {
    await tryGet('metrics_item_id',      'https://api.mercadolibre.com/advertising/product_ads/ads/metrics', { item_id: adIds[0], date_from: dateBegin, date_to: today });
    await tryGet('metrics_campaign_id',  'https://api.mercadolibre.com/advertising/product_ads/ads/metrics', { campaign_id: campId, date_from: dateBegin, date_to: today });
    // Tenta sem prefixo MLB
    const numId = adIds[0].replace('MLB', '');
    await tryGet('metrics_num_id',       'https://api.mercadolibre.com/advertising/product_ads/ads/metrics', { ids: numId, date_from: dateBegin, date_to: today });
  }

  // Métricas direto no campaign search com advertiser_id=156629 (encontrado na resposta anterior)
  await tryGet('camp_by_advertiser',     'https://api.mercadolibre.com/advertising/product_ads/campaigns/search', { advertiser_id: 156629, limit: 5 });
  await tryGet('camp_metrics_adv',       `https://api.mercadolibre.com/advertising/advertisers/156629/campaigns/${campId}/metrics`, { date_from: dateBegin, date_to: today });

  res.json(result);
});

// DEBUG — testa POST e variações para gerar etiqueta
app.get('/api/ml/debug-label/:shipment_id', async (req, res) => {
  const data   = loadData();
  const num    = req.query.conta || data.conta_ativa;
  const c      = data.contas[num] || {};
  const sid    = req.params.shipment_id;
  const tok    = c.access_token;
  const auth   = { Authorization: `Bearer ${tok}` };
  const result = {};

  // Tenta POST em /shipments/{id}/labels
  for (const body of [
    { shipment_ids: [parseInt(sid)], response_type: 'pdf' },
    { response_type: 'pdf' },
    {},
  ]) {
    try {
      const r = await axios.post(
        `https://api.mercadolibre.com/shipments/${sid}/labels`,
        body, { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      result[`POST_${JSON.stringify(body)}`] = { status: r.status, data: typeof r.data === 'string' ? r.data.slice(0, 300) : r.data };
    } catch (e) {
      result[`POST_${JSON.stringify(body)}`] = { status: e.response?.status, error: JSON.stringify(e.response?.data || e.message).slice(0, 200) };
    }
  }

  // Tenta POST em /shipments/labels (batch)
  try {
    const r = await axios.post(
      `https://api.mercadolibre.com/shipments/labels`,
      { shipment_ids: [parseInt(sid)], response_type: 'pdf' },
      { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    result['POST_batch'] = { status: r.status, data: typeof r.data === 'string' ? r.data.slice(0, 300) : r.data };
  } catch (e) {
    result['POST_batch'] = { status: e.response?.status, error: JSON.stringify(e.response?.data || e.message).slice(0, 200) };
  }

  // Tenta GET com x-caller-id no header
  try {
    const r = await axios.get(
      `https://api.mercadolibre.com/shipments/${sid}/labels?response_type=pdf`,
      { headers: { ...auth, 'x-caller-id': c.user_id }, responseType: 'arraybuffer', timeout: 8000 }
    );
    result['GET_xcallerid'] = { status: r.status, bytes: r.data.byteLength, contentType: r.headers['content-type'] };
  } catch (e) {
    result['GET_xcallerid'] = { status: e.response?.status, error: e.response?.data ? Buffer.from(e.response.data).toString('utf8').slice(0, 200) : e.message };
  }

  // Tenta GET via endpoint de orders
  if (req.query.order_id) {
    try {
      const r = await axios.get(
        `https://api.mercadolibre.com/orders/${req.query.order_id}/shipments/${sid}/labels?response_type=pdf`,
        { headers: auth, responseType: 'arraybuffer', timeout: 8000 }
      );
      result['GET_via_order'] = { status: r.status, bytes: r.data.byteLength, contentType: r.headers['content-type'] };
    } catch (e) {
      result['GET_via_order'] = { status: e.response?.status, error: e.response?.data ? Buffer.from(e.response.data).toString('utf8').slice(0, 200) : e.message };
    }
  }

  // Tenta GET no snapshot_id do packing
  if (req.query.snapshot_id) {
    for (const url of [
      `https://api.mercadolibre.com/shipments/labels/snapshot/${req.query.snapshot_id}?response_type=pdf`,
      `https://api.mercadolibre.com/packs/labels/snapshot/${req.query.snapshot_id}?response_type=pdf`,
    ]) {
      try {
        const r = await axios.get(url, { headers: auth, responseType: 'arraybuffer', timeout: 8000 });
        result[`GET_snapshot_${url.split('/')[5]}`] = { status: r.status, bytes: r.data.byteLength };
      } catch (e) {
        result[`GET_snapshot_${url.split('/')[5]}`] = { status: e.response?.status, error: e.response?.data ? Buffer.from(e.response.data).toString('utf8').slice(0, 200) : e.message };
      }
    }
  }

  res.json(result);
});

app.get('/api/ml/etiquetas', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num] || {};
  if (!c.access_token) return res.status(401).json({ error: 'Não conectado' });

  const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Nenhum ID informado' });

  const idsParam = ids.join(',');
  try {
    const resp = await axios.get(
      `https://api.mercadolibre.com/shipment_labels?shipment_ids=${idsParam}&response_type=pdf`,
      { headers: { Authorization: `Bearer ${c.access_token}` }, responseType: 'arraybuffer', timeout: 20000 }
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="etiquetas.pdf"`);
    return res.send(Buffer.from(resp.data));
  } catch (e) {
    res.status(404).json({ error: 'Erro ao baixar etiquetas.', detalhe: JSON.stringify(e.response?.data || e.message) });
  }
});

app.get('/api/ml/etiqueta/:shipment_id', async (req, res) => {
  const data  = loadData();
  const num   = req.query.conta || data.conta_ativa;
  const c     = data.contas[num] || {};
  if (!c.access_token) return res.status(401).json({ error: 'Não conectado' });

  const sid  = req.params.shipment_id;
  const tok  = c.access_token;

  // Tenta o novo endpoint /shipment_labels
  const urls = [
    `https://api.mercadolibre.com/shipment_labels?shipment_ids=${sid}&response_type=pdf`,
    `https://api.mercadolibre.com/shipment_labels?shipment_ids=${sid}&response_type=zpl2`,
    `https://api.mercadolibre.com/shipments/${sid}/labels?response_type=pdf`,
  ];

  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        headers:      { Authorization: `Bearer ${tok}` },
        responseType: 'arraybuffer',
        timeout:      15000,
      });
      const ct = resp.headers['content-type'] || '';
      if (resp.status === 200 && resp.data.byteLength > 100) {
        res.setHeader('Content-Type', ct || 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="etiqueta-${sid}.pdf"`);
        return res.send(Buffer.from(resp.data));
      }
    } catch {}
  }

  // Nenhum funcionou — retorna debug
  const debug = {};
  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 8000 });
      debug[url] = { status: r.status, ct: r.headers['content-type'], size: JSON.stringify(r.data).length };
    } catch (e) {
      debug[url] = { status: e.response?.status, error: JSON.stringify(e.response?.data || e.message).slice(0, 200) };
    }
  }
  res.status(404).json({ error: 'Não foi possível baixar a etiqueta.', debug });
});

app.put('/api/ml/estoque/:mlb', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.status(401).json({ error: 'Não conectado' });

  const { quantidade, variacao_id } = req.body;
  if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < 0) {
    return res.status(400).json({ error: 'Quantidade inválida' });
  }

  const mlb     = req.params.mlb;
  const headers = { Authorization: `Bearer ${c.access_token}`, 'Content-Type': 'application/json' };

  try {
    if (variacao_id) {
      // Atualiza apenas esta variação específica
      await axios.put(
        `https://api.mercadolibre.com/items/${mlb}`,
        { variations: [{ id: Number(variacao_id), available_quantity: quantidade }] },
        { headers, timeout: 10000 }
      );
    } else {
      // Busca o item para saber se tem variações
      const itemResp = await axios.get(`https://api.mercadolibre.com/items/${mlb}`, {
        params:  { attributes: 'id,variations' },
        headers,
        timeout: 10000,
      });
      const variations = itemResp.data.variations || [];
      if (variations.length > 0) {
        await axios.put(
          `https://api.mercadolibre.com/items/${mlb}`,
          { variations: variations.map(v => ({ id: v.id, available_quantity: quantidade })) },
          { headers, timeout: 10000 }
        );
      } else {
        await axios.put(
          `https://api.mercadolibre.com/items/${mlb}`,
          { available_quantity: quantidade },
          { headers, timeout: 10000 }
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    const mlErr = err.response?.data;
    console.error('Erro ao atualizar estoque:', mlErr || err.message);
    const msg = mlErr?.message || mlErr?.error || mlErr?.cause?.[0]?.message || 'Erro ao atualizar no Mercado Livre';
    res.status(400).json({ error: msg, detalhe: JSON.stringify(mlErr) });
  }
});

// ── Inicia o servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
