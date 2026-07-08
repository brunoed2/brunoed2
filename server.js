// ============================================================
// server.js — Servidor Express principal
// Serve os arquivos estáticos + rotas da API do Mercado Livre
// Suporta duas contas ML com alternância em tempo real
// ============================================================

const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const multer   = require('multer');
const https    = require('https');
const zlib     = require('zlib');
const forge    = require('node-forge');

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
const BACKUP_DIR    = path.join(DATA_DIR, 'backups');
const USA_VOLUME    = DATA_DIR === '/data'; // true = volume persistente Railway

// ── Snapshots automáticos diários ────────────────────────────
function criarSnapshotDiario() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const hoje = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `data.backup.${hoje}.json`);
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(DATA_FILE, dest);
      // Apaga backups com mais de 7 dias
      const arquivos = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('data.backup.') && f.endsWith('.json'))
        .sort().reverse();
      arquivos.slice(7).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} });
    }
  } catch (e) { console.error('[backup] Erro ao criar snapshot:', e.message); }
}
// Snapshot no startup e depois a cada 24h
setTimeout(() => {
  criarSnapshotDiario();
  setInterval(criarSnapshotDiario, 24 * 60 * 60 * 1000);
}, 30000); // aguarda 30s para o app inicializar antes do primeiro snapshot
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
  raw.estoque_local                  = raw.estoque_local                  || {};
  raw.estoque_local_last_check       = raw.estoque_local_last_check       || {};
  raw.estoque_local_deducted_orders  = raw.estoque_local_deducted_orders  || {};
  raw.estoque_local_historico        = raw.estoque_local_historico        || [];
  raw.handdry_dashboard_cache        = raw.handdry_dashboard_cache        || null;
  raw.fiscal_baixados                = raw.fiscal_baixados                || [];
  // Auto-configura fornecedor HANDDRY na conta 1
  raw.fornecedores_por_conta = raw.fornecedores_por_conta || {};
  raw.fornecedores_por_conta['1'] = raw.fornecedores_por_conta['1'] || [];
  const HANDDRY_MLBS = ['MLB3700346581','MLB3148872272','MLB2807954078','MLB2807930465'];
  const hdEntry = raw.fornecedores_por_conta['1'].find(f => f.nome?.toUpperCase() === 'HANDDRY');
  if (!hdEntry) {
    raw.fornecedores_por_conta['1'].push({ id: 'handdry', nome: 'HANDDRY', leadTimeDias: 30, skus: [], mlbs: HANDDRY_MLBS });
  } else if (!hdEntry.mlbs || hdEntry.mlbs.length === 0) {
    hdEntry.mlbs = HANDDRY_MLBS;
  }
  raw.usuarios = raw.usuarios || {};
  if (!raw.usuarios['1224']) {
    raw.usuarios['1224'] = { nome: 'Operador', abas: ['estoque', 'vendas', 'historico', 'etiquetas'], painel: 'painel2' };
  }
  if (!raw.usuarios['0505']) {
    raw.usuarios['0505'] = { nome: 'HANDDRY', abas: [], painel: 'fornecedor' };
  }
  // 199412 é sempre admin no painel app — forçado mesmo se já existir com dados errados
  const adminAbas = ['estoque','vendas','historico','ads','lucro','promocoes','contas-pagar','bling','fiscal','compras','calculadora','etiquetas','log-anuncio','configuracoes','scanner'];
  raw.usuarios['199412'] = {
    nome:   (raw.usuarios['199412'] || {}).nome || 'Admin',
    abas:   adminAbas,
    painel: 'app',
  };
  // Migração: garante campo painel em usuários antigos
  for (const [senha, u] of Object.entries(raw.usuarios)) {
    if (!u.painel) u.painel = 'painel2';
  }
  raw.pessoal = raw.pessoal || {};
  raw.pessoal.categorias  = raw.pessoal.categorias  || ['Moradia','Alimentação','Saúde','Transporte','Lazer','Educação','Salário','Freelance','Investimento','Outros'];
  raw.pessoal.recorrentes = raw.pessoal.recorrentes || [];
  raw.pessoal.lancamentos = raw.pessoal.lancamentos || {};
  return raw;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Retorna as credenciais da conta — usa num se fornecido, senão usa conta_ativa
function contaAtiva(data, num) {
  return data.contas[num || data.conta_ativa] || {};
}

// ── Persistência via Railway Environment Variables ────────────

// Estado do último sync — visível via /api/sync/status
let lastSyncStatus = { ok: null, ts: null, erro: null };

// Throttle: atualizar env vars do Railway dispara um novo deploy automaticamente.
// Com volume montado, o disco já é fonte de verdade — env vars são só backup.
// Limita a 1 sync a cada 10 minutos para evitar fila de deploys desnecessários.
// Sync para Railway env vars DESATIVADO — causava loop infinito de deploys.
// Dados persistidos no volume Railway (/data/data.json) + backups diários automáticos.
async function syncRailwayEnvVars(_dataIgnorado) { return { ok: true }; }
async function syncContasPagar()                  { return { ok: true }; }

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

// Sync periódico removido — syncRailwayEnvVars desativado.

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
    if (process.env[`DRE_CACHE_${num}`] !== undefined) {
      try {
        data.lucro_contas[num] = data.lucro_contas[num] || {};
        data.lucro_contas[num].dre_cache = JSON.parse(process.env[`DRE_CACHE_${num}`]);
        changed = true;
      } catch {}
    }
    if (process.env[`GASTOS_FIXOS_TRAV_${num}`] !== undefined) {
      try {
        data.lucro_contas[num] = data.lucro_contas[num] || {};
        data.lucro_contas[num].gastos_fixos_travados = JSON.parse(process.env[`GASTOS_FIXOS_TRAV_${num}`]);
        changed = true;
      } catch {}
    }
    if (process.env[`GASTOS_FIXOS_PAD_${num}`] !== undefined) {
      try {
        data.lucro_contas[num] = data.lucro_contas[num] || {};
        data.lucro_contas[num].gastos_fixos_padrao = JSON.parse(process.env[`GASTOS_FIXOS_PAD_${num}`]);
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

  // Restaura lista de chaves com XML baixado — Railway é fonte verdade
  if (process.env.FISCAL_BAIXADOS !== undefined) {
    try { data.fiscal_baixados = JSON.parse(process.env.FISCAL_BAIXADOS); changed = true; } catch {}
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

// ── Rotas: login e gerenciamento de usuários painel2 ──────────

app.post('/api/login', (req, res) => {
  const { senha } = req.body || {};
  if (!senha) return res.status(400).json({ error: 'Senha obrigatória' });
  const data = loadData();
  const usuario = (data.usuarios || {})[String(senha)];
  if (!usuario) return res.status(401).json({ error: 'Senha incorreta' });
  if (usuario.painel === 'fornecedor') {
    return res.json({ ok: true, nome: usuario.nome, abas: [], painel: 'fornecedor' });
  }
  const APP_TABS = new Set(['ads','lucro','promocoes','contas-pagar','bling','fiscal','compras','calculadora','configuracoes']);
  const painel = (usuario.painel === 'app' || (usuario.abas || []).some(t => APP_TABS.has(t))) ? 'app' : 'painel2';
  res.json({ ok: true, nome: usuario.nome, abas: usuario.abas || [], painel });
});

app.get('/api/usuarios', (req, res) => {
  const data = loadData();
  const lista = Object.entries(data.usuarios || {}).map(([senha, info]) => ({
    senha,
    nome: info.nome || senha,
    abas: info.abas || [],
  }));
  res.json(lista);
});

app.post('/api/usuarios', (req, res) => {
  const { senha, nome, abas, painel } = req.body || {};
  if (!senha || !String(senha).trim()) return res.status(400).json({ error: 'Senha obrigatória' });
  if (String(senha) === '199412') return res.status(400).json({ error: 'Senha reservada' });
  const data = loadData();
  data.usuarios = data.usuarios || {};
  if (data.usuarios[String(senha)]) return res.status(409).json({ error: 'Usuário já existe com essa senha' });
  data.usuarios[String(senha)] = { nome: nome || String(senha), abas: abas || [], painel: painel || 'painel2' };
  saveData(data);
  res.json({ ok: true });
});

app.put('/api/usuarios/:senha', (req, res) => {
  const { senha } = req.params;
  const { nome, abas } = req.body || {};
  const data = loadData();
  data.usuarios = data.usuarios || {};
  if (!data.usuarios[senha]) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (nome !== undefined) data.usuarios[senha].nome = nome;
  if (abas !== undefined) data.usuarios[senha].abas = abas;
  saveData(data);
  res.json({ ok: true });
});

app.delete('/api/usuarios/:senha', (req, res) => {
  const { senha } = req.params;
  if (senha === '199412') return res.status(400).json({ error: 'Não é possível remover o administrador' });
  const data = loadData();
  data.usuarios = data.usuarios || {};
  if (!data.usuarios[senha]) return res.status(404).json({ error: 'Usuário não encontrado' });
  delete data.usuarios[senha];
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
  if (!c.client_id) return res.redirect('/app.html?tab=configuracoes&error=sem_client_id');
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
    + `&scope=offline_access+read_listings+write_listings+read_orders+write_orders+read_shipping+write_shipping+read_product_ads+seller_promotions+promotions+read_billing`;
  res.redirect(url);
});

app.get('/api/ml/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/app.html?tab=configuracoes&error=auth_cancelado');

  const data     = loadData();
  const num      = state || data.conta_ativa;
  const c        = data.contas[num] || {};
  // Força HTTPS no Railway (req.protocol pode retornar 'http' atrás do proxy)
  const proto    = req.get('x-forwarded-proto') || req.protocol;
  const callback = `${proto}://${req.get('host')}/api/ml/callback`;

  addLog(`OAuth callback recebido — conta ${num}, redirect_uri: ${callback}`, 'info');

  if (!c.client_secret) {
    return res.redirect('/app.html?tab=configuracoes&error=auth_falhou&detalhe=' +
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
    res.redirect(`/app.html?tab=configuracoes&connected=true&conta=${num}`);
  } catch (err) {
    const detalhe = JSON.stringify(err.response?.data || err.message);
    addLog(`❌ Erro no token exchange: ${detalhe}`, 'erro');
    res.redirect(`/app.html?tab=configuracoes&error=auth_falhou&detalhe=${encodeURIComponent(detalhe)}`);
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
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ connected: false });
  res.json({ connected: true, nickname: c.nickname || null });
});

app.get('/api/ml/store', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  let c      = contaAtiva(data, num);
  addLog(`[Loja] conta_ativa=${num} access_token=${c.access_token ? 'OK' : 'AUSENTE'}`, 'info');
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

// ── Estoque Local ─────────────────────────────────────────────
function addEstoqueHistorico(data, entry) {
  data.estoque_local_historico = data.estoque_local_historico || [];
  data.estoque_local_historico.push({ ...entry, ts: new Date().toISOString() });
  if (data.estoque_local_historico.length > 2000) {
    data.estoque_local_historico = data.estoque_local_historico.slice(-2000);
  }
}

app.get('/api/estoque-local', (req, res) => {
  const data = loadData();
  res.json({ estoque_local: data.estoque_local });
});

app.post('/api/estoque-local', (req, res) => {
  const { sku, quantidade, usuario } = req.body;
  if (!sku || quantidade === undefined) {
    return res.status(400).json({ erro: 'SKU e quantidade obrigatórios' });
  }

  const data = loadData();
  const skuKey = String(sku);
  const anterior = data.estoque_local[skuKey] !== undefined ? data.estoque_local[skuKey] : null;

  if (quantidade === '' || quantidade === null) {
    delete data.estoque_local[skuKey];
    if (anterior !== null) {
      addEstoqueHistorico(data, { sku: skuKey, anterior, novo: null, tipo: 'manual', usuario: usuario || 'Desconhecido' });
    }
  } else {
    const num = parseInt(quantidade);
    if (isNaN(num) || num < 0) {
      return res.status(400).json({ erro: 'Quantidade deve ser um número positivo' });
    }
    data.estoque_local[skuKey] = num;
    addEstoqueHistorico(data, { sku: skuKey, anterior, novo: num, tipo: 'manual', usuario: usuario || 'Desconhecido' });
  }

  saveData(data);
  res.json({ ok: true, estoque_local: data.estoque_local });
});

// Sincroniza estoque local descontando vendas próprias (não-Full) desde a última verificação
app.post('/api/estoque-local/sync', async (req, res) => {
  const { items, conta } = req.body; // items: [{mlb, sku}]
  if (!Array.isArray(items)) return res.status(400).json({ erro: 'items obrigatório' });

  const data     = loadData();
  const contaNum = conta || data.conta_ativa || '1';
  const lastCheck = data.estoque_local_last_check[contaNum];

  // Primeira vez: registra timestamp e retorna sem processar histórico
  if (!lastCheck) {
    data.estoque_local_last_check[contaNum] = new Date().toISOString();
    saveData(data);
    return res.json({ estoque_local: data.estoque_local });
  }

  // Monta mapa MLB -> SKU (só itens com SKU válido, exclui '—')
  const mlbToSku = {};
  for (const item of items) {
    if (item.mlb && item.sku && item.sku !== '—') mlbToSku[item.mlb] = String(item.sku);
  }

  try {
    const token = await getToken(data, contaNum);
    const c     = data.contas[contaNum];

    // Busca pedidos pagos desde última verificação (paginado, até 200)
    let orders = [];
    let offset = 0;
    while (orders.length < 200) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:                    c.user_id,
          'order.status':            'paid',
          'order.date_created.from': lastCheck,
          sort:                      'date_asc',
          offset,
          limit:                     50,
        },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      const results = resp.data.results || [];
      orders = orders.concat(results);
      if (results.length < 50) break;
      offset += 50;
    }

    for (const order of orders) {
      // Full: ML envia do próprio estoque, não afeta local
      if (order.shipping?.logistic_type === 'fulfillment') continue;

      const deducted = [];
      for (const oi of (order.order_items || [])) {
        const sku = mlbToSku[oi.item.id];
        if (!sku || data.estoque_local[sku] === undefined) continue;
        const qty = oi.quantity || 1;
        const anterior = data.estoque_local[sku];
        data.estoque_local[sku] = Math.max(0, anterior - qty);
        addEstoqueHistorico(data, { sku, anterior, novo: data.estoque_local[sku], tipo: 'venda', pedido_id: order.id, usuario: 'Automático' });
        deducted.push({ sku, qty });
      }
      if (deducted.length > 0) {
        data.estoque_local_deducted_orders[String(order.id)] = {
          items: deducted,
          date:  order.date_created,
        };
      }
    }

    // Busca pedidos cancelados dos últimos 90 dias e reverte deduções registradas
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let cancelled = [];
    offset = 0;
    while (cancelled.length < 500) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:                    c.user_id,
          'order.status':            'cancelled',
          'order.date_created.from': ninetyDaysAgo,
          sort:                      'date_asc',
          offset,
          limit:                     50,
        },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      const results = resp.data.results || [];
      cancelled = cancelled.concat(results);
      if (results.length < 50) break;
      offset += 50;
    }

    for (const order of cancelled) {
      const orderId  = String(order.id);
      const recorded = data.estoque_local_deducted_orders[orderId];
      if (!recorded) continue;
      for (const { sku, qty } of recorded.items) {
        if (data.estoque_local[sku] !== undefined) {
          const anterior = data.estoque_local[sku];
          data.estoque_local[sku] += qty;
          addEstoqueHistorico(data, { sku, anterior, novo: data.estoque_local[sku], tipo: 'cancelamento', pedido_id: orderId, usuario: 'Automático' });
        }
      }
      delete data.estoque_local_deducted_orders[orderId];
    }

    // Remove registros com mais de 90 dias (limpeza)
    for (const [orderId, record] of Object.entries(data.estoque_local_deducted_orders)) {
      if (record.date && record.date < ninetyDaysAgo) {
        delete data.estoque_local_deducted_orders[orderId];
      }
    }

    data.estoque_local_last_check[contaNum] = new Date().toISOString();
    saveData(data);
    res.json({ estoque_local: data.estoque_local });
  } catch (err) {
    res.json({ estoque_local: data.estoque_local, aviso: 'Erro ao consultar pedidos ML' });
  }
});

