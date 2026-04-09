// ============================================================
// app.js — Lógica do frontend do painel
// ============================================================

// ── Navegação entre abas ──────────────────────────────────────

const navBtns = document.querySelectorAll('.nav-btn');
const tabs    = document.querySelectorAll('.tab');

function abrirAba(nome) {
  // Atualiza botões do menu
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  // Mostra a aba correta
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));
  // Carrega dados da aba quando aberta
  if (nome === 'loja') carregarLoja();
  if (nome === 'estoque') carregarEstoque(true);
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => abrirAba(btn.dataset.tab));
});

// Suporte a ?tab=xxx na URL (usado após redirect do OAuth)
(function () {
  const params = new URLSearchParams(location.search);
  const tab    = params.get('tab') || 'config';
  abrirAba(tab);

  // Exibe mensagem de retorno do OAuth
  if (params.get('connected') === 'true') {
    mostrarMsg('msg-config', '✅ Conectado com sucesso ao Mercado Livre!', 'ok');
  }
  if (params.get('error')) {
    const erros = {
      sem_client_id:  'Client ID não configurado. Salve as credenciais antes.',
      auth_cancelado: 'Autorização cancelada pelo usuário.',
      auth_falhou:    'Falha na autenticação.',
    };
    const detalhe = params.get('detalhe') ? ' Detalhe: ' + params.get('detalhe') : '';
    mostrarMsg('msg-config', '❌ ' + (erros[params.get('error')] || 'Erro desconhecido.') + detalhe, 'erro');
  }

  // Limpa os parâmetros da URL sem recarregar a página
  history.replaceState({}, '', '/app.html');
})();

// ── Helpers ───────────────────────────────────────────────────

function mostrarMsg(id, texto, tipo) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = texto;
  el.className   = `msg ${tipo}`;
}

async function apiFetch(url, opts = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return resp.json();
}

// ── Status de conexão ─────────────────────────────────────────

async function atualizarStatus() {
  try {
    const data = await apiFetch('/api/ml/status');
    const dot  = document.getElementById('status-dot');
    const txt  = document.getElementById('status-text');

    if (data.connected) {
      dot.className  = 'dot conectado';
      txt.textContent = `Conectado${data.nickname ? ` como ${data.nickname}` : ''}`;
    } else {
      dot.className  = 'dot desconectado';
      txt.textContent = 'Desconectado';
    }
  } catch {
    document.getElementById('status-text').textContent = 'Sem resposta do servidor';
  }
}

// ── Configurações ─────────────────────────────────────────────

// Preenche a URL de callback nas instruções
document.getElementById('callback-url').textContent =
  `${location.origin}/api/ml/callback`;

// Carrega os dados salvos no formulário ao abrir a página
async function carregarConfig() {
  try {
    const data = await apiFetch('/api/config');
    if (data.client_id)    document.getElementById('client_id').value    = data.client_id;
    if (data.access_token) document.getElementById('access_token').value = data.access_token;
    if (data.refresh_token) document.getElementById('refresh_token').value = data.refresh_token;
    // client_secret não é retornado pelo servidor por segurança
  } catch { /* silencioso */ }
}

