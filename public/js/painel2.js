// ============================================================
// painel2.js — Lógica do Painel 2
// ============================================================

// ── Navegação entre abas ──────────────────────────────────────

const navBtns = document.querySelectorAll('.nav-btn');
const tabs    = document.querySelectorAll('.tab');

function abrirAba(nome) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));
  if (trocandoConta) return; // aguarda trocarConta disparar o reload
  if (nome === 'estoque')   carregarEstoque(true);
  if (nome === 'vendas')    carregarVendas();
  if (nome === 'historico') { histIniciarDatas(); carregarHistorico(); }
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => abrirAba(btn.dataset.tab));
});

// ── Troca de conta ────────────────────────────────────────────

let trocandoConta = false;

async function trocarConta(num) {
  if (trocandoConta) return;
  trocandoConta = true;

  // Invalida qualquer requisição em andamento da conta anterior
  contaGen++;

  document.querySelectorAll('.conta-btn').forEach(b => b.disabled = true);

  try {
    await fetch('/api/conta/ativa', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta: num }),
    });

    document.querySelectorAll('.conta-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.conta === num);
    });

    // Recarrega a aba atual só após confirmação do servidor
    const abaAtiva = document.querySelector('.tab.active')?.id?.replace('tab-', '');
    if (abaAtiva === 'estoque')   carregarEstoque(true);
    if (abaAtiva === 'vendas')    carregarVendas();
    if (abaAtiva === 'historico') carregarHistorico();
  } finally {
    document.querySelectorAll('.conta-btn').forEach(b => b.disabled = false);
    trocandoConta = false;
  }
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

// ── Geração de conta (evita sobrescrita por respostas atrasadas) ──

let contaGen = 0; // incrementado a cada troca; cada load guarda sua geração

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
      <td class="td-titulo" title="${item.titulo}">${item.permalink ? `<a class="link-anuncio" href="${item.permalink}" target="_blank">${item.titulo}</a>` : item.titulo}</td>
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
  const gen = contaGen;

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
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (estoqueData.error) {
      erroEl.textContent   = estoqueData.error;
      erroEl.style.display = 'block';
      return;
    }

    todosItens = estoqueData.items.map(item => ({ ...item, vendas30d: null }));
    renderizarTabela();
  } catch {
    if (contaGen !== gen) return;
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
    if (contaGen !== gen) return;
    const vendasData = await resp.json();
    const vendas = (vendasData && !vendasData.error) ? vendasData : {};

    todosItens = todosItens.map(item => ({
      ...item,
      vendas30d: vendas[item.mlb] || 0,
    }));
    renderizarTabela();
  } catch (err) {
    if (contaGen !== gen) return;
    console.error('Vendas:', err.message);
    todosItens = todosItens.map(item => ({ ...item, vendas30d: 0 }));
    renderizarTabela();
  }
}

// ── Vendas com etiqueta ───────────────────────────────────────

const vendaCache = {}; // shipmentId → dados completos da venda

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
  const checks      = [...document.querySelectorAll('.check-venda:checked')];
  const selecionadas = checks.length;
  const btnBaixar   = document.getElementById('btn-baixar-selecionadas');
  const btnAtendido = document.getElementById('btn-marcar-atendido');

  if (btnBaixar) {
    btnBaixar.style.display = selecionadas > 0 ? '' : 'none';
    btnBaixar.textContent   = `⬇ Baixar ${selecionadas} etiqueta${selecionadas !== 1 ? 's' : ''}`;
  }
  if (btnAtendido) {
    if (selecionadas === 0) {
      btnAtendido.style.display = 'none';
    } else {
      // Se TODOS os selecionados já são atendidos → botão vira "Remover"
      const todosAtendidos = checks.every(cb => cb.closest('tr')?.classList.contains('venda-atendida'));
      btnAtendido.style.display   = '';
      btnAtendido.dataset.remover = todosAtendidos ? '1' : '0';
      if (todosAtendidos) {
        btnAtendido.textContent       = `✕ Remover atendido (${selecionadas})`;
        btnAtendido.style.background  = '#dc2626';
      } else {
        btnAtendido.textContent       = `✔ Marcar atendido (${selecionadas})`;
        btnAtendido.style.background  = '#16a34a';
      }
    }
  }
  // Atualiza estado do checkbox "todas"
  const total  = document.querySelectorAll('.check-venda').length;
  const master = document.getElementById('check-todas');
  if (master) {
    master.checked       = selecionadas === total && total > 0;
    master.indeterminate = selecionadas > 0 && selecionadas < total;
  }
}

