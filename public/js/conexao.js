// ============================================================
// conexao.js — Aba de Conexão com Mercado Livre
// Log ao vivo via SSE + formulário de OAuth
// ============================================================

let cxContaSelecionada = '1';
let cxEventSource = null;

// ── Inicialização ─────────────────────────────────────────────

document.getElementById('cx-callback-url').textContent = `${location.origin}/api/ml/callback`;

// Trata retorno do OAuth (redirect de /api/ml/callback ou /api/bling/callback)
(function cxTratarRetornoOAuth() {
  const params = new URLSearchParams(location.search);
  if (params.get('tab') !== 'conexao') return;

  // ML
  if (params.get('connected') === 'true') {
    const conta = params.get('conta') || '1';
    cxMostrarMsg(`✅ Conta ${conta} conectada com sucesso!`, 'ok');
  }
  if (params.get('error')) {
    const detalhe = params.get('detalhe') ? '\n' + decodeURIComponent(params.get('detalhe')) : '';
    cxMostrarMsg(`❌ Falha na autenticação.${detalhe}`, 'erro');
  }

  // Bling
  if (params.get('bling_connected') === 'true') {
    const bc = params.get('bling_conta') || '1';
    blingMostrarMsg(`✅ Bling Conta ${bc} conectado com sucesso!`, 'ok');
    verificarBling();
  }
  if (params.get('bling_error')) {
    blingMostrarMsg(`❌ Falha na conexão com o Bling: ${decodeURIComponent(params.get('bling_error'))}`, 'erro');
  }

  history.replaceState({}, '', '/app.html?tab=conexao');
})();

// ── Seleção de conta ──────────────────────────────────────────

function selecionarContaCx(num) {
  cxContaSelecionada = num;
  document.getElementById('cx-conta-1').classList.toggle('active', num === '1');
  document.getElementById('cx-conta-2').classList.toggle('active', num === '2');
  cxCarregarCredenciais(num);
  verificarConexao();
}

async function cxCarregarCredenciais(num) {
  try {
    const data = await fetch(`/api/config?conta=${num}`).then(r => r.json());
    document.getElementById('cx-client-id').value     = data.client_id    || '';
    document.getElementById('cx-client-secret').value = '';
  } catch {}
}

// ── Status de conexão ─────────────────────────────────────────