async function salvarConfig(event) {
  event.preventDefault();
  const payload = {
    client_id:     document.getElementById('client_id').value.trim(),
    client_secret: document.getElementById('client_secret').value.trim(),
    access_token:  document.getElementById('access_token').value.trim(),
    refresh_token: document.getElementById('refresh_token').value.trim(),
  };

  // Remove campos vazios para não sobrescrever dados já salvos
  Object.keys(payload).forEach(k => { if (!payload[k]) delete payload[k]; });

  try {
    await apiFetch('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    mostrarMsg('msg-config', '✅ Configurações salvas com sucesso.', 'ok');
    atualizarStatus();
  } catch {
    mostrarMsg('msg-config', '❌ Erro ao salvar. Tente novamente.', 'erro');
  }
}

// Redireciona para o fluxo OAuth do Mercado Livre
function conectarOAuth() {
  location.href = '/api/ml/auth';
}

// ── Loja ──────────────────────────────────────────────────────

async function carregarLoja() {
  const loading = document.getElementById('loja-loading');
  const info    = document.getElementById('loja-info');
  const erroEl  = document.getElementById('loja-erro');

  loading.style.display = 'block';
  info.style.display    = 'none';
  erroEl.style.display  = 'none';

  try {
    const data = await apiFetch('/api/ml/store');

    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    document.getElementById('loja-nome').textContent = data.name  || '—';
    document.getElementById('loja-id').textContent   = data.id    || '—';
    document.getElementById('loja-pais').textContent = data.country || '—';
    info.style.display = 'block';
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao conectar com o servidor.';
    erroEl.style.display = 'block';
  }
}

// ── Estoque ───────────────────────────────────────────────────

let estoqueOffset  = 0;
let estoqueTotal   = 0;
let todosItens     = [];   // cache de todos os itens carregados
let filtroDeposito = 'todos';

// Mapeamento de tipo → classe CSS do badge
const BADGE_CLASS = {
  fulfillment:   'badge-full',
  self_service:  'badge-proprio',
  cross_docking: 'badge-flex',
};

// Configura os botões de filtro
document.querySelectorAll('.filtro-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filtro-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filtroDeposito = btn.dataset.deposito;
    renderizarTabela();
  });
});

function renderizarTabela() {
  const itens = filtroDeposito === 'todos'
    ? todosItens
    : todosItens.filter(i => i.deposito === filtroDeposito);

  const tbody = document.getElementById('tabela-estoque-body');
  tbody.innerHTML = '';

  itens.forEach(item => {
    const badgeClass = BADGE_CLASS[item.deposito] || 'badge-outro';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-sku">${item.sku}</td>
      <td class="td-titulo" title="${item.titulo}">${item.titulo}</td>
      <td class="td-mlb">${item.mlb}</td>
      <td><span class="badge-deposito ${badgeClass}">${item.depositoLabel}</span></td>
      <td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('tabela-estoque').style.display = itens.length ? 'table' : 'none';
  document.getElementById('estoque-total').textContent =
    `${itens.length} de ${estoqueTotal} anúncios` +
    (filtroDeposito !== 'todos' ? ` (filtro ativo)` : '');
}

async function carregarEstoque(reiniciar = false) {
  if (reiniciar) {
    estoqueOffset = 0;
    todosItens    = [];
    document.getElementById('tabela-estoque-body').innerHTML = '';
    document.getElementById('tabela-estoque').style.display = 'none';
    document.getElementById('estoque-paginacao').style.display = 'none';
    document.getElementById('estoque-total').textContent = '';
  }

  const loading = document.getElementById('estoque-loading');
  const erroEl  = document.getElementById('estoque-erro');
  const btnMais = document.getElementById('btn-mais');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  if (btnMais) btnMais.disabled = true;

  try {
    const data = await apiFetch(`/api/ml/estoque?offset=${estoqueOffset}`);
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    estoqueTotal   = data.total;
    estoqueOffset += data.items.length;
    todosItens.push(...data.items);

    renderizarTabela();

    // Mostra botão "carregar mais" se ainda há itens
    const paginacao = document.getElementById('estoque-paginacao');
    if (estoqueOffset < estoqueTotal) {
      paginacao.style.display = 'block';
      if (btnMais) btnMais.disabled = false;
    } else {
      paginacao.style.display = 'none';
    }
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao conectar com o servidor.';
    erroEl.style.display = 'block';
  }
}

function carregarMais() {
  carregarEstoque(false);
}

// ── Sair ─────────────────────────────────────────────────────

function sair() {
  sessionStorage.removeItem('auth');
  location.href = '/';
}

// ── Inicialização ─────────────────────────────────────────────

carregarConfig();
atualizarStatus();
// Atualiza status a cada 60 segundos
setInterval(atualizarStatus, 60_000);