app.get('/api/estoque-local/historico', (req, res) => {
  const data = loadData();
  const sku = req.query.sku;
  let hist = data.estoque_local_historico || [];
  if (sku) hist = hist.filter(e => e.sku === sku);
  res.json({ historico: hist.slice(-200).reverse() });
});

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

    if (!tok) return res.status(500).json({ erro: 'Sem token ML — reconecte a conta.' });

    const resp = await axios.get('https://api.mercadolibre.com/sites/MLB/search', {
      params: { q, limit: 50 },
      headers: { Authorization: `Bearer ${tok}` },
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
      const rNotas = await axios.get('https://api.bling.com.br/Api/v3/nfe', {
        headers: { Authorization: `Bearer ${token}` },
        params: { pagina: 1, limite: 100 }, timeout: 10000,
      }).catch(() => null);
      const notas = (rNotas?.data?.data || []).filter(n => n.situacao === 1);

      // Usa cache da aba Bling se disponível (count filtrado por ML); senão conta bruto
      let pedidos;
      if (blingPedidosCache[conta] !== null) {
        pedidos = blingPedidosCache[conta].count;
      } else {
        const rPedidos = await axios.get('https://api.bling.com.br/Api/v3/pedidos/vendas', {
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
  if (!clientId) return res.redirect('/app.html?tab=configuracoes&bling_error=sem_client_id');
  const state = `${conta}_${Math.random().toString(36).slice(2)}`;
  const url = `https://api.bling.com.br/Api/v3/oauth/authorize`
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
    return res.redirect(`/app.html?tab=configuracoes&bling_error=${encodeURIComponent(error || 'sem_code')}`);
  }
  const { id: clientId, secret: clientSecret } = getBlingCreds(conta);
  if (!clientId || !clientSecret)
    return res.redirect('/app.html?tab=configuracoes&bling_error=sem_credenciais');

  const proto    = req.get('x-forwarded-proto') || req.protocol;
  const callback = `${proto}://${req.get('host')}/api/bling/callback`;
  const creds    = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const resp = await axios.post(
      'https://api.bling.com.br/Api/v3/oauth/token',
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
    res.redirect(`/app.html?tab=configuracoes&bling_connected=true&bling_conta=${conta}`);
  } catch (err) {
    const detalhe = JSON.stringify(err.response?.data || err.message);
    addLog(`[bling] ❌ Erro no token exchange: ${detalhe}`, 'erro');
    res.redirect(`/app.html?tab=configuracoes&bling_error=${encodeURIComponent(detalhe)}`);
  }
});

// Renova o access_token usando o refresh_token
// Mutex por conta: evita dois refreshes simultâneos com o mesmo refresh_token
// (Bling rotaciona o refresh_token — uso duplicado invalida a sessão inteira)
const blingRefreshEmAndamento = {};

async function blingRefreshToken(conta) {
  if (blingRefreshEmAndamento[conta]) {
    addLog(`[bling] refresh conta ${conta} já em andamento — aguardando`, 'info');
    try { return await blingRefreshEmAndamento[conta]; } catch { /* cai no throw abaixo */ }
    // Se o refresh em andamento falhou, relança o erro (lido do disco)
    const dataPos = loadData();
    const bPos = getBlingDataConta(dataPos, conta);
    if (bPos?.access_token) return bPos.access_token;
    throw new Error(`Bling conta ${conta} — refresh anterior falhou`);
  }

  const p = _executarRefreshBling(conta);
  blingRefreshEmAndamento[conta] = p;
  p.finally(() => { blingRefreshEmAndamento[conta] = null; });
  return p;
}

async function _executarRefreshBling(conta) {
  const data = loadData();
  const b = getBlingDataConta(data, conta);
  if (!b?.refresh_token) throw new Error(`Sem refresh_token do Bling (conta ${conta})`);
  const { id: clientId, secret: clientSecret } = getBlingCreds(conta);
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let resp;
  try {
    resp = await axios.post(
      'https://api.bling.com.br/Api/v3/oauth/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: b.refresh_token }),
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    const detalhe = body ? JSON.stringify(body) : err.message;
    addLog(`[bling] ❌ Falha ao renovar token conta ${conta}: ${detalhe}`, 'erro');

    // invalid_grant = refresh token inválido/expirado — limpa tokens para evitar loop infinito de tentativas
    if (body?.error?.type === 'invalid_grant' || body?.error === 'invalid_grant') {
      addLog(`[bling] ⚠️ Conta ${conta}: refresh_token inválido — desconectando conta (reconexão manual necessária)`, 'warn');
      const dataClean = loadData();
      delete dataClean[`bling_${conta}`];
      if (conta === '1') delete dataClean.bling;
      saveData(dataClean);
    }

    // 429 = rate limit — aguarda 5s antes de lançar erro
    if (status === 429) {
      await new Promise(r => setTimeout(r, 5000));
    }

    throw new Error(`Falha ao renovar token Bling conta ${conta}: ${detalhe}`);
  }
  const updated = {
    access_token:  resp.data.access_token,
    refresh_token: resp.data.refresh_token || b.refresh_token,
    expires_at:    Date.now() + ((resp.data.expires_in || 21600) - 300) * 1000,
  };
  // Re-lê do disco antes de salvar para não sobrescrever dados de outros requests
  const dataFresh = loadData();
  dataFresh[`bling_${conta}`] = updated;
  if (conta === '1') dataFresh.bling = updated;
  saveData(dataFresh);
  addLog(`[bling] 🔄 Token conta ${conta} renovado — expira ${new Date(updated.expires_at).toLocaleTimeString('pt-BR')}`, 'ok');
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

// Renovação proativa: verifica a cada 30 min e renova tokens com menos de 2h de vida
// Contas são renovadas sequencialmente (3s de intervalo) para evitar 429 no Bling
setInterval(async () => {
  for (const conta of ['1', '2']) {
    const data = loadData();
    const b = getBlingDataConta(data, conta);
    if (!b?.access_token || !b?.refresh_token) continue;
    const minutosRestantes = Math.round(((b.expires_at || 0) - Date.now()) / 60000);
    if (minutosRestantes < 120) {
      addLog(`[bling] Renovação proativa conta ${conta} (${minutosRestantes}min restantes)`, 'info');
      await blingRefreshToken(conta).catch(e => addLog(`[bling] Renovação proativa conta ${conta} falhou: ${e.message}`, 'warn'));
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}, 30 * 60 * 1000);

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

async function fetchBlingPedidosPendentes(conta) {
  const token = await getBlingToken(conta);
  const resp = await axios.get('https://api.bling.com.br/Api/v3/pedidos/vendas', {
    headers: { Authorization: `Bearer ${token}` },
    params: { pagina: 1, limite: 100, idSituacao: 6 },
    timeout: 15000,
  });
  const itens = resp.data?.data || [];
  addLog(`[bling] conta ${conta}: ${itens.length} pedidos encontrados`, 'info');

  // Busca detalhe de cada pedido para obter o numeroLoja correto e os itens
  // (em paralelo, com limite de concorrência para não estourar rate limit do Bling)
  const CONCORRENCIA_DETALHE = 6;
  const detalhesPorPedido = new Array(itens.length);
  let proximoIndice = 0;
  async function worker() {
    while (proximoIndice < itens.length) {
      const idx = proximoIndice++;
      const p = itens[idx];
      let detalhe = null;
      let ultimoErro = null;
      for (let tentativa = 0; tentativa < 3 && !detalhe; tentativa++) {
        if (tentativa > 0) await new Promise(r => setTimeout(r, 600 * tentativa));
        detalhe = await axios.get(`https://api.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
        }).then(r => r.data?.data || null).catch(e => { ultimoErro = e; return null; });
      }
      if (!detalhe) addLog(`[bling] falha ao buscar detalhe do pedido #${p.numero} (id ${p.id}) após 3 tentativas: ${ultimoErro?.response?.status || ultimoErro?.message || '?'}`, 'warn');
      detalhesPorPedido[idx] = detalhe;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA_DETALHE, itens.length) }, worker));

  const itensDetalhados = itens.map((p, idx) => {
    const detalhe = detalhesPorPedido[idx];
    const produtos = (detalhe?.itens || []).map(i => `${i.descricao}${i.quantidade > 1 ? ` (x${i.quantidade})` : ''}`);
    const pendencias = [];
    if (!detalhe) {
      pendencias.push('Falha ao consultar pedido no Bling — tentar atualizar');
    } else {
      if (!detalhe.contato?.numeroDocumento?.trim()) pendencias.push('CPF/CNPJ não informado');
      const itensSemProduto = (detalhe.itens || []).filter(i => !i?.produto?.id);
      if (itensSemProduto.length > 0) pendencias.push(`Produto não cadastrado: ${itensSemProduto.map(i => i.descricao || '?').join(', ')}`);
    }
    const numeroLojaVal = detalhe?.numeroLoja || p.numeroLoja || '';
    const isML     = /^\d{10,}$/.test(numeroLojaVal);
    const isShopee = !!numeroLojaVal && !isML;
    const canalNome = isShopee ? 'Shopee' : (isML ? 'Mercado Livre' : '');
    return { ...p, numeroLoja: detalhe?.numeroLoja || p.numeroLoja, produtos, pendencias, canal: canalNome, isShopee, lojaId: detalhe?.loja?.id || null };
  });

  // Verifica no ML quais têm shipment ready_to_ship (etiqueta disponível ao emitir NF)
  const mlData = loadData();
  const mlTokens = (await Promise.all(
    ['1', '2'].map(c => getToken(mlData, c).catch(() => null))
  )).filter(Boolean);

  const idsComEtiqueta = new Set();
  if (mlTokens.length > 0) {
    const mlOrders = await Promise.all(
      itensDetalhados.map(async p => {
        if (p.isShopee) return null;
        if (!p.numeroLoja) {
          addLog(`[bling-etq] #${p.numero} sem numeroLoja — pulado`, 'warn');
          return null;
        }
        const lbl = `#${p.numero} (ML:${p.numeroLoja})`;
        for (const tok of mlTokens) {
          // tenta como order
          const resOrder = await axios.get(`https://api.mercadolibre.com/orders/${p.numeroLoja}`, {
            headers: { Authorization: `Bearer ${tok}` }, timeout: 6000,
          }).catch(e => ({ _err: e.response?.status }));
          if (resOrder?.data?.shipping?.id) return { blingId: p.id, shippingId: resOrder.data.shipping.id, tok };
          if (resOrder?._err && resOrder._err !== 404) continue; // 403 = conta errada, tenta próximo token

          // fallback: tenta como pack (quando numeroLoja é um pack_id)
          const resPack = await axios.get(`https://api.mercadolibre.com/packs/${p.numeroLoja}`, {
            headers: { Authorization: `Bearer ${tok}` }, timeout: 6000,
          }).catch(e => ({ _err: e.response?.status }));
          if (resPack?.data?.shipment?.id) {
            addLog(`[bling-etq] ${lbl} encontrado como PACK`, 'info');
            return { blingId: p.id, shippingId: resPack.data.shipment.id, tok };
          }
          if (resPack?._err && resPack._err !== 404) continue;
          addLog(`[bling-etq] ${lbl} não encontrado (order:${resOrder?._err} pack:${resPack?._err})`, 'warn');
        }
        return null;
      })
    );
    const shippingEntries = mlOrders.filter(o => o?.shippingId);
    const shipments = await Promise.all(
      shippingEntries.map(o =>
        axios.get(`https://api.mercadolibre.com/shipments/${o.shippingId}`, {
          headers: { Authorization: `Bearer ${o.tok}` }, timeout: 6000,
        }).then(r => ({ blingId: o.blingId, status: r.data?.status, substatus: r.data?.substatus }))
          .catch(e => { addLog(`[bling-etq] blingId ${o.blingId} erro shipment: ${e.response?.status} ${e.message}`, 'warn'); return null; })
      )
    );
    shipments.filter(Boolean).forEach(s => {
      const num = itensDetalhados.find(p => p.id === s.blingId)?.numero || s.blingId;
      addLog(`[bling-etq] #${num}: status=${s.status} substatus=${s.substatus}`, 'info');
      if (s?.status === 'ready_to_ship' && s?.substatus === 'invoice_pending') idsComEtiqueta.add(s.blingId);
    });
    addLog(`[bling-etq] conta ${conta}: ${idsComEtiqueta.size}/${itens.length} com etiqueta`, 'info');
  }

  blingPedidosCache[conta] = { count: idsComEtiqueta.size, ts: Date.now() };

  return itensDetalhados.map(p => ({
    id:               p.id,
    numero:           p.numero || '—',
    comprador:        p.contato?.nome || '—',
    valor_total:      p.totalProdutos || 0,
    data:             p.data,
    situacao:         p.situacao?.valor || 'Em aberto',
    numeroPedidoLoja: p.numeroLoja || null,
    dataPrevista:     p.dataPrevista || null,
    produtos:         p.produtos || [],
    canal:            p.canal || null,
    lojaId:           p.lojaId || null,
    temEtiqueta:      p.isShopee ? false : (mlTokens.length > 0 ? idsComEtiqueta.has(p.id) : true),
    pendencias:       p.pendencias || [],
    conta,
  }));
}

// Página de diagnóstico: logs de etiqueta ML em tempo real
app.get('/api/bling/log-etiqueta', (req, res) => {
  const logs = logBuffer.filter(e => e.msg && e.msg.includes('[bling-etq]'));
  const linhas = logs.map(e => {
    const cor = e.tipo === 'warn' ? '#f59e0b' : e.tipo === 'erro' ? '#ef4444' : '#34d399';
    const hora = new Date(e.ts).toLocaleTimeString('pt-BR');
    return `<div style="color:${cor};font-family:monospace;font-size:13px;padding:2px 0">[${hora}] ${e.msg}</div>`;
  }).join('') || '<div style="color:#6b7280;font-family:monospace">Nenhum log ainda — abra a aba Bling para gerar.</div>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Log Etiqueta ML</title>
  <meta http-equiv="refresh" content="5">
  <style>body{background:#111;color:#e5e7eb;padding:20px;margin:0}h2{color:#fff;margin-bottom:16px}</style>
  </head><body>
  <h2>Log Etiqueta ML <small style="font-size:13px;color:#9ca3af">(atualiza a cada 5s)</small></h2>
  ${linhas}
  <p style="color:#6b7280;font-size:11px;margin-top:16px">Total: ${logs.length} entradas — últimas ${logBuffer.length} linhas do servidor em memória</p>
  </body></html>`);
});

// Endpoint temporário de diagnóstico: lista canal/loja de todos os pedidos pendentes de uma conta
app.get('/api/bling/debug-canais', async (req, res) => {
  try {
    const conta = blingContaReq(req); // ?conta=2
    const token = await getBlingToken(conta);
    const lista = await axios.get('https://api.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina: 1, limite: 100, idSituacao: 6 },
      timeout: 15000,
    });
    const itens = lista.data?.data || [];
    const resultado = [];
    for (const p of itens) {
      const det = await axios.get(`https://api.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      }).then(r => r.data?.data || {}).catch(() => ({}));
      resultado.push({ id: p.id, numero: det.numero || p.numero, contato: det.contato?.nome, canal: det.canal, loja: det.loja, numeroLoja: det.numeroLoja });
    }
    return res.json(resultado);
  } catch (err) {
    return res.json({ erro: err.response?.data || err.message });
  }
});

app.get('/api/bling/pedidos-pendentes', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const pedidos = await fetchBlingPedidosPendentes(conta);
    pedidos.sort((a, b) => (b.temEtiqueta ? 1 : 0) - (a.temEtiqueta ? 1 : 0));
    return res.json({ pedidos });
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
    addLog(`[bling] pedidos-pendentes: ${detail}`, 'warn');
    return res.json({ erro: detail });
  }
});

app.get('/api/bling/pedidos-pendentes-todas', async (req, res) => {
  try {
    const data = loadData();
    const contasAtivas = ['1', '2'].filter(c => !!(getBlingDataConta(data, c)?.access_token));
    if (contasAtivas.length === 0) return res.json({ erro: 'Nenhuma conta Bling conectada.' });
    const resultados = await Promise.allSettled(contasAtivas.map(c => fetchBlingPedidosPendentes(c)));
    const pedidos = [];
    const erros = [];
    resultados.forEach((r, i) => {
      if (r.status === 'fulfilled') pedidos.push(...r.value);
      else erros.push(`Conta ${contasAtivas[i]}: ${r.reason?.response ? `HTTP ${r.reason.response.status}: ${JSON.stringify(r.reason.response.data).slice(0,150)}` : r.reason?.message}`);
    });
    if (pedidos.length === 0 && erros.length > 0) return res.json({ erro: erros.join(' | ') });
    pedidos.sort((a, b) => (b.temEtiqueta ? 1 : 0) - (a.temEtiqueta ? 1 : 0));
    return res.json({ pedidos });
  } catch (err) {
    return res.json({ erro: err.message });
  }
});

// ── Bling: notas pendentes de envio ──────────────────────────

app.get('/api/bling/notas-pendentes', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const token = await getBlingToken(conta);
    const resp  = await axios.get('https://api.bling.com.br/Api/v3/nfe', {
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

// ── Bling: NFs Shopee autorizadas (pendentes de envio para marketplace) ──

app.get('/api/bling/nfs-shopee-marketplace', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const token = await getBlingToken(conta);
    const resp  = await axios.get('https://api.bling.com.br/Api/v3/nfe', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina: 1, limite: 50 },
      timeout: 15000,
    });
    const nfs = resp.data?.data || [];
    const resultado = [];
    for (const nf of nfs) {
      const det = await axios.get(`https://api.bling.com.br/Api/v3/nfe/${nf.id}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      }).then(r => r.data?.data || {}).catch(() => ({}));

      // numeroPedidoLoja é o campo correto no Bling v3 (não numeroLoja)
      const numeroPedidoLoja = det.numeroPedidoLoja || nf.numeroPedidoLoja || '';
      const lojaId           = det.loja?.id || nf.loja?.id || null;
      const chaveAcesso      = det.chaveAcesso || '';

      // Filtra apenas NFs com pedido de loja (Shopee, ML, etc.)
      if (!numeroPedidoLoja) continue;

      resultado.push({
        id:               nf.id,
        numero:           nf.numero || det.numero || '—',
        destinatario:     det.contato?.nome || nf.contato?.nome || '—',
        valor_total:      det.valorNota || nf.valorNota || 0,
        situacao:         String(det.situacao || nf.situacao || '—'),
        data:             det.dataEmissao || nf.dataEmissao,
        numeroPedidoLoja,
        lojaId,
        chaveAcesso,
      });
    }
    return res.json({ nfs: resultado });
  } catch (err) {
    const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 200)}` : err.message;
    return res.json({ erro: detail });
  }
});

// Debug: retorna dados brutos do Bling para uma NF específica
app.get('/api/bling/nf-raw/:nfId', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const token = await getBlingToken(conta);
    const det = await axios.get(`https://api.bling.com.br/Api/v3/nfe/${req.params.nfId}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
    });
    return res.json(det.data);
  } catch (err) {
    const detail = err.response ? { status: err.response.status, body: err.response.data } : { message: err.message };
    return res.json({ erro: detail });
  }
});

// ── Bling: tentar enviar NF para marketplace (debug) ──────────

app.post('/api/bling/enviar-marketplace/:nfId', async (req, res) => {
  const conta  = blingContaReq(req);
  const { lojaId, numeroPedidoLoja, chaveAcesso } = req.body;
  const nfId = req.params.nfId;

  // Tenta todas as estratégias conhecidas, com delays para não estourar 3 req/s
  const tentativas = [];
  try {
    const token = await getBlingToken(conta);

    const estrategias = [
      // 1. Mudar situação NF para 6 (o XAJAX enviava situacao:6) — pode acionar marketplace
      { label: 'PUT /nfe situacao:6', fn: async () => {
        return axios.put(`https://api.bling.com.br/Api/v3/nfe/${nfId}`, { situacao: { id: 6 } },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
      }},
      // 2. PATCH situação
      { label: 'PATCH situacoes', fn: async () => {
        return axios.post(`https://api.bling.com.br/Api/v3/nfe/${nfId}/situacoes`, { situacao: { id: 6 } },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
      }},
      // 3. enviar-dados-lojas-virtuais com corpo completo extraído do XAJAX
      { label: 'enviar-dados-lojas-virtuais (corpo completo)', fn: async () => {
        return axios.post(`https://api.bling.com.br/Api/v3/nfe/${nfId}/enviar-dados-lojas-virtuais`,
          { idLoja: lojaId, enviarDadosNfe: true, codigoRastreamento: false, numeroLojaVirtual: numeroPedidoLoja, chaveAcesso },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
      }},
    ];

    for (const e of estrategias) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const r = await e.fn();
        addLog(`[bling] enviar-marketplace NF ${nfId} SUCESSO via [${e.label}]`, 'ok');
        return res.json({ ok: true, estrategia: e.label, resposta: r.data });
      } catch (err) {
        let status = err.response?.status, body = err.response?.data;
        if (status === 429) {
          await new Promise(r => setTimeout(r, 3000));
          try {
            const r2 = await e.fn();
            return res.json({ ok: true, estrategia: e.label + ' (retry)', resposta: r2.data });
          } catch (e2) { status = e2.response?.status; body = e2.response?.data; }
        }
        tentativas.push({ estrategia: e.label, status, body });
        addLog(`[bling] enviar-marketplace [${e.label}]: ${status} ${JSON.stringify(body).slice(0,150)}`, 'warn');
      }
    }
    return res.json({ ok: false, tentativas });
  } catch (err) {
    return res.json({ ok: false, erro: err.message });
  }
});

// ── Shopee: envia NF diretamente pela API da Shopee ───────────
// O botão "Enviar dados para Loja Virtual" do Bling usa XAJAX interno (requer sessão browser).
// Replicamos chamando a API pública da Shopee com os dados da NF.
app.post('/api/shopee/enviar-nf', async (req, res) => {
  const { orderSn, chaveAcesso, nfNumero } = req.body;
  if (!orderSn || !chaveAcesso) return res.json({ ok: false, erro: 'orderSn e chaveAcesso obrigatórios' });

  const data = loadData();
  const sp   = data.shopee || {};
  if (!sp.access_token) return res.json({ ok: false, erro: 'Shopee não conectada — use a opção via Bling situação 6' });

  const tentativas = [];

  // Endpoints candidatos da Shopee para NF-e Brasil
  const candidatos = [
    {
      label: 'upload_doc',
      path:  '/api/v2/logistics/upload_doc',
      method: 'POST',
      body: { order_sn: orderSn, package_number: null, doc_type: 'NF_KEY', doc_data: chaveAcesso },
    },
    {
      label: 'set_actual_shipping_info (non_integrated)',
      path:  '/api/v2/logistics/set_actual_shipping_info',
      method: 'POST',
      body: { order_sn: orderSn, package_number: null, non_integrated: { tracking_number: chaveAcesso } },
    },
    {
      label: 'ship_order (non_integrated)',
      path:  '/api/v2/logistics/ship_order',
      method: 'POST',
      body: { order_sn: orderSn, package_number: null, non_integrated: { tracking_number: chaveAcesso } },
    },
  ];

  for (const c of candidatos) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const params = shopeeParams(c.path, sp.partner_key, sp.partner_id, sp.access_token, sp.shop_id);
      const r = await axios.post(`${SHOPEE_BASE}${c.path.replace('/api/v2', '')}`, c.body, { params, timeout: 15000 });
      addLog(`[shopee] enviar-nf ${orderSn} SUCESSO via ${c.label}`, 'ok');
      return res.json({ ok: true, endpoint: c.label, resposta: r.data });
    } catch (err) {
      const t = { endpoint: c.label, status: err.response?.status, body: err.response?.data, msg: err.message };
      tentativas.push(t);
      addLog(`[shopee] enviar-nf ${c.label}: ${t.status} ${JSON.stringify(t.body).slice(0, 150)}`, 'warn');
    }
  }
  return res.json({ ok: false, tentativas });
});

