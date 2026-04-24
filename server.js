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
const multer  = require('multer');
const forge   = require('node-forge');
const https   = require('https');
const zlib    = require('zlib');

const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// ── Armazenamento persistente ─────────────────────────────────
// Prioridade: 1) Railway Volume em /data  2) diretório do app (ephemeral no Railway)
// Para persistência garantida no Railway: adicione um Volume montado em /data
// no dashboard do Railway (Settings → Volumes → Add). Após isso os dados nunca
// se perdem entre restarts ou novos deploys.
function detectarDirDados() {
  const vol = '/data';
  try {
    fs.mkdirSync(vol, { recursive: true });
    const teste = path.join(vol, '.write_test');
    fs.writeFileSync(teste, '1');
    fs.unlinkSync(teste);
    return vol; // Volume montado e gravável
  } catch {
    return __dirname; // Fallback: diretório do app
  }
}
const DATA_DIR      = detectarDirDados();
const DATA_FILE     = path.join(DATA_DIR, 'data.json');
const FISCAL_FILE   = path.join(DATA_DIR, 'fiscal-notas.json');
const USA_VOLUME    = DATA_DIR === '/data'; // true = volume persistente Railway
const FISCAL_TOKEN  = process.env.FISCAL_TOKEN || 'fiscal-sync-2025';

// ── Log ao vivo (aba Conexão) ─────────────────────────────────

const logBuffer = [];          // últimas 300 entradas em memória
const sseClients = new Set();  // clientes SSE conectados

// Cache do count de pedidos com etiqueta (atualizado pela aba Bling, lido pelo dashboard)
const blingPedidosCache = { '1': null, '2': null }; // null = nunca carregado

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
app.use(express.json({ limit: '5mb' }));
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

// Estado do último sync — visível via /api/sync/status
let lastSyncStatus = { ok: null, ts: null, erro: null };

async function syncRailwayEnvVars(_dataIgnorado) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) { addLog('[sync] RAILWAY_TOKEN não configurado — dados não serão persistidos entre restarts', 'warn'); return { ok: false, erro: 'RAILWAY_TOKEN ausente' }; }
  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  if (!projectId || !environmentId || !serviceId) { addLog('[sync] RAILWAY IDs ausentes (PROJECT_ID/ENVIRONMENT_ID/SERVICE_ID)', 'warn'); return { ok: false, erro: 'Railway IDs ausentes' }; }

  // Sempre relê do disco para pegar o estado mais recente, evitando race conditions
  // entre requests concorrentes que poderiam mandar dados antigos pro Railway
  const data = loadData();

  const variables = { ML_CONTA_ATIVA: data.conta_ativa || '1' };
  for (const num of ['1', '2']) {
    const c = data.contas[num] || {};
    if (c.client_id)        variables[`ML_CLIENT_ID_${num}`]        = c.client_id;
    if (c.client_secret)    variables[`ML_CLIENT_SECRET_${num}`]    = c.client_secret;
    if (c.access_token)     variables[`ML_ACCESS_TOKEN_${num}`]     = c.access_token;
    if (c.refresh_token)    variables[`ML_REFRESH_TOKEN_${num}`]    = c.refresh_token;
    if (c.user_id)          variables[`ML_USER_ID_${num}`]          = String(c.user_id);
    if (c.token_expires_at) variables[`ML_TOKEN_EXPIRES_AT_${num}`] = String(c.token_expires_at);
    // Tokens Bling — essenciais para sobreviver a restarts
    const b = data[`bling_${num}`] || (num === '1' ? data.bling : null) || {};
    if (b.access_token)  variables[`BLING_ACCESS_TOKEN_${num}`]  = b.access_token;
    if (b.refresh_token) variables[`BLING_REFRESH_TOKEN_${num}`] = b.refresh_token;
    if (b.expires_at)    variables[`BLING_EXPIRES_AT_${num}`]    = String(b.expires_at);
  }
  // Configuração de lucro (custos + impostos) — por conta
  for (const num of ['1', '2']) {
    const lc = (data.lucro_contas || {})[num];
    if (lc) {
      // Salva custos/imposto sem gastos (evita var muito grande)
      const { gastos: _g, ...lcSemGastos } = lc;
      variables[`LUCRO_CONFIG_${num}`] = JSON.stringify(lcSemGastos);
      // Gastos mensais em var separada — sempre sincroniza
      variables[`GASTOS_DATA_${num}`] = JSON.stringify(lc.gastos || {});
      // Gastos fixos (tipos + valores) — sempre sincroniza
      variables[`GASTOS_FIXOS_TIPOS_${num}`] = JSON.stringify(lc.gastos_fixos_tipos || []);
      variables[`GASTOS_FIXOS_VALS_${num}`]  = JSON.stringify(lc.gastos_fixos_valores || {});
    }
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
    // IDs dos pedidos flagados como atendidos — sempre sincroniza, mesmo vazio,
    // para sobrescrever lista antiga no Railway quando o usuário desmarcar todos
    const sidsAtendidos = ((data.contas[num] || {}).atendidas_dados || []).map(v => String(v.shipmentId));
    variables[`ATENDIDAS_SIDS_${num}`] = JSON.stringify(sidsAtendidos);
    // Contas a pagar — sempre sincroniza
    variables[`CONTAS_PAGAR_${num}`] = JSON.stringify((data.contas_pagar || {})[num] || []);
  }

  // Avisa se alguma variável está muito grande (limite Railway ~32 KB por var)
  for (const [k, v] of Object.entries(variables)) {
    if (typeof v === 'string' && v.length > 28000) {
      addLog(`[sync] ⚠️ Variável ${k} grande (${Math.round(v.length/1024)}KB) — pode falhar no Railway`, 'warn');
    }
  }

  // Retry até 3 vezes com backoff simples
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const resp = await axios.post(
        'https://backboard.railway.app/graphql/v2',
        {
          query: `mutation Upsert($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
          }`,
          variables: { input: { projectId, environmentId, serviceId, variables } },
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      // Railway retorna errors no body mesmo com HTTP 200
      if (resp.data?.errors?.length) {
        const msg = resp.data.errors[0]?.message || 'Erro GraphQL';
        addLog(`[sync] ⚠️ Railway retornou erro (tentativa ${tentativa}/3): ${msg}`, 'warn');
        if (tentativa < 3) { await new Promise(r => setTimeout(r, 2000 * tentativa)); continue; }
        lastSyncStatus = { ok: false, ts: Date.now(), erro: msg };
        return { ok: false, erro: msg };
      }
      addLog(`[sync] ✅ Dados salvos no Railway (tentativa ${tentativa})`, 'ok');
      lastSyncStatus = { ok: true, ts: Date.now(), erro: null };
      return { ok: true };
    } catch (e) {
      addLog(`[sync] ❌ Erro tentativa ${tentativa}/3: ${e.message}`, 'erro');
      if (tentativa < 3) await new Promise(r => setTimeout(r, 2000 * tentativa));
    }
  }
  lastSyncStatus = { ok: false, ts: Date.now(), erro: 'Falha após 3 tentativas' };
  return { ok: false, erro: 'Falha após 3 tentativas' };
}

// ── Sync dedicado e mínimo para Contas a Pagar ────────────────
// Envia APENAS as 2 variáveis CONTAS_PAGAR_1 e CONTAS_PAGAR_2.
// Payload pequeno = muito mais confiável que o sync completo.
async function syncContasPagar() {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) return { ok: false, erro: 'RAILWAY_TOKEN ausente' };
  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  if (!projectId || !environmentId || !serviceId) return { ok: false, erro: 'Railway IDs ausentes' };

  const data = loadData();
  const variables = {};
  for (const num of ['1', '2']) {
    variables[`CONTAS_PAGAR_${num}`] = JSON.stringify((data.contas_pagar || {})[num] || []);
  }

  const payloadKB = Math.round(JSON.stringify(variables).length / 1024);
  addLog(`[sync-cp] Sincronizando contas a pagar (${payloadKB}KB)…`, 'info');

  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    try {
      const resp = await axios.post(
        'https://backboard.railway.app/graphql/v2',
        {
          query: `mutation Upsert($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
          }`,
          variables: { input: { projectId, environmentId, serviceId, variables } },
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
      );
      if (resp.data?.errors?.length) {
        const msg = resp.data.errors[0]?.message || 'Erro GraphQL';
        addLog(`[sync-cp] ⚠️ Railway erro (tentativa ${tentativa}/5): ${msg}`, 'warn');
        if (tentativa < 5) { await new Promise(r => setTimeout(r, 5000)); continue; }
        lastSyncStatus = { ok: false, ts: Date.now(), erro: msg };
        return { ok: false, erro: msg };
      }
      addLog(`[sync-cp] ✅ Contas a pagar salvas no Railway (tentativa ${tentativa})`, 'ok');
      lastSyncStatus = { ok: true, ts: Date.now(), erro: null };
      return { ok: true };
    } catch (e) {
      addLog(`[sync-cp] ❌ Erro tentativa ${tentativa}/5: ${e.message}`, 'erro');
      if (tentativa < 5) await new Promise(r => setTimeout(r, 5000));
    }
  }
  lastSyncStatus = { ok: false, ts: Date.now(), erro: 'Falha após 5 tentativas' };
  return { ok: false, erro: 'Falha após 5 tentativas' };
}

// ── Fila de sync em background ─────────────────────────────────
// Os endpoints escrevem no disco e chamam agendarSyncContasPagar()
// sem await — a resposta HTTP volta imediatamente. O sync acontece
// em background e continua tentando enquanto houver falhas.
let _syncCpPendente = false;
let _syncCpRodando  = false;

function agendarSyncContasPagar() {
  _syncCpPendente = true;
  if (_syncCpRodando) return; // já tem um rodando, ele vai pegar o pendente
  _executarFilaSyncCp();
}

async function _executarFilaSyncCp() {
  _syncCpRodando = true;
  while (_syncCpPendente) {
    _syncCpPendente = false;
    await syncContasPagar().catch(() => {});
    // Se sync falhou, agenda retry em 15 segundos
    if (!lastSyncStatus.ok) {
      await new Promise(r => setTimeout(r, 15000));
      _syncCpPendente = true; // tenta de novo
    }
  }
  _syncCpRodando = false;
}

// Sync periódico de segurança: a cada 3 minutos garante que Railway tem o estado atual
setInterval(() => {
  agendarSyncContasPagar();
  syncRailwayEnvVars().catch(() => {});
}, 3 * 60 * 1000);

