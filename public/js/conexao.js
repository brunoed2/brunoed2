// ============================================================
// conexao.js — Aba de Conexão com Mercado Livre
// Log ao vivo via SSE + formulário de OAuth
// ============================================================

let cxContaSelecionada = '1';
let cxEventSource = null;

// ── Inicialização ─────────────────────────────────────────────

document.getElementById('cx-callback-url').textContent = `${location.origin}/api/ml/callback`;

// Trata retorno do OAuth (redirect de /api/ml/callback)
(function cxTratarRetornoOAuth() {
  const params = new URLSearchParams(location.search);
  if (params.get('tab') !== 'conexao') return;

  if (params.get('connected') === 'true') {
    const conta = params.get('conta') || '1';
    cxMostrarMsg(`✅ Conta ${conta} conectada com sucesso!`, 'ok');
  }
  if (params.get('error')) {
    const detalhe = params.get('detalhe') ? '\n' + decodeURIComponent(params.get('detalhe')) : '';
    cxMostrarMsg(`❌ Falha na autenticação.${detalhe}`, 'erro');
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
      const expInfo   = data.tokenExpired ? ' (token expirado)' : ` (expira em ${data.expiresIn})`;
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

// ── Helpers ───────────────────────────────────────────────────

function cxMostrarMsg(texto, tipo) {
  const el = document.getElementById('cx-msg');
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
  cxCarregarCredenciais(cxContaSelecionada);
}