// ── Bling: helpers de emissão ─────────────────────────────────

async function blingEmitirNFHelper(pedidoId, conta) {
  const token = await getBlingToken(conta);
  const resp  = await axios.post(
    `https://api.bling.com.br/Api/v3/pedidos/vendas/${pedidoId}/gerar-nfe`,
    {},
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  const nfId = resp.data?.data?.idNotaFiscal ?? resp.data?.data?.id;
  if (!nfId) throw new Error(`gerar-nfe não retornou ID. Resposta: ${JSON.stringify(resp.data).slice(0, 200)}`);
  addLog(`[bling] NF gerada para pedido ${pedidoId} — NF id=${nfId}`, 'ok');
  return nfId;
}

async function blingEnviarNFHelper(nfId, conta) {
  const token = await getBlingToken(conta);
  let lastErr;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (tentativa > 0) await new Promise(r => setTimeout(r, 4000 * tentativa));
    try {
      await axios.post(`https://api.bling.com.br/Api/v3/nfe/${nfId}/enviar`, {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 25000 }
      );
      addLog(`[bling] NF ${nfId} enviada para SEFAZ (tentativa ${tentativa + 1})`, 'ok');
      return;
    } catch (err) {
      lastErr = err;
      addLog(`[bling] enviar NF ${nfId} tentativa ${tentativa + 1} falhou: ${err.response ? JSON.stringify(err.response.data).slice(0,150) : err.message}`, 'warn');
    }
  }
  throw lastErr;
}

async function blingAguardarAutorizacaoNF(nfId, token, maxMs = 60000) {
  const inicio = Date.now();
  while (Date.now() - inicio < maxMs) {
    const r = await axios.get(`https://api.bling.com.br/Api/v3/nfe/${nfId}`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
    }).catch(() => null);
    const sit = r?.data?.data?.situacao;
    addLog(`[bling] aguardando NF ${nfId}: id=${sit?.id} valor="${sit?.valor}"`, 'info');
    if (/autorizada/i.test(sit?.valor || '')) return;
    if (/denegad|cancelad|rejeitad/i.test(sit?.valor || '')) throw new Error(`NF ${nfId} rejeitada: ${sit?.valor}`);
    await new Promise(r => setTimeout(r, 5000));
  }
  // Timeout sem confirmar — tenta enviar para loja mesmo assim; Bling retornará erro se NF não estiver autorizada
  addLog(`[bling] NF ${nfId} não confirmada em ${maxMs / 1000}s — tentando enviar para loja mesmo assim`, 'warn');
}


// ── Bling: emitir NF para pedido ML ──────────────────────────

app.post('/api/bling/emitir-nf/:pedidoId', async (req, res) => {
  try {
    const conta = blingContaReq(req);
    const nfId  = await blingEmitirNFHelper(req.params.pedidoId, conta);
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
    await blingEnviarNFHelper(req.params.notaId, conta);
    return res.json({ ok: true });
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
    addLog(`[bling] enviar-nf: ${detail}`, 'warn');
    return res.json({ ok: false, erro: detail });
  }
});

// ── Bling: Shopee Super — gera NF + envia SEFAZ + envia dados para Shopee ──

app.post('/api/bling/shopee-super/:pedidoId', async (req, res) => {
  const conta = blingContaReq(req);
  const blingErrDetail = err => {
    try { return err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data ?? null).slice(0, 300)}` : (err.message || 'erro'); }
    catch { return err.message || 'erro'; }
  };
  let etapa = 'gerar-nf';
  try {
    addLog(`[bling] shopee-super pedido ${req.params.pedidoId}`, 'info');
    const nfId = await blingEmitirNFHelper(req.params.pedidoId, conta);
    etapa = 'enviar-sefaz';
    await new Promise(r => setTimeout(r, 3500));
    await blingEnviarNFHelper(nfId, conta);
    addLog(`[bling] shopee-super pedido ${req.params.pedidoId} NF ${nfId} transmitida`, 'ok');
    return res.json({ ok: true, nfId });
  } catch (err) {
    const detail = blingErrDetail(err);
    addLog(`[bling] shopee-super [${etapa}] pedido ${req.params.pedidoId}: ${detail}`, 'warn');
    return res.json({ ok: false, etapa, erro: `[${etapa}] ${detail}` });
  }
});

// ── Auto Super: notificação + confirmação via link ─────────────

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

function autoSuperHtml(ok, msg) {
  const cor   = ok ? '#15803d' : '#dc2626';
  const bg    = ok ? '#f0fdf4' : '#fff1f2';
  const icone = ok ? '✅' : '❌';
  const titulo = ok ? 'NF Emitida!' : 'Erro';
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:${bg};margin:0}
.box{text-align:center;padding:40px 32px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px;width:90%}
.icon{font-size:60px;margin-bottom:12px}.title{font-size:22px;font-weight:700;color:${cor}}.msg{color:#64748b;margin-top:12px;line-height:1.6;font-size:15px}</style>
</head><body><div class="box"><div class="icon">${icone}</div><div class="title">${titulo}</div><p class="msg">${msg}</p></div></body></html>`;
}

async function autoSuperJob() {
  if (!APP_URL) {
    addLog('[auto-super] APP_URL não configurado — job desativado', 'warn');
    return;
  }
  const data = loadData();
  if (!data.auto_super_notificados) data.auto_super_notificados = {};
  if (!data.auto_super_emitidos)    data.auto_super_emitidos    = {};
  if (!data.auto_super_tokens)      data.auto_super_tokens      = {};

  const agora = Date.now();
  // Limpa tokens expirados
  for (const tk of Object.keys(data.auto_super_tokens)) {
    if (agora > data.auto_super_tokens[tk].expiresAt) delete data.auto_super_tokens[tk];
  }

  const contasBling = ['1', '2'].filter(c => !!(getBlingDataConta(data, c)?.access_token));
  if (!contasBling.length) { saveData(data); return; }

  let changed = false;
  for (const conta of contasBling) {
    let pedidos = [];
    try { pedidos = await fetchBlingPedidosPendentes(conta); } catch (err) {
      addLog(`[auto-super] erro conta ${conta}: ${err.message}`, 'warn'); continue;
    }
    for (const p of pedidos.filter(p => p.temEtiqueta)) {
      const chave = `${p.id}_${conta}`;
      if (data.auto_super_notificados[chave] || data.auto_super_emitidos[chave]) continue;

      const token = crypto.randomBytes(24).toString('hex');
      data.auto_super_tokens[token] = {
        pedidoId: String(p.id), conta, comprador: p.comprador,
        valor: p.valor_total, numero: p.numero, produtos: p.produtos || [],
        expiresAt: agora + 48 * 3600_000,
      };
      data.auto_super_notificados[chave] = agora;
      changed = true;

      const link    = `${APP_URL}/api/bling/confirmar/${token}`;
      const valor   = (p.valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const prods   = (p.produtos || []).join('\n• ');
      const texto   = `⚡ Pedido pronto para NF\n\n#${p.numero} — ${p.comprador} — ${valor}\nConta ${conta}${prods ? `\n\n• ${prods}` : ''}\n\nConfirmar emissão:\n${link}\n\n(Link válido por 48h)`;
      notificar(texto).catch(() => {});
      addLog(`[auto-super] notificado pedido ${p.numero} conta ${conta}`, 'ok');
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  if (changed) saveData(data);
}

app.get('/api/bling/confirmar/:token', async (req, res) => {
  const data  = loadData();
  const info  = (data.auto_super_tokens || {})[req.params.token];

  if (!info)                    return res.send(autoSuperHtml(false, 'Link inválido ou expirado.<br>Emita manualmente na aba Bling.'));
  if (Date.now() > info.expiresAt) {
    delete data.auto_super_tokens[req.params.token];
    saveData(data);
    return res.send(autoSuperHtml(false, 'Link expirado.<br>Emita manualmente na aba Bling.'));
  }

  const { pedidoId, conta, comprador, valor, numero } = info;
  const chave = `${pedidoId}_${conta}`;
  if ((data.auto_super_emitidos || {})[chave])
    return res.send(autoSuperHtml(true, `Pedido #${numero} já havia sido emitido.`));

  try {
    const nfId = await blingEmitirNFHelper(pedidoId, conta);
    await blingEnviarNFHelper(nfId, conta);

    if (!data.auto_super_emitidos) data.auto_super_emitidos = {};
    data.auto_super_emitidos[chave] = Date.now();
    delete data.auto_super_tokens[req.params.token];
    saveData(data);

    const valorFmt = (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    notificar(`✅ NF emitida automaticamente\n\n#${numero} — ${comprador} — ${valorFmt}\nConta ${conta}`).catch(() => {});
    addLog(`[auto-super] NF emitida e enviada: pedido ${numero} conta ${conta}`, 'ok');
    return res.send(autoSuperHtml(true, `Pedido #${numero} — ${comprador}<br>${valorFmt} · Conta ${conta}<br><br>NF gerada e enviada para a SEFAZ.`));
  } catch (err) {
    const detail = err.response ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
    addLog(`[auto-super] erro ao confirmar pedido ${numero}: ${detail}`, 'warn');
    return res.send(autoSuperHtml(false, `Erro: ${detail}<br><br>Tente novamente ou emita manualmente na aba Bling.`));
  }
});

app.get('/api/ml/estoque', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
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
          attributes: 'id,title,permalink,seller_custom_field,available_quantity,variations,shipping,attributes,status,sub_status,price,last_updated,catalog_product_id',
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 15000,
      });
      detalhes.push(...resp.data);
    }

    const pauseDates    = c.pause_dates || {};
    const catalogStates = c.catalog_states || {};
    const agora         = new Date().toISOString();
    let pauseChanged    = false;
    let catalogChanged  = false;

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
            // Salva snapshot automático no log do anúncio
            if (!data.item_logs) data.item_logs = {};
            const logs = data.item_logs[mlb] || [];
            logs.push({ ts: agora, status, sub_status: r.body.sub_status || [], price: r.body.price ?? null, available_quantity: r.body.available_quantity ?? 0 });
            if (logs.length > 200) logs.splice(0, logs.length - 200);
            data.item_logs[mlb] = logs;
          }
        } else {
          if (pauseDates[mlb]) {
            delete pauseDates[mlb];
            pauseChanged = true;
            // Salva snapshot automático quando anúncio é reativado
            if (!data.item_logs) data.item_logs = {};
            const logs = data.item_logs[mlb] || [];
            logs.push({ ts: agora, status, sub_status: r.body.sub_status || [], price: r.body.price ?? null, available_quantity: r.body.available_quantity ?? 0 });
            if (logs.length > 200) logs.splice(0, logs.length - 200);
            data.item_logs[mlb] = logs;
          }
        }

        // Detecta quando ML associa este anúncio a um catálogo
        const novoCatalogId = r.body.catalog_product_id || null;
        if (novoCatalogId && !catalogStates[mlb]) {
          catalogStates[mlb] = novoCatalogId;
          catalogChanged = true;
          const tituloC   = r.body.title || mlb;
          const contaNome = (data.contas[num] || {}).nickname || `Conta ${num}`;
          notificar(`📦 *Anúncio virou catálogo!*\n\n${tituloC}\n${mlb}\nID catálogo: ${novoCatalogId}\nConta: ${contaNome}`).catch(() => {});
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
          variacoes:        (r.body.variations || []).map(v => ({
            id:     v.id,
            nome:   (v.attribute_combinations || []).map(a => a.value_name).join(' / ') || `Var. ${v.id}`,
            estoque: v.available_quantity ?? 0,
          })),
          catalogProductId: r.body.catalog_product_id || null,
        };
      });

    if (pauseChanged || catalogChanged) {
      c.pause_dates    = pauseDates;
      c.catalog_states = catalogStates;
      saveData(data);
    }

    // Deduplica anúncios Full com mesmo catalog_product_id + SKU (listagens de catálogo ML)
    const seenCatalog = new Set();
    const itemsFinal = items.filter(item => {
      if (item.deposito === 'fulfillment' && item.catalogProductId) {
        const key = `${item.catalogProductId}::${item.sku}`;
        if (seenCatalog.has(key)) return false;
        seenCatalog.add(key);
      }
      return true;
    });

    res.json({ items: itemsFinal, total: itemsFinal.length });
  } catch (err) {
    console.error('Erro ao buscar estoque:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar anúncios. Tente novamente.' });
  }
});

app.get('/api/ml/item-log/:mlb', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num] || {};
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  const mlb = req.params.mlb.toUpperCase();

  try {
    const [itemResp, healthResp] = await Promise.allSettled([
      axios.get(`https://api.mercadolibre.com/items/${mlb}`, {
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 10000,
      }),
      axios.get(`https://api.mercadolibre.com/items/${mlb}/health`, {
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 10000,
      }),
    ]);

    if (itemResp.status === 'rejected') {
      const detail = itemResp.reason?.response?.data?.message || itemResp.reason?.message;
      return res.json({ error: detail || 'Erro ao buscar anúncio' });
    }

    const item   = itemResp.value.data;
    const health = healthResp.status === 'fulfilled' ? healthResp.value.data : null;

    // Snapshot: salva se estado mudou ou é o primeiro registro
    const snapshot = {
      ts:                 new Date().toISOString(),
      status:             item.status,
      sub_status:         item.sub_status || [],
      price:              item.price,
      available_quantity: item.available_quantity,
    };

    if (!data.item_logs) data.item_logs = {};
    const logs = data.item_logs[mlb] || [];
    const last = logs[logs.length - 1];
    const mudou = !last
      || last.status !== snapshot.status
      || JSON.stringify(last.sub_status) !== JSON.stringify(snapshot.sub_status)
      || last.price !== snapshot.price
      || last.available_quantity !== snapshot.available_quantity;

    if (mudou) {
      logs.push(snapshot);
      if (logs.length > 200) logs.splice(0, logs.length - 200);
      data.item_logs[mlb] = logs;
      saveData(data);
    }

    res.json({ item, health, snapshots: logs });
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    res.json({ error: detail || 'Erro ao buscar anúncio no Mercado Livre.' });
  }
});

app.get('/api/ml/item/:mlb', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num] || {};
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  const mlb = req.params.mlb;
  if (!mlb) return res.json({ error: 'MLB obrigatório' });

  try {
    const itemResp = await axios.get(`https://api.mercadolibre.com/items/${mlb}`, {
      params: { attributes: 'id,title,price,currency_id,available_quantity,permalink,status' },
      headers: { Authorization: `Bearer ${c.access_token}` },
      timeout: 10000,
    });
    res.json({ item: itemResp.data });
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data || err.message;
    console.error(`Erro ao buscar item ${mlb}:`, detail);
    res.json({ error: detail || 'Erro ao buscar anúncio no Mercado Livre.' });
  }
});

app.get('/api/ml/vendas30dias', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = contaAtiva(data, num);
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
  const data   = loadData();
  const rawMode = req.query.raw === '1'; // ?raw=1 retorna o shipment bruto do primeiro pedido
  const num  = req.query.conta || data.conta_ativa;
  const c    = contaAtiva(data, num);
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
        const scheduleLimit = shipment.shipping_option?.estimated_schedule_limit?.date;
        const handlingHoras = shipment.shipping_option?.estimated_delivery_time?.handling ?? 24;
        const criado        = new Date(shipment.date_created);
        const prazo         = scheduleLimit
          ? new Date(scheduleLimit).toISOString()
          : handlingHoras > 0
            ? new Date(criado.getTime() + handlingHoras * 3600_000).toISOString()
            : null;
        porShipment.set(sid, {
          orderId:        order.id,
          data:           order.date_created,
          dataDespacho:   shipment.date_shipped || prazo || order.date_created,
          comprador:      order.buyer?.nickname || '—',
          shipmentId:     shipment.id,
          conta:          num,
          status:         shipment.status,
          statusLabel:    STATUS_PT[shipment.status] || shipment.status,
          acaoLabel:      SUBSTATUS_LABEL[shipment.substatus] || 'Baixar',
          prazoDespacho:  prazo,
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

    // Registra no histórico todos os pedidos vistos agora
    const agora = new Date().toISOString();
    const histMap = new Map((c.historico_vendas || []).map(h => [String(h.shipmentId), h]));
    for (const v of [...porShipment.values()]) {
      const sid = String(v.shipmentId);
      const atendidaEntry = atendidasMap.get(sid);
      const existente = histMap.get(sid);
      histMap.set(sid, {
        orderId:      v.orderId,
        data:         v.data,
        dataDespacho: existente?.dataDespachoFinalizado === 'ml' ? existente.dataDespacho : (v.dataDespacho || v.prazoDespacho || v.data),
        dataDespachoFinalizado: existente?.dataDespachoFinalizado === 'ml' ? 'ml' : false,
        comprador:    v.comprador,
        shipmentId:   v.shipmentId,
        conta:        v.conta,
        status:       v.status,
        statusLabel:  v.statusLabel,
        itensLista:   v.itensLista,
        atendida:     !!atendidaEntry,
        atendidaEm:   atendidaEntry?.atendidaEm || null,
        primeiroVisto: existente?.primeiroVisto || agora,
        ultimoVisto:  agora,
      });
    }
    // Pedidos que saíram da lista ativa: busca date_shipped real no ML
    const recemSaidos = [...histMap.values()].filter(
      h => !porShipment.has(String(h.shipmentId)) && h.dataDespachoFinalizado !== 'ml' && h.shipmentId
    );
    for (let i = 0; i < recemSaidos.length; i += 5) {
      await Promise.all(recemSaidos.slice(i, i + 5).map(async h => {
        try {
          const r = await axios.get(`https://api.mercadolibre.com/shipments/${h.shipmentId}`, {
            headers: { Authorization: `Bearer ${c.access_token}` },
            timeout: 5000,
          });
          h.dataDespacho = r.data.date_shipped || h.ultimoVisto || agora;
        } catch {
          h.dataDespacho = h.ultimoVisto || agora;
        }
        h.dataDespachoFinalizado = 'ml';
      }));
    }
    const historico = [...histMap.values()]
      .sort((a, b) => b.primeiroVisto.localeCompare(a.primeiroVisto))
      .slice(0, 500);
    if (JSON.stringify(c.historico_vendas) !== JSON.stringify(historico)) {
      c.historico_vendas = historico;
      saveData(data);
    }

    res.json({ vendas });
  } catch (err) {
    console.error('Erro ao buscar vendas com etiqueta:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar vendas.' });
  }
});