async function marcarAtendidoSelecionadas() {
  const checks = [...document.querySelectorAll('.check-venda:checked')];
  if (!checks.length) return;
  const btn     = document.getElementById('btn-marcar-atendido');
  const remover = btn?.dataset.remover === '1';
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }

  const shipmentIds = checks.map(cb => cb.dataset.shipmentId);
  const vendasDados = {};
  if (!remover) shipmentIds.forEach(sid => { if (vendaCache[sid]) vendasDados[sid] = vendaCache[sid]; });

  try {
    const r = await apiFetch('/api/vendas/atendidas-batch', {
      method: remover ? 'DELETE' : 'POST',
      body: JSON.stringify({ shipmentIds, vendasDados }),
    });
    if (r.ok) {
      checks.forEach(cb => {
        const tr = cb.closest('tr');
        if (!tr) return;
        if (remover) {
          tr.classList.remove('venda-atendida');
          const flagBtn = tr.querySelector('.btn-flag');
          if (flagBtn) { flagBtn.classList.remove('btn-flag-ativo'); flagBtn.title = 'Marcar como atendido'; }
        } else {
          tr.classList.add('venda-atendida');
          const flagBtn = tr.querySelector('.btn-flag');
          if (flagBtn) { flagBtn.classList.add('btn-flag-ativo'); flagBtn.title = 'Remover flag'; }
        }
        let next = tr.nextElementSibling;
        while (next && next.classList.contains('venda-sub-item')) {
          next.classList.toggle('venda-atendida', !remover);
          next = next.nextElementSibling;
        }
        cb.checked = false;
      });
      atualizarBotaoSelecionadas();
      aplicarFiltroAtendidos();
    } else {
      alert('Erro ao salvar. Tente novamente.');
    }
  } catch {
    alert('Erro ao salvar. Tente novamente.');
  } finally {
    if (btn) btn.disabled = false;
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

let filtroAtendidos = false; // false = todos, true = só flagados

function toggleFiltroAtendidos() {
  filtroAtendidos = !filtroAtendidos;
  const btn = document.getElementById('btn-filtro-atendidos');
  btn.classList.toggle('btn-primary', filtroAtendidos);
  btn.classList.toggle('btn-secondary', !filtroAtendidos);
  aplicarFiltroAtendidos();
}

function aplicarFiltroAtendidos() {
  const tbody = document.getElementById('tabela-vendas-body');
  let visiveis = 0;
  for (const tr of tbody.querySelectorAll('tr')) {
    if (tr.classList.contains('venda-sub-item')) continue; // sub-linhas seguem a principal
    const atendida = tr.classList.contains('venda-atendida');
    const visivel  = !filtroAtendidos || atendida;
    tr.style.display = visivel ? '' : 'none';
    // Esconde/mostra sub-linhas junto
    let next = tr.nextElementSibling;
    while (next && next.classList.contains('venda-sub-item')) {
      next.style.display = visivel ? '' : 'none';
      next = next.nextElementSibling;
    }
    if (visivel) visiveis++;
  }
  const totalEl = document.getElementById('vendas-total');
  if (filtroAtendidos) {
    totalEl.textContent = `${visiveis} pedido${visiveis !== 1 ? 's' : ''} flagado${visiveis !== 1 ? 's' : ''}`;
  } else {
    const total = tbody.querySelectorAll('tr:not(.venda-sub-item)').length;
    const atendidos = tbody.querySelectorAll('tr.venda-atendida:not(.venda-sub-item)').length;
    totalEl.textContent = `${total} pedido${total !== 1 ? 's' : ''}${atendidos ? ` · ${atendidos} flagado${atendidos !== 1 ? 's' : ''}` : ''}`;
  }
}

async function carregarVendas() {
  const gen     = contaGen;
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
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    const todasVendas = data.vendas || [];
    if (!todasVendas.length) { atualizarBotaoSelecionadas(); return; }

    todasVendas.forEach(v => {
      vendaCache[String(v.shipmentId)] = v;
      const bStatus = BADGE_VENDA_STATUS[v.status] || 'badge-outro';
      const itens   = v.itensLista || [];
      const item0   = itens[0] || {};
      const multi   = itens.length > 1;

      const tr = document.createElement('tr');
      if (multi)      tr.classList.add('venda-multi-header');
      if (v.atendida) tr.classList.add('venda-atendida');

      const imgHtml0 = item0.thumbnail
        ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb" loading="lazy"></a>`
        : `<div class="venda-thumb-vazio"></div>`;

      const flagClass = v.atendida ? 'btn-flag btn-flag-ativo' : 'btn-flag';
      const flagTitle = v.atendida ? 'Remover flag' : 'Marcar como atendido';

      tr.innerHTML = `
        <td><input type="checkbox" class="check-venda" data-shipment-id="${v.shipmentId}" data-conta="${v.conta}" onchange="atualizarBotaoSelecionadas()"></td>
        <td class="td-thumb">${imgHtml0}</td>
        <td class="td-order-id">#${v.orderId}</td>
        <td>${v.comprador}</td>
        <td class="col-num venda-qtd">${item0.quantidade ?? ''}</td>
        <td class="td-sku">${item0.sku || '—'}</td>
        <td class="td-titulo" title="${item0.titulo || ''}${item0.variacao ? ` (${item0.variacao})` : ''}">${item0.titulo || '—'}${item0.variacao ? `<br><span class="venda-variacao">${item0.variacao}</span>` : ''}</td>
        <td><span class="badge-deposito ${bStatus}">${v.statusLabel}</span></td>
        <td><a class="btn-etiqueta" href="/api/ml/etiqueta/${v.shipmentId}?conta=${v.conta}" target="_blank">${v.acaoLabel}</a></td>
        <td><button class="${flagClass}" data-sid="${v.shipmentId}" title="${flagTitle}" onclick="toggleFlag('${v.shipmentId}', this)">✔</button></td>
      `;
      tbody.appendChild(tr);

      for (let i = 1; i < itens.length; i++) {
        const item   = itens[i];
        const isLast = i === itens.length - 1;
        const trSub  = document.createElement('tr');
        trSub.classList.add('venda-sub-item');
        if (isLast) trSub.classList.add('venda-sub-last');
        if (v.atendida) trSub.classList.add('venda-atendida');
        const imgHtml = item.thumbnail
          ? `<a href="${item.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item.thumbnail}" class="venda-thumb" loading="lazy"></a>`
          : `<div class="venda-thumb-vazio"></div>`;
        trSub.innerHTML = `
          <td class="venda-sub-indent"></td>
          <td class="td-thumb">${imgHtml}</td>
          <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
          <td class="col-num venda-qtd">${item.quantidade ?? ''}</td>
          <td class="td-sku">${item.sku || '—'}</td>
          <td class="td-titulo" title="${item.titulo || ''}${item.variacao ? ` (${item.variacao})` : ''}">${item.titulo || '—'}${item.variacao ? `<span class="venda-variacao"> — ${item.variacao}</span>` : ''}</td>
          <td colspan="3"></td>
        `;
        tbody.appendChild(trSub);
      }
    });

    atualizarBotaoSelecionadas();
    tabela.style.display = 'table';
    aplicarFiltroAtendidos();
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar vendas.';
    erroEl.style.display = 'block';
  }
}