function initFromEnvVars() {
  // Se estiver usando Volume Railway E o arquivo já existir, o Volume é a fonte de verdade.
  // Não sobrescrever com env vars que podem estar desatualizadas.
  if (USA_VOLUME && fs.existsSync(DATA_FILE)) {
    addLog(`[init] Volume persistente em uso (${DATA_FILE}) — dados preservados do restart anterior ✅`, 'ok');
    return;
  }
  if (USA_VOLUME) {
    addLog('[init] Volume Railway montado, mas sem dados salvos ainda — restaurando de env vars pela primeira vez', 'info');
  }

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
    // Restaura tokens Bling da conta
    const bKey = `bling_${num}`;
    const bExistente = data[bKey] || (num === '1' ? data.bling : null);
    if (!bExistente?.access_token && process.env[`BLING_ACCESS_TOKEN_${num}`]) {
      const bRestored = {
        access_token:  process.env[`BLING_ACCESS_TOKEN_${num}`],
        refresh_token: process.env[`BLING_REFRESH_TOKEN_${num}`] || '',
        expires_at:    parseInt(process.env[`BLING_EXPIRES_AT_${num}`]) || 0,
      };
      data[bKey] = bRestored;
      if (num === '1') data.bling = bRestored;
      changed = true;
    }
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

  // Configuração de lucro
  data.lucro_contas = data.lucro_contas || {};
  for (const num of ['1', '2']) {
    if (!data.lucro_contas[num] && process.env[`LUCRO_CONFIG_${num}`]) {
      try { data.lucro_contas[num] = JSON.parse(process.env[`LUCRO_CONFIG_${num}`]); changed = true; } catch {}
    }
    // Gastos mensais — Railway é fonte verdade (sempre sobrescreve)
    if (process.env[`GASTOS_DATA_${num}`] !== undefined) {
      try {
        data.lucro_contas[num] = data.lucro_contas[num] || {};
        data.lucro_contas[num].gastos = JSON.parse(process.env[`GASTOS_DATA_${num}`]);
        changed = true;
      } catch {}
    }
    // Gastos fixos (tipos + valores) — Railway é fonte verdade (sempre sobrescreve)
    if (process.env[`GASTOS_FIXOS_TIPOS_${num}`] !== undefined) {
      try {
        data.lucro_contas[num] = data.lucro_contas[num] || {};
        data.lucro_contas[num].gastos_fixos_tipos = JSON.parse(process.env[`GASTOS_FIXOS_TIPOS_${num}`]);
        changed = true;
      } catch {}
    }
    if (process.env[`GASTOS_FIXOS_VALS_${num}`] !== undefined) {
      try {
        data.lucro_contas[num] = data.lucro_contas[num] || {};
        data.lucro_contas[num].gastos_fixos_valores = JSON.parse(process.env[`GASTOS_FIXOS_VALS_${num}`]);
        changed = true;
      } catch {}
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

    // Restaura IDs de pedidos atendidos — Railway é fonte verdade (sempre sobrescreve)
    if (process.env[`ATENDIDAS_SIDS_${num}`] !== undefined) {
      try {
        const c2 = data.contas[num] || {};
        const sids = JSON.parse(process.env[`ATENDIDAS_SIDS_${num}`]);
        c2.atendidas_dados = sids.map(sid => ({ shipmentId: sid, atendida: true, atendidaEm: null }));
        data.contas[num] = c2;
        changed = true;
      } catch {}
    }
    // Restaura contas a pagar — Railway é fonte verdade (sempre sobrescreve)
    if (process.env[`CONTAS_PAGAR_${num}`] !== undefined) {
      try {
        data.contas_pagar = data.contas_pagar || {};
        data.contas_pagar[num] = JSON.parse(process.env[`CONTAS_PAGAR_${num}`]);
        changed = true;
      } catch {}
    }
  }

  if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

initFromEnvVars();

// Evita crash do processo por promessas não tratadas (ex: falha de rede em polling)
process.on('unhandledRejection', (reason) => {
  addLog(`[unhandledRejection] ${reason?.message || reason}`, 'warn');
});
process.on('uncaughtException', (err) => {
  addLog(`[uncaughtException] ${err.message}`, 'erro');
});
// SIGTERM = Railway parando o container para novo deploy — sai com código 0 (sem email de crash)
process.on('SIGTERM', () => process.exit(0));

// Log de diagnóstico na inicialização
(function logStartupState() {
  const data = loadData();
  const railwayOk = !!(process.env.RAILWAY_TOKEN && process.env.RAILWAY_PROJECT_ID);
  addLog(`🚀 Servidor iniciado`, 'info');
  addLog(`Armazenamento: ${USA_VOLUME ? '✅ Volume Railway em /data (persistente)' : '⚠️ Diretório do app (ephemeral — dados perdidos em restart)'}`, USA_VOLUME ? 'ok' : 'warn');
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
  for (const num of ['1', '2']) {
    const b = data[`bling_${num}`] || (num === '1' && data.bling) || null;
    if (b?.access_token) {
      const min = b.expires_at ? Math.round((b.expires_at - Date.now()) / 60000) : null;
      addLog(`Bling Conta ${num}: conectado, expira em ${min ?? '?'} min`, 'ok');
    } else {
      addLog(`Bling Conta ${num}: não conectado`, 'warn');
    }
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
    + `&scope=offline_access+read_listings+write_listings+read_orders+write_orders+read_shipping+write_shipping+read_product_ads+seller_promotions+read_billing`;
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

// ── Pesquisa de mercado ML ────────────────────────────────────
app.get('/api/ml/pesquisa', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ erro: 'Termo de busca obrigatório' });

  try {
    const data = loadData();
    let tok = null;
    for (const num of ['1', '2']) {
      tok = await getToken(data, num).catch(() => null);
      if (tok) break;
    }

    const resp = await axios.get('https://api.mercadolibre.com/sites/MLB/search', {
      params: { q, limit: 50, sort: 'sold_quantity', ...(tok ? { access_token: tok } : {}) },
      timeout: 15000,
    });

    const total  = resp.data?.paging?.total ?? 0;
    const itens  = resp.data?.results || [];

    const precos = itens.map(i => i.price).filter(p => p > 0);
    const soma   = precos.reduce((a, b) => a + b, 0);
    const stats  = {
      total,
      retornados: itens.length,
      precoMedio: precos.length ? soma / precos.length : 0,
      precoMin:   precos.length ? Math.min(...precos) : 0,
      precoMax:   precos.length ? Math.max(...precos) : 0,
      totalVendas: itens.reduce((a, i) => a + (i.sold_quantity || 0), 0),
    };

    const produtos = itens.map((i, idx) => ({
      rank:        idx + 1,
      id:          i.id,
      titulo:      i.title,
      preco:       i.price,
      moeda:       i.currency_id,
      vendas:      i.sold_quantity || 0,
      estoque:     i.available_quantity || 0,
      condicao:    i.condition,
      vendedor:    i.seller?.nickname || '—',
      fretegratis: !!i.shipping?.free_shipping,
      fulfillment: i.shipping?.logistic_type === 'fulfillment',
      link:        i.permalink,
      thumb:       i.thumbnail,
    }));

    res.json({ stats, produtos });
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}`
      : err.message;
    res.status(500).json({ erro: detail });
  }
});

// ── Dashboard: resumo geral ───────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  const data  = loadData();
  const contas = ['1', '2'];

  async function blingResumo(conta) {
    try {
      const token = await getBlingToken(conta);
      const rNotas = await axios.get('https://www.bling.com.br/Api/v3/nfe', {
        headers: { Authorization: `Bearer ${token}` },
        params: { pagina: 1, limite: 100 }, timeout: 10000,
      }).catch(() => null);
      const notas = (rNotas?.data?.data || []).filter(n => n.situacao === 1);

      // Usa cache da aba Bling se disponível (count filtrado por ML); senão conta bruto
      let pedidos;
      if (blingPedidosCache[conta] !== null) {
        pedidos = blingPedidosCache[conta].count;
      } else {
        const rPedidos = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
          headers: { Authorization: `Bearer ${token}` },
          params: { pagina: 1, limite: 100, idSituacao: 6 }, timeout: 10000,
        }).catch(() => null);
        pedidos = (rPedidos?.data?.data || []).length;
      }

      return { pedidos, notas: notas.length };
    } catch { return { pedidos: 0, notas: 0 }; }
  }

  async function mlResumo(conta) {
    try {
      const tok = await getToken(data, conta);
      const c   = data.contas[conta];
      if (!c?.user_id) {
        const me = await axios.get('https://api.mercadolibre.com/users/me', {
          headers: { Authorization: `Bearer ${tok}` }, timeout: 8000,
        }).catch(() => null);
        if (me?.data?.id) { c.user_id = me.data.id; saveData(data); }
      }
      const uid = c?.user_id;
      const hoje   = new Date(); hoje.setHours(0,0,0,0);
      const semana = new Date(hoje); semana.setDate(semana.getDate() - semana.getDay());

      const [rPerguntas, rReclamacoes, rVendasHoje, rVendasSemana] = await Promise.all([
        axios.get('https://api.mercadolibre.com/my/questions/search', {
          headers: { Authorization: `Bearer ${tok}` },
          params: { role: 'SELLER', status: 'UNANSWERED', limit: 1 }, timeout: 8000,
        }).catch(() => null),
        axios.get('https://api.mercadolibre.com/post/v2/claims', {
          headers: { Authorization: `Bearer ${tok}` },
          params: { role: 'respondent', status: 'opened', limit: 1 }, timeout: 8000,
        }).catch(() => null),
        uid ? axios.get('https://api.mercadolibre.com/orders/search', {
          headers: { Authorization: `Bearer ${tok}` },
          params: { seller: uid, 'order.status': 'paid', 'order.date_created.from': hoje.toISOString(), limit: 1 }, timeout: 8000,
        }).catch(() => null) : null,
        uid ? axios.get('https://api.mercadolibre.com/orders/search', {
          headers: { Authorization: `Bearer ${tok}` },
          params: { seller: uid, 'order.status': 'paid', 'order.date_created.from': semana.toISOString(), limit: 1 }, timeout: 8000,
        }).catch(() => null) : null,
      ]);

      return {
        perguntas:    rPerguntas?.data?.total  ?? rPerguntas?.data?.questions?.length ?? 0,
        reclamacoes:  rReclamacoes?.data?.paging?.total ?? 0,
        vendasHoje:   rVendasHoje?.data?.paging?.total  ?? 0,
        vendasSemana: rVendasSemana?.data?.paging?.total ?? 0,
      };
    } catch { return { perguntas: 0, reclamacoes: 0, vendasHoje: 0, vendasSemana: 0 }; }
  }

  function contasPagarResumo() {
    try {
      const hoje    = new Date(); hoje.setHours(0,0,0,0);
      const amanha  = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
      const semana  = new Date(hoje); semana.setDate(semana.getDate() + 7);
      let vencidas = 0, venceHoje = 0, venceSemana = 0;
      for (const num of contas) {
        const cp = (data.contas_pagar || {})[num] || [];
        for (const c of cp) {
          if (c.pago) continue;
          const venc = new Date(c.vencimento + 'T00:00:00');
          if (venc < hoje)   vencidas++;
          else if (venc < amanha) venceHoje++;
          else if (venc < semana) venceSemana++;
        }
      }
      return { vencidas, venceHoje, venceSemana };
    } catch { return { vencidas: 0, venceHoje: 0, venceSemana: 0 }; }
  }

  const [bling1, bling2, ml1, ml2, cp] = await Promise.all([
    blingResumo('1'), blingResumo('2'),
    mlResumo('1'),    mlResumo('2'),
    Promise.resolve(contasPagarResumo()),
  ]);

  res.json({
    bling: { '1': bling1, '2': bling2 },
    ml:    { '1': ml1,    '2': ml2    },
    contasPagar: cp,
    ts: Date.now(),
  });
});

// ── Bling OAuth v3 ────────────────────────────────────────────

// Helper: retorna dados bling da conta (com fallback legado para conta 1)
function getBlingDataConta(data, conta) {
  return data[`bling_${conta}`] || (conta === '1' ? data.bling : null) || null;
}

// Helper: retorna client_id e client_secret da conta correta
function getBlingCreds(conta) {
  if (conta === '2' && BLING_CLIENT_ID_2 && BLING_CLIENT_SECRET_2)
    return { id: BLING_CLIENT_ID_2, secret: BLING_CLIENT_SECRET_2 };
  return { id: BLING_CLIENT_ID, secret: BLING_CLIENT_SECRET };
}

// Inicia o fluxo OAuth — redireciona para o Bling
// ?conta=1 ou ?conta=2 define qual conta será vinculada
app.get('/api/bling/auth', (req, res) => {
  const conta = req.query.conta || '1';
  const { id: clientId } = getBlingCreds(conta);
  if (!clientId) return res.redirect('/app.html?tab=conexao&bling_error=sem_client_id');
  const state = `${conta}_${Math.random().toString(36).slice(2)}`;
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize`
    + `?response_type=code`
    + `&client_id=${clientId}`
    + `&state=${state}`;
  addLog(`[bling] OAuth iniciado, conta=${conta}, state=${state}`, 'info');
  res.redirect(url);
});

// Recebe o code e troca pelo access_token
app.get('/api/bling/callback', async (req, res) => {
  addLog(`[bling] callback recebido: ${JSON.stringify(req.query)}`, 'info');
  const { code, error, state } = req.query;
  const conta = state?.split('_')[0] || '1';
  if (error || !code) {
    addLog(`[bling] callback sem code: error=${error}`, 'warn');
    return res.redirect(`/app.html?tab=conexao&bling_error=${encodeURIComponent(error || 'sem_code')}`);
  }
  const { id: clientId, secret: clientSecret } = getBlingCreds(conta);
  if (!clientId || !clientSecret)
    return res.redirect('/app.html?tab=conexao&bling_error=sem_credenciais');

  const proto    = req.get('x-forwarded-proto') || req.protocol;
  const callback = `${proto}://${req.get('host')}/api/bling/callback`;
  const creds    = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const resp = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callback }),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    const data = loadData();
    const token = {
      access_token:  resp.data.access_token,
      refresh_token: resp.data.refresh_token,
      expires_at:    Date.now() + ((resp.data.expires_in || 21600) - 300) * 1000,
    };
    data[`bling_${conta}`] = token;
    if (conta === '1') data.bling = token; // compatibilidade legada
    saveData(data);
    addLog(`[bling] ✅ Token conta ${conta} obtido e salvo`, 'ok');
    res.redirect(`/app.html?tab=conexao&bling_connected=true&bling_conta=${conta}`);
  } catch (err) {
    const detalhe = JSON.stringify(err.response?.data || err.message);
    addLog(`[bling] ❌ Erro no token exchange: ${detalhe}`, 'erro');
    res.redirect(`/app.html?tab=conexao&bling_error=${encodeURIComponent(detalhe)}`);
  }
});

