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

let filtroAtendidos = false;

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
    const visivel  = !filtroAtendidos || atendida;
    tr.style.display = visivel ? '' : 'none';
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
    const total     = tbody.querySelectorAll('tr:not(.venda-sub-item)').length;
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
  if (!tbody) return;

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
    await apiFetch('/api/vendas/historico/sincronizar', { method: 'POST' });
  } catch {}

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