app.get('/api/ml/pedidos-futuros', async (req, res) => {
  const data    = loadData();
  const rawMode = req.query.raw === '1';
  const num  = req.query.conta || data.conta_ativa;
  const c    = contaAtiva(data, num);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)      return res.json({ error: 'user_id não encontrado' });

  const isFull = (s) => s && (
    s.logistic_type === 'fulfillment' ||
    s.logistic_type === 'fulfillment_reverse' ||
    (s.logistic_type || '').includes('fulfillment')
  );

  try {
    // Pedidos pagos com envio ainda pendente (vendedor não iniciou handling)
    const todasOrdens = [];
    let offset = 0;
    while (todasOrdens.length < 500) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:            c.user_id,
          'order.status':    'paid',
          'shipping.status': 'pending',
          sort:              'date_asc',
          offset,
          limit: 50,
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 15000,
      });
      const orders = resp.data.results || [];
      todasOrdens.push(...orders);
      if (orders.length < 50) break;
      offset += 50;
    }

    // Filtra apenas pedidos com shipment direto (não Full)
    const comShipment = todasOrdens.filter(o =>
      o.shipping?.id &&
      o.shipping.logistic_type !== 'fulfillment' &&
      o.shipping.mode !== 'fulfillment'
    );

    // Busca detalhes de shipment em lotes de 10
    const resultado = [];
    for (let i = 0; i < comShipment.length; i += 10) {
      const lote = comShipment.slice(i, i + 10);
      const detalhes = await Promise.all(
        lote.map(async (order) => {
          try {
            const r = await axios.get(`https://api.mercadolibre.com/shipments/${order.shipping.id}`, {
              headers: { Authorization: `Bearer ${c.access_token}` },
              timeout: 8000,
            });
            return { order, shipment: r.data };
          } catch {
            return { order, shipment: null };
          }
        })
      );
      resultado.push(...detalhes);
    }

    const filtradas = resultado.filter(({ shipment }) => shipment && !isFull(shipment));

    // Modo debug: retorna o shipment bruto do primeiro pedido
    if (rawMode && filtradas.length > 0) {
      return res.json({ debug_order: filtradas[0].order, debug_shipment: filtradas[0].shipment });
    }

    // Coleta MLBs únicos para buscar thumbnail e SKU
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
            let thumb = b.thumbnail || null;
            if (thumb) thumb = thumb.replace(/-[A-Z]\.jpg/, '-O.jpg');
            const varMap = {};
            for (const v of (b.variations || [])) {
              varMap[v.id] = (v.attribute_combinations || []).map(a => a.value_name).join(' / ') || `Var. ${v.id}`;
            }
            itemMap[b.id] = { thumbnail: thumb, sku: sku !== '—' ? sku : null, permalink: b.permalink || null, variations: varMap };
          }
        }
      } catch {}
    }

    const pedidos = [];
    for (const { order, shipment } of filtradas) {
      const bufferingDate = shipment.shipping_option?.buffering?.date;
      const scheduleLimit = shipment.shipping_option?.estimated_schedule_limit?.date;
      const payBefore     = shipment.shipping_option?.estimated_delivery_time?.pay_before;
      const dataLiberacao = (bufferingDate || scheduleLimit || payBefore)
        ? new Date(bufferingDate || scheduleLimit || payBefore).toISOString()
        : new Date(shipment.date_created).toISOString();

      const itensLista = [];
      for (const i of (order.order_items || [])) {
        const extra = itemMap[i.item.id] || {};
        let variacaoNome = null;
        if (i.item.variation_attributes?.length > 0) {
          variacaoNome = i.item.variation_attributes.map(a => a.value_name).join(' / ');
        } else if (extra.variations && i.item.variation_id) {
          variacaoNome = extra.variations[i.item.variation_id] || null;
        }
        itensLista.push({
          titulo:     i.item.title,
          variacao:   variacaoNome,
          sku:        extra.sku || '—',
          thumbnail:  extra.thumbnail || null,
          permalink:  extra.permalink || null,
          quantidade: i.quantity || 1,
        });
      }

      pedidos.push({
        orderId:       order.id,
        data:          order.date_created,
        comprador:     order.buyer?.nickname || order.buyer?.first_name || 'Desconhecido',
        shipmentId:    shipment.id,
        conta:         num,
        dataLiberacao,
        itensLista,
      });
    }

    pedidos.sort((a, b) => a.dataLiberacao.localeCompare(b.dataLiberacao));
    res.json({ pedidos });
  } catch (err) {
    console.error('Erro ao buscar pedidos futuros:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar pedidos futuros.' });
  }
});

app.get('/api/vendas/historico', (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c) return res.json({ historico: [] });
  const { de, ate } = req.query;
  let historico = c.historico_vendas || [];
  const dataOrdenar = h => (h.dataDespacho || h.data || '').slice(0, 10);
  if (de)  historico = historico.filter(h => dataOrdenar(h) >= de);
  if (ate) historico = historico.filter(h => dataOrdenar(h) <= ate);
  historico = historico.sort((a, b) => dataOrdenar(b).localeCompare(dataOrdenar(a)));
  res.json({ historico });
});

app.post('/api/vendas/historico/sincronizar', async (req, res) => {
  const data = loadData();
  const num  = req.body.conta || req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c?.access_token) return res.json({ ok: false, erro: 'Não conectado' });

  const sete = new Date();
  sete.setDate(sete.getDate() - 7);
  const limite = sete.toISOString();

  const pendentes = (c.historico_vendas || []).filter(h =>
    h.dataDespachoFinalizado !== 'ml' &&
    h.shipmentId &&
    (h.primeiroVisto || h.data || '') >= limite
  );

  let atualizados = 0;
  for (let i = 0; i < pendentes.length; i += 5) {
    await Promise.all(pendentes.slice(i, i + 5).map(async h => {
      try {
        const r = await axios.get(`https://api.mercadolibre.com/shipments/${h.shipmentId}`, {
          headers: { Authorization: `Bearer ${c.access_token}` },
          timeout: 5000,
        });
        h.dataDespacho = r.data.date_shipped || h.ultimoVisto || h.data;
      } catch {
        h.dataDespacho = h.ultimoVisto || h.data;
      }
      h.dataDespachoFinalizado = 'ml';
      atualizados++;
    }));
  }

  if (atualizados > 0) saveData(data);
  res.json({ ok: true, atualizados });
});

app.post('/api/vendas/atendida', (req, res) => {
  const { shipmentId, venda } = req.body;
  if (!shipmentId) return res.json({ error: 'shipmentId obrigatório' });
  const data = loadData();
  const num  = req.body.conta || data.conta_ativa;
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
  verificarTodosPedidosAtendidos().catch(e => addLog(`[atendida] notif-todos erro: ${e.message}`, 'warn'));
});

app.delete('/api/vendas/atendida', (req, res) => {
  const { shipmentId } = req.body;
  if (!shipmentId) return res.json({ error: 'shipmentId obrigatório' });
  const data = loadData();
  const num  = req.body.conta || data.conta_ativa;
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
  const num  = req.body.conta || data.conta_ativa;
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
  syncRailwayEnvVars(data).catch(e => console.error('[atendidas-batch] sync erro:', e.message));
  res.json({ ok: true });
  verificarTodosPedidosAtendidos().catch(e => addLog(`[atendidas-batch] notif-todos erro: ${e.message}`, 'warn'));
});

app.delete('/api/vendas/atendidas-batch', async (req, res) => {
  const { shipmentIds } = req.body;
  if (!Array.isArray(shipmentIds) || !shipmentIds.length) return res.status(400).json({ error: 'shipmentIds obrigatório' });
  const data = loadData();
  const num  = req.body.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c) return res.json({ error: 'Conta não encontrada' });
  const sids = new Set(shipmentIds.map(String));
  c.atendidas_dados = (c.atendidas_dados || []).filter(v => !sids.has(String(v.shipmentId)));
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[atendidas-batch-del] sync erro:', e.message));
  res.json({ ok: true });
});


// ── Promoções ──────────────────────────────────────────────────

// Cache de frete médio por SKU (TTL 1h por conta)
const _fretePorSkuCache = {};

async function calcFretePorSku(data, c) {
  const num    = String(data.conta_ativa || '1');
  const cached = _fretePorSkuCache[num];
  if (cached && Date.now() - cached.ts < 3600000) return cached.data;

  const headers  = { Authorization: `Bearer ${c.access_token}` };
  const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Busca últimos 30 dias de pedidos pagos (max 200)
  let ordens = [];
  let off = 0;
  while (ordens.length < 200) {
    try {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: c.user_id, 'order.status': 'paid', sort: 'date_desc', limit: 50, offset: off,
                  'order.date_created.from': dateFrom + 'T00:00:00.000-03:00' },
        headers, timeout: 15000,
      });
      const results = resp.data.results || [];
      ordens = ordens.concat(results);
      if (results.length < 50) break;
      off += 50;
    } catch { break; }
  }

  // Custo de frete por shipment
  const shipIds = [...new Set(ordens.map(o => o.shipping?.id).filter(Boolean))];
  const fretePorShipment = {};
  for (let i = 0; i < shipIds.length; i += 25) {
    await Promise.all(shipIds.slice(i, i + 25).map(async sid => {
      try {
        const r = await axios.get(`https://api.mercadolibre.com/shipments/${sid}/costs`, { headers, timeout: 8000 });
        const senders = r.data?.senders || [];
        const sender  = senders.find(sv => sv.user_id == c.user_id) || senders[0];
        fretePorShipment[sid] = sender?.cost ?? 0;
      } catch { fretePorShipment[sid] = 0; }
    }));
  }

  // Agrupa frete por SKU
  const acc = {};
  for (const order of ordens) {
    const frete = fretePorShipment[order.shipping?.id] ?? 0;
    for (const oi of (order.order_items || [])) {
      const sku = oi.item?.seller_sku;
      if (!sku) continue;
      if (!acc[sku]) acc[sku] = { sum: 0, n: 0 };
      acc[sku].sum += frete;
      acc[sku].n++;
    }
  }

  const result = {};
  for (const [sku, { sum, n }] of Object.entries(acc)) {
    result[sku] = n > 0 ? sum / n : 0;
  }

  _fretePorSkuCache[num] = { ts: Date.now(), data: result };
  addLog(`[promos] frete por SKU calculado: ${Object.keys(result).length} SKUs`, 'info');
  return result;
}

const PROMO_TIPO_LABEL_SERVER = {
  SMART:          'Oferta Inteligente',
  DOD:            'Oferta do Dia',
  DEAL:           'Deal do Dia',
  LIGHTNING_DEAL: 'Oferta Relâmpago',
  PRICE_DISCOUNT: 'Saia na Frente',
  FREE_SHIPPING:  'Frete Grátis',
  DEAL_OF_THE_DAY:'Oferta do Dia',
  SPECIAL_PRICE:  'Preço Especial',
  REBATE:         'Saia na Frente',
  FEE_REDUCTION:  'Redução de Tarifa',
};

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

  // Pega um item ativo para testar endpoints por item
  let primeiroItemId = null;
  try {
    const ri = await axios.get(`https://api.mercadolibre.com/users/${uid}/items/search`, {
      params: { status: 'active', limit: 1 }, headers: h, timeout: 8000,
    });
    primeiroItemId = ri.data?.results?.[0] || null;
  } catch {}

  const r = {};
  // v2 — parâmetro correto segundo documentação recente
  r['v2/promotions?candidate'] = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, app_version: 'v2', status: 'candidate', limit: 5 });
  r['v2/promotions?started']   = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, app_version: 'v2', status: 'started',   limit: 5 });
  r['v2/promotions?active']    = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, app_version: 'v2', status: 'active',    limit: 5 });
  r['v2/promotions (sem status)'] = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, app_version: 'v2', limit: 5 });
  // sem app_version para comparar
  r['v1/promotions (sem status)'] = await testar(`https://api.mercadolibre.com/seller-promotions/promotions`, { seller_id: uid, limit: 5 });

  async function testarV2(url, params = {}) {
    try {
      const r = await axios.get(url, { params, headers: { ...h, 'x-version': '2' }, timeout: 8000 });
      return { status: r.status, ct: r.headers['content-type'], data: r.data };
    } catch (e) {
      return { status: e.response?.status, error: e.response?.data || e.message };
    }
  }

  if (primeiroItemId) {
    r[`seller-promotions/items/${primeiroItemId} (app_version=v2)`] = await testar(`https://api.mercadolibre.com/seller-promotions/items/${primeiroItemId}`, { app_version: 'v2' });
    r[`items/${primeiroItemId} (original_price+price)`]             = await testar(`https://api.mercadolibre.com/items/${primeiroItemId}`, { attributes: 'id,title,price,original_price,deal_ids' });
  }

  res.json({ user_id: uid, primeiro_item: primeiroItemId, r });
});

// Debug: retorna resposta bruta da API de promoções para um item específico
app.get('/api/ml/promocoes/debug-item', async (req, res) => {
  const { mlb } = req.query;
  if (!mlb) return res.json({ error: 'mlb obrigatório' });
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  try {
    const r = await axios.get(`https://api.mercadolibre.com/seller-promotions/items/${mlb}`, {
      params: { app_version: 'v2' },
      headers: { Authorization: `Bearer ${c.access_token}` },
      timeout: 10000, validateStatus: () => true,
    });
    res.json({ status: r.status, data: r.data });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/ml/promocoes', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = contaAtiva(data, num);
  if (!c.access_token) return res.json({ error: 'Não conectado ao Mercado Livre' });
  if (!c.user_id)      return res.json({ error: 'user_id não encontrado — reconecte a conta' });

  const headers = { Authorization: `Bearer ${c.access_token}` };
  const uid     = c.user_id;

  try {
    // 1. Coleta IDs de itens ativos (até 200)
    const itemIds = [];
    let offset = 0;
    while (itemIds.length < 200) {
      const r = await axios.get(`https://api.mercadolibre.com/users/${uid}/items/search`, {
        params: { status: 'active', limit: 100, offset },
        headers, timeout: 15000,
      });
      const ids   = r.data.results || [];
      const total = r.data.paging?.total || 0;
      itemIds.push(...ids);
      offset += ids.length;
      if (!ids.length || offset >= total) break;
    }
    addLog(`[promos] ${itemIds.length} itens ativos`, 'info');
    if (!itemIds.length) return res.json({ itens: [], erroApi: 'Nenhum item ativo encontrado' });

    // 2. Detalhes dos itens em lotes de 20 (paralelo)
    const itemDetails = {};
    const detChunks = Array.from({ length: Math.ceil(itemIds.length / 20) }, (_, i) => itemIds.slice(i * 20, i * 20 + 20));
    await Promise.all(detChunks.map(async chunk => {
      try {
        const r = await axios.get('https://api.mercadolibre.com/items', {
          params: { ids: chunk.join(','), attributes: 'id,title,thumbnail,price,listing_type_id,seller_custom_field,permalink,attributes,variations' },
          headers, timeout: 12000,
        });
        for (const e of (r.data || [])) {
          if (e.code !== 200) continue;
          const b = e.body;
          itemDetails[b.id] = {
            titulo:      b.title,
            thumbnail:   b.thumbnail?.replace(/-[A-Z]\.jpg/, '-O.jpg') || null,
            preco:       b.price,
            sku:         extrairSku(b) || '—',
            permalink:   b.permalink || null,
            listingType: b.listing_type_id || null,
          };
        }
      } catch {}
    }));

    // 3. Promoções por item via seller-promotions/items/{id}?app_version=v2
    //    Agrupado por item (não por promoção)
    const resultMap = {};
    const proChunks = Array.from({ length: Math.ceil(itemIds.length / 25) }, (_, i) => itemIds.slice(i * 25, i * 25 + 25));

    for (const chunk of proChunks) {
      await Promise.all(chunk.map(async itemId => {
        try {
          const r = await axios.get(`https://api.mercadolibre.com/seller-promotions/items/${itemId}`, {
            params: { app_version: 'v2' },
            headers, timeout: 10000, validateStatus: () => true,
          });
          if (r.status !== 200 || !Array.isArray(r.data) || !r.data.length) return;
          const info = itemDetails[itemId] || {};

          const promocoes = r.data.map(promo => {
            let precoPromo = null, descontoMin = null, descontoMax = null;
            const usaFaixa = ['PRICE_DISCOUNT', 'DOD', 'DEAL'].includes(promo.type);
            if (usaFaixa) {
              precoPromo = promo.suggested_discounted_price || promo.max_discounted_price || (promo.price > 0 ? promo.price : null) || null;
              const orig = promo.original_price;
              if (orig) {
                if (promo.max_discounted_price) descontoMin = Math.round((1 - promo.max_discounted_price / orig) * 100);
                if (promo.min_discounted_price) descontoMax = Math.round((1 - promo.min_discounted_price / orig) * 100);
              }
            } else {
              precoPromo  = promo.price || null;
              descontoMin = promo.seller_percentage ?? null;
            }
            return {
              id:           promo.id   || null,
              nome:         promo.name || PROMO_TIPO_LABEL_SERVER[promo.type] || promo.type || '—',
              tipo:         promo.type || 'PRICE_DISCOUNT',
              precoPromo,
              precoOriginal: promo.original_price || null,
              sellerPct:    promo.seller_percentage ?? null,
              meliPct:      promo.meli_percentage   ?? null,
              descontoMin,
              descontoMax,
              participando: promo.status === 'started',
              status:       promo.status || 'candidate',
              dataInicio:   promo.start_date  || null,
              dataFim:      promo.finish_date || null,
            };
          });

          resultMap[itemId] = {
            mlb:        itemId,
            titulo:     info.titulo      || '—',
            thumbnail:  info.thumbnail   || null,
            sku:        info.sku         || '—',
            permalink:  info.permalink   || null,
            precoAtual: info.preco       ?? null,
            listingType: info.listingType || null,
            promocoes,
          };
        } catch {}
      }));
    }

    const itens = Object.values(resultMap);
    addLog(`[promos] ${itens.length} itens com promoção, ${itens.reduce((s, i) => s + i.promocoes.length, 0)} oportunidades`, 'info');

    if (!itens.length) {
      return res.json({ itens: [], erroApi: `Nenhuma promoção disponível para os ${itemIds.length} itens ativos` });
    }

    const numConta = String(data.conta_ativa || '1');
    const lc = (data.lucro_contas || {})[numConta] || {};
    const fretePorSku = await calcFretePorSku(data, c).catch(() => ({}));
    const lucroConfig = {
      taxa_imposto:  lc.taxa_imposto ?? 0,
      frete_medio:   lc.frete_medio  ?? 0,
      frete_por_sku: fretePorSku,
      custos:        lc.custos       || {},
    };
    return res.json({ itens, lucroConfig, fonte: 'per-item-v2' });

  } catch (err) {
    console.error('Promoções:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar promoções: ' + (err.response?.data?.message || err.message) });
  }
});

app.post('/api/ml/promocoes/participar', async (req, res) => {
  const { mlb, promotion_id, preco } = req.body;
  if (!mlb || !promotion_id) return res.json({ error: 'mlb e promotion_id obrigatórios' });
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = contaAtiva(data, num);
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
  const num  = req.query.conta || data.conta_ativa;
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
    taxa_imposto:        lc.taxa_imposto         ?? 0,
    taxa_imposto_por_mes: lc.taxa_imposto_por_mes || {},
    frete_medio:         lc.frete_medio          ?? 0,
    custos:              lc.custos               || {},
    custos_historico:    lc.custos_historico     || {},
  });
});

// Retorna o valor vigente em uma data 'YYYY-MM-DD' dado um histórico ordenado ascendente
function custoVigenteNaData(historico, dataISO) {
  const data = (dataISO || '').slice(0, 10);
  let valor = 0;
  for (const h of (historico || [])) {
    if (h.desde <= data) valor = h.valor; else break;
  }
  return valor;
}

function lucroHojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

