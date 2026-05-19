// ============================================================
// app.js — Lógica do frontend do painel
// ============================================================

// ── Navegação entre abas ──────────────────────────────────────

const navBtns    = document.querySelectorAll('.nav-btn');
const tabs       = document.querySelectorAll('.tab');
const drawerBtns = document.querySelectorAll('.mobile-drawer-btn');

function abrirAba(nome) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  drawerBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));

  // Atualiza label da barra inferior mobile
  const labelEl = document.getElementById('mobile-tab-label');
  if (labelEl) {
    const btn = document.querySelector(`.nav-btn[data-tab="${nome}"]`);
    if (btn) labelEl.textContent = btn.textContent.trim();
  }

  if (nome === 'loja') carregarLoja();
  if (nome === 'estoque') carregarEstoque(true);
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => abrirAba(btn.dataset.tab));
});

drawerBtns.forEach(btn => {
  btn.addEventListener('click', () => { abrirAba(btn.dataset.tab); fecharMobileMenu(); });
});

function toggleMobileMenu() {
  document.getElementById('mobileDrawer').classList.toggle('open');
  document.getElementById('mobileOverlay').classList.toggle('open');
}

function fecharMobileMenu() {
  document.getElementById('mobileDrawer').classList.remove('open');
  document.getElementById('mobileOverlay').classList.remove('open');
}

// Suporte a ?tab=xxx na URL (usado após redirect do OAuth)
(function () {
  const params = new URLSearchParams(location.search);
  const tab    = params.get('tab') || 'loja';
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
let estoqueLocal = {}; // Armazenamento local do estoque

const BADGE_DEPOSITO = {
  fulfillment:   'badge-full',
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
    const histKey = (item.sku && item.sku !== '—') ? String(item.sku) : `_mlb_${item.mlb}`;
    const estoqueLocalValor = estoqueLocal[item.mlb] !== undefined ? estoqueLocal[item.mlb] : '';
    const estoqueLocalCell = `<td class="col-num" style="white-space:nowrap">
      <input type="number" class="estoque-local-input" data-mlb="${item.mlb}" value="${estoqueLocalValor}" placeholder="—" min="0" style="width:58px;text-align:center">
      <button class="btn-hist-estoque" data-sku="${histKey}" title="Histórico de alterações">📋</button>
    </td>`;

    const estoqueForaFullCell = `<td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</td>`;
    const estoqueFullCell = `<td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</td>`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-sku">${item.sku}</td>
      <td class="td-titulo" title="${item.titulo}">${item.titulo}</td>
      <td class="td-mlb">${item.mlb}</td>
      <td><span class="badge-deposito ${bDeposito}">${item.depositoLabel}</span></td>
      <td><span class="badge-deposito ${bStatus}">${STATUS_LABEL[item.status] || item.status}</span></td>
      ${estoqueLocalCell}
      <td class="col-num">
        <button class="btn-transferir" data-mlb="${item.mlb}" onclick="transferirEstoque('${item.mlb}')" title="Transferir estoque local para ML">→</button>
      </td>
      ${estoqueForaFullCell}
      ${estoqueFullCell}
      <td class="col-num">${item.vendas30d === null ? '...' : (item.vendas30d || '—')}</td>
      <td class="col-num ${duracao.classe}">${item.vendas30d === null ? '...' : duracao.texto}</td>
    `;
    tbody.appendChild(tr);
  });

  // Adicionar event listeners para os inputs de estoque local
  document.querySelectorAll('.estoque-local-input').forEach(input => {
    input.addEventListener('change', salvarEstoqueLocal);
    input.addEventListener('input', salvarEstoqueLocal);
  });

  document.querySelectorAll('.btn-hist-estoque').forEach(btn => {
    btn.addEventListener('click', () => abrirHistoricoEstoque(btn.dataset.sku));
  });

  document.getElementById('tabela-estoque').style.display = itens.length ? 'table' : 'none';
  const filtroAtivo = filtros.deposito !== 'todos' || filtros.status !== 'todos';
  document.getElementById('estoque-total').textContent =
    `${itens.length} de ${todosItens.length} anúncios` +
    (filtroAtivo ? ' (filtro ativo)' : '');
}

// Salva o estoque local no servidor
async function salvarEstoqueLocal(event) {
  const input = event.target;
  const mlb = input.dataset.mlb;
  const valor = input.value.trim();

  try {
    const response = await apiFetch('/api/estoque-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mlb, quantidade: valor })
    });

    if (response.erro) {
      console.error('Erro ao salvar estoque local:', response.erro);
      return;
    }

    // Atualizar o objeto local
    if (valor === '') {
      delete estoqueLocal[mlb];
    } else {
      const num = parseInt(valor);
      if (!isNaN(num) && num >= 0) {
        estoqueLocal[mlb] = num;
      }
    }
  } catch (error) {
    console.error('Erro ao conectar com o servidor:', error);
  }
}

async function abrirHistoricoEstoque(sku) {
  document.getElementById('hist-estoque-sku').textContent = sku;
  document.getElementById('hist-estoque-body').innerHTML = '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:16px">Carregando...</td></tr>';
  document.getElementById('modal-hist-estoque').style.display = 'flex';
  try {
    const resp = await apiFetch(`/api/estoque-local/historico?sku=${encodeURIComponent(sku)}`);
    const hist = resp.historico || [];
    const TIPO = { manual: 'Manual', venda: 'Venda', cancelamento: 'Cancelamento' };
    if (hist.length === 0) {
      document.getElementById('hist-estoque-body').innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:16px">Nenhum registro ainda</td></tr>';
      return;
    }
    document.getElementById('hist-estoque-body').innerHTML = hist.map(e => {
      const dt   = new Date(e.ts).toLocaleString('pt-BR');
      const de   = e.anterior !== null && e.anterior !== undefined ? e.anterior : '—';
      const para = e.novo    !== null && e.novo    !== undefined ? e.novo    : '—';
      const tipo = TIPO[e.tipo] || e.tipo;
      const pedido = e.pedido_id ? `#${e.pedido_id}` : '—';
      return `<tr>
        <td style="padding:5px 8px">${dt}</td>
        <td style="padding:5px 8px">${e.usuario || '—'}</td>
        <td style="padding:5px 8px">${de} → ${para}</td>
        <td style="padding:5px 8px">${tipo}</td>
        <td style="padding:5px 8px">${pedido}</td>
      </tr>`;
    }).join('');
  } catch {
    document.getElementById('hist-estoque-body').innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:#f87171;padding:16px">Erro ao carregar histórico</td></tr>';
  }
}