// Renova o access_token usando o refresh_token
async function blingRefreshToken(conta) {
  const data = loadData();
  const b = getBlingDataConta(data, conta);
  if (!b?.refresh_token) throw new Error(`Sem refresh_token do Bling (conta ${conta})`);
  const { id: clientId, secret: clientSecret } = getBlingCreds(conta);
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp  = await axios.post(
    'https://www.bling.com.br/Api/v3/oauth/token',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: b.refresh_token }),
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  const updated = {
    access_token:  resp.data.access_token,
    refresh_token: resp.data.refresh_token || b.refresh_token,
    expires_at:    Date.now() + ((resp.data.expires_in || 21600) - 300) * 1000,
  };
  data[`bling_${conta}`] = updated;
  if (conta === '1') data.bling = updated;
  saveData(data);
  addLog(`[bling] 🔄 Token conta ${conta} renovado`, 'ok');
  return updated.access_token;
}

// Retorna token válido, renovando se necessário
async function getBlingToken(conta) {
  const data = loadData();
  const b = getBlingDataConta(data, conta);
  if (!b?.access_token) throw new Error(`Bling conta ${conta} não conectado`);
  if (Date.now() >= (b.expires_at || 0)) return blingRefreshToken(conta);
  return b.access_token;
}

// Helper: retorna a conta bling a usar para um request (query param ou conta_ativa)
function blingContaReq(req) {
  const data = loadData();
  return req.query.conta || data.conta_ativa || '1';
}

// Status de conexão — retorna status das duas contas
app.get('/api/bling/status', async (req, res) => {
  if (!BLING_CLIENT_ID) return res.json({ '1': { connected: false, erro: 'BLING_CLIENT_ID não configurado' }, '2': { connected: false } });
  const data = loadData();
  const result = {};
  for (const c of ['1', '2']) {
    const b = getBlingDataConta(data, c);
    if (!b?.access_token) { result[c] = { connected: false }; continue; }
    try {
      await getBlingToken(c);
      result[c] = { connected: true };
    } catch (err) {
      result[c] = { connected: false, erro: err.message };
    }
  }
  return res.json(result);
});

// ── Bling: pedidos de venda com situação "Em aberto" ─────────
// situacao 6 = Em aberto no Bling v3

app.get('/api/bling/pedidos-pendentes', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const token = await getBlingToken(conta);

    // Lista pedidos Em aberto com rastreamento pendente de etiqueta
    const resp = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina: 1, limite: 100, idSituacao: 6, rastreamento: 8 },
      timeout: 15000,
    });
    const itens = resp.data?.data || [];
    addLog(`[bling] ${itens.length} pedidos encontrados`, 'info');

    // Busca detalhe de cada pedido para obter o numeroLoja correto (lista retorna ID diferente)
    // Tenta até 3 vezes antes de desistir e usar o valor da lista
    const itensDetalhados = [];
    for (const p of itens) {
      let numeroLojaCorreto = null;
      for (let tentativa = 0; tentativa < 3 && !numeroLojaCorreto; tentativa++) {
        if (tentativa > 0) await new Promise(r => setTimeout(r, 600 * tentativa));
        numeroLojaCorreto = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
        }).then(r => r.data?.data?.numeroLoja || null).catch(() => null);
      }
      itensDetalhados.push({ ...p, numeroLoja: numeroLojaCorreto || p.numeroLoja });
    }

    // Verifica no ML quais têm shipment ready_to_ship (etiqueta disponível ao emitir NF)
    const mlData = loadData();
    const mlTokens = (await Promise.all(
      ['1', '2'].map(c => getToken(mlData, c).catch(() => null))
    )).filter(Boolean);

    const idsComEtiqueta = new Set();
    if (mlTokens.length > 0) {
      const mlOrders = await Promise.all(
        itensDetalhados.map(async p => {
          if (!p.numeroLoja) return null;
          for (const tok of mlTokens) {
            const res = await axios.get(`https://api.mercadolibre.com/orders/${p.numeroLoja}`, {
              headers: { Authorization: `Bearer ${tok}` }, timeout: 6000,
            }).catch(() => null);
            if (res?.data?.shipping?.id) return { blingId: p.id, shippingId: res.data.shipping.id, tok };
          }
          return null;
        })
      );
      const shippingEntries = mlOrders.filter(o => o?.shippingId);
      const shipments = await Promise.all(
        shippingEntries.map(o =>
          axios.get(`https://api.mercadolibre.com/shipments/${o.shippingId}`, {
            headers: { Authorization: `Bearer ${o.tok}` }, timeout: 6000,
          }).then(r => ({ blingId: o.blingId, status: r.data?.status, substatus: r.data?.substatus })).catch(() => null)
        )
      );
      shipments.filter(Boolean).forEach(s => {
        addLog(`[bling] shipment ${s.blingId}: ${s.status}/${s.substatus}`, 'info');
        if (s?.status === 'ready_to_ship' && s?.substatus === 'invoice_pending') idsComEtiqueta.add(s.blingId);
      });
      addLog(`[bling] ${idsComEtiqueta.size}/${itens.length} com etiqueta disponível`, 'info');
    }

    // Atualiza cache para o dashboard
    blingPedidosCache[conta] = { count: idsComEtiqueta.size, ts: Date.now() };

    const pedidos = itensDetalhados.map(p => ({
      id:               p.id,
      numero:           p.numero || '—',
      comprador:        p.contato?.nome || '—',
      valor_total:      p.totalProdutos || 0,
      data:             p.data,
      situacao:         p.situacao?.valor || 'Em aberto',
      numeroPedidoLoja: p.numeroLoja || null,
      dataPrevista:     p.dataPrevista || null,
      temEtiqueta:      mlTokens.length > 0 ? idsComEtiqueta.has(p.id) : true,
    }));

    pedidos.sort((a, b) => (b.temEtiqueta ? 1 : 0) - (a.temEtiqueta ? 1 : 0));

    return res.json({ pedidos });
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
    addLog(`[bling] pedidos-pendentes: ${detail}`, 'warn');
    return res.json({ erro: detail });
  }
});

// ── Bling: notas pendentes de envio ──────────────────────────

app.get('/api/bling/notas-pendentes', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const token = await getBlingToken(conta);
    const resp  = await axios.get('https://www.bling.com.br/Api/v3/nfe', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina: 1, limite: 100 },
      timeout: 15000,
    });
    const nfs = resp.data?.data || [];
    // situacao=1: pendente/digitação; situacao=5: autorizada — mostrar só pendentes
    const notas = nfs
      .filter(n => n.situacao === 1)
      .map(n => ({
        id:           n.id,
        numero:       n.numero || '—',
        destinatario: n.contato?.nome || '—',
        valor_total:  n.totalProdutos || 0,
        situacao:     'Pendente',
        data:         n.dataEmissao || n.data,
      }));
    return res.json({ notas });
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
    addLog(`[bling] notas-pendentes: ${detail}`, 'warn');
    return res.json({ erro: detail });
  }
});

// ── Bling: emitir NF para pedido ML ──────────────────────────

app.post('/api/bling/emitir-nf/:pedidoId', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const token = await getBlingToken(conta);
    const { pedidoId } = req.params;
    const resp = await axios.post(
      `https://www.bling.com.br/Api/v3/pedidos/vendas/${pedidoId}/gerar-nfe`,
      {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const nfId = resp.data?.data?.id;
    addLog(`[bling] NF gerada para pedido ${pedidoId} — NF id=${nfId}`, 'ok');
    return res.json({ ok: true, nfId });
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    addLog(`[bling] emitir-nf pedido ${req.params.pedidoId}: ${detail}`, 'warn');
    return res.json({ ok: false, erro: detail });
  }
});

// ── Bling: enviar NF (transmitir para SEFAZ) ──────────────────

