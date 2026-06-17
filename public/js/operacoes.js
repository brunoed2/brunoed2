// ============================================================
// operacoes.js — Vendas com etiqueta + Histórico de vendas
// Usado em app.html (apiFetch e contaGen vêm de app-v2.js)
// ============================================================

// ── Vendas com etiqueta ───────────────────────────────────────

function formatarPrazo(iso) {
  if (!iso) return '<span style="color:#aaa">—</span>';
  const prazo = new Date(iso);
  const diff  = prazo - Date.now();
  const h     = diff / 3_600_000;
  const d     = String(prazo.getDate()).padStart(2, '0');
  const mo    = String(prazo.getMonth() + 1).padStart(2, '0');
  const hh    = String(prazo.getHours()).padStart(2, '0');
  const mi    = String(prazo.getMinutes()).padStart(2, '0');
  const txt   = `${d}/${mo} ${hh}:${mi}`;
  if (h < 2)  return `<span style="color:#dc2626;font-weight:700">${txt}</span>`;
  if (h < 6)  return `<span style="color:#d97706;font-weight:600">${txt}</span>`;
  return txt;
}

const vendaCache = {};

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
  const checks       = [...document.querySelectorAll('.check-venda:checked')];
  const selecionadas = checks.length;
  const btnBaixar    = document.getElementById('btn-baixar-selecionadas');
  const btnAtendido  = document.getElementById('btn-marcar-atendido');

  if (btnBaixar) {
    btnBaixar.style.display = selecionadas > 0 ? '' : 'none';
    btnBaixar.textContent   = `⬇ Baixar ${selecionadas} etiqueta${selecionadas !== 1 ? 's' : ''}`;
  }
  if (btnAtendido) {
    if (selecionadas === 0) {
      btnAtendido.style.display = 'none';
    } else {
      const todosAtendidos = checks.every(cb => cb.closest('tr')?.classList.contains('venda-atendida'));
      btnAtendido.style.display   = '';
      btnAtendido.dataset.remover = todosAtendidos ? '1' : '0';
      if (todosAtendidos) {
        btnAtendido.textContent      = `✕ Remover atendido (${selecionadas})`;
        btnAtendido.style.background = '#dc2626';
      } else {
        btnAtendido.textContent      = `✔ Marcar atendido (${selecionadas})`;
        btnAtendido.style.background = '#16a34a';
      }
    }
  }
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
      body: JSON.stringify({ shipmentIds, vendasDados, conta: window.CONTA_ATIVA }),
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

let filtroAtendidos  = false;
let skuFiltroVendas  = null;
let skuFiltroFuturos = null;

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
    if (tr.classList.contains('venda-sub-item')) continue;
    const atendida = tr.classList.contains('venda-atendida');
    const skuMatch = !skuFiltroVendas || (tr.dataset.skus || '').split(' ').includes(skuFiltroVendas);
    const visivel  = (!filtroAtendidos || atendida) && skuMatch;
    tr.style.display = visivel ? '' : 'none';
    let next = tr.nextElementSibling;
    while (next && next.classList.contains('venda-sub-item')) {
      next.style.display = visivel ? '' : 'none';
      next = next.nextElementSibling;
    }
    if (visivel) visiveis++;
  }
  const totalEl = document.getElementById('vendas-total');
  const total   = tbody.querySelectorAll('tr:not(.venda-sub-item)').length;
  if (filtroAtendidos) {
    totalEl.textContent = `${visiveis} pedido${visiveis !== 1 ? 's' : ''} flagado${visiveis !== 1 ? 's' : ''}`;
  } else if (skuFiltroVendas) {
    totalEl.textContent = `${visiveis} de ${total} pedido${total !== 1 ? 's' : ''}`;
  } else {
    const atendidos = tbody.querySelectorAll('tr.venda-atendida:not(.venda-sub-item)').length;
    totalEl.textContent = `${total} pedido${total !== 1 ? 's' : ''}${atendidos ? ` · ${atendidos} flagado${atendidos !== 1 ? 's' : ''}` : ''}`;
  }
}

function aplicarFiltroFuturos() {
  const tbody = document.getElementById('tabela-futuros-body');
  if (!tbody) return;
  let visiveis = 0;
  for (const tr of tbody.querySelectorAll('tr')) {
    if (tr.classList.contains('venda-sub-item')) continue;
    if (tr.classList.contains('futuros-data-sep')) continue;
    const skuMatch = !skuFiltroFuturos || (tr.dataset.skus || '').split(' ').includes(skuFiltroFuturos);
    tr.style.display = skuMatch ? '' : 'none';
    let next = tr.nextElementSibling;
    while (next && next.classList.contains('venda-sub-item')) {
      next.style.display = skuMatch ? '' : 'none';
      next = next.nextElementSibling;
    }
    if (skuMatch) visiveis++;
  }
  const totalEl  = document.getElementById('futuros-total');
  const total    = tbody.querySelectorAll('tr:not(.venda-sub-item)').length;
  totalEl.textContent = skuFiltroFuturos
    ? `${visiveis} de ${total} pedido${total !== 1 ? 's' : ''}`
    : `${total} pedido${total !== 1 ? 's' : ''}`;
}

