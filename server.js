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
  if (!token) return;
  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  if (!projectId || !environmentId || !serviceId) return;

  const variables = { ML_CONTA_ATIVA: data.conta_ativa || '1' };
  for (const num of ['1', '2']) {
    const c = data.contas[num] || {};
    if (c.client_id)     variables[`ML_CLIENT_ID_${num}`]     = c.client_id;
    if (c.client_secret) variables[`ML_CLIENT_SECRET_${num}`] = c.client_secret;
    if (c.access_token)  variables[`ML_ACCESS_TOKEN_${num}`]  = c.access_token;
    if (c.refresh_token) variables[`ML_REFRESH_TOKEN_${num}`] = c.refresh_token;
    if (c.user_id)       variables[`ML_USER_ID_${num}`]       = String(c.user_id);
  }

  await axios.post(
    'https://backboard.railway.app/graphql/v2',
    {
      query: `mutation Upsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }`,
      variables: { input: { projectId, environmentId, serviceId, variables } },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
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
    + `&state=${num}`;
  res.redirect(url);
});

app.get('/api/ml/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/app.html?tab=config&error=auth_cancelado');

  const data     = loadData();
  const num      = state || data.conta_ativa;
  const c        = data.contas[num] || {};
  const callback = `${req.protocol}://${req.get('host')}/api/ml/callback`;

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
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    c.access_token  = resp.data.access_token;
    c.refresh_token = resp.data.refresh_token;
    c.user_id       = resp.data.user_id;
    // Busca o nickname para exibir no seletor de conta
    try {
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${c.access_token}` },
      });
      c.nickname = me.data.nickname;
    } catch {}
    data.contas[num] = c;
    saveData(data);
    res.redirect(`/app.html?tab=config&connected=true&conta=${num}`);
  } catch (err) {
    const detalhe = JSON.stringify(err.response?.data || err.message);
    console.error('Erro no callback OAuth:', detalhe);
    res.redirect(`/app.html?tab=config&error=auth_falhou&detalhe=${encodeURIComponent(detalhe)}`);
  }
});

// ── Rotas de dados ML ─────────────────────────────────────────

async function refreshToken(data, num) {
  const c = data.contas[num];
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
  c.access_token  = resp.data.access_token;
  c.refresh_token = resp.data.refresh_token;
  saveData(data);
  return c;
}

app.get('/api/ml/status', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ connected: false });
  try {
    const resp = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${c.access_token}` },
    });
    res.json({ connected: true, nickname: resp.data.nickname });
  } catch {
    res.json({ connected: false });
  }
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
          attributes: 'id,title,seller_custom_field,available_quantity,variations,shipping,attributes,status,last_updated',
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
          sku:           extrairSku(r.body),
          estoque:       r.body.available_quantity ?? 0,
          status,
          pausadoDesde:  status === 'paused' ? (pauseDates[mlb] || agora) : null,
          deposito:      logisticType,
          depositoLabel: DEPOSITO_LABEL[logisticType] || logisticType,
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

    const vendas = resultado
      .filter(({ shipment }) =>
        shipment &&
        LABEL_STATUSES.has(shipment.status) &&
        LABEL_SUBSTATUSES.has(shipment.substatus) &&
        !isFull(shipment)
      )
      .map(({ order, shipment }) => {
        const itens = (order.order_items || []).map(i => ({
          titulo: `${i.quantity}x ${i.item.title}`,
          sku:    i.item.seller_custom_field || '—',
        }));
        return {
          orderId:     order.id,
          data:        order.date_created,
          comprador:   order.buyer?.nickname || '—',
          itens:       itens.map(i => i.titulo).join(' | '),
          skus:        itens.map(i => i.sku).join(' | '),
          shipmentId:  shipment.id,
          status:      shipment.status,
          statusLabel: STATUS_PT[shipment.status] || shipment.status,
          acaoLabel:   SUBSTATUS_LABEL[shipment.substatus] || 'Baixar',
        };
      });

    res.json({ vendas });
  } catch (err) {
    console.error('Erro ao buscar vendas com etiqueta:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar vendas.' });
  }
});

// DEBUG — retorna o objeto completo do shipment para inspeção
app.get('/api/ml/debug-shipment/:shipment_id', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.status(401).json({ error: 'Não conectado' });
  try {
    const resp = await axios.get(
      `https://api.mercadolibre.com/shipments/${req.params.shipment_id}`,
      { headers: { Authorization: `Bearer ${c.access_token}` } }
    );
    res.json(resp.data);
  } catch (err) {
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/api/ml/etiqueta/:shipment_id', (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.status(401).json({ error: 'Não conectado' });

  // Redireciona direto para a URL da ML com o token — forma mais confiável para labels
  const url = `https://api.mercadolibre.com/shipments/${req.params.shipment_id}/labels`
    + `?response_type=pdf&access_token=${encodeURIComponent(c.access_token)}`;
  res.redirect(url);
});

// ── Inicia o servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