app.post('/api/bling/enviar-nf/:notaId', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const token = await getBlingToken(conta);
    const { notaId } = req.params;
    await axios.post(`https://www.bling.com.br/Api/v3/nfe/${notaId}/enviar`, {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    addLog(`[bling] NF ${notaId} enviada para SEFAZ`, 'ok');
    return res.json({ ok: true });
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    addLog(`[bling] enviar-nf: ${detail}`, 'warn');
    return res.json({ ok: false, erro: detail });
  }
});

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
          if (!pauseDates[mlb]) {
            pauseDates[mlb] = agora;
            pauseChanged = true;
            // Notifica Telegram quando anúncio é pausado pela primeira vez
            const titulo = r.body.title || mlb;
            const conta  = (data.contas[num] || {}).nickname || `Conta ${num}`;
            notificar(`⏸ <b>Anúncio pausado — ${conta}</b>\n\n${titulo}\n<code>${mlb}</code>`).catch(() => {});
          }
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
    // Busca diretamente por status do envio — evita varrer todos os pedidos pagos
    const todasOrdens = [];
    for (const shippingStatus of ['handling', 'ready_to_ship']) {
      let offset = 0;
      const limit = 50;
      while (true) {
        const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
          params: {
            seller:            c.user_id,
            'order.status':    'paid',
            'shipping.status': shippingStatus,
            sort:              'date_desc',
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
    }

    // Filtra ordens com shipment direto, excluindo Full
    const comShipment = todasOrdens.filter(o =>
      o.shipping && o.shipping.id &&
      o.shipping.logistic_type !== 'fulfillment' &&
      o.shipping.mode !== 'fulfillment'
    );

    // Orders de pack sem shipping próprio — busca o shipping pelo pack
    const semShipmentComPack = todasOrdens.filter(o =>
      o.pack_id && !(o.shipping && o.shipping.id)
    );
    const packsVistos = new Set();
    for (const o of semShipmentComPack) {
      const packId = o.pack_id;
      if (packsVistos.has(packId)) continue;
      packsVistos.add(packId);
      try {
        const rPack = await axios.get(
          `https://api.mercadolibre.com/packs/${packId}`,
          { headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 8000 }
        );
        const pack = rPack.data;
        if (pack.shipment?.id) {
          // Associa o shipping do pack à primeira order do pack que temos
          o.shipping = { id: pack.shipment.id };
          comShipment.push(o);
        }
      } catch {}
    }

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
    const atendidasMap = new Map((c.atendidas_dados || []).map(v => [String(v.shipmentId), v]));

    // Pendentes: da API, excluindo os já atendidos
    const pendentes = [...porShipment.values()]
      .filter(v => !atendidasMap.has(String(v.shipmentId)))
      .map(v => ({ ...v, atendida: false }));

    // Atualiza atendidos que ainda estão na API; remove os que saíram (já enviados)
    atendidasMap.forEach((salvo, sid) => {
      if (porShipment.has(sid)) {
        atendidasMap.set(sid, { ...porShipment.get(sid), atendida: true });
      } else {
        atendidasMap.delete(sid); // saiu da API — remove para não mostrar com dados indefinidos
      }
    });

    // Persiste a limpeza caso algum atendido tenha sido removido
    const novaLista = [...atendidasMap.values()];
    if (novaLista.length !== (c.atendidas_dados || []).length) {
      c.atendidas_dados = novaLista;
      saveData(data);
    }

    const atendidas = novaLista.map(v => ({ ...v, atendida: true }));
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

// Marca ou desmarca vários pedidos como atendidos de uma vez e aguarda sync Railway
app.post('/api/vendas/atendidas-batch', async (req, res) => {
  const { shipmentIds, vendasDados } = req.body;
  if (!Array.isArray(shipmentIds) || !shipmentIds.length) return res.status(400).json({ error: 'shipmentIds obrigatório' });
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c) return res.json({ error: 'Conta não encontrada' });
  if (!c.atendidas_dados) c.atendidas_dados = [];
  const agora = new Date().toISOString();
  shipmentIds.forEach(shipmentId => {
    const sid       = String(shipmentId);
    const existente = c.atendidas_dados.find(v => String(v.shipmentId) === sid);
    const venda     = (vendasDados || {})[sid] || existente || null;
    c.atendidas_dados = c.atendidas_dados.filter(v => String(v.shipmentId) !== sid);
    if (venda) c.atendidas_dados.push({ ...venda, atendida: true, atendidaEm: existente?.atendidaEm || agora });
    else       c.atendidas_dados.push({ shipmentId: sid, atendida: true, atendidaEm: agora });
  });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[atendidas-batch] sync erro:', e.message));
  res.json({ ok: true });
});

app.delete('/api/vendas/atendidas-batch', async (req, res) => {
  const { shipmentIds } = req.body;
  if (!Array.isArray(shipmentIds) || !shipmentIds.length) return res.status(400).json({ error: 'shipmentIds obrigatório' });
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c) return res.json({ error: 'Conta não encontrada' });
  const sids = new Set(shipmentIds.map(String));
  c.atendidas_dados = (c.atendidas_dados || []).filter(v => !sids.has(String(v.shipmentId)));
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[atendidas-batch-del] sync erro:', e.message));
  res.json({ ok: true });
});


// ── Promoções ──────────────────────────────────────────────────

// Debug temporário — testa vários endpoints possíveis de promoções ML
app.get('/api/ml/promocoes/debug', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  const h = { Authorization: `Bearer ${c.access_token}` };
  const uid = c.user_id;

  async function testar(url, params = {}) {
    try {
      const r = await axios.get(url, { params, headers: h, timeout: 8000 });
      return { status: r.status, ct: r.headers['content-type'], data: r.data };
    } catch (e) {
      return { status: e.response?.status, error: e.response?.data || e.message };
    }
  }

  const r = {};
  // seller-promotions sem seller_id (usa token para identificar)
  r['seller-promotions/promotions-sem-seller_id'] = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { status: 'candidate', limit: 5 });
  r['seller-promotions/promotions?candidate']     = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, status: 'candidate', limit: 5 });
  r['seller-promotions/promotions?started']       = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, status: 'started', limit: 5 });
  r['seller-promotions/promotions?paused']        = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, status: 'paused', limit: 5 });
  r['seller-promotions/promotions?finished']      = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, status: 'finished', limit: 5 });
  // variações com site_id
  r['seller-promotions/promotions?site=MLB']      = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, site_id: 'MLB', limit: 5 });
  // users/{id}/seller-promotions
  r['users/{id}/seller-promotions']               = await testar(`https://api.mercadolibre.com/users/${uid}/seller-promotions`, { limit: 5 });
  // campaings
  r['seller-promotions/campaigns']                = await testar(`https://api.mercadolibre.com/seller-promotions/campaigns`, { seller_id: uid, limit: 5 });

  res.json({ user_id: uid, r });
});

app.get('/api/ml/promocoes', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)      return res.json({ error: 'user_id não encontrado' });

  const headers = { Authorization: `Bearer ${c.access_token}` };

  try {
    // Busca promoções disponíveis — tenta candidate primeiro, depois started
    let promocoes = [];
    for (const status of ['candidate', 'started']) {
      try {
        const rPromo = await axios.get('https://api.mercadolibre.com/seller-promotions/promotions', {
          params: { seller_id: c.user_id, status, limit: 50 },
          headers, timeout: 15000,
        });
        const lista = rPromo.data.results || (Array.isArray(rPromo.data) ? rPromo.data : []);
        promocoes = promocoes.concat(lista);
      } catch {}
    }
    if (!promocoes.length) return res.json({ promocoes: [] });

    // Para cada promoção, busca os itens elegíveis
    const resultado = await Promise.all(
      promocoes.map(async (promo) => {
        try {
          const rItens = await axios.get('https://api.mercadolibre.com/seller-promotions/items', {
            params: { promotion_id: promo.id, seller_id: c.user_id, limit: 100 },
            headers,
            timeout: 12000,
          });
          const itens = rItens.data.results || rItens.data || [];

          // Busca thumbnail/SKU/título dos itens (em lote)
          const mlbs = [...new Set(itens.map(i => i.item_id || i.id).filter(Boolean))];
          const itemMap = {};
          for (let i = 0; i < mlbs.length; i += 20) {
            const chunk = mlbs.slice(i, i + 20);
            try {
              const r = await axios.get('https://api.mercadolibre.com/items', {
                params:  { ids: chunk.join(','), attributes: 'id,title,thumbnail,price,seller_custom_field,permalink' },
                headers,
                timeout: 10000,
              });
              for (const entry of r.data) {
                if (entry.code === 200) {
                  const b = entry.body;
                  itemMap[b.id] = { titulo: b.title, thumbnail: b.thumbnail?.replace(/-[A-Z]\.jpg/, '-O.jpg') || null, preco: b.price, sku: b.seller_custom_field || null, permalink: b.permalink };
                }
              }
            } catch {}
          }

          return {
            id:          promo.id,
            nome:        promo.name || promo.type || promo.id,
            tipo:        promo.type || '—',
            inicio:      promo.start_date || null,
            fim:         promo.finish_date || null,
            status:      promo.status || '—',
            itens:       itens.map(i => {
              const mlb  = i.item_id || i.id;
              const info = itemMap[mlb] || {};
              return {
                mlb,
                titulo:         info.titulo    || i.title || '—',
                thumbnail:      info.thumbnail || null,
                sku:            info.sku       || '—',
                permalink:      info.permalink || null,
                precoAtual:     info.preco     ?? i.price ?? null,
                precoSugerido:  i.suggested_price ?? i.price_action?.suggested_price ?? null,
                descontoMin:    i.min_discount_percentage ?? null,
                descontoMax:    i.max_discount_percentage ?? null,
                participando:   i.status === 'active' || i.status === 'started',
              };
            }),
          };
        } catch {
          return { id: promo.id, nome: promo.name || promo.id, tipo: promo.type || '—', itens: [] };
        }
      })
    );

    res.json({ promocoes: resultado });
  } catch (err) {
    console.error('Promoções:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar promoções: ' + (err.response?.data?.message || err.message) });
  }
});