app.post('/api/lucro/taxa-imposto-mes', async (req, res) => {
  const { conta, mes, taxa } = req.body;
  const num = String(conta || '1');
  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'mes inválido' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.taxa_imposto_por_mes = lc.taxa_imposto_por_mes || {};
  lc.taxa_imposto_por_mes[mes] = parseFloat(taxa) || 0;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[taxa-imposto-mes] sync erro:', e.message));
  res.json({ ok: true });
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
  syncRailwayEnvVars(data).catch(e => console.error('[lucro/config] sync erro:', e.message));
  res.json({ ok: true });
});

app.post('/api/lucro/custo', async (req, res) => {
  const { conta, sku, custo, desde } = req.body;
  const num = String(conta || '1');
  if (!sku) return res.status(400).json({ error: 'sku obrigatório' });
  const dataVigencia = /^\d{4}-\d{2}-\d{2}$/.test(desde || '') ? desde : lucroHojeISO();
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.custos = lc.custos || {};
  lc.custos_historico = lc.custos_historico || {};

  // Migração lazy: preserva o valor flat antigo como vigente desde sempre,
  // antes de aplicar a nova entrada — não retroage vendas já calculadas.
  if (!lc.custos_historico[sku] && lc.custos[sku]) {
    lc.custos_historico[sku] = [{ desde: '1970-01-01', valor: lc.custos[sku] }];
  }
  lc.custos_historico[sku] = lc.custos_historico[sku] || [];

  const valor = parseFloat(custo) || 0;
  const hist  = lc.custos_historico[sku];
  const idx   = hist.findIndex(h => h.desde === dataVigencia);
  if (idx >= 0) hist[idx].valor = valor;
  else hist.push({ desde: dataVigencia, valor });
  hist.sort((a, b) => a.desde.localeCompare(b.desde));

  lc.custos[sku] = custoVigenteNaData(hist, lucroHojeISO());

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[lucro/custo] sync erro:', e.message));
  res.json({ ok: true, custos_historico: hist, custo_atual: lc.custos[sku] });
});

app.post('/api/lucro/custo-remover', async (req, res) => {
  const { conta, sku, desde } = req.body;
  const num = String(conta || '1');
  if (!sku || !desde) return res.status(400).json({ error: 'sku e desde obrigatórios' });
  const data = loadData();
  const lc = (data.lucro_contas || {})[num];
  if (!lc || !lc.custos_historico || !lc.custos_historico[sku]) return res.json({ ok: true });

  lc.custos_historico[sku] = lc.custos_historico[sku].filter(h => h.desde !== desde);
  if (lc.custos_historico[sku].length === 0) {
    delete lc.custos_historico[sku];
    lc.custos = lc.custos || {};
    lc.custos[sku] = 0;
  } else {
    lc.custos[sku] = custoVigenteNaData(lc.custos_historico[sku], lucroHojeISO());
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[lucro/custo-remover] sync erro:', e.message));
  res.json({ ok: true, custos_historico: lc.custos_historico[sku] || [], custo_atual: lc.custos[sku] });
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
  const data     = loadData();
  const num      = String(req.query.conta || data.conta_ativa || '1');
  const mes      = req.query.mes || new Date().toISOString().slice(0, 7);
  const lc       = (data.lucro_contas || {})[num] || {};
  const travados = lc.gastos_fixos_travados || [];
  const padrao   = lc.gastos_fixos_padrao   || {};
  const valoresMes = (lc.gastos_fixos_valores || {})[mes] || {};
  // Itens travados sem valor no mês herdam o valor padrão (último salvo)
  const valores = { ...valoresMes };
  for (const nome of travados) {
    if (!(nome in valores) && nome in padrao) {
      valores[nome] = padrao[nome];
    }
  }
  res.json({
    tipos:      lc.gastos_fixos_tipos || [],
    valores,
    valoresMes, // somente valores explicitamente salvos neste mês (sem auto-fill)
    travados,
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
  syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-tipo] sync erro:', e.message));
  res.json({ ok: true });
});

// Remove tipo
app.delete('/api/lucro/gastos-fixo-tipo', async (req, res) => {
  const { conta, nome } = req.body;
  const num = String(conta || '1');
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.gastos_fixos_tipos    = (lc.gastos_fixos_tipos    || []).filter(t => t !== nome);
  lc.gastos_fixos_travados = (lc.gastos_fixos_travados || []).filter(t => t !== nome);
  if (lc.gastos_fixos_padrao) delete lc.gastos_fixos_padrao[nome];
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-tipo] sync erro:', e.message));
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
  syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-valor] sync erro:', e.message));
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
  // Atualiza valor padrão para itens travados (cadeado)
  const travados = lc.gastos_fixos_travados || [];
  if (travados.length) {
    lc.gastos_fixos_padrao = lc.gastos_fixos_padrao || {};
    for (const nome of travados) {
      if (nome in valores) lc.gastos_fixos_padrao[nome] = parseFloat(valores[nome]) || 0;
    }
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-batch] sync erro:', e.message));
  res.json({ ok: true });
});

// Cache do DRE (Lucro ML + Ads por mês, calculados no front e salvos aqui)
app.get('/api/lucro/dre-cache', (req, res) => {
  const data = loadData();
  const num  = String(req.query.conta || data.conta_ativa || '1');
  const ano  = req.query.ano || String(new Date().getFullYear());
  const lc   = (data.lucro_contas || {})[num] || {};
  res.json({ cache: (lc.dre_cache || {})[ano] || {} });
});

