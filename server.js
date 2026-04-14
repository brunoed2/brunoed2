// ============================================================
// server.js — Servidor Express principal
// Serve os arquivos estáticos + rotas da API do Mercado Livre
// Suporta duas contas ML com alternância em tempo real
// ============================================================

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

// PKCE: guarda code_verifier em memória por conta durante o fluxo OAuth
const pkceVerifiers = new Map(); // num → code_verifier

function gerarCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}
function gerarCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

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
    if (c.client_id)        variables[`ML_CLIENT_ID_${num}`]        = c.client_id;
    if (c.client_secret)    variables[`ML_CLIENT_SECRET_${num}`]    = c.client_secret;
    if (c.access_token)     variables[`ML_ACCESS_TOKEN_${num}`]     = c.access_token;
    if (c.refresh_token)    variables[`ML_REFRESH_TOKEN_${num}`]    = c.refresh_token;
    if (c.user_id)          variables[`ML_USER_ID_${num}`]          = String(c.user_id);
    if (c.token_expires_at) variables[`ML_TOKEN_EXPIRES_AT_${num}`] = String(c.token_expires_at);
  }
  // Certificado digital Notas de Entrada — por conta
  for (const num of ['1', '2']) {
    const n = (data.notas_contas || {})[num] || {};
    if (n.cert_b64)  variables[`NOTAS_CERT_B64_${num}`]  = n.cert_b64;
    if (n.cert_nome) variables[`NOTAS_CERT_NOME_${num}`] = n.cert_nome;
    if (n.senha)     variables[`NOTAS_SENHA_${num}`]     = n.senha;
    if (n.cnpj)      variables[`NOTAS_CNPJ_${num}`]      = n.cnpj;
    if (n.titular)   variables[`NOTAS_TITULAR_${num}`]   = n.titular;
    // Lista de notas (sem o campo zip para economizar espaço nas env vars)
    if (n.lista && n.lista.length > 0) {
      const listaSemZip = n.lista.map(({ zip, ...resto }) => resto);
      variables[`NOTAS_LISTA_${num}`] = JSON.stringify(listaSemZip);
    }
    if (n.ultNSU) variables[`NOTAS_ULTNSU_${num}`] = n.ultNSU;
    if (n.maxNSU) variables[`NOTAS_MAXNSU_${num}`] = n.maxNSU;
    if (n.ultimaRejeicao656) variables[`NOTAS_REJEICAO656_${num}`] = String(n.ultimaRejeicao656);
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
      client_id:        `ML_CLIENT_ID_${num}`,
      client_secret:    `ML_CLIENT_SECRET_${num}`,
      access_token:     `ML_ACCESS_TOKEN_${num}`,
      refresh_token:    `ML_REFRESH_TOKEN_${num}`,
      user_id:          `ML_USER_ID_${num}`,
    };
    for (const [key, envKey] of Object.entries(map)) {
      if (!c[key] && process.env[envKey]) {
        c[key] = process.env[envKey];
        changed = true;
      }
    }
    // token_expires_at é número — trata separado
    if (!c.token_expires_at && process.env[`ML_TOKEN_EXPIRES_AT_${num}`]) {
      c.token_expires_at = parseInt(process.env[`ML_TOKEN_EXPIRES_AT_${num}`]) || 0;
      changed = true;
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

  // Certificado digital Notas de Entrada — por conta
  data.notas_contas = data.notas_contas || {};
  for (const num of ['1', '2']) {
    const nc = data.notas_contas[num] || {};
    if (!nc.cert_b64 && process.env[`NOTAS_CERT_B64_${num}`]) {
      nc.cert_b64  = process.env[`NOTAS_CERT_B64_${num}`];
      nc.cert_nome = process.env[`NOTAS_CERT_NOME_${num}`] || '';
      nc.senha     = process.env[`NOTAS_SENHA_${num}`]     || '';
      nc.cnpj      = process.env[`NOTAS_CNPJ_${num}`]      || '';
      nc.titular   = process.env[`NOTAS_TITULAR_${num}`]   || '';
      changed = true;
    }
    // Restaura lista de notas (sem zip — download de XML requer nova busca)
    if (!nc.lista && process.env[`NOTAS_LISTA_${num}`]) {
      try { nc.lista = JSON.parse(process.env[`NOTAS_LISTA_${num}`]); changed = true; } catch {}
    }
    if (!nc.ultNSU && process.env[`NOTAS_ULTNSU_${num}`]) {
      nc.ultNSU = process.env[`NOTAS_ULTNSU_${num}`]; changed = true;
    }
    if (!nc.maxNSU && process.env[`NOTAS_MAXNSU_${num}`]) {
      nc.maxNSU = process.env[`NOTAS_MAXNSU_${num}`]; changed = true;
    }
    if (!nc.ultimaRejeicao656 && process.env[`NOTAS_REJEICAO656_${num}`]) {
      nc.ultimaRejeicao656 = parseInt(process.env[`NOTAS_REJEICAO656_${num}`]) || 0; changed = true;
    }
    data.notas_contas[num] = nc;
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
    const expira = c.token_expires_at || 0;
    const minutos = expira ? Math.round((expira - Date.now()) / 60000) : null;
    const expiraInfo = minutos !== null
      ? (temRefresh ? `renova automaticamente (token atual expira em ${minutos} min)` : `expira em ${minutos} min — sem refresh_token!`)
      : 'expires_at ausente';
    addLog(`Conta ${num}: access_token=${temToken ? 'presente' : 'AUSENTE'}, refresh_token=${temRefresh ? 'presente' : 'AUSENTE'}, ${expiraInfo}`, temToken ? 'ok' : 'warn');
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
  if (!c.client_id) return res.redirect('/app.html?tab=conexao&error=sem_client_id');
  const proto    = req.get('x-forwarded-proto') || req.protocol;
  const callback = `${proto}://${req.get('host')}/api/ml/callback`;

  // Gera PKCE
  const verifier  = gerarCodeVerifier();
  const challenge = gerarCodeChallenge(verifier);
  pkceVerifiers.set(num, verifier);
  addLog(`OAuth iniciado — conta ${num}, PKCE gerado`, 'info');

  const url = `https://auth.mercadolivre.com.br/authorization`
    + `?response_type=code`
    + `&client_id=${c.client_id}`
    + `&redirect_uri=${encodeURIComponent(callback)}`
    + `&state=${num}`
    + `&code_challenge=${challenge}`
    + `&code_challenge_method=S256`
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

  // Recupera o code_verifier do PKCE gerado no /api/ml/auth
  const codeVerifier = pkceVerifiers.get(num);
  pkceVerifiers.delete(num);
  if (!codeVerifier) addLog(`⚠️ PKCE verifier não encontrado para conta ${num}`, 'warn');

  try {
    const params = new URLSearchParams({
      grant_type:    'authorization_code',
      client_id:     c.client_id,
      client_secret: c.client_secret,
      code,
      redirect_uri:  callback,
    });
    if (codeVerifier) params.set('code_verifier', codeVerifier);

    const resp = await axios.post(
      'https://api.mercadolibre.com/oauth/token',
      params,
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
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
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
  // Se não há data de expiração (0), assume que o token ainda é válido e tenta usá-lo
  if (!expira || Date.now() < expira) return c.access_token;
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

// Recebe logs do frontend (erros JS, chamadas de função, etc.)
app.post('/api/conexao/clientlog', (req, res) => {
  const { msg, tipo } = req.body || {};
  if (msg) addLog(`[browser] ${msg}`, tipo || 'info');
  res.json({ ok: true });
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
  addLog(`[Loja] conta_ativa=${data.conta_ativa} access_token=${c.access_token ? 'OK' : 'AUSENTE'}`, 'info');
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  const fetchStore = async (token) => {
    const r = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return r.data;
  };

  try {
    const user = await fetchStore(c.access_token);
    addLog(`[Loja] ✅ OK — ${user.nickname}`, 'ok');
    res.json({ name: user.nickname, id: user.id, country: user.country_id });
  } catch (err) {
    addLog(`[Loja] ❌ Erro ML: ${err.message}`, 'erro');
    if (c.refresh_token) {
      try {
        c = await refreshToken(data, data.conta_ativa);
        const user = await fetchStore(c.access_token);
        res.json({ name: user.nickname, id: user.id, country: user.country_id });
      } catch (err2) {
        addLog(`[Loja] ❌ Erro após refresh: ${err2.message}`, 'erro');
        res.json({ error: 'Sessão expirada. Reconecte na aba Conexão.' });
      }
    } else {
      res.json({ error: `Erro ao buscar loja: ${err.message}` });
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

// Ping simples para testar conectividade frontend→servidor
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/ml/estoque', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  let c      = data.contas[num];
  addLog(`[Estoque] conta_ativa=${num} access_token=${c.access_token ? 'OK' : 'AUSENTE'}`, 'info');
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  if (!c.user_id) {
    try {
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 10000,
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
            params:  { status, offset, limit },
            headers: { Authorization: `Bearer ${c.access_token}` },
            timeout: 15000,
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
        timeout: 15000,
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
    // Busca pedidos dos últimos 60 dias para não perder pedidos antigos com etiqueta pendente
    const dataInicio = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19) + '.000-03:00';
    const todasOrdens = [];
    let offset = 0;
    const limit = 50;
    while (true) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:                      c.user_id,
          'order.status':              'paid',
          'order.date_created.from':   dataInicio,
          sort:                        'date_desc',
          offset,
          limit,
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 15000,
      });
      const orders = resp.data.results || [];
      todasOrdens.push(...orders);
      if (orders.length < limit || todasOrdens.length >= 500) break;
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
    const STATUS_PT = {
      handling:      'Preparando',
      ready_to_ship: 'Aguardando coleta',
    };

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
            const varMap = {};
            for (const v of (b.variations || [])) {
              varMap[v.id] = (v.attribute_combinations || []).map(a => a.value_name).join(' / ') || `Var. ${v.id}`;
            }
            itemMap[b.id] = {
              thumbnail:  thumb,
              sku:        sku !== '—' ? sku : null,
              permalink:  b.permalink || null,
              variations: varMap,
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
          orderId:        order.id,
          data:           order.date_created,
          comprador:      order.buyer?.nickname || '—',
          shipmentId:     shipment.id,
          conta:          data.conta_ativa,
          status:         shipment.status,
          statusLabel:    STATUS_PT[shipment.status] || shipment.status,
          acaoLabel:      SUBSTATUS_LABEL[shipment.substatus] || 'Baixar',
          itensLista:     [],
        });
      }
      const grupo = porShipment.get(sid);
      for (const i of (order.order_items || [])) {
        const extra = itemMap[i.item.id] || {};
        // Tenta variation_attributes direto da ordem (mais confiável)
        let variacaoNome = null;
        if (i.item.variation_attributes && i.item.variation_attributes.length > 0) {
          variacaoNome = i.item.variation_attributes.map(a => a.value_name).join(' / ');
        } else if (extra.variations && i.item.variation_id) {
          variacaoNome = extra.variations[i.item.variation_id] || null;
        }
        grupo.itensLista.push({
          titulo:     i.item.title,
          variacao:   variacaoNome,
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

// DEBUG — testa order ID ou pack ID
app.get('/api/ml/debug-order/:order_id', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ error: 'Não conectado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };
  const id = req.params.order_id;
  const result = { conta_usada: num, user_id: c.user_id };

  // Tenta como order direto
  try {
    const r = await axios.get(`https://api.mercadolibre.com/orders/${id}`, { headers, timeout: 10000 });
    const o = r.data;
    const shipping = o.shipping?.id
      ? await axios.get(`https://api.mercadolibre.com/shipments/${o.shipping.id}`, { headers, timeout: 10000 }).then(r2 => r2.data).catch(() => null)
      : null;
    result.via = 'order';
    result.order_status = o.status;
    result.shipping_id  = o.shipping?.id;
    result.shipment_status    = shipping?.status;
    result.shipment_substatus = shipping?.substatus;
    result.logistic_type      = shipping?.logistic_type;
    return res.json(result);
  } catch {}

  // Tenta como pack
  try {
    const r = await axios.get(`https://api.mercadolibre.com/packs/${id}`, { headers, timeout: 10000 });
    const pack = r.data;
    const orders = pack.orders || [];
    const shipId = pack.shipment?.id;
    const shipping = shipId
      ? await axios.get(`https://api.mercadolibre.com/shipments/${shipId}`, { headers, timeout: 10000 }).then(r2 => r2.data).catch(() => null)
      : null;
    result.via = 'pack';
    result.pack_status        = pack.status;
    result.order_ids          = orders.map(o => o.id);
    result.shipping_id        = shipId;
    result.shipment_status    = shipping?.status;
    result.shipment_substatus = shipping?.substatus;
    result.logistic_type      = shipping?.logistic_type;
    return res.json(result);
  } catch {}

  // Tenta buscar orders pelo pack.id
  try {
    const r = await axios.get('https://api.mercadolibre.com/orders/search', {
      params: { seller: c.user_id, 'pack.id': id },
      headers, timeout: 10000,
    });
    result.via = 'orders_by_pack';
    result.orders = (r.data.results || []).map(o => ({
      order_id: o.id, status: o.status, shipping_id: o.shipping?.id,
    }));
    return res.json(result);
  } catch (e) {
    result.error = e.response?.data || e.message;
    return res.json(result);
  }
});

// Lista os primeiros pedidos pagos da conta para diagnóstico
app.get('/api/ml/debug-orders', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id) return res.json({ error: 'user_id não encontrado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };
  try {
    const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
      params: { seller: c.user_id, 'order.status': 'paid', sort: 'date_desc', offset: 0, limit: 10 },
      headers, timeout: 15000,
    });
    const orders = (resp.data.results || []).map(o => ({
      order_id:      o.id,
      date:          o.date_created?.slice(0, 10),
      status:        o.status,
      shipping_id:   o.shipping?.id,
      logistic_type: o.shipping?.logistic_type,
      mode:          o.shipping?.mode,
    }));
    res.json({ conta: num, user_id: c.user_id, total: resp.data.paging?.total, orders });
  } catch (e) {
    res.json({ error: e.response?.data || e.message });
  }
});

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

// ── Shopee: helpers ──────────────────────────────────────────

function shopeeSign(partnerId, path, timestamp, partnerKey, accessToken, shopId) {
  let base = `${partnerId}|${path}|${timestamp}`;
  if (accessToken) base += `|${accessToken}`;
  if (shopId)      base += `|${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
}

const SHOPEE_BASE = 'https://partner.shopeemobile.com/api/v2';

function shopeeParams(path, partnerKey, partnerId, accessToken, shopId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(partnerId, path, timestamp, partnerKey, accessToken, shopId);
  const p = { partner_id: Number(partnerId), timestamp, sign };
  if (accessToken) p.access_token = accessToken;
  if (shopId)      p.shop_id      = Number(shopId);
  return p;
}

// ── Shopee: rotas ─────────────────────────────────────────────

app.get('/api/shopee/config', (req, res) => {
  const data = loadData();
  const sp   = data.shopee || {};
  res.json({ partner_id: sp.partner_id || '', shop_id: sp.shop_id || '', connected: !!sp.access_token });
});

app.post('/api/shopee/config', (req, res) => {
  const { partner_id, partner_key } = req.body;
  const data = loadData();
  if (!data.shopee) data.shopee = {};
  if (partner_id  !== undefined) data.shopee.partner_id  = String(partner_id);
  if (partner_key !== undefined) data.shopee.partner_key = String(partner_key);
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/shopee/auth', (req, res) => {
  const data = loadData();
  const sp   = data.shopee || {};
  if (!sp.partner_id || !sp.partner_key) return res.redirect('/app.html?shopee_error=sem_credenciais');
  const proto    = req.get('x-forwarded-proto') || req.protocol;
  const callback = `${proto}://${req.get('host')}/api/shopee/callback`;
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/shop/auth_partner';
  const sign = shopeeSign(sp.partner_id, path, timestamp, sp.partner_key);
  const url  = `${SHOPEE_BASE}/shop/auth_partner`
    + `?partner_id=${sp.partner_id}&timestamp=${timestamp}&sign=${sign}`
    + `&redirect=${encodeURIComponent(callback)}`;
  res.redirect(url);
});

app.get('/api/shopee/callback', async (req, res) => {
  const { code, shop_id, error } = req.query;
  if (error || !code || !shop_id) return res.redirect('/app.html?shopee_error=auth_cancelado');
  const data = loadData();
  const sp   = data.shopee || {};
  if (!sp.partner_id || !sp.partner_key) return res.redirect('/app.html?shopee_error=sem_credenciais');
  try {
    const path      = '/api/v2/auth/token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign      = shopeeSign(sp.partner_id, path, timestamp, sp.partner_key);
    const r = await axios.post(`${SHOPEE_BASE}/auth/token/get`, {
      code, shop_id: Number(shop_id), partner_id: Number(sp.partner_id),
    }, { params: { partner_id: Number(sp.partner_id), timestamp, sign }, timeout: 10000 });
    const { access_token, refresh_token, expire_in } = r.data;
    if (!access_token) throw new Error(JSON.stringify(r.data));
    data.shopee = { ...sp, shop_id: String(shop_id), access_token, refresh_token, expires_at: Date.now() + (expire_in || 14400) * 1000 };
    saveData(data);
    addLog(`Shopee: conectado — shop_id ${shop_id}`, 'info');
    res.redirect('/app.html?shopee_ok=1');
  } catch (err) {
    addLog(`Shopee callback erro: ${err.message}`, 'warn');
    res.redirect('/app.html?shopee_error=token');
  }
});

app.get('/api/shopee/status', async (req, res) => {
  const data = loadData();
  const sp   = data.shopee || {};
  if (!sp.access_token) return res.json({ connected: false });
  try {
    const path      = '/api/v2/shop/get_shop_info';
    const params    = shopeeParams(path, sp.partner_key, sp.partner_id, sp.access_token, sp.shop_id);
    const r = await axios.get(`${SHOPEE_BASE}/shop/get_shop_info`, { params, timeout: 8000 });
    if (r.data.error) return res.json({ connected: false, error: r.data.message });
    res.json({ connected: true, shop_name: r.data.response?.shop_name || '—', shop_id: sp.shop_id });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

app.get('/api/shopee/orders', async (req, res) => {
  const data = loadData();
  const sp   = data.shopee || {};
  if (!sp.access_token) return res.json({ error: 'Shopee não conectada' });
  try {
    const path   = '/api/v2/order/get_order_list';
    const params = shopeeParams(path, sp.partner_key, sp.partner_id, sp.access_token, sp.shop_id);
    params.order_status = 'READY_TO_SHIP';
    params.page_size    = 50;
    params.cursor       = '';
    const r = await axios.get(`${SHOPEE_BASE}/order/get_order_list`, { params, timeout: 10000 });
    if (r.data.error) return res.json({ error: r.data.message });
    const orders = r.data.response?.order_list || [];
    if (!orders.length) return res.json({ orders: [] });

    // Busca detalhes dos pedidos
    const sns = orders.map(o => o.order_sn);
    const pathD   = '/api/v2/order/get_order_detail';
    const paramsD = shopeeParams(pathD, sp.partner_key, sp.partner_id, sp.access_token, sp.shop_id);
    paramsD.order_sn_list   = sns.join(',');
    paramsD.response_optional_fields = 'buyer_username,item_list,recipient_address';
    const rd = await axios.get(`${SHOPEE_BASE}/order/get_order_detail`, { params: paramsD, timeout: 10000 });
    const detalhes = rd.data.response?.order_list || [];
    res.json({ orders: detalhes });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── Telegram: notificação de novos pedidos ────────────────────

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function enviarTelegram(texto) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id:    TELEGRAM_CHAT_ID,
      text:       texto,
      parse_mode: 'HTML',
    }, { timeout: 8000 });
  } catch (err) {
    addLog(`Telegram: falha ao enviar mensagem — ${err.message}`, 'warn');
  }
}

// Mantém os shipmentIds já notificados em memória (reseta ao reiniciar)
const shipmentsNotificados = new Set();
let telegramPrimeiraVerificacao = true;

async function verificarNovosShipmentsTelegram() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const data = loadData();
  // Verifica todas as contas configuradas
  for (const num of ['1', '2']) {
    const c = data.contas[num];
    if (!c || !c.access_token) continue;
    try {
      // Reutiliza a mesma lógica do endpoint de vendas-etiquetas
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: c.user_id, 'order.status': 'paid', sort: 'date_desc', limit: 50 },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 15000,
      });
      const orders = resp.data.results || [];
      const LABEL_STATUSES    = new Set(['handling', 'ready_to_ship']);
      const LABEL_SUBSTATUSES = new Set(['ready_to_print', 'printed']);
      const STATUS_PT = { handling: 'Preparando', ready_to_ship: 'Aguardando coleta' };

      for (const order of orders) {
        if (!order.shipping?.id) continue;
        const sid = String(order.shipping.id);
        if (shipmentsNotificados.has(sid)) continue;

        try {
          const sr = await axios.get(`https://api.mercadolibre.com/shipments/${order.shipping.id}`, {
            headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 8000,
          });
          const shipment = sr.data;
          const isFull = (shipment.logistic_type || '').includes('fulfillment');
          if (!LABEL_STATUSES.has(shipment.status) || !LABEL_SUBSTATUSES.has(shipment.substatus) || isFull) {
            shipmentsNotificados.add(sid); // marca para não checar de novo
            continue;
          }
          shipmentsNotificados.add(sid);
          if (telegramPrimeiraVerificacao) continue; // não notifica na inicialização

          const itens = (order.order_items || []).map(i => `• ${i.item.title} (x${i.quantity})`).join('\n');
          const conta = c.nome || `Conta ${num}`;
          const status = STATUS_PT[shipment.status] || shipment.status;
          const texto = `🛍 <b>Novo pedido — ${conta}</b>\n` +
            `Pedido: #${order.id}\n` +
            `Comprador: ${order.buyer?.nickname || '—'}\n` +
            `Status: ${status}\n\n${itens}`;
          await enviarTelegram(texto);
        } catch {}
      }
    } catch (err) {
      addLog(`Telegram monitor conta ${num}: ${err.message}`, 'warn');
    }
  }
  telegramPrimeiraVerificacao = false;
}

// ── Notas de Entrada (SEFAZ NF-e) ────────────────────────────────────────────

const multer = require('multer');
const forge  = require('node-forge');
const https  = require('https');
const zlib   = require('zlib');

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function extrairCnpjDoCert(pfxBuffer, senha) {
  let p12;
  try {
    const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);
  } catch {
    throw new Error('Senha incorreta ou arquivo PFX inválido');
  }
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const bags = certBags[forge.pki.oids.certBag] || [];
  if (!bags.length) throw new Error('Nenhum certificado encontrado no PFX');
  const cert = bags[0].cert;

  const cn = cert.subject.getField('CN')?.value || '';
  const allAttrs = cert.subject.attributes.map(a => String(a.value || '')).join(' ');
  let cnpj = null;
  const titular = cn.includes(':') ? cn.split(':')[0].trim() : cn.trim();

  // Padrão ICP-Brasil: "NOME DA EMPRESA:01234567000195"
  const matchCn = cn.match(/:(\d{14})(\s|$)/);
  if (matchCn) {
    cnpj = matchCn[1];
  } else {
    const matchAny = allAttrs.match(/\b(\d{14})\b/);
    if (matchAny) cnpj = matchAny[1];
  }

  if (!cnpj) {
    const sanExt = cert.extensions?.find(e => e.name === 'subjectAltName');
    if (sanExt?.altNames) {
      for (const alt of sanExt.altNames) {
        const m = String(alt.value || '').match(/\d{14}/);
        if (m) { cnpj = m[0]; break; }
      }
    }
  }

  if (!cnpj) throw new Error('CNPJ não encontrado no certificado. Certifique-se de usar um certificado e-CNPJ ICP-Brasil válido.');
  return { cnpj, titular };
}

async function queryNFeDistribuicao(pfxBuffer, senha, cnpj, cUF, ultNSU) {
  const nsuPad = String(ultNSU || 0).padStart(15, '0');
  const soapBody = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><soapenv:Header/><soapenv:Body><nfe:nfeDistDFeInteresse><nfe:nfeDadosMsg><distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><cUFAutor>${cUF}</cUFAutor><CNPJ>${cnpj}</CNPJ><distNSU><ultNSU>${nsuPad}</ultNSU></distNSU></distDFeInt></nfe:nfeDadosMsg></nfe:nfeDistDFeInteresse></soapenv:Body></soapenv:Envelope>`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www1.nfe.fazenda.gov.br',
      port: 443,
      path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
      method: 'POST',
      pfx: pfxBuffer,
      passphrase: senha,
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction': '"http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"',
        'Content-Length': Buffer.byteLength(soapBody, 'utf8'),
      },
      rejectUnauthorized: false,
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ao consultar SEFAZ (30s)')); });
    req.write(soapBody);
    req.end();
  });
}

function parsearRespostaSefaz(xmlResp) {
  const get = tag => xmlResp.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1];
  const cStat   = get('cStat');
  const xMotivo = get('xMotivo');
  const ultNSU  = get('ultNSU');
  const maxNSU  = get('maxNSU');

  const docs = [];
  const re = /<docZip[^>]*NSU="(\d+)"[^>]*schema="([^"]*)"[^>]*>([\s\S]+?)<\/docZip>/g;
  let m;
  while ((m = re.exec(xmlResp)) !== null) {
    docs.push({ nsu: m[1], schema: m[2], zip: m[3].trim() });
  }
  return { cStat, xMotivo, ultNSU, maxNSU, docs };
}

function extrairCampos(xmlDoc) {
  const get = tag => xmlDoc.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1] || '';
  const emitBloco = xmlDoc.match(/<emit>([\s\S]*?)<\/emit>/)?.[1] || '';
  const destBloco = xmlDoc.match(/<dest>([\s\S]*?)<\/dest>/)?.[1] || '';
  const getBloco  = (src, tag) => src.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`))?.[1] || '';
  return {
    chNFe:     get('chNFe') || (xmlDoc.match(/Id="NFe(\d{44})"/) || [])[1] || '',
    nNF:       get('nNF'),
    serie:     get('serie'),
    dhEmi:     get('dhEmi') || get('dEmi'),
    vNF:       get('vNF'),
    xNome:     emitBloco ? getBloco(emitBloco, 'xNome') : get('xNome'),
    CNPJ_emit: emitBloco ? getBloco(emitBloco, 'CNPJ')  : '',
    CNPJ_dest: destBloco ? getBloco(destBloco, 'CNPJ')  : '',
    tpNF:      get('tpNF'),
    xSitNFe:   get('xSitNFe'),
  };
}