app.post('/api/ml/promocoes/participar', async (req, res) => {
  const { mlb, promotion_id, preco } = req.body;
  if (!mlb || !promotion_id) return res.json({ error: 'mlb e promotion_id obrigatórios' });
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  try {
    const body = { promotion_id };
    if (preco != null) body.price = preco;
    const r = await axios.post(
      `https://api.mercadolibre.com/seller-promotions/items/${mlb}`,
      body,
      { headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 10000 }
    );
    res.json({ ok: true, data: r.data });
  } catch (err) {
    res.json({ error: err.response?.data?.message || err.message, detail: err.response?.data });
  }
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


// ── Rotas: Lucro ─────────────────────────────────────────────

app.get('/api/lucro/config', (req, res) => {
  const data  = loadData();
  const num   = req.query.conta || data.conta_ativa;
  const lc    = (data.lucro_contas || {})[num] || {};
  res.json({
    taxa_imposto: lc.taxa_imposto ?? 0,
    frete_medio:  lc.frete_medio  ?? 0,
    custos:       lc.custos       || {},
  });
});

app.post('/api/lucro/config', async (req, res) => {
  const { conta, taxa_imposto, frete_medio } = req.body;
  const num = String(conta || '1');
  if (!['1','2'].includes(num)) return res.status(400).json({ error: 'Conta inválida' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  if (taxa_imposto !== undefined) lc.taxa_imposto = parseFloat(taxa_imposto) || 0;
  if (frete_medio  !== undefined) lc.frete_medio  = parseFloat(frete_medio)  || 0;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[lucro/config] sync erro:', e.message));
  res.json({ ok: true });
});

app.post('/api/lucro/custo', async (req, res) => {
  const { conta, sku, custo } = req.body;
  const num = String(conta || '1');
  if (!sku) return res.status(400).json({ error: 'sku obrigatório' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.custos = lc.custos || {};
  lc.custos[sku] = parseFloat(custo) || 0;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[lucro/custo] sync erro:', e.message));
  res.json({ ok: true });
});

// ── Gastos mensais ───────────────────────────────────────────
app.get('/api/lucro/gastos', (req, res) => {
  const data = loadData();
  const num  = String(req.query.conta || data.conta_ativa || '1');
  const mes  = req.query.mes || new Date().toISOString().slice(0, 7);
  const lc   = (data.lucro_contas || {})[num] || {};
  res.json({
    gastos:      (lc.gastos      || {})[mes] || [],
    coleta_full: (lc.coleta_full || {})[mes] ?? 0,
  });
});

// ── Gastos fixos (recorrentes) ────────────────────────────────
// Tipos: lista de nomes salvos globalmente por conta
// Valores: { mes: { nome: valor } } por conta

app.get('/api/lucro/gastos-fixos', (req, res) => {
  const data = loadData();
  const num  = String(req.query.conta || data.conta_ativa || '1');
  const mes  = req.query.mes || new Date().toISOString().slice(0, 7);
  const lc   = (data.lucro_contas || {})[num] || {};
  res.json({
    tipos:   lc.gastos_fixos_tipos   || [],
    valores: (lc.gastos_fixos_valores || {})[mes] || {},
  });
});

// Adiciona tipo
app.post('/api/lucro/gastos-fixo-tipo', async (req, res) => {
  const { conta, nome } = req.body;
  const num = String(conta || '1');
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.gastos_fixos_tipos = lc.gastos_fixos_tipos || [];
  if (!lc.gastos_fixos_tipos.includes(nome.trim())) {
    lc.gastos_fixos_tipos.push(nome.trim());
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-tipo] sync erro:', e.message));
  res.json({ ok: true });
});

// Remove tipo
app.delete('/api/lucro/gastos-fixo-tipo', async (req, res) => {
  const { conta, nome } = req.body;
  const num = String(conta || '1');
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.gastos_fixos_tipos = (lc.gastos_fixos_tipos || []).filter(t => t !== nome);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-tipo] sync erro:', e.message));
  res.json({ ok: true });
});

// Salva valor de um tipo para o mês (individual — mantido por compatibilidade)
app.post('/api/lucro/gastos-fixo-valor', async (req, res) => {
  const { conta, mes, nome, valor } = req.body;
  const num = String(conta || '1');
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.gastos_fixos_valores = lc.gastos_fixos_valores || {};
  lc.gastos_fixos_valores[mes] = lc.gastos_fixos_valores[mes] || {};
  lc.gastos_fixos_valores[mes][nome] = parseFloat(valor) || 0;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-valor] sync erro:', e.message));
  res.json({ ok: true });
});

// Salva todos os valores do mês de uma vez (batch — evita perda por saves parciais)
app.post('/api/lucro/gastos-fixos-valores-batch', async (req, res) => {
  const { conta, mes, valores } = req.body;
  const num = String(conta || '1');
  if (!valores || typeof valores !== 'object') return res.status(400).json({ error: 'valores inválido' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.gastos_fixos_valores = lc.gastos_fixos_valores || {};
  lc.gastos_fixos_valores[mes] = {};
  for (const [nome, valor] of Object.entries(valores)) {
    lc.gastos_fixos_valores[mes][nome] = parseFloat(valor) || 0;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-batch] sync erro:', e.message));
  res.json({ ok: true });
});

app.post('/api/lucro/gasto', async (req, res) => {
  const { conta, mes, descricao, valor } = req.body;
  const num = String(conta || '1');
  if (!['1','2'].includes(num)) return res.status(400).json({ error: 'Conta inválida' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.gastos = lc.gastos || {};
  lc.gastos[mes] = lc.gastos[mes] || [];
  const id = Date.now().toString();
  lc.gastos[mes].push({ id, descricao: String(descricao || '').trim(), valor: parseFloat(valor) || 0 });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  await syncRailwayEnvVars(data).catch(e => console.error('[lucro/gasto] sync erro:', e.message));
  res.json({ ok: true, id });
});

app.delete('/api/lucro/gasto', async (req, res) => {
  const { conta, mes, id } = req.body;
  const num = String(conta || '1');
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  if (lc.gastos?.[mes]) {
    lc.gastos[mes] = lc.gastos[mes].filter(g => g.id !== id);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    await syncRailwayEnvVars(data).catch(e => console.error('[lucro/gasto] sync erro:', e.message));
  }
  res.json({ ok: true });
});

// ── Gastos automáticos (Ads + Full) ─────────────────────────
app.get('/api/lucro/gastos-auto', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c?.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)       return res.json({ error: 'user_id não encontrado' });

  const mes = req.query.mes || new Date().toISOString().slice(0, 7);
  const [ano, m] = mes.split('-').map(Number);
  const de       = `${mes}-01`;
  const hoje     = new Date().toISOString().split('T')[0];
  const ultimoDia = new Date(ano, m, 0).getDate();
  const ate_full  = `${mes}-${String(ultimoDia).padStart(2, '0')}`;
  const ate       = ate_full > hoje ? hoje : ate_full;
  const headers   = { Authorization: `Bearer ${c.access_token}` };

  const [adsCost, fullCost] = await Promise.all([

    // ── Ads: usa endpoint seller-level para custo total (mais estável)
    (async () => {
      try {
        // Tenta endpoint de métricas por seller (única chamada, evita inconsistência por timeout por campanha)
        const r = await axios.get('https://api.mercadolibre.com/advertising/product_ads/metrics', {
          params: { seller_id: c.user_id, date_from: de, date_to: ate }, headers, timeout: 12000,
        });
        const custo = Number(r.data?.cost ?? r.data?.total_cost);
        if (!isNaN(custo) && custo >= 0) {
          console.log(`[gastos-auto] ads seller_metrics: R$${custo}`);
          return custo;
        }
        throw new Error('seller_metrics sem campo cost');
      } catch (e1) {
        // Fallback: soma por campanha com retry por campanha falha
        console.log('[gastos-auto] fallback por campanha:', e1.message);
        try {
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
          const campIds = [...new Set(todosAds.filter(a => a.campaign_id > 0).map(a => a.campaign_id))];
          if (!campIds.length) return 0;
          const custos = await Promise.all(campIds.map(async (campId) => {
            for (let t = 0; t < 3; t++) {
              try {
                const r = await axios.get(
                  `https://api.mercadolibre.com/advertising/product_ads/campaigns/${campId}/metrics`,
                  { params: { date_from: de, date_to: ate }, headers, timeout: 10000 }
                );
                return Number(r.data.cost) || 0;
              } catch { if (t < 2) await new Promise(res => setTimeout(res, 1000 * (t + 1))); }
            }
            return 0;
          }));
          return custos.reduce((s, v) => s + v, 0);
        } catch { return 0; }
      }
    })(),

    // ── Full: busca pedidos Full e soma custos de envio ───────
    (async () => {
      try {
        let todasOrdens = [];
        let offset = 0;
        while (offset < 5000) {
          const params = {
            seller: c.user_id, 'order.status': 'paid', sort: 'date_desc', limit: 50, offset,
            'order.date_created.from': de  + 'T00:00:00.000-03:00',
            'order.date_created.to':   ate + 'T23:59:59.000-03:00',
          };
          const resp = await axios.get('https://api.mercadolibre.com/orders/search', { params, headers, timeout: 15000 });
          const results = resp.data.results || [];
          todasOrdens = todasOrdens.concat(results);
          if (results.length < 50) break;
          offset += 50;
        }
        const fullOrdens = todasOrdens.filter(o =>
          o.shipping?.id && (
            o.shipping.logistic_type === 'fulfillment' ||
            o.shipping.mode          === 'fulfillment'
          )
        );
        const fullIds = [...new Set(fullOrdens.map(o => o.shipping.id))];
        const fretePorShipment = {};
        const BATCH = 25;
        for (let i = 0; i < fullIds.length; i += BATCH) {
          await Promise.all(fullIds.slice(i, i + BATCH).map(async (sid) => {
            try {
              const r = await axios.get(`https://api.mercadolibre.com/shipments/${sid}/costs`, { headers, timeout: 8000 });
              const senders = r.data?.senders || [];
              const sender  = senders.find(s => s.user_id == c.user_id) || senders[0];
              fretePorShipment[sid] = sender?.cost ?? 0;
            } catch { fretePorShipment[sid] = 0; }
          }));
        }
        return Object.values(fretePorShipment).reduce((s, v) => s + v, 0);
      } catch { return 0; }
    })(),
  ]);

  res.json({ ads_cost: adsCost, full_cost: fullCost });
});

app.get('/api/lucro/vendas', async (req, res) => {
  const data    = loadData();
  const num     = req.query.conta || data.conta_ativa;
  const c       = data.contas[num];
  if (!c?.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)       return res.json({ error: 'user_id não encontrado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };

  try {
    // Filtra por data no servidor para não buscar todo o histórico
    const dateFrom = req.query.date_from; // YYYY-MM-DD (opcional)
    const dateTo   = req.query.date_to;   // YYYY-MM-DD (opcional)

    // Busca pedidos paginando até acabar (max 20 páginas = 1000 pedidos por segurança)
    let todasOrdens = [];
    let offset = 0;
    while (offset < 5000) {
      const params = { seller: c.user_id, 'order.status': 'paid', sort: 'date_desc', limit: 50, offset };
      if (dateFrom) params['order.date_created.from'] = dateFrom + 'T00:00:00.000-03:00';
      if (dateTo)   params['order.date_created.to']   = dateTo   + 'T23:59:59.000-03:00';
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params, headers, timeout: 15000,
      });
      const results = resp.data.results || [];
      todasOrdens = todasOrdens.concat(results);
      if (results.length < 50) break;
      offset += 50;
    }

    // Busca custo de frete via /shipments/{id}/costs → senders[].cost
    // Em lotes de 25 para não sobrecarregar a API do ML
    const shipmentIds = [...new Set(todasOrdens.map(o => o.shipping?.id).filter(Boolean))];
    const fretePorShipment = {};
    const BATCH = 25;
    for (let i = 0; i < shipmentIds.length; i += BATCH) {
      await Promise.all(
        shipmentIds.slice(i, i + BATCH).map(async (sid) => {
          try {
            const r = await axios.get(`https://api.mercadolibre.com/shipments/${sid}/costs`, {
              headers, timeout: 8000,
            });
            const senders = r.data?.senders || [];
            const sender  = senders.find(s => s.user_id == c.user_id) || senders[0];
            fretePorShipment[sid] = sender?.cost ?? 0;
          } catch { fretePorShipment[sid] = 0; }
        })
      );
    }

    // Modo debug: mostra campo shipping dos pedidos + estrutura de custo dos shipments
    if (req.query.debug === '1') {
      const ordersShipping = todasOrdens.slice(0, 5).map(o => ({
        orderId:      o.id,
        shipping:     o.shipping,
        pack_id:      o.pack_id,
      }));
      const rawData = await Promise.all(
        shipmentIds.slice(0, 3).map(async sid => {
          try {
            const r = await axios.get(`https://api.mercadolibre.com/shipments/${sid}`, { headers, timeout: 8000 });
            return { sid, cost: r.data.cost, cost_components: r.data.cost_components, base_cost: r.data.base_cost, logistic_type: r.data.logistic_type };
          } catch (e) { return { sid, error: e.message }; }
        })
      );
      return res.json({ shipment_ids_found: shipmentIds.length, orders_shipping: ordersShipping, shipments_raw: rawData });
    }

    const vendas = todasOrdens.map(order => {
      const itens = (order.order_items || []).map(oi => ({
        mlb:        oi.item?.id         || '',
        sku:        oi.item?.seller_sku || '',
        titulo:     oi.item?.title      || '',
        quantidade: oi.quantity         || 1,
        precoUnit:  oi.unit_price       || 0,
        taxaML:     (oi.sale_fee || 0) * (oi.quantity || 1), // sale_fee é por unidade
      }));
      const receita   = itens.reduce((s, i) => s + i.precoUnit * i.quantidade, 0);
      const taxaML    = itens.reduce((s, i) => s + i.taxaML, 0);
      const freteReal = fretePorShipment[order.shipping?.id] ?? 0;
      return {
        orderId: order.id,
        data:    order.date_closed || order.date_created,
        itens,
        receita,
        taxaML,
        freteReal,
      };
    });

    res.json({ vendas });
  } catch (err) {
    addLog(`Lucro: erro ao buscar vendas — ${err.message}`, 'erro');
    res.json({ error: `Erro ao buscar vendas: ${err.message}` });
  }
});

// Debug — inbound plans (envios ao Full / reabastecimento)
app.get('/api/ml/debug-inbound', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c?.access_token) return res.json({ error: 'Não conectado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };
  const result  = {};

  const tentativas = [
    // Logistics API
    { label: 'logistics/shipment_orders_inbound',   url: `https://api.mercadolibre.com/logistics/shipment_orders/search`,          params: { seller_id: c.user_id, type: 'inbound', limit: 3 } },
    { label: 'logistics/shipment_orders_FF',        url: `https://api.mercadolibre.com/logistics/shipment_orders/search`,          params: { seller_id: c.user_id, mode: 'FF', limit: 3 } },
    { label: 'logistics/handling_units',            url: `https://api.mercadolibre.com/logistics/handling_units/search`,           params: { seller_id: c.user_id, limit: 3 } },
    // Fulfillment restock / replenishment
    { label: 'fulfillment/restock',                 url: `https://api.mercadolibre.com/fulfillment/restock`,                      params: { seller_id: c.user_id, limit: 3 } },
    { label: 'fulfillment/inbound/restocking',      url: `https://api.mercadolibre.com/fulfillment/inbound/restocking`,           params: { seller_id: c.user_id, limit: 3 } },
    { label: 'users/restock',                       url: `https://api.mercadolibre.com/users/${c.user_id}/restock`,                params: { limit: 3 } },
    // Conta / financeiro
    { label: 'account/movements_inbound',           url: `https://api.mercadolibre.com/users/${c.user_id}/mercadopago_account/movements`, params: { limit: 3 } },
    { label: 'account/balance',                     url: `https://api.mercadolibre.com/account/balance`,                          params: { user_id: c.user_id } },
    // Shipments com filtro Full
    { label: 'users/shipments_FF',                  url: `https://api.mercadolibre.com/users/${c.user_id}/shipments`,              params: { logistic_type: 'fulfillment', limit: 3 } },
    { label: 'shipments_search_FF',                 url: `https://api.mercadolibre.com/shipments/search`,                         params: { seller: c.user_id, logistic_type: 'fulfillment', limit: 3 } },
  ];

  // Se passado um id (plan ou shipment), testa direto
  if (req.query.plan_id) {
    const pid = req.query.plan_id;
    tentativas.push(
      { label: `shipments/${pid}`,                url: `https://api.mercadolibre.com/shipments/${pid}`,                         params: {} },
      { label: `shipments/${pid}/costs`,          url: `https://api.mercadolibre.com/shipments/${pid}/costs`,                   params: {} },
      { label: `logistics/shipment_orders/${pid}`,url: `https://api.mercadolibre.com/logistics/shipment_orders/${pid}`,         params: {} },
      { label: `fulfillment/inbound/${pid}`,      url: `https://api.mercadolibre.com/fulfillment/inbound/${pid}`,               params: {} },
      { label: `fulfillment/restock/${pid}`,      url: `https://api.mercadolibre.com/fulfillment/restock/${pid}`,               params: {} },
    );
  }

  for (const { label, url, params } of tentativas) {
    try {
      const r = await axios.get(url, { params, headers, timeout: 8000 });
      result[label] = { status: r.status, data: r.data };
    } catch (e) {
      result[label] = { status: e.response?.status, error: e.response?.data || e.message };
    }
  }

  res.json(result);
});

// Debug — Billing API (coleta Full / inbound)
app.get('/api/ml/debug-billing', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c?.access_token) return res.json({ error: 'Não conectado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };
  const result  = {};

  // 1. Tenta listar os períodos de billing disponíveis
  const periodosTentativas = [
    { label: 'monthly/periods',              url: `https://api.mercadolibre.com/billing/monthly/periods`,                              params: { user_id: c.user_id } },
    { label: 'monthly/periods_no_param',     url: `https://api.mercadolibre.com/billing/monthly/periods`,                              params: {} },
    { label: 'monthly/periods_seller',       url: `https://api.mercadolibre.com/billing/monthly/periods`,                              params: { seller_id: c.user_id } },
  ];

  for (const { label, url, params } of periodosTentativas) {
    try {
      const r = await axios.get(url, { params, headers, timeout: 8000 });
      result[label] = { status: r.status, data: r.data };
    } catch (e) {
      result[label] = { status: e.response?.status, error: e.response?.data || e.message };
    }
  }

  // 2. Se passado um key, testa summary e details
  if (req.query.key) {
    const key = req.query.key;
    const detalhesTentativas = [
      { label: `monthly_summary_${key}`,        url: `https://api.mercadolibre.com/billing/monthly/periods/key/${key}/group/ML/summary`,  params: {} },
      { label: `monthly_details_${key}`,        url: `https://api.mercadolibre.com/billing/monthly/periods/key/${key}/group/ML/details`,  params: { limit: 5 } },
      { label: `integration_details_${key}`,    url: `https://api.mercadolibre.com/billing/integration/periods/key/${key}/group/ML/details`, params: { document_type: 'BILL' } },
    ];
    for (const { label, url, params } of detalhesTentativas) {
      try {
        const r = await axios.get(url, { params, headers, timeout: 8000 });
        result[label] = { status: r.status, data: r.data };
      } catch (e) {
        result[label] = { status: e.response?.status, error: e.response?.data || e.message };
      }
    }
  }

  res.json(result);
});

// Debug — estrutura real do shipment para diagnóstico do frete
app.get('/api/ml/debug-shipment/:sid', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c?.access_token) return res.json({ error: 'Não conectado' });
  try {
    const r = await axios.get(`https://api.mercadolibre.com/shipments/${req.params.sid}`, {
      headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 10000,
    });
    // Retorna todos os campos de custo
    const d = r.data;
    res.json({
      id:               d.id,
      logistic_type:    d.logistic_type,
      cost:             d.cost,
      cost_components:  d.cost_components,
      base_cost:        d.base_cost,
      shipping_costs:   d.shipping_costs,
      cost_detail:      d.cost_detail,
      extended_info:    d.extended_info,
    });
  } catch (err) { res.json({ error: err.message }); }
});

// Debug — inspeciona custo do shipment a partir do order_id
app.get('/api/ml/debug-order-shipment/:order_id', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c?.access_token) return res.json({ error: 'Não conectado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };
  try {
    const order   = await axios.get(`https://api.mercadolibre.com/orders/${req.params.order_id}`, { headers, timeout: 10000 }).then(r => r.data);
    const sid     = order.shipping?.id;
    const payId   = order.payments?.[0]?.id;
    const [ship, shipCosts, collection] = await Promise.all([
      sid   ? axios.get(`https://api.mercadolibre.com/shipments/${sid}`, { headers, timeout: 10000 }).then(r => r.data).catch(() => null) : null,
      sid   ? axios.get(`https://api.mercadolibre.com/shipments/${sid}/costs`, { headers, timeout: 10000 }).then(r => r.data).catch(e => ({ error: e.message })) : null,
      payId ? axios.get(`https://api.mercadolibre.com/collections/${payId}`, { headers, timeout: 10000 }).then(r => r.data).catch(e => ({ error: e.message })) : null,
    ]);
    const col = collection?.collection || collection;
    res.json({
      ship_cost_components:      ship?.cost_components,
      ship_base_cost:            ship?.base_cost,
      shipment_costs_endpoint:   shipCosts,
      collection_net_received:   col?.net_received_amount,
      collection_shipping_cost:  col?.shipping_cost,
      collection_marketplace_fee: col?.marketplace_fee,
      collection_raw_keys:       col ? Object.keys(col) : null,
    });
  } catch (err) { res.json({ error: err.message }); }
});

// Lista os primeiros pedidos pagos da conta para diagnóstico
app.get('/api/ml/debug-orders', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id) return res.json({ error: 'user_id não encontrado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };
  const findId  = req.query.find; // busca um order_id específico na lista
  try {
    let found = null;
    let offset = 0;
    const limit = 50;
    while (offset < 600) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: c.user_id, 'order.status': 'paid', sort: 'date_desc', offset, limit },
        headers, timeout: 15000,
      });
      const results = resp.data.results || [];
      if (findId) {
        const match = results.find(o => String(o.id) === String(findId));
        if (match) {
          found = { order_id: match.id, date: match.date_created?.slice(0,10), pack_id: match.pack_id || null, shipping: match.shipping };
          break;
        }
        if (results.length < limit) break;
        offset += limit;
        continue;
      }
      const orders = results.map(o => ({
        order_id:      o.id,
        date:          o.date_created?.slice(0, 10),
        status:        o.status,
        pack_id:       o.pack_id || null,
        shipping_id:   o.shipping?.id,
        logistic_type: o.shipping?.logistic_type,
        mode:          o.shipping?.mode,
      }));
      return res.json({ conta: num, user_id: c.user_id, total: resp.data.paging?.total, orders });
    }
    if (findId) return res.json({ conta: num, user_id: c.user_id, found, searched_up_to_offset: offset });
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
const BLING_CLIENT_ID     = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_CLIENT_ID_2     = process.env.BLING_CLIENT_ID_2;
const BLING_CLIENT_SECRET_2 = process.env.BLING_CLIENT_SECRET_2;

// Número 1: contas a pagar + anúncios pausados
const CALLMEBOT_PHONE  = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
// Número 2: pedidos novos
const CALLMEBOT_PHONE_PEDIDOS  = process.env.CALLMEBOT_PHONE_PEDIDOS;
const CALLMEBOT_APIKEY_PEDIDOS = process.env.CALLMEBOT_APIKEY_PEDIDOS;

async function enviarWhatsApp(phone, apikey, texto) {
  if (!phone || !apikey) return;
  try {
    const msg = texto.replace(/<[^>]+>/g, ''); // remove HTML tags, sem encode manual
    const resp = await axios.get('https://api.callmebot.com/whatsapp.php', {
      params: { phone, text: msg, apikey },
      timeout: 10000,
    });
    const body = String(resp.data || '').trim();
    addLog(`WhatsApp → ${phone}: ${body || 'sem resposta'}`, body.toLowerCase().includes('error') || body.toLowerCase().includes('wrong') ? 'warn' : 'ok');
  } catch (err) {
    addLog(`WhatsApp: falha ao enviar para ${phone} — ${err.message}`, 'warn');
  }
}

// Notificações de contas a pagar e anúncios pausados
async function notificar(texto) {
  await Promise.allSettled([
    enviarTelegram(texto),
    enviarWhatsApp(CALLMEBOT_PHONE, CALLMEBOT_APIKEY, texto),
  ]);
}

// Notificações de pedidos novos (número diferente)
async function notificarPedido(texto) {
  await Promise.allSettled([
    enviarTelegram(texto),
    enviarWhatsApp(CALLMEBOT_PHONE_PEDIDOS, CALLMEBOT_APIKEY_PEDIDOS, texto),
  ]);
}

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

// Mantém os shipmentIds já notificados — carregado do disco, persiste entre restarts
function carregarShipmentsNotificados() {
  const data = loadData();
  return new Set(Array.isArray(data.shipmentsNotificados) ? data.shipmentsNotificados : []);
}
function salvarShipmentsNotificados(set) {
  const data = loadData();
  // Guarda no máximo os últimos 500 IDs para não crescer indefinidamente
  const arr = Array.from(set);
  data.shipmentsNotificados = arr.slice(-500);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
const shipmentsNotificados = carregarShipmentsNotificados();

// Remove um pedido do controle de notificados (para renotificar quando etiqueta ficar disponível)
app.delete('/api/telegram/notificado/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const data = loadData();
  let shipmentId = null;
  for (const num of ['1', '2']) {
    const c = data.contas?.[num];
    if (!c?.access_token) continue;
    try {
      const r = await axios.get(`https://api.mercadolibre.com/orders/${orderId}`, {
        headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 8000,
      });
      shipmentId = String(r.data?.shipping?.id || '');
      if (shipmentId) break;
    } catch {}
  }
  if (!shipmentId) return res.json({ error: 'Pedido não encontrado ou sem shipment' });
  const removido = shipmentsNotificados.delete(shipmentId);
  if (removido) salvarShipmentsNotificados(shipmentsNotificados);
  res.json({ ok: true, shipmentId, removido });
});

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
          addLog(`[pedido] #${order.id} status=${shipment.status} substatus=${shipment.substatus} full=${isFull}`, 'info');

          if (!LABEL_STATUSES.has(shipment.status) || !LABEL_SUBSTATUSES.has(shipment.substatus) || isFull) {
            shipmentsNotificados.add(sid);
            salvarShipmentsNotificados(shipmentsNotificados);
            continue;
          }

          shipmentsNotificados.add(sid);
          salvarShipmentsNotificados(shipmentsNotificados);

          const itens = (order.order_items || []).map(i => `• ${i.item.title} (x${i.quantity})`).join('\n');
          const conta = c.nickname || c.nome || `Conta ${num}`;
          const status = STATUS_PT[shipment.status] || shipment.status;
          const texto = `🛍 <b>Novo pedido — ${conta}</b>\n` +
            `Pedido: #${order.id}\n` +
            `Comprador: ${order.buyer?.nickname || '—'}\n` +
            `Status: ${status}\n\n${itens}`;
          await notificarPedido(texto);
          addLog(`[pedido] Notificação enviada — #${order.id}`, 'ok');
        } catch (err) {
          addLog(`[pedido] Erro ao processar shipment ${sid}: ${err.message}`, 'warn');
        }
      }
    } catch (err) {
      addLog(`Telegram monitor conta ${num}: ${err.message}`, 'warn');
    }
  }
}