function renderizarChipsSKU(tipo, lista) {
  const container = document.getElementById(tipo === 'vendas' ? 'vendas-sku-chips' : 'futuros-sku-chips');
  if (!container) return;
  const skuMap = new Map();
  for (const venda of lista) {
    for (const item of (venda.itensLista || [])) {
      if (!item.sku) continue;
      skuMap.set(item.sku, (skuMap.get(item.sku) || 0) + (item.quantidade || 0));
    }
  }
  if (!skuMap.size) { container.innerHTML = ''; return; }
  const skus = [...skuMap.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  container.innerHTML = skus.map(sku =>
    `<button class="chip-sku" data-sku="${sku}" onclick="filtrarPorSku('${tipo}', this.dataset.sku)">${sku} · ${skuMap.get(sku)}un</button>`
  ).join('');
}

function filtrarPorSku(tipo, sku) {
  if (tipo === 'vendas') {
    skuFiltroVendas = skuFiltroVendas === sku ? null : sku;
    document.querySelectorAll('#vendas-sku-chips .chip-sku').forEach(btn =>
      btn.classList.toggle('chip-sku-ativo', btn.dataset.sku === skuFiltroVendas)
    );
    aplicarFiltroAtendidos();
  } else {
    skuFiltroFuturos = skuFiltroFuturos === sku ? null : sku;
    document.querySelectorAll('#futuros-sku-chips .chip-sku').forEach(btn =>
      btn.classList.toggle('chip-sku-ativo', btn.dataset.sku === skuFiltroFuturos)
    );
    aplicarFiltroFuturos();
  }
}

async function carregarVendas() {
  const gen     = contaGen;
  const loading = document.getElementById('vendas-loading');
  const erroEl  = document.getElementById('vendas-erro');
  const totalEl = document.getElementById('vendas-total');
  const tabela  = document.getElementById('tabela-vendas');
  const tbody   = document.getElementById('tabela-vendas-body');
  if (!tbody) return;

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  tabela.style.display  = 'none';
  totalEl.textContent   = '';
  tbody.innerHTML       = '';
  skuFiltroVendas       = null;

  try {
    const data = await apiFetch(`/api/ml/vendas-etiquetas?conta=${window.CONTA_ATIVA}`);
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
      tr.dataset.skus = [...new Set(itens.map(i => i.sku).filter(Boolean))].join(' ');
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
    renderizarChipsSKU('vendas', todasVendas);
    aplicarFiltroAtendidos();
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar vendas.';
    erroEl.style.display = 'block';
  }
}

// ── Pedidos Futuros ──────────────────────────────────────────
let pedidosFuturosAberto    = false;
let pedidosFuturosCarregado = false;

function togglePedidosFuturos() {
  pedidosFuturosAberto = !pedidosFuturosAberto;
  const conteudo = document.getElementById('futuros-conteudo');
  const chevron  = document.getElementById('futuros-chevron');
  const btnAtu   = document.getElementById('btn-atualizar-futuros');
  conteudo.style.display  = pedidosFuturosAberto ? 'block' : 'none';
  chevron.style.transform = pedidosFuturosAberto ? 'rotate(90deg)' : '';
  btnAtu.style.display    = pedidosFuturosAberto ? '' : 'none';
  if (pedidosFuturosAberto && !pedidosFuturosCarregado) carregarFuturos();
}

async function carregarFuturos() {
  const gen     = contaGen;
  const loading = document.getElementById('futuros-loading');
  const erroEl  = document.getElementById('futuros-erro');
  const totalEl = document.getElementById('futuros-total');
  const tabela  = document.getElementById('tabela-futuros');
  const tbody   = document.getElementById('tabela-futuros-body');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  tabela.style.display  = 'none';
  totalEl.textContent   = '';
  tbody.innerHTML       = '';
  skuFiltroFuturos      = null;

  try {
    const data = await apiFetch(`/api/ml/pedidos-futuros?conta=${window.CONTA_ATIVA}`);
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    const pedidos = data.pedidos || [];
    pedidosFuturosCarregado = true;
    totalEl.textContent = `${pedidos.length} pedido${pedidos.length !== 1 ? 's' : ''}`;

    if (!pedidos.length) return;

    pedidos.sort((a, b) => {
      if (!a.dataLiberacao && !b.dataLiberacao) return 0;
      if (!a.dataLiberacao) return 1;
      if (!b.dataLiberacao) return -1;
      return a.dataLiberacao.localeCompare(b.dataLiberacao);
    });

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    let dataGrupoAtual = null;

    pedidos.forEach(p => {
      const itens   = p.itensLista || [];
      const item0   = itens[0] || {};
      const multi   = itens.length > 1;
      const dataLib = p.dataLiberacao ? new Date(p.dataLiberacao) : null;
      // Usa a data UTC para evitar que meia-noite UTC vire dia anterior em BRT
      const dataStr = p.dataLiberacao
        ? p.dataLiberacao.slice(0, 10).split('-').reverse().join('/')
        : '—';
      const liberaHoje = dataLib && dataLib <= hoje;

      const dataGrupo = p.dataLiberacao ? p.dataLiberacao.slice(0, 10) : '__sem_data__';
      if (dataGrupo !== dataGrupoAtual) {
        dataGrupoAtual = dataGrupo;
        const trSep = document.createElement('tr');
        trSep.className = 'futuros-data-sep';
        const labelData = liberaHoje
          ? `<span style="color:#d97706">${dataStr} — hoje</span>`
          : dataStr;
        trSep.innerHTML = `<td colspan="7">${labelData}</td>`;
        tbody.appendChild(trSep);
      }

      const tr = document.createElement('tr');
      tr.dataset.skus = [...new Set(itens.map(i => i.sku).filter(Boolean))].join(' ');
      if (multi) tr.classList.add('venda-multi-header');
      if (liberaHoje) tr.style.background = 'rgba(234,179,8,0.08)';

      const imgHtml0 = item0.thumbnail
        ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb" loading="lazy"></a>`
        : `<div class="venda-thumb-vazio"></div>`;

      tr.innerHTML = `
        <td class="td-thumb">${imgHtml0}</td>
        <td class="td-order-id">#${p.orderId}</td>
        <td>${p.comprador}</td>
        <td class="col-num venda-qtd">${item0.quantidade ?? ''}</td>
        <td class="td-sku">${item0.sku || '—'}</td>
        <td class="td-titulo" title="${item0.titulo || ''}${item0.variacao ? ` (${item0.variacao})` : ''}">${item0.titulo || '—'}${item0.variacao ? `<br><span class="venda-variacao">${item0.variacao}</span>` : ''}</td>
        <td></td>
      `;
      tbody.appendChild(tr);

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
          <td class="td-thumb">${imgHtml}</td>
          <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
          <td class="col-num venda-qtd">${item.quantidade ?? ''}</td>
          <td class="td-sku">${item.sku || '—'}</td>
          <td class="td-titulo" title="${item.titulo || ''}${item.variacao ? ` (${item.variacao})` : ''}">${item.titulo || '—'}${item.variacao ? `<span class="venda-variacao"> — ${item.variacao}</span>` : ''}</td>
          <td></td>
        `;
        tbody.appendChild(trSub);
      }
    });

    tabela.style.display = 'table';
    renderizarChipsSKU('futuros', pedidos);
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar pedidos futuros.';
    erroEl.style.display = 'block';
  }
}

async function toggleFlag(shipmentId, btn) {
  btn.disabled = true;
  const tr       = btn.closest('tr');
  const atendida = tr.classList.contains('venda-atendida');
  const sid      = String(shipmentId);
  try {
    const vendasDados = {};
    if (!atendida && vendaCache[sid]) vendasDados[sid] = vendaCache[sid];
    await apiFetch('/api/vendas/atendidas-batch', {
      method: atendida ? 'DELETE' : 'POST',
      body: JSON.stringify({ shipmentIds: [sid], vendasDados, conta: window.CONTA_ATIVA }),
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

// ── Histórico de vendas ───────────────────────────────────────

let histDados = [];

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
    await apiFetch('/api/vendas/historico/sincronizar', { method: 'POST', body: JSON.stringify({ conta: window.CONTA_ATIVA }) });
  } catch {}

  try {
    const params = new URLSearchParams();
    if (ini) params.set('de', ini);
    if (fim) params.set('ate', fim);
    params.set('conta', window.CONTA_ATIVA);
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
    const dataFmt = (h.dataDespacho || h.data) ? new Date(h.dataDespacho || h.data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—';
    const qtdTotal = (h.itensLista || []).reduce((s, i) => s + (i.quantidade || 1), 0);
    const skus  = [...new Set((h.itensLista || []).map(i => i.sku).filter(Boolean))].join(', ') || '—';
    const itens = (h.itensLista || []).map(i => `${i.titulo}${i.variacao ? ' — ' + i.variacao : ''}${i.quantidade > 1 ? ' (x' + i.quantidade + ')' : ''}`).join('<br>');
    const atendidoHtml = h.atendida
      ? `<span style="color:#16a34a;font-size:12px">✔ Sim${h.atendidaEm ? '<br><span style="font-size:11px;color:#94a3b8">' + new Date(h.atendidaEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</span>' : ''}</span>`
      : '<span style="color:#94a3b8;font-size:12px">—</span>';
    const item0 = (h.itensLista || [])[0];
    const imgHtml = item0?.thumbnail
      ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb" loading="lazy"></a>`
      : '<span style="color:#94a3b8;font-size:11px">—</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${dataFmt}</td>
      <td>${imgHtml}</td>
      <td style="white-space:nowrap">#${h.orderId}</td>
      <td>${h.comprador || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td style="font-size:12px;color:#64748b">${skus}</td>
      <td style="font-size:12px">${itens}</td>
      <td>${atendidoHtml}</td>
    `;
    tbody.appendChild(tr);
  }
}
