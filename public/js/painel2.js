// ============================================================
// painel2.js — Lógica do Painel 2
// ============================================================

// ── Navegação entre abas ──────────────────────────────────────

const navBtns = document.querySelectorAll('.nav-btn');
const tabs    = document.querySelectorAll('.tab');

function abrirAba(nome) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));
  if (nome === 'estoque') carregarEstoque(true);
  if (nome === 'vendas')  carregarVendas();
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => abrirAba(btn.dataset.tab));
});

// ── Troca de conta ────────────────────────────────────────────

async function trocarConta(num) {
  await fetch('/api/conta/ativa', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ conta: num }),
  });
  document.querySelectorAll('.conta-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.conta === num);
  });
  // Recarrega a aba atual
  const abaAtiva = document.querySelector('.tab.active')?.id?.replace('tab-', '');
  if (abaAtiva === 'estoque') carregarEstoque(true);
  if (abaAtiva === 'vendas')  carregarVendas();
}

async function inicializarSeletorConta() {
  try {
    const data = await apiFetch('/api/conta/ativa');
    document.querySelectorAll('.conta-btn').forEach(b => {
      const num      = b.dataset.conta;
      const nickname = data.contas?.[num]?.nickname;
      if (nickname) b.textContent = nickname;
      b.classList.toggle('active', num === data.conta_ativa);
    });
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────

async function apiFetch(url, opts = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return resp.json();
}

// ── Estoque ───────────────────────────────────────────────────

let todosItens = [];
let filtros    = { deposito: 'todos', status: 'todos' };
let sortState    = { campo: null, direcao: 'asc' };
let expandedMLBs = new Set();

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

function calcularDuracao(estoque, vendas30d) {
  if (estoque === 0)   return { texto: 'Zerado',  classe: 'duracao-zerado' };
  if (!vendas30d)      return { texto: '∞',        classe: 'duracao-infinito' };
  const dias = Math.round(estoque / (vendas30d / 30));
  let classe = 'duracao-ok';
  if (dias <= 15)      classe = 'duracao-critico';
  else if (dias <= 30) classe = 'duracao-alerta';
  return { texto: `${dias}d`, classe };
}

function toggleVariacoes(mlb) {
  if (expandedMLBs.has(mlb)) {
    expandedMLBs.delete(mlb);
  } else {
    expandedMLBs.add(mlb);
  }
  const aberto = expandedMLBs.has(mlb);
  document.querySelectorAll(`.variacao-row-${mlb}`).forEach(row => {
    row.style.display = aberto ? '' : 'none';
  });
  const btn = document.getElementById(`btn-expandir-${mlb}`);
  if (btn) btn.textContent = aberto ? '▲' : '▼';
}

async function atualizarEstoqueVariacao(mlb, variacaoId, btn) {
  const input   = btn.previousElementSibling;
  const novaQtd = parseInt(input.value, 10);
  if (isNaN(novaQtd) || novaQtd < 0) return;

  btn.disabled    = true;
  btn.textContent = '...';

  try {
    const result = await apiFetch(`/api/ml/estoque/${mlb}`, {
      method: 'PUT',
      body:   JSON.stringify({ quantidade: novaQtd, variacao_id: variacaoId }),
    });
    if (result.error) {
      btn.textContent = '✗';
      btn.classList.add('btn-confirmar-erro');
      btn.title = result.error;
      setTimeout(() => {
        btn.textContent = '✓';
        btn.classList.remove('btn-confirmar-erro');
        btn.title = '';
        btn.disabled = false;
      }, 3000);
    } else {
      btn.textContent = '✓';
      btn.classList.add('btn-confirmar-ok');
      input.defaultValue = novaQtd;
      const item = todosItens.find(i => i.mlb === mlb);
      if (item && item.variacoes) {
        const v = item.variacoes.find(v => v.id === variacaoId);
        if (v) v.estoque = novaQtd;
        const total = item.variacoes.reduce((s, v) => s + v.estoque, 0);
        item.estoque = total;
        const totalEl = document.getElementById(`estoque-total-${mlb}`);
        if (totalEl) totalEl.textContent = total;
      }
      setTimeout(() => {
        btn.classList.remove('btn-confirmar-ok');
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    btn.textContent = '✗';
    btn.classList.add('btn-confirmar-erro');
    btn.title = e.message;
    setTimeout(() => {
      btn.textContent = '✓';
      btn.classList.remove('btn-confirmar-erro');
      btn.title = '';
      btn.disabled = false;
    }, 3000);
  }
}

function isProprio(deposito) {
  return deposito === 'self_service' || deposito === 'xd_drop_off';
}

async function atualizarEstoque(mlb, btn) {
  const input   = btn.previousElementSibling;
  const novaQtd = parseInt(input.value, 10);
  if (isNaN(novaQtd) || novaQtd < 0) return;

  btn.disabled    = true;
  btn.textContent = '...';

  try {
    const result = await apiFetch(`/api/ml/estoque/${mlb}`, {
      method: 'PUT',
      body:   JSON.stringify({ quantidade: novaQtd }),
    });
    if (result.error) {
      btn.textContent = '✗';
      btn.classList.add('btn-confirmar-erro');
      btn.title = result.error;
      setTimeout(() => {
        btn.textContent = '✓';
        btn.classList.remove('btn-confirmar-erro');
        btn.title    = '';
        btn.disabled = false;
      }, 3000);
    } else {
      btn.textContent = '✓';
      btn.classList.add('btn-confirmar-ok');
      const item = todosItens.find(i => i.mlb === mlb);
      if (item) item.estoque = novaQtd;
      input.defaultValue = novaQtd;
      setTimeout(() => {
        btn.classList.remove('btn-confirmar-ok');
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    btn.textContent = '✗';
    btn.classList.add('btn-confirmar-erro');
    btn.title = e.message;
    setTimeout(() => {
      btn.textContent = '✓';
      btn.classList.remove('btn-confirmar-erro');
      btn.title    = '';
      btn.disabled = false;
    }, 3000);
  }
}

function renderizarTabela() {
  let itens = todosItens;
  const skuFiltro    = (document.getElementById('filtro-sku')?.value    || '').trim().toLowerCase();
  const tituloFiltro = (document.getElementById('filtro-titulo')?.value || '').trim().toLowerCase();
  if (skuFiltro)    itens = itens.filter(i => String(i.sku).toLowerCase().includes(skuFiltro));
  if (tituloFiltro) itens = itens.filter(i => String(i.titulo).toLowerCase().includes(tituloFiltro));
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
    const bDeposito    = BADGE_DEPOSITO[item.deposito] || 'badge-outro';
    const bStatus      = BADGE_STATUS[item.status]     || 'badge-outro';
    const duracao      = calcularDuracao(item.estoque, item.vendas30d);
    const diasPausado  = calcularDiasPausado(item.status, item.pausadoDesde);
    const temVariacoes = isProprio(item.deposito) && item.variacoes && item.variacoes.length > 0;

    let estoqueCell;
    if (temVariacoes) {
      const aberto = expandedMLBs.has(item.mlb);
      estoqueCell = `<td class="col-num"><div class="estoque-edit-wrap"><span id="estoque-total-${item.mlb}" class="${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</span><button id="btn-expandir-${item.mlb}" class="btn-expandir-var" onclick="toggleVariacoes('${item.mlb}')">${aberto ? '▲' : '▼'}</button></div></td>`;
    } else if (isProprio(item.deposito)) {
      estoqueCell = `<td class="col-num"><div class="estoque-edit-wrap"><input type="number" class="estoque-input" value="${item.estoque}" min="0"><button class="btn-confirmar-estoque" onclick="atualizarEstoque('${item.mlb}', this)">✓</button></div></td>`;
    } else {
      estoqueCell = `<td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</td>`;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-sku">${item.sku}</td>
      <td class="td-titulo" title="${item.titulo}">${item.titulo}</td>
      <td class="td-mlb">${item.mlb}</td>
      <td><span class="badge-deposito ${bDeposito}">${item.depositoLabel}</span></td>
      <td><span class="badge-deposito ${bStatus}">${STATUS_LABEL[item.status] || item.status}</span></td>
      ${estoqueCell}
      <td class="col-num">${item.vendas30d === null ? '...' : (item.vendas30d || '—')}</td>
      <td class="col-num ${duracao.classe}">${item.vendas30d === null ? '...' : duracao.texto}</td>
      <td class="col-num ${diasPausado !== null ? 'pausado-dias' : ''}">${diasPausado !== null ? diasPausado + 'd' : ''}</td>
    `;
    tbody.appendChild(tr);

    if (temVariacoes) {
      const aberto = expandedMLBs.has(item.mlb);
      item.variacoes.forEach(v => {
        const trVar = document.createElement('tr');
        trVar.className = `variacao-row variacao-row-${item.mlb}`;
        trVar.style.display = aberto ? '' : 'none';
        trVar.innerHTML = `
          <td colspan="2" class="variacao-indent"></td>
          <td colspan="3" class="variacao-nome">↳ ${v.nome}</td>
          <td class="col-num">
            <div class="estoque-edit-wrap">
              <input type="number" class="estoque-input" value="${v.estoque}" min="0">
              <button class="btn-confirmar-estoque" onclick="atualizarEstoqueVariacao('${item.mlb}', ${v.id}, this)">✓</button>
            </div>
          </td>
          <td colspan="3"></td>
        `;
        tbody.appendChild(trVar);
      });
    }
  });

  document.getElementById('tabela-estoque').style.display = itens.length ? 'table' : 'none';
  const filtroAtivo = filtros.deposito !== 'todos' || filtros.status !== 'todos';
  document.getElementById('estoque-total').textContent =
    `${itens.length} de ${todosItens.length} anúncios` +
    (filtroAtivo ? ' (filtro ativo)' : '');
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

// ── Vendas com etiqueta ───────────────────────────────────────

const BADGE_VENDA_STATUS = {
  handling:      'badge-pausado',
  ready_to_ship: 'badge-ativo',
  shipped:       'badge-encerrado',
};

function toggleTodasVendas(master) {
  document.querySelectorAll('.check-venda').forEach(cb => cb.checked = master.checked);
  atualizarBotaoSelecionadas();
}

function atualizarBotaoSelecionadas() {
  const selecionadas = document.querySelectorAll('.check-venda:checked').length;
  const btn = document.getElementById('btn-baixar-selecionadas');
  if (btn) {
    btn.style.display = selecionadas > 0 ? '' : 'none';
    btn.textContent   = `⬇ Baixar ${selecionadas} etiqueta${selecionadas !== 1 ? 's' : ''}`;
  }
  // Atualiza estado do checkbox "todas"
  const total = document.querySelectorAll('.check-venda').length;
  const master = document.getElementById('check-todas');
  if (master) {
    master.checked       = selecionadas === total && total > 0;
    master.indeterminate = selecionadas > 0 && selecionadas < total;
  }
}

function baixarSelecionadas() {
  const checks = document.querySelectorAll('.check-venda:checked');
  if (!checks.length) return;

  // Agrupa por conta para montar as URLs corretas
  const porConta = {};
  checks.forEach(cb => {
    const conta = cb.dataset.conta;
    if (!porConta[conta]) porConta[conta] = [];
    porConta[conta].push(cb.dataset.shipmentId);
  });

  for (const [conta, ids] of Object.entries(porConta)) {
    window.open(`/api/ml/etiquetas?ids=${ids.join(',')}&conta=${conta}`, '_blank');
  }
}

async function carregarVendas() {
  const loading = document.getElementById('vendas-loading');
  const erroEl  = document.getElementById('vendas-erro');
  const totalEl = document.getElementById('vendas-total');
  const tabela  = document.getElementById('tabela-vendas');
  const tbody   = document.getElementById('tabela-vendas-body');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  tabela.style.display  = 'none';
  totalEl.textContent   = '';
  tbody.innerHTML       = '';

  try {
    const data = await apiFetch('/api/ml/vendas-etiquetas');
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    const todasVendas = data.vendas || [];
    const vendas    = todasVendas.filter(v => !v.atendida);
    const atendidas = todasVendas.filter(v => v.atendida);

    totalEl.textContent = `${vendas.length} venda${vendas.length !== 1 ? 's' : ''} pendente${vendas.length !== 1 ? 's' : ''}`;

    if (!vendas.length && !atendidas.length) return;

    renderizarAtendidos(atendidas);

    if (!vendas.length) { tabela.style.display = 'none'; atualizarBotaoSelecionadas(); return; }

    vendas.forEach(v => {
      const bStatus  = BADGE_VENDA_STATUS[v.status] || 'badge-outro';
      const itens = v.itensLista || [];
      const item0 = itens[0] || {};
      const multi = itens.length > 1;

      // Linha principal do pedido (mostra primeiro item)
      const tr = document.createElement('tr');
      if (multi) tr.classList.add('venda-multi-header');
      const imgHtml0 = item0.thumbnail
        ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb" loading="lazy"></a>`
        : `<div class="venda-thumb-vazio"></div>`;
      tr.innerHTML = `
        <td><input type="checkbox" class="check-venda" data-shipment-id="${v.shipmentId}" data-conta="${v.conta}" onchange="atualizarBotaoSelecionadas()"></td>
        <td class="td-thumb">${imgHtml0}</td>
        <td class="td-order-id">#${v.orderId}</td>
        <td>${v.comprador}</td>
        <td class="col-num venda-qtd">${item0.quantidade ?? ''}</td>
        <td class="td-sku">${item0.sku || '—'}</td>
        <td class="td-titulo" title="${item0.titulo || ''}">${item0.titulo || '—'}</td>
        <td><span class="badge-deposito ${bStatus}">${v.statusLabel}</span></td>
        <td><a class="btn-etiqueta" href="/api/ml/etiqueta/${v.shipmentId}?conta=${v.conta}" target="_blank">${v.acaoLabel}</a></td>
        <td><button class="btn-atender" onclick="marcarAtendido('${v.shipmentId}', this)" title="Marcar como atendido">✔</button></td>
      `;
      tbody.appendChild(tr);

      // Sub-linhas para os demais itens do mesmo pedido
      for (let i = 1; i < itens.length; i++) {
        const item   = itens[i];
        const isLast = i === itens.length - 1;
        const trSub  = document.createElement('tr');
        trSub.classList.add('venda-sub-item');
        if (isLast) trSub.classList.add('venda-sub-last');
        const imgHtml = item.thumbnail
          ? `<a href="${item.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item.thumbnail}" class="venda-thumb" loading="lazy"></a>`
          : `<div class="venda-thumb-vazio"></div>`;
        trSub.innerHTML = `
          <td class="venda-sub-indent"></td>
          <td class="td-thumb">${imgHtml}</td>
          <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
          <td class="col-num venda-qtd">${item.quantidade ?? ''}</td>
          <td class="td-sku">${item.sku || '—'}</td>
          <td class="td-titulo" title="${item.titulo || ''}">${item.titulo || '—'}</td>
          <td colspan="3"></td>
        `;
        tbody.appendChild(trSub);
      }
    });
    atualizarBotaoSelecionadas();

    tabela.style.display = 'table';
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar vendas.';
    erroEl.style.display = 'block';
  }
}

// ── Atendidos ─────────────────────────────────────────────────

async function marcarAtendido(shipmentId, btn) {
  btn.disabled = true;
  try {
    await apiFetch('/api/vendas/atendida', {
      method: 'POST',
      body:   JSON.stringify({ shipmentId }),
    });
    carregarVendas();
  } catch {
    btn.disabled = false;
  }
}

async function desatenderPedido(shipmentId, btn) {
  btn.disabled = true;
  try {
    await apiFetch('/api/vendas/atendida', {
      method:  'DELETE',
      body:    JSON.stringify({ shipmentId }),
    });
    carregarVendas();
  } catch {
    btn.disabled = false;
  }
}

function renderizarAtendidos(atendidas) {
  const header = document.getElementById('atendidos-header');
  const tbody  = document.getElementById('tabela-atendidos-body');
  const total  = document.getElementById('atendidos-total');

  tbody.innerHTML = '';

  if (!atendidas.length) {
    header.style.display = 'none';
    return;
  }

  header.style.display = '';
  total.textContent    = `✔ ${atendidas.length} pedido${atendidas.length !== 1 ? 's' : ''} atendido${atendidas.length !== 1 ? 's' : ''}`;

  atendidas.forEach(v => {
    const itens = v.itensLista || [];
    const item0 = itens[0] || {};
    const multi = itens.length > 1;

    const tr = document.createElement('tr');
    if (multi) tr.classList.add('venda-multi-header');
    const imgHtml0 = item0.thumbnail
      ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb venda-thumb-sm" loading="lazy"></a>`
      : `<div class="venda-thumb-vazio venda-thumb-sm"></div>`;
    tr.innerHTML = `
      <td class="td-thumb">${imgHtml0}</td>
      <td class="td-order-id">#${v.orderId}</td>
      <td>${v.comprador}</td>
      <td class="col-num venda-qtd">${item0.quantidade ?? ''}</td>
      <td class="td-sku">${item0.sku || '—'}</td>
      <td class="td-titulo" title="${item0.titulo || ''}">${item0.titulo || '—'}</td>
      <td><button class="btn-desatender" onclick="desatenderPedido('${v.shipmentId}', this)" title="Remover dos atendidos">↩ Devolver</button></td>
    `;
    tbody.appendChild(tr);

    for (let i = 1; i < itens.length; i++) {
      const item   = itens[i];
      const isLast = i === itens.length - 1;
      const trSub  = document.createElement('tr');
      trSub.classList.add('venda-sub-item');
      if (isLast) trSub.classList.add('venda-sub-last');
      const imgHtml = item.thumbnail
        ? `<a href="${item.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item.thumbnail}" class="venda-thumb venda-thumb-sm" loading="lazy"></a>`
        : `<div class="venda-thumb-vazio venda-thumb-sm"></div>`;
      trSub.innerHTML = `
        <td class="td-thumb">${imgHtml}</td>
        <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
        <td class="col-num venda-qtd">${item.quantidade ?? ''}</td>
        <td class="td-sku">${item.sku || '—'}</td>
        <td class="td-titulo" title="${item.titulo || ''}">${item.titulo || '—'}</td>
        <td></td>
      `;
      tbody.appendChild(trSub);
    }
  });
}

// ── Sair ──────────────────────────────────────────────────────

function sair() {
  sessionStorage.removeItem('auth');
  location.href = '/';
}

// ── Inicialização ─────────────────────────────────────────────

inicializarSeletorConta();
carregarEstoque(true);