async function verificarConexao() {
  const dot = document.getElementById('cx-status-dot');
  const txt = document.getElementById('cx-status-txt');
  txt.textContent = 'Verificando...';
  dot.className = 'dot';

  try {
    const resp = await fetch(`/api/conexao/status?conta=${cxContaSelecionada}`,
      { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();

    if (data.connected) {
      dot.className   = 'dot conectado';
      const expInfo   = data.tokenExpired
        ? ' (token expirado — reconecte)'
        : data.hasRefresh
          ? ' ✓ renova automaticamente'
          : ` (expira em ${data.expiresIn} — sem refresh token)`;
      txt.textContent = `Conectado${data.nickname ? ` como ${data.nickname}` : ''}${expInfo}`;
    } else {
      dot.className   = 'dot desconectado';
      txt.textContent = 'Não conectado';
    }
  } catch {
    dot.className   = 'dot desconectado';
    txt.textContent = 'Servidor não responde';
  }
}

// ── Salvar e iniciar OAuth ────────────────────────────────────

async function cxPing() {
  try {
    const r = await fetch('/api/ping', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    cxRenderLog({ ts: Date.now(), msg: `🏓 Ping OK — servidor respondeu em ${Date.now() - d.ts}ms`, tipo: 'ok' });
  } catch (e) {
    cxRenderLog({ ts: Date.now(), msg: `❌ Ping falhou: ${e.message}`, tipo: 'erro' });
  }
}

async function cxSalvarEConectar() {
  const clientId     = document.getElementById('cx-client-id').value.trim();
  const clientSecret = document.getElementById('cx-client-secret').value.trim();

  if (!clientId) {
    cxMostrarMsg('❌ Client ID é obrigatório', 'erro');
    return;
  }

  const payload = { conta: cxContaSelecionada, client_id: clientId };
  if (clientSecret) payload.client_secret = clientSecret;

  cxMostrarMsg('💾 Salvando...', 'info');
  try {
    await fetch('/api/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    cxMostrarMsg('✅ Salvo. Redirecionando para ML...', 'ok');
  } catch {
    cxMostrarMsg('❌ Erro ao salvar credenciais', 'erro');
    return;
  }

  setTimeout(() => {
    location.href = `/api/ml/auth?conta=${cxContaSelecionada}`;
  }, 600);
}

// ── Log ao vivo (SSE) ─────────────────────────────────────────

function cxIniciarStream() {
  if (cxEventSource) return;

  cxEventSource = new EventSource('/api/conexao/stream');

  cxEventSource.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      cxRenderLog(entry);
    } catch {}
  };

  cxEventSource.onerror = () => {
    // SSE reconecta automaticamente; só loga se ficar fechado
    if (cxEventSource.readyState === EventSource.CLOSED) {
      cxRenderLog({ ts: Date.now(), msg: '⚠️ Stream desconectado. Tentando reconectar...', tipo: 'warn' });
    }
  };
}

function cxPararStream() {
  if (cxEventSource) {
    cxEventSource.close();
    cxEventSource = null;
  }
}

function cxRenderLog(entry) {
  const lista = document.getElementById('cx-log-lista');
  if (!lista) return;
  const hora = new Date(entry.ts).toLocaleTimeString('pt-BR');
  const div  = document.createElement('div');
  div.className = `cx-log-entry cx-log-${entry.tipo}`;
  div.innerHTML = `<span class="cx-log-hora">${hora}</span> ${escapeHtml(entry.msg)}`;
  lista.appendChild(div);
  lista.scrollTop = lista.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cxLimparLog() {
  const lista = document.getElementById('cx-log-lista');
  if (lista) lista.innerHTML = '';
}

async function cxTestarTelegram() {
  const btn = document.getElementById('btn-telegram-teste');
  if (btn) btn.disabled = true;
  try {
    const d = await fetch('/api/telegram/teste', { method: 'POST' }).then(r => r.json());
    if (d.ok) {
      alert('✅ Mensagem enviada! Verifique o Telegram.');
    } else {
      alert('⚠️ Falha: ' + (d.erro || 'Erro desconhecido.\nVerifique TELEGRAM_TOKEN e TELEGRAM_CHAT_ID no Railway.'));
    }
  } catch {
    alert('⚠️ Erro ao conectar com o servidor.');
  }
  if (btn) btn.disabled = false;
}

async function cxTestarWhatsappPedidos() {
  const btn = document.getElementById('btn-whatsapp-pedidos-teste');
  if (btn) btn.disabled = true;
  try {
    const d = await fetch('/api/whatsapp/teste-pedidos', { method: 'POST' }).then(r => r.json());
    if (d.ok) {
      alert('✅ Mensagem enviada! Verifique o WhatsApp do número de pedidos.');
    } else {
      alert('⚠️ Falha: ' + (d.erro || 'Verifique CALLMEBOT_PHONE_PEDIDOS e CALLMEBOT_APIKEY_PEDIDOS no Railway.'));
    }
  } catch {
    alert('⚠️ Erro ao conectar com o servidor.');
  }
  if (btn) btn.disabled = false;
}

// ── Bling ─────────────────────────────────────────────────────

async function verificarBling() {
  const dot = document.getElementById('bling-status-dot');
  const txt = document.getElementById('bling-status-txt');
  txt.textContent = 'Bling: verificando...';
  dot.className = 'dot';
  try {
    const data = await fetch('/api/bling/status', { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    const c1 = data['1']?.connected;
    const c2 = data['2']?.connected;
    const partes = [
      `Conta 1: ${c1 ? '✅' : '❌'}`,
      `Conta 2: ${c2 ? '✅' : '❌'}`,
    ];
    dot.className = `dot ${(c1 || c2) ? 'conectado' : 'desconectado'}`;
    txt.textContent = `Bling — ${partes.join(' | ')}`;
    // Atualiza botões
    for (const c of ['1', '2']) {
      const btn = document.getElementById(`btn-bling-conectar-${c}`);
      if (btn) btn.textContent = data[c]?.connected ? `✅ Bling Conta ${c} (reconectar)` : `🔗 Conectar Bling Conta ${c}`;
    }
  } catch {
    dot.className = 'dot desconectado';
    txt.textContent = 'Bling: servidor não responde';
  }
}

// ── Helpers ───────────────────────────────────────────────────

function cxMostrarMsg(texto, tipo) {
  const el = document.getElementById('cx-msg');
  if (!el) return;
  el.textContent = texto;
  el.className   = `msg ${tipo}`;
}

function blingMostrarMsg(texto, tipo) {
  const el = document.getElementById('bling-msg');
  if (!el) return;
  el.textContent = texto;
  el.className   = `msg ${tipo}`;
}

// ── Hook na troca de aba ──────────────────────────────────────
// Inicia/para o stream SSE conforme a aba fica visível

const _abrirAbaOriginal = typeof abrirAba === 'function' ? abrirAba : null;

document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'conexao') {
      cxIniciarStream();
      verificarConexao();
      verificarBling();
      cxCarregarCredenciais(cxContaSelecionada);
    } else {
      cxPararStream();
    }
  });
});

// Se a página já abriu na aba conexao (ex: retorno do OAuth)
if (new URLSearchParams(location.search).get('tab') === 'conexao') {
  cxIniciarStream();
  verificarConexao();
  verificarBling();
  cxCarregarCredenciais(cxContaSelecionada);
}