// ── Polling em background: anúncios pausados ──────────────────
async function verificarAnunciosPausadosTelegram() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const data = loadData();
  for (const num of ['1', '2']) {
    const c = data.contas[num];
    if (!c || !c.access_token) continue;
    try {
      const pauseDates = c.pause_dates || {};
      let pauseChanged = false;

      // Busca apenas anúncios pausados + ativos para detectar mudanças
      const idsAtivos   = await buscarIdsStatus(c, 'active');
      const idsPausados = await buscarIdsStatus(c, 'paused');

      // Anúncios que ficaram pausados agora (não estavam em pauseDates)
      const novamentePausados = idsPausados.filter(id => !pauseDates[id]);

      if (novamentePausados.length) {
        // Busca detalhes dos novos pausados para pegar o título
        const chunks = [];
        for (let i = 0; i < novamentePausados.length; i += 20) chunks.push(novamentePausados.slice(i, i + 20));
        for (const chunk of chunks) {
          try {
            const resp = await axios.get('https://api.mercadolibre.com/items', {
              params: { ids: chunk.join(','), attributes: 'id,title' },
              headers: { Authorization: `Bearer ${c.access_token}` },
              timeout: 10000,
            });
            const itens = resp.data || [];
            for (const item of itens) {
              if (item.code !== 200) continue;
              const mlb    = item.body.id;
              const titulo = item.body.title || mlb;
              const conta  = c.nickname || `Conta ${num}`;
              pauseDates[mlb] = new Date().toISOString();
              pauseChanged = true;
              notificar(`⏸ <b>Anúncio pausado — ${conta}</b>\n\n${titulo}\n<code>${mlb}</code>`).catch(() => {});
              addLog(`Notificação: anúncio pausado — ${mlb}`, 'info');
            }
          } catch {}
        }
      }

      // Remove do pauseDates anúncios que voltaram a ficar ativos
      for (const id of idsAtivos) {
        if (pauseDates[id]) { delete pauseDates[id]; pauseChanged = true; }
      }

      if (pauseChanged) {
        c.pause_dates = pauseDates;
        saveData(data);
      }
    } catch (err) {
      addLog(`Telegram monitor pausados conta ${num}: ${err.message}`, 'warn');
    }
  }
}

