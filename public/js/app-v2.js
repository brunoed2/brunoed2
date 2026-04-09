// ============================================================
// app-v2.js — Lógica do frontend do painel principal
// ============================================================

// ── Estado ────────────────────────────────────────────────────

let contaConfigurando = '1'; // conta sendo editada na aba config

// ── Navegação entre abas ──────────────────────────────────────

const navBtns = document.querySelectorAll('.nav-btn');
const tabs    = document.querySelectorAll('.tab');

function abrirAba(nome) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));
  if (nome === 'loja')    carregarLoja();
  if (nome === 'estoque') carregarEstoque(true);
  if (nome === 'config')  carregarConfig(contaConfigurando);
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => abrirAba(btn.dataset.tab));
});

(function () {
  const params = new URLSearchParams(location.search);
  const tab    = params.get('tab') || 'loja';
  abrirAba(tab);

  if (params.get('connected') === 'true') {
    const conta = params.get('conta') || '1';
    mostrarMsg('msg-config', `✅ Conta ${conta} conectada com sucesso ao Mercado Livre!`, 'ok');
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

// ── Troca de conta ────────────────────────────────────────────

async function trocarConta(num) {
  await apiFetch('/api/conta/ativa', {
    method: 'POST',
    body:   JSON.stringify({ conta: num }),
  });
  // Atualiza visual do seletor
  document.querySelectorAll('.conta-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.conta === num);
  });
  // Recarrega dados da aba atual
  const abaAtiva = document.querySelector('.tab.active')?.id?.replace('tab-', '');
  if (abaAtiva === 'loja')    carregarLoja();
  if (abaAtiva === 'estoque') carregarEstoque(true);
  atualizarStatus();
}

// Inicializa seletor de conta com o estado do servidor
async function inicializarSeletorConta() {
  try {
    const data = await apiFetch('/api/conta/ativa');
    document.querySelectorAll('.conta-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.conta === data.conta_ativa);
    });
  } catch {}
}

// ── Status de conexão ─────────────────────────────────────────

async function atualizarStatus() {
  try {
    const data = await apiFetch('/api/ml/status');
    const dot  = document.getElementById('status-dot');
    const txt  = document.getElementById('status-text');
    if (data.connected) {
      dot.className   = 'dot conectado';
      txt.textContent = `Conectado${data.nickname ? ` como ${data.nickname}` : ''}`;
    } else {
      dot.className   = 'dot desconectado';
      txt.textContent = 'Desconectado';
    }
  } catch {
    document.getElementById('status-text').textContent = 'Sem resposta do servidor';
  }
}

// ── Configurações ─────────────────────────────────────────────

document.getElementById('callback-url').textContent = `${location.origin}/api/ml/callback`;

function abrirConfigConta(num) {
  contaConfigurando = num;
  document.getElementById('cfg-titulo').textContent = `Credenciais — Conta ${num}`;
  document.getElementById('cfg-tab-1').className = num === '1' ? 'btn-primary' : 'btn-secondary';
  document.getElementById('cfg-tab-2').className = num === '2' ? 'btn-primary' : 'btn-secondary';
  carregarConfig(num);
}

async function carregarConfig(num) {
  try {
    const data = await apiFetch(`/api/config?conta=${num}`);
    document.getElementById('client_id').value     = data.client_id    || '';
    document.getElementById('access_token').value  = data.access_token || '';
    document.getElementById('refresh_token').value = data.refresh_token || '';
    document.getElementById('client_secret').value = '';
  } catch {}
}

async function salvarConfig(event) {
  event.preventDefault();
  const payload = {
    conta:         contaConfigurando,
    client_id:     document.getElementById('client_id').value.trim(),
    client_secret: document.getElementById('client_secret').value.trim(),
    access_token:  document.getElementById('access_token').value.trim(),
    refresh_token: document.getElementById('refresh_token').value.trim(),
  };
  Object.keys(payload).forEach(k => { if (!payload[k]) delete payload[k]; });

  try {
    await apiFetch('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    mostrarMsg('msg-config', `✅ Conta ${contaConfigurando} salva com sucesso.`, 'ok');
    atualizarStatus();
  } catch {
    mostrarMsg('msg-config', '❌ Erro ao salvar. Tente novamente.', 'erro');
  }
}

function conectarOAuth() {
  location.href = `/api/ml/auth?conta=${contaConfigurando}`;
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

    document.getElementById('loja-nome').textContent  = data.name    || '—';
    document.getElementById('loja-id').textContent    = data.id      || '—';
    document.getElementById('loja-pais').textContent  = data.country || '—';
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
let sortState  = { campo: null, direcao: 'asc' };

function calcularDiasPausado(status, pausadoDesde) {
  if (status !== 'paused' || !pausadoDesde) return null;
  const ms = Date.now() - new Date(pausadoDesde).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function diasEstoqueNum(estoque, vendas30d) {
  if (estoque === 0 || estoque === '—') return -1;
  if (!vendas30d) return Infinity;
  return Math.round(estoque / (vendas30d / 30));
}

function sortarItens(itens) {
  if (!sortState.campo) return itens;
  return [...itens].sort((a, b) => {
    let va, vb;
    if (sortState.campo === 'diasEstoque') {
      va = diasEstoqueNum(a.estoque, a.vendas30d);
      vb = diasEstoqueNum(b.estoque, b.vendas30d);
    } else if (sortState.campo === 'diasPausado') {
      va = calcularDiasPausado(a.status, a.pausadoDesde) ?? -1;
      vb = calcularDiasPausado(b.status, b.pausadoDesde) ?? -1;
    } else {
      va = a[sortState.campo];
      vb = b[sortState.campo];
    }
    if (va == null || va === '—') return 1;
    if (vb == null || vb === '—') return -1;
    if (typeof va === 'number' && typeof vb === 'number') {
      return sortState.direcao === 'asc' ? va - vb : vb - va;
    }
    const cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
    return sortState.direcao === 'asc' ? cmp : -cmp;
  });
}

function atualizarIconesSort() {
  document.querySelectorAll('.th-sort').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (th.dataset.sort === sortState.campo) {
      icon.textContent = sortState.direcao === 'asc' ? ' ▲' : ' ▼';
      th.classList.add('th-ativo');
    } else {
      icon.textContent = '';
      th.classList.remove('th-ativo');
    }
  });
}

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

document.querySelectorAll('.th-sort').forEach(th => {
  th.addEventListener('click', () => {
    if (sortState.campo === th.dataset.sort) {
      sortState.direcao = sortState.direcao === 'asc' ? 'desc' : 'asc';
    } else {
      sortState.campo   = th.dataset.sort;
      sortState.direcao = 'asc';
    }
    renderizarTabela();
  });
});

document.querySelectorAll('.filtro-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const grupo = btn.dataset.filtro;
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
  itens = sortarItens(itens);
  atualizarIconesSort();

  const tbody = document.getElementById('tabela-estoque-body');
  tbody.innerHTML = '';

  itens.forEach(item => {
    const bDeposito   = BADGE_DEPOSITO[item.deposito] || 'badge-outro';
    const bStatus     = BADGE_STATUS[item.status]     || 'badge-outro';
    const duracao     = calcularDuracao(item.estoque, item.vendas30d);
    const diasPausado = calcularDiasPausado(item.status, item.pausadoDesde);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-sku">${item.sku}</td>
      <td class="td-titulo" title="${item.titulo}">${item.titulo}</td>
      <td class="td-mlb">${item.mlb}</td>
      <td><span class="badge-deposito ${bDeposito}">${item.depositoLabel}</span></td>
      <td><span class="badge-deposito ${bStatus}">${STATUS_LABEL[item.status] || item.status}</span></td>
      <td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</td>
      <td class="col-num">${item.vendas30d === null ? '...' : (item.vendas30d || '—')}</td>
      <td class="col-num ${duracao.classe}">${item.vendas30d === null ? '...' : duracao.texto}</td>
      <td class="col-num ${diasPausado !== null ? 'pausado-dias' : ''}">${diasPausado !== null ? diasPausado + 'd' : ''}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('tabela-estoque').style.display = itens.length ? 'table' : 'none';
  const filtroAtivo = filtros.deposito !== 'todos' || filtros.status !== 'todos';
  document.getElementById('estoque-total').textContent =
    `${itens.length} de ${todosItens.length} anúncios` +
    (filtroAtivo ? ' (filtro ativo)' : '');
}

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

  let estoqueData;
  try {
    estoqueData = await apiFetch('/api/ml/estoque');
    loading.style.display = 'none';

    if (estoqueData.error) {
      erroEl.textContent   = estoqueData.error;
      erroEl.style.display = 'block';
      return;
    }

    todosItens = estoqueData.items.map(item => ({ ...item, vendas30d: null }));
    renderizarTabela();
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar estoque.';
    erroEl.style.display = 'block';
    return;
  }

  document.getElementById('estoque-total').textContent += '  (carregando vendas...)';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    const resp = await fetch('/api/ml/vendas30dias', { signal: controller.signal });
    clearTimeout(timer);
    const vendasData = await resp.json();
    const vendas = (vendasData && !vendasData.error) ? vendasData : {};

    todosItens = todosItens.map(item => ({
      ...item,
      vendas30d: vendas[item.mlb] || 0,
    }));
    renderizarTabela();
  } catch (err) {
    console.error('Vendas:', err.message);
    todosItens = todosItens.map(item => ({ ...item, vendas30d: 0 }));
    renderizarTabela();
  }
}

// ── Sair ──────────────────────────────────────────────────────

function sair() {
  sessionStorage.removeItem('auth');
  location.href = '/';
}

// ── Inicialização ─────────────────────────────────────────────

inicializarSeletorConta();
carregarConfig('1');
atualizarStatus();
setInterval(atualizarStatus, 60_000);