app.post('/api/notas/certificado', uploadMem.single('cert'), (req, res) => {
  if (!req.file) return res.json({ error: 'Arquivo não enviado' });
  const senha = req.body.senha || '';
  const data  = loadData();
  const num   = req.body.conta || data.conta_ativa;
  try {
    const { cnpj, titular } = extrairCnpjDoCert(req.file.buffer, senha);
    data.notas_contas = data.notas_contas || {};
    data.notas_contas[num] = data.notas_contas[num] || {};
    const n = data.notas_contas[num];
    n.cert_b64  = req.file.buffer.toString('base64');
    n.cert_nome = req.file.originalname;
    n.senha     = senha;
    n.cnpj      = cnpj;
    n.titular   = titular;
    saveData(data);
    addLog(`Notas conta ${num}: certificado carregado — ${titular} (${cnpj})`, 'info');
    res.json({ ok: true, cnpj, titular });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/notas/config', (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const n    = (data.notas_contas || {})[num] || {};
  res.json({
    cnpj: n.cnpj || null,
    titular: n.titular || null,
    cert_nome: n.cert_nome || null,
    ultimaRejeicao656: n.ultimaRejeicao656 || null,
  });
});

app.get('/api/notas/xml/:nsu', (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const n    = (data.notas_contas || {})[num] || {};
  const nota = (n.lista || []).find(x => x.nsu === req.params.nsu);
  if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
  if (!nota.zip) return res.status(404).json({ error: 'XML não disponível para esta nota' });
  try {
    const xml = zlib.gunzipSync(Buffer.from(nota.zip, 'base64'));
    const nomeArquivo = `NFe_${nota.chNFe || nota.nsu}.xml`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(xml);
  } catch {
    res.status(500).json({ error: 'Erro ao descompactar XML' });
  }
});

app.get('/api/notas/lista', (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const n    = (data.notas_contas || {})[num] || {};
  res.json({ notas: n.lista || [], ultNSU: n.ultNSU || '0', maxNSU: n.maxNSU || '0' });
});

app.post('/api/notas/limpar', (req, res) => {
  const data = loadData();
  const num  = req.body.conta || data.conta_ativa;
  const n    = (data.notas_contas || {})[num];
  if (n) { n.lista = []; n.ultNSU = '0'; n.maxNSU = '0'; }
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/notas/buscar', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  data.notas_contas = data.notas_contas || {};
  data.notas_contas[num] = data.notas_contas[num] || {};
  const n = data.notas_contas[num];
  if (!n.cert_b64) return res.json({ error: 'Certificado não configurado. Faça o upload do certificado digital.' });

  const cUF     = req.query.cUF || '35';
  const pfxBuffer = Buffer.from(n.cert_b64, 'base64');

  // Acumula notas de múltiplos lotes até atingir maxNSU ou receber 656
  const listaExistente = n.lista || [];
  const nsuSet  = new Set(listaExistente.map(x => x.nsu));
  const todasNovas = [];
  let nsuAtual  = n.ultNSU || '0';
  let maxNSUFinal = n.maxNSU || '0';
  let aviso = null;
  const MAX_LOTES = 20; // segurança: no máximo 20 chamadas por busca (~1000 docs)

  try {
    for (let lote = 0; lote < MAX_LOTES; lote++) {
      addLog(`Notas conta ${num}: lote ${lote + 1} — UF ${cUF}, NSU ${nsuAtual}`, 'info');
      const xmlResp = await queryNFeDistribuicao(pfxBuffer, n.senha, n.cnpj, cUF, nsuAtual);
      const { cStat, xMotivo, ultNSU: novoNSU, maxNSU, docs } = parsearRespostaSefaz(xmlResp);

      if (novoNSU && novoNSU !== '000000000000000') nsuAtual = novoNSU;
      if (maxNSU)  maxNSUFinal = maxNSU;

      if (cStat !== '137' && cStat !== '138') {
        addLog(`Notas conta ${num}: SEFAZ ${cStat} — ${xMotivo}`, 'warn');
        aviso = `SEFAZ ${cStat}: ${xMotivo || 'Erro desconhecido'}`;
        n.ultNSU = nsuAtual;
        n.maxNSU = maxNSUFinal;
        if (cStat === '656') n.ultimaRejeicao656 = Date.now();
        saveData(data);
        break;
      }

      for (const doc of docs) {
        if (nsuSet.has(doc.nsu)) continue;
        nsuSet.add(doc.nsu);
        try {
          const buf    = Buffer.from(doc.zip, 'base64');
          const xmlDoc = zlib.gunzipSync(buf).toString('utf8');
          const campos = extrairCampos(xmlDoc);
          // Mantém só compras: CNPJ como destinatário ou tpNF=entrada e não é o emitente
          const ehCompra = campos.CNPJ_dest === n.cnpj ||
            (campos.tpNF === '0' && campos.CNPJ_emit !== n.cnpj) ||
            (!campos.CNPJ_dest && !campos.tpNF && campos.CNPJ_emit !== n.cnpj);
          if (!ehCompra) continue;
          campos.nsu    = doc.nsu;
          campos.schema = doc.schema;
          campos.tipo   = doc.schema.startsWith('resNFe') ? 'resumo' : 'completa';
          campos.zip    = doc.zip; // base64 gzip — para download do XML
          todasNovas.push(campos);
        } catch (e) {
          addLog(`Notas conta ${num}: erro NSU ${doc.nsu}: ${e.message}`, 'warn');
        }
      }

      // Salva progresso após cada lote
      const listaAtualizada = [...todasNovas, ...listaExistente];
      n.lista  = listaAtualizada;
      n.ultNSU = nsuAtual;
      n.maxNSU = maxNSUFinal;
      saveData(data);

      // Para quando chegamos ao fim
      const ult = parseInt(nsuAtual);
      const max = parseInt(maxNSUFinal);
      if (!docs.length || ult >= max) break;
    }

    const listaFinal = n.lista || [];
    addLog(`Notas conta ${num}: ${todasNovas.length} nova(s). Total: ${listaFinal.length}. NSU ${nsuAtual}/${maxNSUFinal}`, 'info');
    res.json({
      ok: true,
      novas: todasNovas,
      novasCount: todasNovas.length,
      total: listaFinal.length,
      ultNSU: nsuAtual,
      maxNSU: maxNSUFinal,
      ...(aviso ? { aviso } : {}),
    });
  } catch (err) {
    addLog(`Notas: erro — ${err.message}`, 'erro');
    res.json({ error: `Erro ao consultar SEFAZ: ${err.message}` });
  }
});

// ── Inicia o servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  // Inicia monitoramento Telegram 10s após subir, depois a cada 60s
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    addLog('Telegram: monitoramento de pedidos ativado', 'info');
    setTimeout(() => {
      verificarNovosShipmentsTelegram();
      setInterval(verificarNovosShipmentsTelegram, 60_000);
    }, 10_000);
  } else {
    addLog('Telegram: TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não configurados', 'warn');
  }
});