async function buscarIdsStatus(c, status) {
  const ids = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    try {
      const resp = await axios.get(`https://api.mercadolibre.com/users/${c.user_id}/items/search`, {
        params: { status, offset, limit },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 10000,
      });
      const results = resp.data.results || [];
      ids.push(...results);
      if (results.length < limit) break;
      offset += limit;
      if (offset >= 2000) break;
    } catch { break; }
  }
  return ids;
}

// ── Polling em background: estoque baixo (<15 dias) ───────────
async function verificarEstoqueBaixo() {
  const data = loadData();
  const hoje = new Date().toISOString().split('T')[0];

  for (const num of ['1', '2']) {
    const c = data.contas[num];
    if (!c || !c.access_token || !c.user_id) continue;

    try {
      const idsAtivos = await buscarIdsStatus(c, 'active');
      if (!idsAtivos.length) continue;

      // Busca estoque dos ativos em chunks de 20
      const itensMapa = {};
      for (let i = 0; i < idsAtivos.length; i += 20) {
        const chunk = idsAtivos.slice(i, i + 20);
        try {
          const resp = await axios.get('https://api.mercadolibre.com/items', {
            params: { ids: chunk.join(','), attributes: 'id,title,available_quantity,variations' },
            headers: { Authorization: `Bearer ${c.access_token}` },
            timeout: 10000,
          });
          for (const item of (resp.data || [])) {
            if (item.code !== 200) continue;
            const estoque = item.body.variations?.length
              ? item.body.variations.reduce((s, v) => s + (v.available_quantity ?? 0), 0)
              : (item.body.available_quantity ?? 0);
            itensMapa[item.body.id] = { titulo: item.body.title, estoque };
          }
        } catch {}
      }

      // Busca vendas dos últimos 30 dias
      const vendasPorItem = {};
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      let offset = 0;
      while (true) {
        try {
          const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
            params: { seller: c.user_id, 'order.status': 'paid', 'order.date_created.from': from, sort: 'date_desc', offset, limit: 50 },
            headers: { Authorization: `Bearer ${c.access_token}` },
            timeout: 10000,
          });
          const orders = resp.data.results || [];
          const total  = resp.data.paging?.total || 0;
          for (const order of orders) {
            for (const oi of (order.order_items || [])) {
              vendasPorItem[oi.item.id] = (vendasPorItem[oi.item.id] || 0) + (oi.quantity || 1);
            }
          }
          if (orders.length < 50) break;
          offset += 50;
          if (offset >= total || offset >= 2000) break;
        } catch { break; }
      }

      // Calcula dias de estoque e filtra < 15 dias
      const alertaDates = c.estoque_alerta_dates || {};
      let alertaChanged = false;
      const conta = c.nickname || `Conta ${num}`;
      const alertas = [];

      for (const [mlb, { titulo, estoque }] of Object.entries(itensMapa)) {
        if (estoque <= 0) continue;
        const vendas30 = vendasPorItem[mlb] || 0;
        if (vendas30 === 0) continue; // sem histórico de vendas, ignora
        const diasEstoque = Math.floor(estoque / (vendas30 / 30));

        if (diasEstoque < 15) {
          if (alertaDates[mlb] !== hoje) {
            alertaDates[mlb] = hoje;
            alertaChanged = true;
            alertas.push({ mlb, titulo, estoque, diasEstoque });
          }
        } else {
          if (alertaDates[mlb]) { delete alertaDates[mlb]; alertaChanged = true; }
        }
      }

      if (alertas.length) {
        const header = `📦 <b>Estoque baixo — ${conta}</b>`;
        const linhas = alertas
          .sort((a, b) => a.diasEstoque - b.diasEstoque)
          .map(a => `• ${a.titulo}\n  <code>${a.mlb}</code> — ${a.estoque} un. (~${a.diasEstoque} dias)`);
        // Divide em blocos de até 1400 chars para não cortar no CallMeBot
        const blocos = [];
        let bloco = [];
        let tamanho = header.length + 2;
        for (const linha of linhas) {
          const add = linha.length + 2;
          if (tamanho + add > 1400 && bloco.length) {
            blocos.push(bloco);
            bloco = [];
            tamanho = header.length + 2;
          }
          bloco.push(linha);
          tamanho += add;
        }
        if (bloco.length) blocos.push(bloco);
        for (let i = 0; i < blocos.length; i++) {
          const sufixo = blocos.length > 1 ? ` (${i + 1}/${blocos.length})` : '';
          notificar(`${header}${sufixo}\n\n${blocos[i].join('\n\n')}`).catch(() => {});
        }
        addLog(`Notificação: estoque baixo — ${alertas.length} item(s) — conta ${num}`, 'info');
      }

      if (alertaChanged) {
        c.estoque_alerta_dates = alertaDates;
        saveData(data);
      }
    } catch (err) {
      addLog(`Monitor estoque baixo conta ${num}: ${err.message}`, 'warn');
    }
  }
}

// ── Notificação diária: contas a pagar vencendo hoje ──────────
async function notificarContasVencendoHoje() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const hoje = new Date().toISOString().split('T')[0];
  const data = loadData();
  const linhas = [];

  for (const num of ['1', '2']) {
    const lista = (data.contas_pagar || {})[num] || [];
    const vencemHoje = lista.filter(c => !c.pago && c.dVenc === hoje);
    for (const c of vencemHoje) {
      const valor = 'R$ ' + (c.vDup || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
      linhas.push(`• ${c.fornecedor} — ${valor} (NF ${c.nNF} Parc. ${c.nDup})`);
    }
  }

  if (!linhas.length) return;

  const dataFmt = hoje.split('-').reverse().join('/');
  const texto = `📅 <b>Contas a pagar — vencimento hoje (${dataFmt})</b>\n\n` + linhas.join('\n');
  await notificar(texto).catch(() => {});
  addLog(`Notificação: ${linhas.length} conta(s) vencendo hoje`, 'info');
}

// Executa check de contas a vencer todo dia às 8h (verifica a cada hora)
setInterval(() => {
  const hora = new Date().getHours();
  if (hora === 8) notificarContasVencendoHoje().catch(() => {});
}, 60 * 60 * 1000);