// Transfere o estoque local para o Mercado Livre
async function transferirEstoque(mlb) {
  const valor = estoqueLocal[mlb];
  if (valor === undefined || valor === '') {
    alert('Digite um valor de estoque local primeiro.');
    return;
  }

  if (!confirm(`Transferir estoque ${valor} para o anúncio ${mlb}?`)) {
    return;
  }

  try {
    const response = await apiFetch(`/api/ml/estoque/${mlb}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estoque: valor })
    });

    if (response.error) {
      alert('Erro ao atualizar estoque: ' + response.error);
      return;
    }

    alert('Estoque atualizado com sucesso!');

    // Recarregar dados do estoque
    await carregarEstoque(true);

  } catch (error) {
    alert('Erro ao conectar com o servidor.');
  }
}

// Carrega o estoque local do servidor
async function carregarEstoqueLocal() {
  try {
    const response = await apiFetch('/api/estoque-local');
    if (response.estoque_local) {
      estoqueLocal = response.estoque_local;
    }
  } catch (error) {
    console.error('Erro ao carregar estoque local:', error);
    estoqueLocal = {};
  }
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

  // Carregar estoque local na primeira vez
  if (Object.keys(estoqueLocal).length === 0) {
    await carregarEstoqueLocal();
  }

  const loading = document.getElementById('estoque-loading');
  const erroEl  = document.getElementById('estoque-erro');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';

  // 1. Carrega estoque primeiro — aparece rápido
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

  // 2. Carrega vendas em segundo plano — atualiza tabela quando chegar
  document.getElementById('estoque-total').textContent += '  (carregando vendas...)';
  try {
    const vendasData = await apiFetch('/api/ml/vendas30dias');
    const vendas = vendasData.error ? {} : vendasData;

    todosItens = todosItens.map(item => ({
      ...item,
      vendas30d: vendas[item.mlb] || 0,
    }));

    renderizarTabela();
  } catch {
    // Vendas falhou — mantém tabela sem essa coluna
    todosItens = todosItens.map(item => ({ ...item, vendas30d: 0 }));
    renderizarTabela();
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