// ── Flag ──────────────────────────────────────────────────────

async function toggleFlag(shipmentId, btn) {
  btn.disabled = true;
  const tr       = btn.closest('tr');
  const atendida = tr.classList.contains('venda-atendida');
  const sid      = String(shipmentId);
  try {
    // Usa o endpoint batch (aguarda sync Railway) mesmo para item único
    const vendasDados = {};
    if (!atendida && vendaCache[sid]) vendasDados[sid] = vendaCache[sid];
    await apiFetch('/api/vendas/atendidas-batch', {
      method: atendida ? 'DELETE' : 'POST',
      body: JSON.stringify({ shipmentIds: [sid], vendasDados }),
    });
    tr.classList.toggle('venda-atendida');
    btn.classList.toggle('btn-flag-ativo');
    btn.title = tr.classList.contains('venda-atendida') ? 'Remover flag' : 'Marcar como atendido';
    let next = tr.nextElementSibling;
    while (next && next.classList.contains('venda-sub-item')) {
      next.classList.toggle('venda-atendida', tr.classList.contains('venda-atendida'));
      next = next.nextElementSibling;
    }
    aplicarFiltroAtendidos();
  } catch {}
  btn.disabled = false;
}

// ── Sair ──────────────────────────────────────────────────────

function sair() {
  sessionStorage.removeItem('auth');
  location.href = '/';
}