app.post('/api/telegram/teste', async (req, res) => {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.json({ ok: false, erro: 'TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não configurados' });
  }
  try {
    await notificar('🧪 *Teste de notificação*\n\nSeu app está funcionando! Você receberá:\n• 🛍 Novos pedidos para embalar\n• ⏸ Anúncios pausados\n• 📅 Contas a pagar vencendo no dia (às 8h)');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

app.post('/api/whatsapp/teste-pedidos', async (req, res) => {
  if (!CALLMEBOT_PHONE_PEDIDOS || !CALLMEBOT_APIKEY_PEDIDOS) {
    return res.json({ ok: false, erro: 'CALLMEBOT_PHONE_PEDIDOS ou CALLMEBOT_APIKEY_PEDIDOS não configurados' });
  }
  try {
    const resp = await axios.get('https://api.callmebot.com/whatsapp.php', {
      params: { phone: CALLMEBOT_PHONE_PEDIDOS, text: '🧪 Teste — notificações de pedidos novos ativas!', apikey: CALLMEBOT_APIKEY_PEDIDOS },
      timeout: 10000,
    });
    const body = String(resp.data || '').trim();
    const erro = body.toLowerCase().includes('error') || body.toLowerCase().includes('wrong');
    addLog(`WhatsApp teste-pedidos → ${CALLMEBOT_PHONE_PEDIDOS}: ${body}`, erro ? 'warn' : 'ok');
    res.json({ ok: !erro, resposta: body });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

app.post('/api/whatsapp/teste-estoque-baixo', async (req, res) => {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) {
    return res.json({ ok: false, erro: 'CALLMEBOT_PHONE ou CALLMEBOT_APIKEY não configurados' });
  }
  try {
    await verificarEstoqueBaixo();
    res.json({ ok: true, mensagem: 'Rotina executada — veja o log para detalhes' });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

// ── Notas Fiscais de Compra (Fiscal.io) ───────────────────────────────────────

function loadFiscalNotas() {
  try { return JSON.parse(fs.readFileSync(FISCAL_FILE, 'utf8')); } catch { return {}; }
}
function saveFiscalNotas(notas) {
  fs.writeFileSync(FISCAL_FILE, JSON.stringify(notas, null, 2));
}

// Recebe notas do agente local e faz upsert por chave
app.post('/api/fiscal/sync', (req, res) => {
  const { notas, token } = req.body;
  if (token !== FISCAL_TOKEN) return res.status(403).json({ ok: false, erro: 'Token inválido' });
  if (!Array.isArray(notas)) return res.json({ ok: false, erro: 'notas deve ser array' });

  const db = loadFiscalNotas();
  let novas = 0;
  for (const n of notas) {
    const key = n.chave || `${n.filial}-${n.emitid}-${n.num}-${n.serie}`;
    if (!key) continue;
    if (!db[key]) novas++;
    db[key] = n;
  }
  saveFiscalNotas(db);
  addLog(`Fiscal sync: ${notas.length} recebidas, ${novas} novas`, 'info');
  res.json({ ok: true, novas, total: Object.keys(db).length });
});

// Retorna notas agrupadas por CNPJ
app.get('/api/fiscal/notas', (req, res) => {
  const db = loadFiscalNotas();
  const grupos = {};
  for (const n of Object.values(db)) {
    const cnpj = n.filial || '';
    if (!/^\d{14}$/.test(cnpj)) continue; // ignora entradas inválidas
    if (!grupos[cnpj]) grupos[cnpj] = { cnpj, nome: n.tomanome || cnpj, notas: [] };
    grupos[cnpj].notas.push(n);
  }
  // Ordena notas de cada grupo por data decrescente
  for (const g of Object.values(grupos)) {
    g.notas.sort((a, b) => (b.dtemi || '').localeCompare(a.dtemi || ''));
  }
  res.json(Object.values(grupos));
});

// ── Contas a Pagar ────────────────────────────────────────────────────────────

// Helper: extrai texto de uma tag XML (ignora prefixo de namespace)
function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}(?:\\s[^>]*)?>([^<]*)<\\/(?:[^:>]+:)?${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}
function xmlBlock(xml, tag) {
  const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'i'));
  return m ? m[1] : '';
}
function xmlAllBlocks(xml, tag) {
  const re = new RegExp(`<(?:[^:>]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'gi');
  const res = []; let m;
  while ((m = re.exec(xml)) !== null) res.push(m[1]);
  return res;
}

function parseNFeXML(xmlStr) {
  const emitBlk = xmlBlock(xmlStr, 'emit');
  const ideBlk  = xmlBlock(xmlStr, 'ide');
  const cobrBlk = xmlBlock(xmlStr, 'cobr');

  const fornecedor = xmlVal(emitBlk, 'xNome') || 'Desconhecido';
  const cnpj       = xmlVal(emitBlk, 'CNPJ')  || xmlVal(emitBlk, 'CPF') || '';
  const nNF        = xmlVal(ideBlk,  'nNF')    || '';
  const serie      = xmlVal(ideBlk,  'serie')  || '';
  const dEmi       = xmlVal(ideBlk,  'dEmi')   || '';
  const chNFe      = xmlVal(xmlStr,  'chNFe')  || '';

  const dups = [];
  if (cobrBlk) {
    xmlAllBlocks(cobrBlk, 'dup').forEach(dup => {
      const nDup = xmlVal(dup, 'nDup') || '001';
      const dVenc = xmlVal(dup, 'dVenc');
      const vDup  = parseFloat(xmlVal(dup, 'vDup')) || 0;
      if (dVenc && vDup > 0) dups.push({ nDup, dVenc, vDup });
    });
  }
  // NFs sem <dup> são pagamentos à vista — não geram conta a pagar
  return { fornecedor, cnpj, nNF, serie, dEmi, chNFe, dups };
}

app.get('/api/contas-pagar', (req, res) => {
  const data = loadData();
  const num  = String(data.conta_ativa || '1');
  const cp   = (data.contas_pagar || {})[num] || [];
  res.json({ contas: cp });
});

app.post('/api/contas-pagar/xml', uploadMem.single('xml'), async (req, res) => {
  const data = loadData();
  const num  = String(data.conta_ativa || '1');
  data.contas_pagar = data.contas_pagar || {};
  data.contas_pagar[num] = data.contas_pagar[num] || [];

  if (!req.file) return res.status(400).json({ error: 'Arquivo XML não recebido' });
  const xmlStr = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, ''); // remove BOM

  let parsed;
  try { parsed = parseNFeXML(xmlStr); }
  catch (e) { return res.status(400).json({ error: 'Erro ao interpretar XML: ' + e.message }); }

  if (!parsed.dups.length) return res.json({ importados: 0, aviso: 'NF à vista ou sem duplicatas — nada a pagar.' });

  const agora = new Date().toISOString();
  let importados = 0;
  let dup = 0;

  for (const d of parsed.dups) {
    // Evita duplicata: mesmo chNFe + nDup (ou nNF + dVenc + vDup se não tiver chave)
    const chave = parsed.chNFe
      ? `${parsed.chNFe}-${d.nDup}`
      : `${parsed.cnpj}-${parsed.nNF}-${d.nDup}-${d.dVenc}`;
    const existe = data.contas_pagar[num].find(c => c.chave === chave);
    if (existe) { dup++; continue; }
    data.contas_pagar[num].push({
      id:          Date.now().toString() + Math.random().toString(36).slice(2, 6),
      chave,
      fornecedor:  parsed.fornecedor,
      cnpj:        parsed.cnpj,
      nNF:         parsed.nNF,
      serie:       parsed.serie,
      dEmi:        parsed.dEmi,
      nDup:        d.nDup,
      dVenc:       d.dVenc,
      vDup:        d.vDup,
      pago:        false,
      pagoEm:      null,
      adicionadoEm: agora,
    });
    importados++;
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  agendarSyncContasPagar(); // fire-and-forget — não bloqueia a resposta HTTP
  res.json({ importados, dup, syncOk: null }); // cliente vai polling /api/sync/status
});

app.post('/api/contas-pagar/:id/pago', async (req, res) => {
  const data = loadData();
  const num  = String(data.conta_ativa || '1');
  const lista = (data.contas_pagar || {})[num] || [];
  const item  = lista.find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  item.pago   = !item.pago;
  item.pagoEm = item.pago ? new Date().toISOString() : null;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  agendarSyncContasPagar();
  res.json({ ok: true, pago: item.pago });
});

app.delete('/api/contas-pagar/:id', async (req, res) => {
  const data = loadData();
  const num  = String(data.conta_ativa || '1');
  if (data.contas_pagar?.[num]) {
    data.contas_pagar[num] = data.contas_pagar[num].filter(c => c.id !== req.params.id);
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  agendarSyncContasPagar();
  res.json({ ok: true });
});

// ── Sync Railway: status e forçar ────────────────────────────────────────────

app.get('/api/sync/status', (req, res) => {
  res.json(lastSyncStatus);
});

app.post('/api/sync/force', (req, res) => {
  agendarSyncContasPagar();
  res.json({ ok: true, msg: 'Sync agendado — acompanhe /api/sync/status' });
});

// ── Notas de Entrada (SEFAZ NF-e) ────────────────────────────────────────────

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
    CNPJ_raiz: get('CNPJ'), // primeiro CNPJ no doc (emitente no resNFe)
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
  // Exclui eventos (resEvento, procEventoNFe) que não são notas de compra
  const notas = (n.lista || []).filter(x => !x.schema || !x.schema.toLowerCase().includes('evento'));
  res.json({ notas, ultNSU: n.ultNSU || '0', maxNSU: n.maxNSU || '0' });
});

app.post('/api/notas/limpar', (req, res) => {
  const data = loadData();
  const num  = req.body.conta || data.conta_ativa;
  const n    = (data.notas_contas || {})[num];
  if (n) { n.lista = []; n.ultNSU = '0'; n.maxNSU = '0'; }
  saveData(data);
  res.json({ ok: true });
});

// Endpoint temporário de diagnóstico — mostra campos salvos nas notas
app.get('/api/notas/debug', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const n    = (data.notas_contas || {})[num] || {};
  const lista = n.lista || [];
  // Mostra os primeiros 5 registros sem o campo zip (que pode ser grande)
  const amostras = lista.slice(0, 5).map(({ zip, ...rest }) => rest);
  res.json({ total: lista.length, ultNSU: n.ultNSU, maxNSU: n.maxNSU, cnpj: n.cnpj, amostras });
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
          // Ignora eventos (cancelamentos, EPEC, etc.) — não são NF-e de entrada
          const schema = doc.schema || '';
          if (schema.toLowerCase().includes('evento')) continue;

          const buf    = Buffer.from(doc.zip, 'base64');
          const xmlDoc = zlib.gunzipSync(buf).toString('utf8');
          const campos = extrairCampos(xmlDoc);

          // Log para diagnóstico quando campos importantes estão vazios
          if (!campos.nNF && !campos.xNome) {
            addLog(`Notas NSU ${doc.nsu} (schema=${schema}): nNF e xNome vazios. chNFe=${campos.chNFe?.slice(0,10)||'—'} tpNF=${campos.tpNF} CNPJ_dest=${campos.CNPJ_dest} CNPJ_emit=${campos.CNPJ_emit} xml_ini="${xmlDoc.slice(0,120).replace(/\s+/g,' ')}"`, 'warn');
          }

          // Ignora se não extraiu chave nem número de NF
          if (!campos.chNFe && !campos.nNF) continue;

          // Mantém só compras: CNPJ como destinatário, ou tpNF=0 (entrada) e não é o emitente
          // Para resNFe: não há bloco dest/emit — considera compra se CNPJ raiz (emitente) ≠ nosso CNPJ
          const CNPJ_raiz = campos.CNPJ_emit || campos.CNPJ_raiz || '';
          const ehCompra = campos.CNPJ_dest === n.cnpj ||
            (campos.tpNF === '0' && campos.CNPJ_emit !== n.cnpj) ||
            (schema.startsWith('resNFe') && CNPJ_raiz !== n.cnpj);
          if (!ehCompra) continue;

          campos.nsu    = doc.nsu;
          campos.schema = schema;
          campos.tipo   = schema.startsWith('resNFe') ? 'resumo' : 'completa';
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
  if (CALLMEBOT_PHONE && CALLMEBOT_APIKEY) {
    addLog(`WhatsApp: contas/anúncios → ${CALLMEBOT_PHONE} ✅`, 'ok');
    // Estoque baixo: verifica a cada 6 horas
    setTimeout(() => {
      verificarEstoqueBaixo().catch(() => {});
      setInterval(() => verificarEstoqueBaixo().catch(() => {}), 6 * 60 * 60_000);
    }, 90_000);
  }
  if (CALLMEBOT_PHONE_PEDIDOS && CALLMEBOT_APIKEY_PEDIDOS) {
    addLog(`WhatsApp: pedidos novos → ${CALLMEBOT_PHONE_PEDIDOS} ✅`, 'ok');
  }
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    addLog('Telegram: monitoramento de pedidos e anúncios ativado', 'info');
    // Pedidos novos: verifica a cada 60s
    setTimeout(() => {
      verificarNovosShipmentsTelegram().catch(() => {});
      setInterval(() => verificarNovosShipmentsTelegram().catch(() => {}), 60_000);
    }, 10_000);
    // Anúncios pausados: verifica a cada 5 minutos
    setTimeout(() => {
      verificarAnunciosPausadosTelegram().catch(() => {});
      setInterval(() => verificarAnunciosPausadosTelegram().catch(() => {}), 5 * 60_000);
    }, 30_000);
  } else {
    addLog('Telegram: TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não configurados', 'warn');
  }
});
