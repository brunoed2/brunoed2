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

let todosItens = [];
let filtros    = { deposito: 'todos', status: 'todos' };

const BADGE_DEPOSITO = {
  fulfillment:   'badge-full',
  self_service:  'badge-proprio',
  cross_docking: 'badge-flex',
};

const BADGE_STATUS = {
  active: 'badge-ativo',
  paused: 'badge-pausado',
  closed: 'badge-encerrado',
};

const STATUS_LABEL = {
  active: 'Ativo',
  paused: 'Pausado',
  closed: 'Encerrado',
};

// Configura botões de filtro
document.querySelectorAll('.filtro-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const grupo = btn.dataset.filtro;
    // Desmarca apenas os do mesmo grupo
    document.querySelectorAll(`.filtro-btn[data-filtro="${grupo}"]`)
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filtros[grupo] = btn.dataset.valor;
    renderizarTabela();
  });
});

function renderizarTabela() {
  let itens = todosItens;
  if (filtros.deposito === 'proprio') {
    itens = itens.filter(i => i.deposito === 'self_service' || i.deposito === 'xd_drop_off');
  } else if (filtros.deposito !== 'todos') {
    itens = itens.filter(i => i.deposito === filtros.deposito);
  }
  if (filtros.status !== 'todos') itens = itens.filter(i => i.status === filtros.status);

  const tbody = document.getElementById('tabela-estoque-body');
  tbody.innerHTML = '';

  itens.forEach(item => {
    const bDeposito = BADGE_DEPOSITO[item.deposito] || 'badge-outro';
    const bStatus   = BADGE_STATUS[item.status]     || 'badge-outro';
    const duracao   = calcularDuracao(item.estoque, item.vendas30d);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-sku">${item.sku}</td>
      <td class="td-titulo" title="${item.titulo}">${item.titulo}</td>
      <td class="td-mlb">${item.mlb}</td>
      <td><span class="badge-deposito ${bDeposito}">${item.depositoLabel}</span></td>
      <td><span class="badge-deposito ${bStatus}">${STATUS_LABEL[item.status] || item.status}</span></td>
      <td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</td>
      <td class="col-num">${item.vendas30d || '—'}</td>
      <td class="col-num ${duracao.classe}">${duracao.texto}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('tabela-estoque').style.display = itens.length ? 'table' : 'none';
  const filtroAtivo = filtros.deposito !== 'todos' || filtros.status !== 'todos';
  document.getElementById('estoque-total').textContent =
    `${itens.length} de ${todosItens.length} anúncios` +
    (filtroAtivo ? ' (filtro ativo)' : '');
}

// Calcula classe de cor e texto da duração do estoque
function calcularDuracao(estoque, vendas30d) {
  if (estoque === 0)   return { texto: 'Zerado',  classe: 'duracao-zerado' };
  if (!vendas30d)      return { texto: '∞',        classe: 'duracao-infinito' };
  const dias = Math.round(estoque / (vendas30d / 30));
  let classe = 'duracao-ok';
  if (dias <= 15)      classe = 'duracao-critico';
  else if (dias <= 30) classe = 'duracao-alerta';
  return { texto: `${dias}d`, classe };
}

async function carregarEstoque(reiniciar = false) {
  if (reiniciar) {
    todosItens = [];
    document.getElementById('tabela-estoque-body').innerHTML = '';
    document.getElementById('tabela-estoque').style.display  = 'none';
    document.getElementById('estoque-total').textContent     = '';
  }

  const loading = document.getElementById('estoque-loading');
  const erroEl  = document.getElementById('estoque-erro');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';

  try {
    // Busca estoque e vendas em paralelo
    const [estoqueData, vendasData] = await Promise.all([
      apiFetch('/api/ml/estoque'),
      apiFetch('/api/ml/vendas30dias'),
    ]);

    loading.style.display = 'none';

    if (estoqueData.error) {
      erroEl.textContent   = estoqueData.error;
      erroEl.style.display = 'block';
      return;
    }

    // Mescla vendas nos itens
    const vendas = vendasData.error ? {} : vendasData;
    todosItens = estoqueData.items.map(item => ({
      ...item,
      vendas30d: vendas[item.mlb] || 0,
    }));

    renderizarTabela();
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao conectar com o servidor.';
    erroEl.style.display = 'block';
  }
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