// ── Histórico de vendas ───────────────────────────────────────

let histDados = []; // cache local para busca sem nova chamada ao servidor

function histIniciarDatas() {
  const ini = document.getElementById('hist-data-ini');
  const fim = document.getElementById('hist-data-fim');
  if (!ini || !fim || ini.value) return;
  const hoje = new Date();
  const fim7 = hoje.toISOString().split('T')[0];
  const ini7 = new Date(hoje);
  ini7.setDate(hoje.getDate() - 6);
  ini.value = ini7.toISOString().split('T')[0];
  fim.value = fim7;
}

async function carregarHistorico() {
  const loading = document.getElementById('hist-loading');
  const vazio   = document.getElementById('hist-vazio');
  const tabela  = document.getElementById('tabela-hist');
  const tbody   = document.getElementById('tabela-hist-body');
  if (!tbody) return;

  const ini = document.getElementById('hist-data-ini')?.value || '';
  const fim = document.getElementById('hist-data-fim')?.value || '';

  if (loading) loading.style.display = 'block';
  if (tabela)  tabela.style.display  = 'none';
  if (vazio)   vazio.style.display   = 'none';

  try {
    const params = new URLSearchParams();
    if (ini) params.set('de', ini);
    if (fim) params.set('ate', fim);
    const d = await apiFetch(`/api/vendas/historico?${params}`);
    histDados = d.historico || [];
  } catch {
    histDados = [];
  }

  if (loading) loading.style.display = 'none';
  renderizarHistorico();
}

function renderizarHistorico() {
  const vazio   = document.getElementById('hist-vazio');
  const tabela  = document.getElementById('tabela-hist');
  const tbody   = document.getElementById('tabela-hist-body');
  const totalEl = document.getElementById('hist-total');
  if (!tbody) return;

  const termo = (document.getElementById('hist-busca')?.value || '').toLowerCase().trim();

  const filtrado = termo ? histDados.filter(h => {
    const skus  = (h.itensLista || []).map(i => i.sku).join(' ');
    const itens = (h.itensLista || []).map(i => i.titulo + ' ' + (i.variacao || '')).join(' ');
    return [String(h.orderId), h.comprador || '', skus, itens].some(s => s.toLowerCase().includes(termo));
  }) : histDados;

  if (totalEl) totalEl.textContent = filtrado.length ? `${filtrado.length} pedido${filtrado.length !== 1 ? 's' : ''}` : '';

  if (!filtrado.length) {
    if (tabela) tabela.style.display = 'none';
    if (vazio)  vazio.style.display  = 'block';
    if (vazio)  vazio.textContent    = 'Nenhum pedido encontrado neste período.';
    return;
  }

  if (vazio)  vazio.style.display  = 'none';
  if (tabela) tabela.style.display = 'table';

  tbody.innerHTML = '';
  for (const h of filtrado) {
    const dataFmt = h.data ? new Date(h.data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—';
    const qtdTotal = (h.itensLista || []).reduce((s, i) => s + (i.quantidade || 1), 0);
    const skus  = [...new Set((h.itensLista || []).map(i => i.sku).filter(Boolean))].join(', ') || '—';
    const itens = (h.itensLista || []).map(i => `${i.titulo}${i.variacao ? ' — ' + i.variacao : ''}${i.quantidade > 1 ? ' (x' + i.quantidade + ')' : ''}`).join('<br>');
    const atendidoHtml = h.atendida
      ? `<span style="color:#16a34a;font-size:12px">✔ Sim${h.atendidaEm ? '<br><span style="font-size:11px;color:#94a3b8">' + new Date(h.atendidaEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</span>' : ''}</span>`
      : '<span style="color:#94a3b8;font-size:12px">—</span>';
    const statusBadgeClass = { handling: 'badge-pausado', ready_to_ship: 'badge-ativo', shipped: 'badge-encerrado' }[h.status] || '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${dataFmt}</td>
      <td style="white-space:nowrap">#${h.orderId}</td>
      <td>${h.comprador || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td style="font-size:12px;color:#64748b">${skus}</td>
      <td style="font-size:12px">${itens}</td>
      <td><span class="badge-deposito ${statusBadgeClass}">${h.statusLabel || h.status || '—'}</span></td>
      <td>${atendidoHtml}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Inicialização ─────────────────────────────────────────────

inicializarSeletorConta();
carregarVendas();