app.post('/api/lucro/dre-cache-mes', async (req, res) => {
  const { conta, mes, lucroML, taxaML, frete, custo, imposto, ads } = req.body;
  const num = String(conta || '1');
  const ano = String(mes || '').slice(0, 4);
  if (!mes || !ano) return res.status(400).json({ error: 'mes inválido' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.dre_cache = lc.dre_cache || {};
  lc.dre_cache[ano] = lc.dre_cache[ano] || {};
  const pf = v => (v === null || v === undefined) ? null : (parseFloat(v) || 0);
  lc.dre_cache[ano][mes] = {
    lucroML:   pf(lucroML),
    taxaML:    pf(taxaML),
    frete:     pf(frete),
    custo:     pf(custo),
    imposto:   pf(imposto),
    ads:       parseFloat(ads) || 0,
    updatedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[dre-cache-mes] sync erro:', e.message));
  res.json({ ok: true });
});

// DRE local — gastos + fixos para todos os meses de um ano (sem chamada à API ML)
app.get('/api/lucro/dre-local', (req, res) => {
  const data     = loadData();
  const num      = String(req.query.conta || data.conta_ativa || '1');
  const ano      = parseInt(req.query.ano) || new Date().getFullYear();
  const lc       = (data.lucro_contas || {})[num] || {};
  const travados = lc.gastos_fixos_travados || [];
  const padrao   = lc.gastos_fixos_padrao   || {};
  const meses    = [];
  for (let m = 1; m <= 12; m++) {
    const mes         = `${ano}-${String(m).padStart(2, '0')}`;
    const gastosDoMes = (lc.gastos || {})[mes] || [];
    const fixosRaw    = (lc.gastos_fixos_valores || {})[mes] || {};
    // Auto-fill para itens travados sem valor no mês
    const fixos = { ...fixosRaw };
    for (const nome of travados) {
      if (!(nome in fixos) && nome in padrao) fixos[nome] = padrao[nome];
    }
    const totalEntradas  = gastosDoMes.filter(g => g.tipo === 'entrada').reduce((s, g) => s + g.valor, 0);
    const totalGastosVar = gastosDoMes.filter(g => g.tipo !== 'entrada').reduce((s, g) => s + g.valor, 0);
    const totalFixos     = Object.values(fixos).reduce((s, v) => s + (parseFloat(v) || 0), 0);
    meses.push({ mes, totalEntradas, totalGastosVar, totalFixos });
  }
  res.json({ meses });
});

// Ativa/desativa cadeado (valor padrão repetido todo mês)
app.post('/api/lucro/gastos-fixo-travado', async (req, res) => {
  const { conta, nome, travado, valor } = req.body;
  const num = String(conta || '1');
  if (!nome?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
  lc.gastos_fixos_travados = lc.gastos_fixos_travados || [];
  if (travado) {
    if (!lc.gastos_fixos_travados.includes(nome)) lc.gastos_fixos_travados.push(nome);
    // Salva valor atual como padrão ao travar
    if (valor !== null && valor !== undefined) {
      lc.gastos_fixos_padrao = lc.gastos_fixos_padrao || {};
      lc.gastos_fixos_padrao[nome] = parseFloat(valor) || 0;
    }
  } else {
    lc.gastos_fixos_travados = lc.gastos_fixos_travados.filter(t => t !== nome);
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[gastos-fixo-travado] sync erro:', e.message));
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
  const tipoVal = req.body.tipo === 'entrada' ? 'entrada' : 'gasto';
  lc.gastos[mes].push({ id, descricao: String(descricao || '').trim(), valor: parseFloat(valor) || 0, tipo: tipoVal });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(e => console.error('[lucro/gasto] sync erro:', e.message));
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
    syncRailwayEnvVars(data).catch(e => console.error('[lucro/gasto] sync erro:', e.message));
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

    // Pedidos num mesmo pack (mesmo shipping.id) dividem o custo do frete igualmente
    const pedidosPorShipment = {};
    todasOrdens.forEach(o => {
      const sid = o.shipping?.id;
      if (sid) pedidosPorShipment[sid] = (pedidosPorShipment[sid] || 0) + 1;
    });

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
      const sid       = order.shipping?.id;
      const freteBruto = fretePorShipment[sid] ?? 0;
      const freteReal  = sid ? freteBruto / (pedidosPorShipment[sid] || 1) : 0;
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

// Debug — shipment completo + lead_time a partir do order_id
app.get('/api/ml/debug-prazo/:order_id', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c?.access_token) return res.json({ error: 'Não conectado' });
  const headers = { Authorization: `Bearer ${c.access_token}` };
  try {
    const order = await axios.get(`https://api.mercadolibre.com/orders/${req.params.order_id}`, { headers, timeout: 10000 }).then(r => r.data);
    const sid   = order.shipping?.id;
    if (!sid) return res.json({ error: 'Pedido sem shipment' });
    const [rShip, rLead] = await Promise.allSettled([
      axios.get(`https://api.mercadolibre.com/shipments/${sid}`,           { headers, timeout: 10000 }),
      axios.get(`https://api.mercadolibre.com/shipments/${sid}/lead_time`, { headers, timeout: 10000 }),
    ]);
    res.json({
      order_id:  req.params.order_id,
      shipment_id: sid,
      shipment:  rShip.status === 'fulfilled' ? rShip.value.data : { error: rShip.reason?.message },
      lead_time: rLead.status === 'fulfilled' ? rLead.value.data : { error: rLead.reason?.message },
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

// Busca pedido pelo shipment ID (usado pelo scanner de QR code)
app.get('/api/ml/pedido-por-shipment/:id', async (req, res) => {
  const data = loadData();
  const sid  = String(req.params.id).trim();

  // Busca detalhes de itens (thumbnail + SKU) via API do ML em paralelo
  async function enriquecerItens(orderIds, token) {
    const itensLista = [];
    let comprador = '—';
    for (const orderId of orderIds) {
      try {
        const rOrder = await axios.get(`https://api.mercadolibre.com/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 6000,
        });
        comprador = rOrder.data.buyer?.nickname || comprador;
        const items = rOrder.data.order_items || [];
        const detalhes = await Promise.all(items.map(async i => {
          try {
            const r = await axios.get(`https://api.mercadolibre.com/items/${i.item.id}`, {
              headers: { Authorization: `Bearer ${token}` },
              params: { attributes: 'thumbnail,seller_custom_field,permalink' },
              timeout: 5000,
            });
            return { thumbnail: r.data.thumbnail || null, sku: r.data.seller_custom_field || null, permalink: r.data.permalink || null };
          } catch { return { thumbnail: null, sku: null, permalink: null }; }
        }));
        items.forEach((i, idx) => {
          const d = detalhes[idx];
          const variacaoNome = i.item.variation_attributes?.length
            ? i.item.variation_attributes.map(a => a.value_name).join(' / ') : null;
          itensLista.push({ titulo: i.item.title, variacao: variacaoNome, sku: d.sku || '—', thumbnail: d.thumbnail, permalink: d.permalink, quantidade: i.quantity || 1 });
        });
      } catch {}
    }
    return { itensLista, comprador };
  }

  // 1. Busca no histórico de todas as contas
  for (const [num, c] of Object.entries(data.contas || {})) {
    const base = (c.historico_vendas || []).find(h => String(h.shipmentId) === sid)
              || (c.atendidas_dados  || []).find(h => String(h.shipmentId) === sid);
    if (!base) continue;

    // Enriquece thumbnail/SKU se algum item estiver sem
    const semThumb = (base.itensLista || []).some(i => !i.thumbnail || !i.sku || i.sku === '—');
    if (semThumb && c.access_token && base.orderId) {
      try {
        const { itensLista, comprador } = await enriquecerItens([base.orderId], c.access_token);
        if (itensLista.length) base.itensLista = itensLista;
        if (comprador !== '—') base.comprador = comprador;
      } catch {}
    }
    return res.json({ encontrado: true, fonte: 'historico', conta: num, ...base });
  }

  // 2. Fallback: consulta shipment diretamente na API do ML
  for (const [num, c] of Object.entries(data.contas || {})) {
    if (!c.access_token) continue;
    try {
      const rShip = await axios.get(`https://api.mercadolibre.com/shipments/${sid}`, {
        headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 6000,
      });
      const shipment = rShip.data;
      const orderIds = shipment.order_ids?.length ? shipment.order_ids : (shipment.order_id ? [shipment.order_id] : []);
      if (!orderIds.length) continue;
      const { itensLista, comprador } = await enriquecerItens(orderIds, c.access_token);
      return res.json({ encontrado: true, fonte: 'ml-api', conta: num, shipmentId: sid, comprador, status: shipment.status, itensLista });
    } catch {}
  }

  res.status(404).json({ encontrado: false, erro: 'Shipment não encontrado em nenhuma conta' });
});

app.put('/api/ml/estoque/:mlb', async (req, res) => {
  const data = loadData();
  const num  = String(req.query.conta || data.conta_ativa || '1');
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.status(401).json({ error: `Não conectado (conta: ${num})` });

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

    res.json({ ok: true, conta: num, ml_user_id: c.user_id || null });
  } catch (err) {
    const mlErr = err.response?.data;
    console.error(`Erro ao atualizar estoque (conta=${num}):`, mlErr || err.message);
    const msg = mlErr?.message || mlErr?.error || mlErr?.cause?.[0]?.message || 'Erro ao atualizar no Mercado Livre';
    res.status(400).json({ error: msg, detalhe: JSON.stringify(mlErr), conta: num, ml_user_id: c.user_id || null });
  }
});

app.post('/api/ml/sair-full/:mlb', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.status(401).json({ error: 'Não conectado' });

  const mlb     = req.params.mlb;
  const headers = { Authorization: `Bearer ${c.access_token}`, 'Content-Type': 'application/json' };
  try {
    await axios.put(
      `https://api.mercadolibre.com/items/${mlb}`,
      { shipping: { logistic_type: 'not_specified', mode: 'me2' } },
      { headers, timeout: 15000 }
    );
    addLog(`[estoque] ${mlb} saiu do Full`, 'ok');
    return res.json({ ok: true });
  } catch (err) {
    const mlErr = err.response?.data;
    const msg   = mlErr?.message || mlErr?.error || mlErr?.cause?.[0]?.message || err.message;
    const notModifiable = JSON.stringify(mlErr).includes('logistic_type.not_modifiable');
    addLog(`[estoque] sair-full ${mlb}: ${JSON.stringify(mlErr)}`, 'warn');
    return res.json({ ok: false, erro: msg, detalhe: JSON.stringify(mlErr), notModifiable });
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
// Número 2: pedidos novos (CallMeBot)
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

// Notificações de pedidos novos — Telegram + CallMeBot
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

let _notificarTodosTimeout = null;

// Consulta a API do ML e retorna true se não houver pedidos notificados ainda não atendidos
async function checarNenhumPedidoPendente() {
  const data = loadData();
  const todasAtendidas = new Set();
  for (const num of ['1', '2']) {
    (data.contas?.[num]?.atendidas_dados || []).forEach(v => todasAtendidas.add(String(v.shipmentId)));
  }
  for (const num of ['1', '2']) {
    const c = data.contas?.[num];
    if (!c?.access_token) continue;
    try {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: { seller: c.user_id, 'order.status': 'paid', sort: 'date_desc', limit: 50 },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 10000,
      });
      for (const order of (resp.data.results || [])) {
        if (!order.shipping?.id) continue;
        const sid = String(order.shipping.id);
        if (shipmentsNotificados.has(sid) && !todasAtendidas.has(sid)) return false;
      }
    } catch (err) {
      addLog(`[atendidos] Erro ao checar pendentes conta ${num}: ${err.message}`, 'warn');
      return null;
    }
  }
  return true;
}

// Após marcar atendido: consulta API e notifica Bruno se fila zerou
async function verificarTodosPedidosAtendidos() {
  const resultado = await checarNenhumPedidoPendente();
  if (resultado !== true) return;
  // Aguarda 70s (> ciclo de polling de 60s) e re-verifica para evitar falso positivo
  if (_notificarTodosTimeout) clearTimeout(_notificarTodosTimeout);
  _notificarTodosTimeout = setTimeout(async () => {
    _notificarTodosTimeout = null;
    const confirmado = await checarNenhumPedidoPendente();
    if (confirmado === true) {
      addLog('[atendidos] Todos os pedidos atendidos — notificando Bruno', 'ok');
      await enviarWhatsApp(CALLMEBOT_PHONE_PEDIDOS, CALLMEBOT_APIKEY_PEDIDOS,
        '✅ Todos os pedidos foram embalados e atendidos!');
    }
  }, 70000);
}

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

// Limpa toda a lista de notificados para reprocessar pedidos pendentes
app.delete('/api/telegram/notificados/todos', (_req, res) => {
  shipmentsNotificados.clear();
  salvarShipmentsNotificados(shipmentsNotificados);
  res.json({ ok: true, mensagem: 'Lista de notificados limpa — próximo ciclo verifica todos os pedidos' });
});

async function verificarNovosShipmentsTelegram() {
  const temTelegram = TELEGRAM_TOKEN && TELEGRAM_CHAT_ID;
  const temWhatsApp = CALLMEBOT_PHONE_PEDIDOS && CALLMEBOT_APIKEY_PEDIDOS;
  if (!temTelegram && !temWhatsApp) return;
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
      addLog(`[pedido] Conta ${num}: ${orders.length} pedidos pagos encontrados na API`, 'info');

      for (const order of orders) {
        if (!order.shipping?.id) {
          addLog(`[pedido] #${order.id} pulado — sem shipping.id`, 'info');
          continue;
        }
        const sid = String(order.shipping.id);
        if (shipmentsNotificados.has(sid)) {
          addLog(`[pedido] #${order.id} (shipment ${sid}) pulado — já está em shipmentsNotificados`, 'info');
          continue;
        }

        try {
          const sr = await axios.get(`https://api.mercadolibre.com/shipments/${order.shipping.id}`, {
            headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 8000,
          });
          const shipment = sr.data;
          const isFull = (shipment.logistic_type || '').includes('fulfillment');
          addLog(`[pedido] #${order.id} status=${shipment.status} substatus=${shipment.substatus} full=${isFull}`, 'info');

          if (isFull) {
            shipmentsNotificados.add(sid);
            salvarShipmentsNotificados(shipmentsNotificados);
            continue;
          }
          if (!LABEL_STATUSES.has(shipment.status) || !LABEL_SUBSTATUSES.has(shipment.substatus)) {
            // etiqueta ainda não disponível — verifica de novo no próximo ciclo
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
          // Novo pedido chegou — cancela eventual timeout de "todos atendidos"
          if (_notificarTodosTimeout) { clearTimeout(_notificarTodosTimeout); _notificarTodosTimeout = null; }
          addLog(`[pedido] Notificação enviada — #${order.id}`, 'ok');
          await new Promise(r => setTimeout(r, 4000)); // evita rate limit do CallMeBot entre pedidos
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
  const temCanal = (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) || (CALLMEBOT_PHONE && CALLMEBOT_APIKEY);
  if (!temCanal) return;
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

// ── Polling em background: detecção de anúncios que viraram catálogo ─
async function verificarCatalogosML() {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) return;
  const data = loadData();
  for (const num of ['1', '2']) {
    const c = data.contas[num];
    if (!c || !c.access_token) continue;
    try {
      const catalogStates = c.catalog_states || {};
      let catalogChanged  = false;

      const idsAtivos = await buscarIdsStatus(c, 'active');
      if (!idsAtivos.length) continue;

      for (let i = 0; i < idsAtivos.length; i += 20) {
        const chunk = idsAtivos.slice(i, i + 20);
        try {
          const resp = await axios.get('https://api.mercadolibre.com/items', {
            params: { ids: chunk.join(','), attributes: 'id,title,catalog_product_id' },
            headers: { Authorization: `Bearer ${c.access_token}` },
            timeout: 10000,
          });
          for (const item of (resp.data || [])) {
            if (item.code !== 200) continue;
            const mlb       = item.body.id;
            const catalogId = item.body.catalog_product_id || null;
            if (catalogId && !catalogStates[mlb]) {
              catalogStates[mlb] = catalogId;
              catalogChanged = true;
              const titulo    = item.body.title || mlb;
              const contaNome = c.nickname || `Conta ${num}`;
              notificar(`📦 *Anúncio virou catálogo!*\n\n${titulo}\n${mlb}\nID catálogo: ${catalogId}\nConta: ${contaNome}`).catch(() => {});
              addLog(`Catálogo ML detectado: ${mlb} → ${catalogId}`, 'info');
            }
          }
        } catch {}
      }

      if (catalogChanged) {
        c.catalog_states = catalogStates;
        saveData(data);
      }
    } catch (err) {
      addLog(`Monitor catálogo conta ${num}: ${err.message}`, 'warn');
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

// Auto Super: verifica pedidos prontos para NF a cada 15 minutos
setInterval(() => autoSuperJob().catch(err => addLog(`[auto-super] erro no job: ${err.message}`, 'warn')), 15 * 60 * 1000);
// Roda 1x na inicialização (após 30s para tokens carregarem)
setTimeout(() => autoSuperJob().catch(err => addLog(`[auto-super] erro no job inicial: ${err.message}`, 'warn')), 30 * 1000);

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

app.post('/api/whatsapp/reenviar-estoque-baixo', async (req, res) => {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) {
    return res.json({ ok: false, erro: 'CALLMEBOT_PHONE ou CALLMEBOT_APIKEY não configurados' });
  }
  try {
    const data = loadData();
    for (const num of ['1', '2']) {
      if (data.contas[num]) data.contas[num].estoque_alerta_dates = {};
    }
    saveData(data);
    await verificarEstoqueBaixo();
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, erro: e.message });
  }
});

app.post('/api/whatsapp/teste-estoque-baixo', async (req, res) => {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) {
    return res.json({ ok: false, erro: 'CALLMEBOT_PHONE ou CALLMEBOT_APIKEY não configurados' });
  }
  try {
    const resp = await axios.get('https://api.callmebot.com/whatsapp.php', {
      params: { phone: CALLMEBOT_PHONE, text: '🧪 Teste — notificações de estoque/anúncios ativas!', apikey: CALLMEBOT_APIKEY },
      timeout: 10000,
    });
    const body = String(resp.data || '').trim();
    const erro = body.toLowerCase().includes('error') || body.toLowerCase().includes('wrong');
    addLog(`WhatsApp teste-estoque → ${CALLMEBOT_PHONE}: ${body}`, erro ? 'warn' : 'ok');
    res.json({ ok: !erro, resposta: body });
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

// Diagnóstico: mostra todos os campos distintos entre TODAS as notas
app.get('/api/fiscal/debug-campos', (req, res) => {
  const db = loadFiscalNotas();
  const notas = Object.values(db);
  // Coleta union de todos os campos
  const todosCampos = new Set();
  notas.forEach(n => Object.keys(n).forEach(k => todosCampos.add(k)));
  // Para cada campo, mostra exemplo de valor de uma nota que o tem
  const resultado = {};
  for (const campo of todosCampos) {
    const notaComCampo = notas.find(n => n[campo] != null && n[campo] !== '');
    if (notaComCampo) {
      const v = notaComCampo[campo];
      resultado[campo] = typeof v === 'string' && v.length > 80 ? `[string len=${v.length}]` : v;
    }
  }
  res.json({ totalNotas: notas.length, campos: resultado });
});

// Retorna notas agrupadas por CNPJ
app.get('/api/fiscal/notas', (req, res) => {
  const db = loadFiscalNotas();

  // Constrói set de chaves NF que têm XML no sistema DF-e (notas_contas)
  const data = loadData();
  const chavesComXml = new Set();
  for (const num of ['1', '2']) {
    const lista = (data.notas_contas || {})[num]?.lista || [];
    for (const item of lista) {
      if (item.zip && item.chNFe) chavesComXml.add(item.chNFe);
    }
  }

  // Chaves que já foram baixadas em algum momento (persiste via Railway env var FISCAL_BAIXADOS)
  const fiscalBaixados = new Set(data.fiscal_baixados || []);

  // Constrói set de chaves NF que tiveram CP lançado (chave CP = chNFe-nDup)
  const cpLancadas = new Set();
  for (const num of ['1', '2']) {
    const cp = (data.contas_pagar || {})[num] || [];
    for (const entry of cp) {
      if (entry.chave && entry.chave.length > 44) cpLancadas.add(entry.chave.slice(0, 44));
    }
  }

  const grupos = {};
  for (const n of Object.values(db)) {
    const cnpj = n.filial || '';
    if (!/^\d{14}$/.test(cnpj)) continue; // ignora entradas inválidas
    if (!grupos[cnpj]) grupos[cnpj] = { cnpj, nome: n.tomanome || cnpj, notas: [] };
    grupos[cnpj].notas.push({
      ...n,
      zip: undefined,
      temXml:    !!(n.zip || (n.chave && (chavesComXml.has(n.chave) || fiscalBaixados.has(n.chave) || cpLancadas.has(n.chave)))),
      cpLancado: !!(n.chave && cpLancadas.has(n.chave)),
    });
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
  const num  = String(req.query.conta || data.conta_ativa || '1');
  const cp   = (data.contas_pagar || {})[num] || [];
  res.json({ contas: cp });
});

app.post('/api/contas-pagar/xml', uploadMem.single('xml'), async (req, res) => {
  const data = loadData();
  const num  = String(req.query.conta || data.conta_ativa || '1');
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
  const num  = String(req.query.conta || data.conta_ativa || '1');
  const lista = (data.contas_pagar || {})[num] || [];
  const item  = lista.find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  item.pago   = !item.pago;
  item.pagoEm = item.pago ? new Date().toISOString() : null;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  agendarSyncContasPagar();
  res.json({ ok: true, pago: item.pago });
});

app.put('/api/contas-pagar/:id', (req, res) => {
  const { dVenc, vDup } = req.body;
  if (!dVenc || !/^\d{4}-\d{2}-\d{2}$/.test(dVenc)) return res.status(400).json({ error: 'dVenc inválido' });
  const vDupNum = parseFloat(vDup);
  if (isNaN(vDupNum) || vDupNum < 0) return res.status(400).json({ error: 'vDup inválido' });
  const data = loadData();
  const num  = String(req.query.conta || data.conta_ativa || '1');
  const lista = (data.contas_pagar || {})[num] || [];
  const item  = lista.find(c => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  item.dVenc = dVenc;
  item.vDup  = vDupNum;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  agendarSyncContasPagar();
  res.json({ ok: true });
});

app.delete('/api/contas-pagar/:id', async (req, res) => {
  const data = loadData();
  const num  = String(req.query.conta || data.conta_ativa || '1');
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

// Lista NFs que tiveram XML baixado — útil para saber o que relançar no contas a pagar
app.get('/api/admin/nfs-baixadas', (req, res) => {
  const data = loadData();
  const baixados = new Set(data.fiscal_baixados || []);
  if (!baixados.size) return res.json({ total: 0, nfs: [] });

  const nfs = [];
  for (const num of ['1', '2']) {
    const lista = ((data.notas_contas || {})[num] || {}).lista || [];
    for (const n of lista) {
      if (n.chave && baixados.has(n.chave)) {
        nfs.push({
          chave:      n.chave,
          conta:      num,
          fornecedor: n.emit?.xNome || n.tomanome || '—',
          cnpjForn:   n.emit?.CNPJ  || n.filial   || '—',
          nNF:        n.nNF  || '—',
          serie:      n.serie || '—',
          dEmi:       n.dEmi  || n.dtemi || '—',
          valor:      n.vNF   || n.valor || 0,
        });
      }
    }
  }
  // Ordena por data decrescente
  nfs.sort((a, b) => (b.dEmi || '').localeCompare(a.dEmi || ''));
  res.json({ total: nfs.size, nfs });
});

// ── Backup / Restore ─────────────────────────────────────────
app.get('/api/admin/backup', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) return res.status(404).json({ error: 'Sem dados' });
  const hoje = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="backup-${hoje}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(fs.readFileSync(DATA_FILE, 'utf-8'));
});

app.post('/api/admin/restore', express.json({ limit: '20mb' }), (req, res) => {
  const data = req.body;
  if (!data || !data.contas) return res.status(400).json({ error: 'Arquivo inválido — falta campo contas' });
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.pre-restore');
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

app.get('/api/admin/backup-snapshots', (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const arquivos = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data.backup.') && f.endsWith('.json'))
      .sort().reverse();
    const snapshots = arquivos.map(nome => {
      const stat = fs.statSync(path.join(BACKUP_DIR, nome));
      const kb = Math.round(stat.size / 1024);
      return { nome, tamanho: `${kb} KB` };
    });
    res.json({ snapshots });
  } catch { res.json({ snapshots: [] }); }
});

app.get('/api/admin/backup-snapshot/:nome', (req, res) => {
  const nome = path.basename(req.params.nome); // evita path traversal
  const arquivo = path.join(BACKUP_DIR, nome);
  if (!fs.existsSync(arquivo)) return res.status(404).json({ error: 'Não encontrado' });
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(fs.readFileSync(arquivo, 'utf-8'));
});

app.post('/api/admin/backup-snapshot-restore/:nome', (req, res) => {
  const nome = path.basename(req.params.nome);
  const arquivo = path.join(BACKUP_DIR, nome);
  if (!fs.existsSync(arquivo)) return res.status(404).json({ error: 'Snapshot não encontrado' });
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.pre-restore');
  fs.copyFileSync(arquivo, DATA_FILE);
  res.json({ ok: true });
});

app.post('/api/sync/force', (req, res) => {
  agendarSyncContasPagar();
  res.json({ ok: true, msg: 'Sync agendado — acompanhe /api/sync/status' });
});

// Restauração de emergência: força releitura de TODAS as env vars mesmo com volume presente.
app.post('/api/admin/restore-envvars', (req, res) => {
  try {
    const bak = DATA_FILE + '.bak';
    if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, bak);
    fs.unlinkSync(DATA_FILE);
  } catch {}
  initFromEnvVars();
  res.json({ ok: true, msg: 'Dados restaurados das env vars. Acesse o app normalmente.' });
});

// Restaura apenas configuração de lucro/gastos/DRE das env vars, sem tocar no resto.
app.post('/api/admin/restore-lucro-envvars', (req, res) => {
  const data = loadData();
  data.lucro_contas = data.lucro_contas || {};
  for (const num of ['1', '2']) {
    const lc = data.lucro_contas[num] = data.lucro_contas[num] || {};
    if (process.env[`LUCRO_CONFIG_${num}`]) {
      try { const cfg = JSON.parse(process.env[`LUCRO_CONFIG_${num}`]); Object.assign(lc, cfg); } catch {}
    }
    if (process.env[`DRE_CACHE_${num}`])          { try { lc.dre_cache             = JSON.parse(process.env[`DRE_CACHE_${num}`]);          } catch {} }
    if (process.env[`GASTOS_DATA_${num}`])         { try { lc.gastos               = JSON.parse(process.env[`GASTOS_DATA_${num}`]);         } catch {} }
    if (process.env[`GASTOS_FIXOS_TIPOS_${num}`])  { try { lc.gastos_fixos_tipos   = JSON.parse(process.env[`GASTOS_FIXOS_TIPOS_${num}`]);  } catch {} }
    if (process.env[`GASTOS_FIXOS_VALS_${num}`])   { try { lc.gastos_fixos_valores = JSON.parse(process.env[`GASTOS_FIXOS_VALS_${num}`]);   } catch {} }
    if (process.env[`GASTOS_FIXOS_TRAV_${num}`])   { try { lc.gastos_fixos_travados= JSON.parse(process.env[`GASTOS_FIXOS_TRAV_${num}`]);   } catch {} }
    if (process.env[`GASTOS_FIXOS_PAD_${num}`])    { try { lc.gastos_fixos_padrao  = JSON.parse(process.env[`GASTOS_FIXOS_PAD_${num}`]);    } catch {} }
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  res.json({ ok: true, msg: 'Lucro/gastos/DRE restaurados das env vars.' });
});

// Mescla o backup (data.json.bak) com dados atuais.
// Estratégia: backup é a base (tem estoque local, fornecedores, contas a pagar, etc.)
// Tokens ML e Bling do estado atual (env vars) sobrescrevem o backup por serem mais recentes.
app.post('/api/admin/merge-backup', (req, res) => {
  const bak = DATA_FILE + '.bak';
  if (!fs.existsSync(bak)) return res.status(404).json({ error: 'Backup não encontrado' });
  let backup, current;
  try { backup = JSON.parse(fs.readFileSync(bak, 'utf-8')); } catch { return res.status(500).json({ error: 'Backup corrompido/ilegível' }); }
  try { current = loadData(); } catch { current = {}; }

  // Base = backup (preserva estoque local, fornecedores, etc.)
  const merged = JSON.parse(JSON.stringify(backup));

  // Tokens ML mais recentes das env vars sobrescrevem o backup
  for (const num of ['1', '2']) {
    const cur = (current.contas || {})[num] || {};
    merged.contas = merged.contas || {};
    merged.contas[num] = merged.contas[num] || {};
    ['client_id','client_secret','access_token','refresh_token','user_id','token_expires_at'].forEach(k => {
      if (cur[k]) merged.contas[num][k] = cur[k];
    });
    // Tokens Bling
    const bKey = `bling_${num}`;
    if ((current[bKey] || {}).access_token) merged[bKey] = current[bKey];
    // Contas a pagar: usa o conjunto com mais registros
    const cpBak = ((backup.contas_pagar || {})[num] || []);
    const cpCur = ((current.contas_pagar || {})[num] || []);
    merged.contas_pagar = merged.contas_pagar || {};
    merged.contas_pagar[num] = cpBak.length >= cpCur.length ? cpBak : cpCur;
  }
  if ((current.bling || {}).access_token) merged.bling = current.bling;

  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2));
  res.json({ ok: true, msg: 'Dados mesclados: backup restaurado com tokens atualizados das env vars.' });
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
  if (!cnpj) throw new Error('CNPJ não encontrado no certificado. Use um certificado e-CNPJ ICP-Brasil válido ou informe o CNPJ manualmente.');
  return { cnpj, titular };
}

async function queryNFeByChave(pfxBuffer, senha, cnpj, cUF, chNFe) {
  const soapBody = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><soapenv:Header/><soapenv:Body><nfe:nfeDistDFeInteresse><nfe:nfeDadosMsg><distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><cUFAutor>${cUF}</cUFAutor><CNPJ>${cnpj}</CNPJ><consChNFe><chNFe>${chNFe}</chNFe></consChNFe></distDFeInt></nfe:nfeDadosMsg></nfe:nfeDistDFeInteresse></soapenv:Body></soapenv:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www1.nfe.fazenda.gov.br', port: 443,
      path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', method: 'POST',
      pfx: pfxBuffer, passphrase: senha,
      headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '"http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"', 'Content-Length': Buffer.byteLength(soapBody, 'utf8') },
      rejectUnauthorized: false, timeout: 30000,
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout SEFAZ (30s)')); });
    req.write(soapBody); req.end();
  });
}

// Busca cert correto para uma nota e baixa o XML do SEFAZ, salvando em fiscal-notas.json
// e registrando a chave em data.fiscal_baixados (persistido via Railway env vars).
// Retorna o zip (base64 gzip) ou lança erro.
async function baixarXmlDoSefaz(chave) {
  const cUF = chave.slice(0, 2);
  const data = loadData();
  const db   = loadFiscalNotas();
  const notaKey    = Object.keys(db).find(k => db[k].chave === chave);
  const filialCnpj = notaKey ? (db[notaKey].filial || '') : '';

  let pfxBuffer, senha, cnpj;
  for (const num of ['1', '2']) {
    const nc = (data.notas_contas || {})[num] || {};
    if (nc.cert_b64 && nc.senha && nc.cnpj) {
      if (!pfxBuffer) { pfxBuffer = Buffer.from(nc.cert_b64, 'base64'); senha = nc.senha; cnpj = nc.cnpj; }
      if (nc.cnpj === filialCnpj) { pfxBuffer = Buffer.from(nc.cert_b64, 'base64'); senha = nc.senha; cnpj = nc.cnpj; break; }
    }
  }
  if (!pfxBuffer) throw new Error('Nenhum certificado digital configurado. Configure em NF Entrada.');
  if (filialCnpj && cnpj !== filialCnpj) throw new Error(`Certificado (${cnpj}) não corresponde ao destinatário desta NF (${filialCnpj}). Configure o certificado correto.`);

  const xmlResp = await queryNFeByChave(pfxBuffer, senha, cnpj, cUF, chave);
  const { cStat, xMotivo, docs } = parsearRespostaSefaz(xmlResp);
  if (!docs.length) throw new Error(`SEFAZ: ${cStat} - ${xMotivo}`);

  // Salva zip em fiscal-notas.json
  const db2 = loadFiscalNotas();
  const key = Object.keys(db2).find(k => db2[k].chave === chave);
  if (key) { db2[key].zip = docs[0].zip; saveFiscalNotas(db2); }

  // Registra chave em data.fiscal_baixados para persistência via Railway env vars
  const data2 = loadData();
  data2.fiscal_baixados = [...new Set([...(data2.fiscal_baixados || []), chave])];
  saveData(data2);
  agendarSyncContasPagar();

  addLog(`[fiscal] XML baixado para chave ${chave.slice(0, 10)}...`, 'ok');
  return docs[0].zip;
}

app.post('/api/fiscal/baixar-xml', async (req, res) => {
  const { chave } = req.body;
  if (!chave || chave.length !== 44) return res.json({ ok: false, erro: 'Chave inválida (deve ter 44 dígitos)' });
  try {
    await baixarXmlDoSefaz(chave);
    return res.json({ ok: true });
  } catch (err) {
    addLog(`[fiscal] baixar-xml erro: ${err.message}`, 'warn');
    return res.json({ ok: false, erro: err.message });
  }
});

app.get('/api/fiscal/xml/:chave', (req, res) => {
  const { chave } = req.params;
  const db  = loadFiscalNotas();
  const key = Object.keys(db).find(k => db[k].chave === chave);
  if (!key || !db[key].zip) return res.status(404).json({ error: 'XML não disponível' });
  try {
    const xml = zlib.gunzipSync(Buffer.from(db[key].zip, 'base64'));
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nfe_${chave}.xml"`);
    res.send(xml);
  } catch { res.status(500).json({ error: 'Erro ao descompactar XML' }); }
});

app.get('/api/fiscal/danfe/:chave', async (req, res) => {
  const { chave } = req.params;
  let db  = loadFiscalNotas();
  let key = Object.keys(db).find(k => db[k].chave === chave);
  // Se zip sumir (ex: redeploy sem volume), tenta re-baixar automaticamente do SEFAZ
  if (!key || !db[key].zip) {
    try {
      await baixarXmlDoSefaz(chave);
      db  = loadFiscalNotas();
      key = Object.keys(db).find(k => db[k].chave === chave);
    } catch (e) {
      return res.status(404).send(`<h2 style="font-family:sans-serif">XML não disponível.<br><small>${e.message}</small></h2>`);
    }
  }
  if (!key || !db[key].zip) return res.status(404).send('<h2 style="font-family:sans-serif">XML não disponível para esta nota.</h2>');
  try {
    const xml = zlib.gunzipSync(Buffer.from(db[key].zip, 'base64')).toString('utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(gerarHtmlDanfe(xml));
  } catch (e) { res.status(500).send('<h2>Erro ao processar XML: ' + e.message + '</h2>'); }
});

app.post('/api/fiscal/lancar-cp', (req, res) => {
  const { chave } = req.body;
  if (!chave) return res.json({ ok: false, erro: 'Chave não informada' });
  const db  = loadFiscalNotas();
  const key = Object.keys(db).find(k => db[k].chave === chave);
  if (!key)        return res.json({ ok: false, erro: 'Nota não encontrada' });
  if (!db[key].zip) return res.json({ ok: false, erro: 'XML não foi baixado para esta nota. Baixe o XML primeiro.' });

  let xml;
  try { xml = zlib.gunzipSync(Buffer.from(db[key].zip, 'base64')).toString('utf8'); }
  catch (e) { return res.json({ ok: false, erro: 'Erro ao ler XML: ' + e.message }); }

  let parsed;
  try { parsed = parseNFeXML(xml); }
  catch (e) { return res.json({ ok: false, erro: 'Erro ao interpretar XML: ' + e.message }); }

  const data = loadData();
  // Determina conta pelo CNPJ filial
  const filialCnpj = db[key].filial || '';
  let num = String(data.conta_ativa || '1');
  for (const n of ['1', '2']) {
    const nc = (data.notas_contas || {})[n] || {};
    if (nc.cnpj && nc.cnpj === filialCnpj) { num = n; break; }
  }

  data.contas_pagar = data.contas_pagar || {};
  data.contas_pagar[num] = data.contas_pagar[num] || [];

  if (!parsed.dups.length) return res.json({ ok: true, importados: 0, aviso: 'NF à vista ou sem duplicatas — nada a pagar.' });

  const agora = new Date().toISOString();
  let importados = 0, dup = 0;
  for (const d of parsed.dups) {
    const chaveCP = parsed.chNFe
      ? `${parsed.chNFe}-${d.nDup}`
      : `${parsed.cnpj}-${parsed.nNF}-${d.nDup}-${d.dVenc}`;
    if (data.contas_pagar[num].find(c => c.chave === chaveCP)) { dup++; continue; }
    data.contas_pagar[num].push({
      id:          Date.now().toString() + Math.random().toString(36).slice(2, 6),
      chave:       chaveCP,
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

  saveData(data);
  agendarSyncContasPagar();
  res.json({ ok: true, importados, dup });
});

function gerarHtmlDanfe(xml) {
  const v    = (tag) => xmlVal(xml, tag);
  const blk  = (tag) => xmlBlock(xml, tag);

  const emitBlk  = blk('emit');
  const destBlk  = blk('dest');
  const ideBlk   = blk('ide');
  const totalBlk = blk('ICMSTot');
  const cobrBlk  = blk('cobr');
  const protBlk  = blk('protNFe');
  const transpBlk= blk('transp');

  const fmtCnpj = c => (c || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  const fmtDate = d => d ? d.replace(/(\d{4})-(\d{2})-(\d{2}).*/, '$3/$2/$1') : '';
  const fmtBrl  = v => isNaN(parseFloat(v)) ? 'R$ 0,00' : parseFloat(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtCep  = c => (c || '').replace(/(\d{5})(\d{3})/, '$1-$2');

  const nNF    = xmlVal(ideBlk, 'nNF') || '';
  const serie  = xmlVal(ideBlk, 'serie') || '';
  const dEmi   = xmlVal(ideBlk, 'dEmi') || xmlVal(ideBlk, 'dhEmi') || '';
  const natOp  = xmlVal(ideBlk, 'natOp') || '';
  const tpNF   = xmlVal(ideBlk, 'tpNF');  // 0=entrada 1=saída
  const chNFe  = v('chNFe') || '';

  const eNome  = xmlVal(emitBlk, 'xNome') || '';
  const eFant  = xmlVal(emitBlk, 'xFant') || '';
  const eCnpj  = xmlVal(emitBlk, 'CNPJ')  || '';
  const eIE    = xmlVal(emitBlk, 'IE')    || '';
  const eEnderBlk = xmlBlock(emitBlk, 'enderEmit');
  const eLgr   = xmlVal(eEnderBlk, 'xLgr')  || '';
  const eNro   = xmlVal(eEnderBlk, 'nro')   || '';
  const eBairro= xmlVal(eEnderBlk, 'xBairro')|| '';
  const eMun   = xmlVal(eEnderBlk, 'xMun')  || '';
  const eUF    = xmlVal(eEnderBlk, 'UF')    || '';
  const eCep   = xmlVal(eEnderBlk, 'CEP')   || '';
  const eFone  = xmlVal(eEnderBlk, 'fone')  || '';

  const dNome  = xmlVal(destBlk, 'xNome') || '';
  const dCnpj  = xmlVal(destBlk, 'CNPJ')  || xmlVal(destBlk, 'CPF') || '';
  const dIE    = xmlVal(destBlk, 'IE')    || '';
  const dEnderBlk = xmlBlock(destBlk, 'enderDest');
  const dLgr   = xmlVal(dEnderBlk, 'xLgr')  || '';
  const dNro   = xmlVal(dEnderBlk, 'nro')   || '';
  const dBairro= xmlVal(dEnderBlk, 'xBairro')|| '';
  const dMun   = xmlVal(dEnderBlk, 'xMun')  || '';
  const dUF    = xmlVal(dEnderBlk, 'UF')    || '';
  const dCep   = xmlVal(dEnderBlk, 'CEP')   || '';

  const vNF    = xmlVal(totalBlk, 'vNF')    || '0';
  const vBC    = xmlVal(totalBlk, 'vBC')    || '0';
  const vICMS  = xmlVal(totalBlk, 'vICMS')  || '0';
  const vProd  = xmlVal(totalBlk, 'vProd')  || '0';
  const vDesc  = xmlVal(totalBlk, 'vDesc')  || '0';
  const vFrete = xmlVal(totalBlk, 'vFrete') || '0';
  const vIPI   = xmlVal(totalBlk, 'vIPI')   || '0';
  const vPIS   = xmlVal(totalBlk, 'vPIS')   || '0';
  const vCOFINS= xmlVal(totalBlk, 'vCOFINS')|| '0';

  const nProt  = xmlVal(protBlk, 'nProt') || '';
  const dhRecb = xmlVal(protBlk, 'dhRecbto') || '';
  const modFrete= xmlVal(transpBlk, 'modFrete');
  const freteModos = { '0':'CIF (Emitente)','1':'FOB (Destinatário)','2':'Terceiro','3':'Próprio Emt','4':'Próprio Dest','9':'Sem transporte' };

  // Produtos
  const dets = xmlAllBlocks(xml, 'det');
  const prodRows = dets.map(det => {
    const prodBlk = xmlBlock(det, 'prod');
    const xProd = xmlVal(prodBlk, 'xProd') || '';
    const cProd = xmlVal(prodBlk, 'cProd') || '';
    const NCM   = xmlVal(prodBlk, 'NCM')   || '';
    const qCom  = xmlVal(prodBlk, 'qCom')  || '';
    const uCom  = xmlVal(prodBlk, 'uCom')  || '';
    const vUnCom= xmlVal(prodBlk, 'vUnCom')|| '';
    const vProdItem = xmlVal(prodBlk, 'vProd') || '';
    const vDescItem = xmlVal(prodBlk, 'vDesc') || '';
    return `<tr>
      <td>${cProd}</td>
      <td style="max-width:240px">${xProd}</td>
      <td>${NCM}</td>
      <td style="text-align:right">${parseFloat(qCom||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:4})}</td>
      <td>${uCom}</td>
      <td style="text-align:right">${fmtBrl(vUnCom)}</td>
      <td style="text-align:right">${fmtBrl(vDescItem)}</td>
      <td style="text-align:right;font-weight:600">${fmtBrl(vProdItem)}</td>
    </tr>`;
  }).join('');

  // Duplicatas
  const dupRows = cobrBlk ? xmlAllBlocks(cobrBlk, 'dup').map(dup => {
    const nDup  = xmlVal(dup, 'nDup') || '001';
    const dVenc = xmlVal(dup, 'dVenc') || '';
    const vDup  = xmlVal(dup, 'vDup')  || '0';
    return `<tr><td>${nDup}</td><td>${fmtDate(dVenc)}</td><td style="text-align:right;font-weight:600">${fmtBrl(vDup)}</td></tr>`;
  }).join('') : '';

  const chFormatada = chNFe.replace(/(\d{4})/g, '$1 ').trim();
  const tipoNF = tpNF === '0' ? 'ENTRADA' : 'SAÍDA';

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>DANFE — NF-e ${nNF}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;font-size:10px;color:#111;background:#f3f3f3;padding:12px}
  .page{background:#fff;max-width:820px;margin:0 auto;padding:16px;border:1px solid #aaa}
  .header{display:grid;grid-template-columns:1fr 180px 140px;gap:8px;margin-bottom:8px}
  .box{border:1px solid #888;padding:6px}
  .box-title{font-size:8px;color:#555;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
  .danfe-title{text-align:center;font-size:15px;font-weight:700;letter-spacing:1px}
  .danfe-sub{text-align:center;font-size:8px;color:#444;margin:2px 0}
  .danfe-nf{text-align:center;font-size:13px;font-weight:700;margin:4px 0}
  .chave{font-size:7.5px;word-break:break-all;font-family:monospace;background:#f5f5f5;padding:3px;border:1px solid #ccc;margin:6px 0}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
  .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px}
  .full{margin-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:9px}
  th{background:#e8e8e8;border:1px solid #aaa;padding:3px 4px;text-align:left;font-size:8px}
  td{border:1px solid #ccc;padding:2px 4px;vertical-align:top}
  .totals-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:8px}
  .tot-item{border:1px solid #ccc;padding:4px}
  .tot-label{font-size:7.5px;color:#555;text-transform:uppercase}
  .tot-val{font-size:11px;font-weight:700;margin-top:2px}
  .print-btn{display:block;margin:16px auto 0;padding:8px 24px;background:#1d4ed8;color:#fff;border:none;border-radius:4px;font-size:13px;cursor:pointer;font-weight:600}
  @media print{.print-btn{display:none}body{background:#fff;padding:0}.page{border:none;box-shadow:none}}
  strong{font-weight:700}
</style></head><body>
<div class="page">
  <div class="header">
    <div class="box">
      <div class="box-title">Emitente</div>
      <strong style="font-size:11px">${eNome}</strong>${eFant ? `<br><span style="color:#555">${eFant}</span>` : ''}
      <br>${eLgr}${eNro ? ', ' + eNro : ''} — ${eBairro}<br>${eMun}/${eUF} &nbsp; CEP ${fmtCep(eCep)}
      <br>CNPJ: <strong>${fmtCnpj(eCnpj)}</strong> &nbsp; IE: ${eIE}
      ${eFone ? `<br>Tel: ${eFone}` : ''}
    </div>
    <div class="box" style="text-align:center;display:flex;flex-direction:column;justify-content:center">
      <div class="danfe-title">DANFE</div>
      <div class="danfe-sub">Documento Auxiliar da<br>Nota Fiscal Eletrônica</div>
      <div class="danfe-sub" style="margin-top:4px">Tipo: <strong>${tipoNF}</strong></div>
      <div class="danfe-nf">N° ${nNF.padStart(9,'0')}</div>
      <div class="danfe-sub">Série ${serie}</div>
    </div>
    <div class="box" style="display:flex;flex-direction:column;gap:4px">
      <div><div class="box-title">Emissão</div><strong>${fmtDate(dEmi)}</strong></div>
      <div><div class="box-title">Protocolo</div><span style="font-size:8px">${nProt || '—'}</span></div>
      <div><div class="box-title">Data protocolo</div><span style="font-size:8px">${fmtDate(dhRecb)}</span></div>
    </div>
  </div>

  <div class="chave">
    <span style="color:#555;font-size:7px">CHAVE DE ACESSO: </span>${chFormatada}
  </div>

  <div class="full box" style="margin-bottom:8px">
    <div class="box-title">Natureza da Operação</div>
    <strong>${natOp}</strong>
    &nbsp;&nbsp; Frete: ${freteModos[modFrete] || modFrete || '—'}
  </div>

  <div class="row2">
    <div class="box">
      <div class="box-title">Destinatário / Remetente</div>
      <strong style="font-size:11px">${dNome}</strong>
      <br>CNPJ/CPF: <strong>${fmtCnpj(dCnpj) || dCnpj}</strong> &nbsp; IE: ${dIE || '—'}
      <br>${dLgr}${dNro ? ', ' + dNro : ''} — ${dBairro}
      <br>${dMun}/${dUF} &nbsp; CEP ${fmtCep(dCep)}
    </div>
    <div class="box">
      <div class="box-title">Totais</div>
      <div class="totals-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="tot-item"><div class="tot-label">Produtos</div><div class="tot-val">${fmtBrl(vProd)}</div></div>
        <div class="tot-item"><div class="tot-label">Desconto</div><div class="tot-val">${fmtBrl(vDesc)}</div></div>
        <div class="tot-item"><div class="tot-label">Frete</div><div class="tot-val">${fmtBrl(vFrete)}</div></div>
        <div class="tot-item"><div class="tot-label">IPI</div><div class="tot-val">${fmtBrl(vIPI)}</div></div>
        <div class="tot-item"><div class="tot-label">BC ICMS</div><div class="tot-val">${fmtBrl(vBC)}</div></div>
        <div class="tot-item"><div class="tot-label">ICMS</div><div class="tot-val">${fmtBrl(vICMS)}</div></div>
        <div class="tot-item" style="grid-column:1/-1;background:#f0fdf4;border-color:#16a34a"><div class="tot-label">VALOR TOTAL DA NF</div><div class="tot-val" style="font-size:14px;color:#16a34a">${fmtBrl(vNF)}</div></div>
      </div>
    </div>
  </div>

  ${dets.length ? `
  <div class="full">
    <div class="box-title" style="margin-bottom:4px">Produtos / Serviços</div>
    <table>
      <thead><tr><th>Código</th><th>Descrição</th><th>NCM</th><th style="text-align:right">Qtd</th><th>Un</th><th style="text-align:right">Vl Unit</th><th style="text-align:right">Desc</th><th style="text-align:right">Vl Total</th></tr></thead>
      <tbody>${prodRows}</tbody>
    </table>
  </div>` : ''}

  ${dupRows ? `
  <div class="full" style="margin-top:8px">
    <div class="box-title" style="margin-bottom:4px">Cobrança / Duplicatas</div>
    <table style="max-width:360px">
      <thead><tr><th>Parcela</th><th>Vencimento</th><th style="text-align:right">Valor</th></tr></thead>
      <tbody>${dupRows}</tbody>
    </table>
  </div>` : ''}

</div>
<button class="print-btn" onclick="window.print()">🖨️ Imprimir / Salvar PDF</button>
</body></html>`;
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
  const re = /<docZip([^>]*)>([\s\S]+?)<\/docZip>/g;
  let m;
  while ((m = re.exec(xmlResp)) !== null) {
    const attrs  = m[1];
    const nsu    = attrs.match(/NSU="(\d+)"/)?.[1]    || '';
    const schema = attrs.match(/schema="([^"]*)"/)?.[1] || '';
    docs.push({ nsu, schema, zip: m[2].trim() });
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
  let cnpj = (req.body.cnpj || '').replace(/\D/g, '');
  let titular = req.body.titular || '';
  // Tenta extrair CNPJ/titular do certificado automaticamente; se falhar usa os campos manuais
  try {
    const extraido = extrairCnpjDoCert(req.file.buffer, senha);
    cnpj    = extraido.cnpj    || cnpj;
    titular = extraido.titular || titular;
  } catch {}
  if (!cnpj) return res.json({ error: 'Informe o CNPJ da empresa no campo abaixo.' });
  data.notas_contas = data.notas_contas || {};
  data.notas_contas[num] = data.notas_contas[num] || {};
  const n = data.notas_contas[num];
  n.cert_b64  = req.file.buffer.toString('base64');
  n.cert_nome = req.file.originalname;
  n.senha     = senha;
  n.cnpj      = cnpj;
  n.titular   = titular || cnpj;
  saveData(data);
  addLog(`Notas conta ${num}: certificado carregado — ${n.titular} (${cnpj})`, 'info');
  res.json({ ok: true, cnpj, titular: n.titular });
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

// ── ZPL → PDF (via Labelary) ──────────────────────────────────
function zplSplitLabels(zpl) {
  // Mantém junto de cada ^XA...^XZ qualquer comando ~DG (download de imagem)
  // que vem antes dele, senão o ^XG de recall perde a imagem e a Labelary
  // devolve 404 "ZPL generated no labels".
  const blocks = [];
  const regex = /([\s\S]*?)(\^XA[\s\S]*?\^XZ)/gi;
  let match;
  while ((match = regex.exec(zpl)) !== null) {
    blocks.push(match[1] + match[2]);
  }
  // Descarta blocos que não desenham nada (ex: ^XA^ID...^XZ só de limpeza de memória)
  return blocks.filter(b => /\^FO/i.test(b));
}

async function singleLabelToPdf(labelSize, labelZpl) {
  const FormData = require('form-data');
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const form = new FormData();
    form.append('file', Buffer.from(labelZpl, 'utf-8'), { filename: 'label.zpl' });
    try {
      const resp = await axios.post(
        `https://api.labelary.com/v1/printers/8dpmm/labels/${labelSize}/0/`,
        form,
        {
          headers: { ...form.getHeaders(), 'Accept': 'application/pdf' },
          responseType: 'arraybuffer',
          timeout: 12000,
        }
      );
      return Buffer.from(resp.data);
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || status === 502 || status === 503 || status === 504;
      if (retryable && attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function convertLabelsWithConcurrency(labels, labelSize, concurrency = 6) {
  const results = new Array(labels.length);
  let idx = 0;
  async function worker() {
    while (idx < labels.length) {
      const i = idx++;
      results[i] = await singleLabelToPdf(labelSize, labels[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, labels.length) }, worker));
  return results;
}

app.post('/api/zpl-to-pdf', express.text({ type: '*/*', limit: '20mb' }), async (req, res) => {
  const tamanho = req.query.tamanho;
  const sizes = { '100x150': '3.94x5.91', '104x29': '4.09x1.14' };
  const labelSize = sizes[tamanho];
  if (!labelSize) return res.status(400).json({ erro: 'Tamanho inválido. Use 100x150 ou 104x29' });

  const zpl = req.body;
  if (!zpl || typeof zpl !== 'string' || !zpl.trim()) {
    return res.status(400).json({ erro: 'Conteúdo ZPL inválido ou vazio' });
  }

  try {
    const { PDFDocument } = require('pdf-lib');
    const labels = zplSplitLabels(zpl);
    if (labels.length === 0) return res.status(400).json({ erro: 'Nenhuma etiqueta encontrada no ZPL (^XA...^XZ)' });

    console.log(`[zpl-to-pdf] ${labels.length} etiqueta(s), tamanho=${tamanho}`);

    // Timeout interno de 50s para retornar erro legível antes do Railway cortar com 502
    const TIMEOUT_MS = 50000;
    const conversao = convertLabelsWithConcurrency(labels, labelSize, 6);
    const timeout   = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tempo limite atingido com ${labels.length} etiqueta(s). Tente um arquivo menor ou tente novamente.`)), TIMEOUT_MS)
    );
    const pdfBuffers = await Promise.race([conversao, timeout]);

    // Mescla todas as páginas em um único PDF
    const merged = await PDFDocument.create();
    for (const buf of pdfBuffers) {
      const doc   = await PDFDocument.load(buf);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const finalPdf = Buffer.from(await merged.save());

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="etiquetas.pdf"');
    res.set('X-Label-Count', String(labels.length));
    res.set('Access-Control-Expose-Headers', 'X-Label-Count');
    res.send(finalPdf);
  } catch (err) {
    console.error('[zpl-to-pdf] erro:', err.message);
    const detalhe = err.response?.data
      ? Buffer.from(err.response.data).toString().substring(0, 300)
      : err.message;
    res.status(500).json({ erro: 'Erro ao converter ZPL', detalhe });
  }
});

// ── Inicia o servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  // Persiste configurações auto-geradas no boot (ex: HANDDRY MLBs)
  try { saveData(loadData()); } catch {}
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  // Inicia monitoramento Telegram 10s após subir, depois a cada 60s
  if (CALLMEBOT_PHONE && CALLMEBOT_APIKEY) {
    addLog(`WhatsApp: contas/anúncios → ${CALLMEBOT_PHONE} ✅`, 'ok');
  }
  if (CALLMEBOT_PHONE_PEDIDOS && CALLMEBOT_APIKEY_PEDIDOS) {
    addLog(`WhatsApp: pedidos novos → ${CALLMEBOT_PHONE_PEDIDOS} ✅`, 'ok');
  }
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    addLog('Telegram: ativado ✅', 'ok');
  }
  // Estoque baixo: roda se tiver WhatsApp principal ou Telegram
  if ((CALLMEBOT_PHONE && CALLMEBOT_APIKEY) || (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID)) {
    setTimeout(() => {
      verificarEstoqueBaixo().catch(() => {});
      setInterval(() => verificarEstoqueBaixo().catch(() => {}), 6 * 60 * 60_000);
    }, 90_000);
  }
  // Pedidos novos: roda se tiver WhatsApp pedidos ou Telegram
  if ((CALLMEBOT_PHONE_PEDIDOS && CALLMEBOT_APIKEY_PEDIDOS) || (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID)) {
    setTimeout(() => {
      verificarNovosShipmentsTelegram().catch(() => {});
      setInterval(() => verificarNovosShipmentsTelegram().catch(() => {}), 60_000);
    }, 10_000);
  }
  // Anúncios pausados: roda se tiver WhatsApp principal ou Telegram
  if ((CALLMEBOT_PHONE && CALLMEBOT_APIKEY) || (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID)) {
    setTimeout(() => {
      verificarAnunciosPausadosTelegram().catch(() => {});
      setInterval(() => verificarAnunciosPausadosTelegram().catch(() => {}), 5 * 60_000);
    }, 30_000);
  }
  // Catálogos ML: detecta quando ML cria anúncio de catálogo a partir de um item
  if (CALLMEBOT_PHONE && CALLMEBOT_APIKEY) {
    setTimeout(() => {
      verificarCatalogosML().catch(() => {});
      setInterval(() => verificarCatalogosML().catch(() => {}), 15 * 60_000);
    }, 120_000);
  }
});

// ── Fornecedores (Previsão de Compra) — por conta ─────────────

function getFornecedoresConta(data, contaOverride) {
  const num = String(contaOverride || data.conta_ativa || '1');
  if (!data.fornecedores_por_conta) data.fornecedores_por_conta = {};
  if (!data.fornecedores_por_conta[num]) data.fornecedores_por_conta[num] = [];
  return { lista: data.fornecedores_por_conta[num], num };
}

app.get('/api/fornecedores', (req, res) => {
  const data = loadData();
  const { lista } = getFornecedoresConta(data, req.query.conta);
  res.json({ fornecedores: lista });
});

app.post('/api/fornecedores/vincular', (req, res) => {
  const { sku, fornecedorId, conta } = req.body;
  if (!sku) return res.status(400).json({ error: 'sku obrigatório' });
  const data = loadData();
  const { lista } = getFornecedoresConta(data, conta);
  lista.forEach(f => { f.skus = f.skus.filter(s => s !== sku); });
  if (fornecedorId) {
    const forn = lista.find(f => f.id === fornecedorId);
    if (forn && !forn.skus.includes(sku)) forn.skus.push(sku);
  }
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/fornecedores', (req, res) => {
  const { nome, leadTimeDias, skus, conta } = req.body;
  if (!nome || !leadTimeDias) return res.status(400).json({ error: 'nome e leadTimeDias obrigatórios' });
  const data = loadData();
  const { lista } = getFornecedoresConta(data, conta || req.query.conta);
  const novo = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    nome: nome.trim(),
    leadTimeDias: Number(leadTimeDias),
    skus: Array.isArray(skus) ? skus : (skus || '').split(',').map(s => s.trim()).filter(Boolean),
  };
  lista.push(novo);
  saveData(data);
  res.json({ ok: true, fornecedor: novo });
});

app.put('/api/fornecedores/:id', (req, res) => {
  const data = loadData();
  const { nome, leadTimeDias, skus, mlbs, conta } = req.body;
  const { lista } = getFornecedoresConta(data, conta || req.query.conta);
  const idx = lista.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'não encontrado' });
  if (nome) lista[idx].nome = nome.trim();
  if (leadTimeDias != null) lista[idx].leadTimeDias = Number(leadTimeDias);
  if (skus != null) lista[idx].skus = Array.isArray(skus) ? skus : (skus || '').split(',').map(s => s.trim()).filter(Boolean);
  if (mlbs != null) {
    lista[idx].mlbs = Array.isArray(mlbs) ? mlbs : (mlbs || '').split(',').map(s => s.trim()).filter(Boolean);
    data.handdry_dashboard_cache = null; // invalida cache ao mudar MLBs
  }
  saveData(data);
  res.json({ ok: true, fornecedor: lista[idx] });
});

app.delete('/api/fornecedores/:id', (req, res) => {
  const data = loadData();
  const { lista, num } = getFornecedoresConta(data, req.query.conta);
  const antes = lista.length;
  data.fornecedores_por_conta[num] = lista.filter(f => f.id !== req.params.id);
  if (data.fornecedores_por_conta[num].length === antes) return res.status(404).json({ error: 'não encontrado' });
  saveData(data);
  res.json({ ok: true });
});

// ── Dashboard do fornecedor HANDDRY (ML-powered, com cache) ──
app.get('/api/fornecedor/dashboard', async (req, res) => {
  const data     = loadData();
  const NOME_FORN = 'HANDDRY';

  // Localiza registro HANDDRY e a conta associada
  let handdry  = null;
  let contaNum = null;
  for (const num of Object.keys(data.fornecedores_por_conta || {})) {
    const lista = data.fornecedores_por_conta[num] || [];
    const forn  = lista.find(f => f.nome.toUpperCase() === NOME_FORN);
    if (forn) { handdry = forn; contaNum = num; break; }
  }

  const mlbs = (handdry?.mlbs || []).map(m => String(m).trim()).filter(Boolean);

  if (mlbs.length === 0) {
    return res.json({ produtos: [], vendas_diarias: {}, sem_config: true });
  }

  // Intervalo de datas (padrão: últimos 6 meses)
  const hoje  = new Date();
  const de    = req.query.de  || new Date(hoje.getTime() - 180 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const ate   = req.query.ate || hoje.toISOString().slice(0, 10);
  const force = req.query.force === '1';

  // Serve do cache se ainda válido (1 hora)
  const cache = data.handdry_dashboard_cache;
  if (!force && cache && cache.de === de && cache.ate === ate && cache.lastSync) {
    const age = Date.now() - new Date(cache.lastSync).getTime();
    if (age < 60 * 60 * 1000) return res.json({ ...cache, cached: true });
  }

  // Credenciais da conta do fornecedor
  const c = (data.contas || {})[contaNum] || contaAtiva(data);
  if (!c?.access_token) return res.json({ error: 'Conta não conectada ao Mercado Livre' });
  if (!c?.user_id)      return res.json({ error: 'user_id não encontrado' });

  try {
    const mlbSet        = new Set(mlbs);
    const vendasDiarias = {};
    for (const mlb of mlbs) vendasDiarias[mlb] = {};

    // Busca pedidos pagos no período, filtrando pelos MLBs do HANDDRY
    let offset = 0;
    const limit = 50;
    let paginaTotal = Infinity;

    while (offset < paginaTotal && offset < 5000) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:                      c.user_id,
          'order.status':              'paid',
          'order.date_created.from':   de  + 'T00:00:00.000-03:00',
          'order.date_created.to':     ate + 'T23:59:59.000-03:00',
          sort:  'date_asc',
          limit, offset,
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 15000,
      });

      const orders = resp.data.results || [];
      paginaTotal  = resp.data.paging?.total || 0;

      for (const order of orders) {
        const date = (order.date_created || '').slice(0, 10);
        for (const oi of (order.order_items || [])) {
          const mlb = oi.item.id;
          if (!mlbSet.has(mlb)) continue;
          vendasDiarias[mlb][date] = (vendasDiarias[mlb][date] || 0) + (oi.quantity || 1);
        }
      }

      if (orders.length < limit) break;
      offset += limit;
    }

    // Busca info e estoque real dos itens no ML
    const produtos = [];
    for (let i = 0; i < mlbs.length; i += 20) {
      const chunk = mlbs.slice(i, i + 20);
      try {
        const r = await axios.get('https://api.mercadolibre.com/items', {
          params: { ids: chunk.join(','), attributes: 'id,title,available_quantity,thumbnail,status' },
          headers: { Authorization: `Bearer ${c.access_token}` },
          timeout: 10000,
        });
        for (const entry of (r.data || [])) {
          if (entry.code !== 200) continue;
          const b = entry.body;
          let thumb = b.thumbnail || null;
          if (thumb) thumb = thumb.replace(/-[A-Z]\.jpg/, '-O.jpg');
          produtos.push({ mlb: b.id, titulo: b.title || b.id, estoque: b.available_quantity ?? 0, thumbnail: thumb, status: b.status });
        }
      } catch {}
    }

    const resultado = { produtos, vendas_diarias: vendasDiarias, de, ate, lastSync: new Date().toISOString() };
    data.handdry_dashboard_cache = resultado;
    saveData(data);
    res.json(resultado);
  } catch (err) {
    addLog(`[Fornecedor] Erro dashboard: ${err.response?.data?.message || err.message}`, 'error');
    res.json({ error: 'Erro ao buscar dados: ' + (err.response?.data?.message || err.message) });
  }
});

// Endpoint admin: configura MLBs do HANDDRY
app.post('/api/fornecedor/config-mlbs', (req, res) => {
  const { mlbs, conta } = req.body || {};
  if (!Array.isArray(mlbs)) return res.status(400).json({ error: 'mlbs deve ser array' });
  const data = loadData();
  const NOME_FORN = 'HANDDRY';
  let atualizado = false;
  for (const num of Object.keys(data.fornecedores_por_conta || {})) {
    const lista = data.fornecedores_por_conta[num] || [];
    const idx = lista.findIndex(f => f.nome.toUpperCase() === NOME_FORN);
    if (idx !== -1) {
      lista[idx].mlbs = mlbs.map(m => String(m).trim()).filter(Boolean);
      atualizado = true;
    }
  }
  if (!atualizado) return res.status(404).json({ error: 'Fornecedor HANDDRY não encontrado — cadastre-o primeiro na aba Compras' });
  data.handdry_dashboard_cache = null;
  saveData(data);
  res.json({ ok: true, mlbs: mlbs.filter(Boolean) });
});

// ── DRE Pessoal ───────────────────────────────────────────────

function injetarRecorrentesPessoal(pessoal, chave) {
  const [ano, mesNum] = chave.split('-');
  const lista = pessoal.lancamentos[chave] || [];
  const jaInjetados = new Set(lista.filter(l => l.recorrente_id).map(l => l.recorrente_id));
  let houve = false;
  for (const r of pessoal.recorrentes) {
    if (jaInjetados.has(r.id)) continue;
    const dia = String(Math.min(r.dia, 28)).padStart(2, '0');
    lista.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      descricao: r.descricao,
      valor: r.valor,
      tipo: r.tipo,
      categoria: r.categoria,
      data: `${ano}-${mesNum}-${dia}`,
      recorrente_id: r.id,
      criado_em: new Date().toISOString()
    });
    houve = true;
  }
  pessoal.lancamentos[chave] = lista;
  return houve;
}

app.get('/api/pessoal/dados', (req, res) => {
  const { ano, mes } = req.query;
  if (!ano || !mes) return res.status(400).json({ error: 'ano e mes obrigatórios' });
  const data = loadData();
  const pessoal = data.pessoal;
  const chave = `${ano}-${mes}`;
  const houve = injetarRecorrentesPessoal(pessoal, chave);
  if (houve) saveData(data);
  const lancamentos = (pessoal.lancamentos[chave] || []).sort((a, b) => a.data.localeCompare(b.data));
  res.json({ categorias: pessoal.categorias, recorrentes: pessoal.recorrentes, lancamentos });
});

app.post('/api/pessoal/categorias', (req, res) => {
  const { nome, acao } = req.body || {};
  if (!nome || !acao) return res.status(400).json({ error: 'nome e acao obrigatórios' });
  const data = loadData();
  const pessoal = data.pessoal;
  if (acao === 'add') {
    if (!pessoal.categorias.includes(nome)) pessoal.categorias.push(nome);
  } else if (acao === 'remove') {
    pessoal.categorias = pessoal.categorias.filter(c => c !== nome);
  }
  saveData(data);
  res.json({ categorias: pessoal.categorias });
});

app.post('/api/pessoal/recorrentes', (req, res) => {
  const { descricao, valor, tipo, categoria, dia } = req.body || {};
  if (!descricao || !tipo || !dia) return res.status(400).json({ error: 'descricao, tipo e dia são obrigatórios' });
  const data = loadData();
  const pessoal = data.pessoal;
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), descricao, valor: valor ? Number(valor) : null, tipo, categoria, dia: Number(dia) };
  pessoal.recorrentes.push(item);
  saveData(data);
  res.json({ ok: true, item });
});

app.put('/api/pessoal/recorrentes/:id', (req, res) => {
  const data = loadData();
  const pessoal = data.pessoal;
  const idx = pessoal.recorrentes.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Recorrente não encontrado' });
  const { valor, dia } = req.body || {};
  if (valor !== undefined) pessoal.recorrentes[idx].valor = valor ? Number(valor) : null;
  if (dia !== undefined) pessoal.recorrentes[idx].dia = Number(dia);
  saveData(data);
  res.json({ ok: true, item: pessoal.recorrentes[idx] });
});

app.delete('/api/pessoal/recorrentes/:id', (req, res) => {
  const data = loadData();
  const pessoal = data.pessoal;
  pessoal.recorrentes = pessoal.recorrentes.filter(r => r.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/pessoal/lancamentos', (req, res) => {
  const { descricao, valor, tipo, categoria, data: dataLanc } = req.body || {};
  if (!descricao || !tipo || !dataLanc) return res.status(400).json({ error: 'descricao, tipo e data são obrigatórios' });
  const data = loadData();
  const pessoal = data.pessoal;
  const chave = dataLanc.slice(0, 7);
  pessoal.lancamentos[chave] = pessoal.lancamentos[chave] || [];
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), descricao, valor: Number(valor), tipo, categoria, data: dataLanc, recorrente_id: null, criado_em: new Date().toISOString() };
  pessoal.lancamentos[chave].push(item);
  saveData(data);
  res.json({ ok: true, item });
});

app.put('/api/pessoal/lancamentos/:id', (req, res) => {
  const { ano, mes } = req.query;
  if (!ano || !mes) return res.status(400).json({ error: 'ano e mes obrigatórios' });
  const chave = `${ano}-${mes}`;
  const { descricao, valor, tipo, categoria, data: dataLanc, pago } = req.body || {};
  const data = loadData();
  const pessoal = data.pessoal;
  const lista = pessoal.lancamentos[chave] || [];
  const idx = lista.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lançamento não encontrado' });
  if (descricao !== undefined) lista[idx].descricao = descricao;
  if (valor !== undefined) lista[idx].valor = valor ? Number(valor) : null;
  if (tipo !== undefined) lista[idx].tipo = tipo;
  if (categoria !== undefined) lista[idx].categoria = categoria;
  if (dataLanc !== undefined) lista[idx].data = dataLanc;
  if (pago !== undefined) lista[idx].pago = Boolean(pago);
  saveData(data);
  res.json({ ok: true, item: lista[idx] });
});

app.delete('/api/pessoal/lancamentos/:id', (req, res) => {
  const { ano, mes } = req.query;
  if (!ano || !mes) return res.status(400).json({ error: 'ano e mes obrigatórios' });
  const chave = `${ano}-${mes}`;
  const data = loadData();
  const pessoal = data.pessoal;
  const antes = (pessoal.lancamentos[chave] || []).length;
  pessoal.lancamentos[chave] = (pessoal.lancamentos[chave] || []).filter(l => l.id !== req.params.id);
  if (pessoal.lancamentos[chave].length === antes) return res.status(404).json({ error: 'Lançamento não encontrado' });
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/pessoal/dre', (req, res) => {
  const { ano } = req.query;
  if (!ano) return res.status(400).json({ error: 'ano obrigatório' });
  const data = loadData();
  const pessoal = data.pessoal;
  const meses = [];
  for (let m = 1; m <= 12; m++) {
    const mesStr = String(m).padStart(2, '0');
    const chave = `${ano}-${mesStr}`;
    const lista = pessoal.lancamentos[chave] || [];
    const entradas = lista.filter(l => l.tipo === 'entrada');
    const saidas = lista.filter(l => l.tipo === 'saida');
    const totalEntradas = entradas.reduce((s, l) => s + l.valor, 0);
    const totalSaidas = saidas.reduce((s, l) => s + l.valor, 0);
    const porCategoriaEntrada = {};
    for (const l of entradas) porCategoriaEntrada[l.categoria] = (porCategoriaEntrada[l.categoria] || 0) + l.valor;
    const porCategoriaSaida = {};
    for (const l of saidas) porCategoriaSaida[l.categoria] = (porCategoriaSaida[l.categoria] || 0) + l.valor;
    meses.push({ mes: m, mesStr, totalEntradas, totalSaidas, resultado: totalEntradas - totalSaidas, porCategoriaEntrada, porCategoriaSaida });
  }
  res.json({ ano, meses });
});
