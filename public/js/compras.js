// ============================================================
// compras.js — Previsão de Compra
// ============================================================

let fornecedores  = [];
let previsaoLinhas = [];
let editandoFornId = null;
let prevSortState  = { campo: 'statusNum', direcao: 'asc' };

// ── Sub-abas ──────────────────────────────────────────────────

function comprasAbrirSub(sub) {
  document.querySelectorAll('.compras-sub-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sub === sub));
  document.querySelectorAll('.compras-painel').forEach(p =>
    p.style.display = p.id === `compras-painel-${sub}` ? '' : 'none');
  if (sub === 'previsao')    carregarPrevisao();
  if (sub === 'fornecedores') carregarFornecedores();
}

// ── Fornecedores ──────────────────────────────────────────────

async function carregarFornecedores() {
  const data = await apiFetch('/api/fornecedores');
  fornecedores = data.fornecedores || [];
  renderizarFornecedores();
}

function renderizarFornecedores() {
  const tbody = document.getElementById('tabela-fornecedores-body');
  if (!tbody) return;
  if (!fornecedores.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:24px">Nenhum fornecedor cadastrado.</td></tr>`;
    return;
  }
  tbody.innerHTML = fornecedores.map(f => `
    <tr>
      <td><strong>${esc(f.nome)}</strong></td>
      <td class="col-num">${f.leadTimeDias} dias</td>
      <td class="td-skus-fornecedor">${f.skus.length ? f.skus.map(s => `<span class="tag-sku">${esc(s)}</span>`).join(' ') : '<span style="color:#94a3b8">—</span>'}</td>
      <td>
        <div style="display:flex;gap:6px;justify-content:flex-end">
          <button class="btn-sm" onclick="abrirModalFornecedor('${f.id}')">Editar</button>
          <button class="btn-sm btn-danger-sm" onclick="excluirFornecedor('${f.id}')">Excluir</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function abrirModalFornecedor(id = null) {
  editandoFornId = id;
  const f = id ? fornecedores.find(x => x.id === id) : null;
  document.getElementById('modal-forn-titulo').textContent = f ? 'Editar Fornecedor' : 'Novo Fornecedor';
  document.getElementById('forn-nome').value  = f?.nome || '';
  document.getElementById('forn-lead').value  = f?.leadTimeDias || '';
  document.getElementById('forn-skus').value  = f?.skus?.join(', ') || '';
  document.getElementById('modal-fornecedor').style.display = 'flex';
  setTimeout(() => document.getElementById('forn-nome').focus(), 50);
}

function fecharModalFornecedor() {
  document.getElementById('modal-fornecedor').style.display = 'none';
  editandoFornId = null;
}

async function salvarFornecedor() {
  const nome         = document.getElementById('forn-nome').value.trim();
  const leadTimeDias = parseInt(document.getElementById('forn-lead').value, 10);
  const skus         = document.getElementById('forn-skus').value;
  if (!nome)                         { alert('Informe o nome do fornecedor.'); return; }
  if (!leadTimeDias || leadTimeDias < 1) { alert('Informe o lead time em dias.'); return; }

  const url    = editandoFornId ? `/api/fornecedores/${editandoFornId}` : '/api/fornecedores';
  const method = editandoFornId ? 'PUT' : 'POST';
  const r = await apiFetch(url, { method, body: JSON.stringify({ nome, leadTimeDias, skus }) });
  if (r.error) { alert(r.error); return; }
  fecharModalFornecedor();
  await carregarFornecedores();
}

async function excluirFornecedor(id) {
  if (!confirm('Excluir este fornecedor?')) return;
  await apiFetch(`/api/fornecedores/${id}`, { method: 'DELETE' });
  await carregarFornecedores();
}

// ── Previsão ──────────────────────────────────────────────────

async function carregarPrevisao() {
  const loadEl = document.getElementById('previsao-loading');
  const erroEl = document.getElementById('previsao-erro');
  const tabela = document.getElementById('tabela-previsao');
  loadEl.style.display = '';
  erroEl.style.display = 'none';
  tabela.style.display = 'none';
  document.getElementById('previsao-total').textContent = '';

  try {
    const [estoqueData, vendas30d, fornData] = await Promise.all([
      apiFetch('/api/ml/estoque'),
      apiFetch('/api/ml/vendas30dias'),
      apiFetch('/api/fornecedores'),
    ]);
    fornecedores = fornData.fornecedores || [];

    // Agrupa por SKU; produtos sem SKU real ficam como linha individual (chave = MLB)
    const porSku = {};
    for (const item of (estoqueData.items || [])) {
      const temSku = item.sku && item.sku !== '—';
      const chave  = temSku ? item.sku : `_mlb_${item.mlb}`;
      if (!porSku[chave]) porSku[chave] = { sku: temSku ? item.sku : '', titulo: item.titulo, full: 0, proprio: 0, vendas30d: 0 };
      if (item.deposito === 'fulfillment') {
        porSku[chave].full += item.estoque || 0;
      } else {
        porSku[chave].proprio += item.estoque || 0;
      }
      porSku[chave].vendas30d += vendas30d[item.mlb] || 0;
    }

    const hoje = new Date();
    previsaoLinhas = Object.values(porSku).map(s => {
      const total      = s.full + s.proprio;
      const vendasDia  = s.vendas30d / 30;
      const diasRestantes = vendasDia > 0 ? Math.round(total / vendasDia) : null;

      const forn     = fornecedores.find(f => f.skus.includes(s.sku)) || null;
      const leadTime = forn ? forn.leadTimeDias : null;

      let statusNum = 3; let statusLabel = 'OK'; let statusClass = 'prev-ok';
      let pedirEm = null;

      if (diasRestantes !== null && leadTime !== null) {
        const diasParaPedir = diasRestantes - leadTime;
        if (diasRestantes <= leadTime) {
          statusNum = 1; statusLabel = 'Urgente'; statusClass = 'prev-urgente';
          pedirEm = 'Agora';
        } else if (diasRestantes <= Math.round(leadTime * 1.5)) {
          statusNum = 2; statusLabel = 'Atenção'; statusClass = 'prev-atencao';
          const dt = new Date(hoje); dt.setDate(dt.getDate() + diasParaPedir);
          pedirEm = dt.toLocaleDateString('pt-BR');
        } else {
          const dt = new Date(hoje); dt.setDate(dt.getDate() + diasParaPedir);
          pedirEm = dt.toLocaleDateString('pt-BR');
        }
      }

      return { ...s, total, vendasDia, diasRestantes, forn, leadTime, statusNum, statusLabel, statusClass, pedirEm };
    });

    // Preenche filtro de fornecedores
    const sel = document.getElementById('filtro-fornecedor');
    if (sel) {
      const valorAtual = sel.value;
      sel.innerHTML = '<option value="">Todos os fornecedores</option>'
        + fornecedores.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('');
      sel.value = fornecedores.find(f => f.id === valorAtual) ? valorAtual : '';
    }

    loadEl.style.display = 'none';
    renderizarPrevisao();
    tabela.style.display = 'table';
    document.getElementById('previsao-total').textContent = `${previsaoLinhas.length} SKUs`;
  } catch {
    loadEl.style.display = 'none';
    erroEl.textContent = 'Erro ao carregar previsão.';
    erroEl.style.display = '';
  }
}

function renderizarPrevisao() {
  const { campo, direcao } = prevSortState;
  const mult = direcao === 'asc' ? 1 : -1;

  const filtroForn = document.getElementById('filtro-fornecedor')?.value || '';
  const base = filtroForn
    ? previsaoLinhas.filter(l => l.forn?.id === filtroForn)
    : previsaoLinhas;

  const linhas = [...base].sort((a, b) => {
    if (campo === 'statusNum')     return (a.statusNum - b.statusNum) * mult;
    if (campo === 'diasRestantes') return ((a.diasRestantes ?? 99999) - (b.diasRestantes ?? 99999)) * mult;
    if (campo === 'full')          return ((a.full || 0) - (b.full || 0)) * mult;
    if (campo === 'proprio')       return ((a.proprio || 0) - (b.proprio || 0)) * mult;
    if (campo === 'total')         return ((a.total || 0) - (b.total || 0)) * mult;
    if (campo === 'vendasDia')     return ((a.vendasDia || 0) - (b.vendasDia || 0)) * mult;
    if (campo === 'sku')           return (a.sku || 'zzz').localeCompare(b.sku || 'zzz') * mult;
    if (campo === 'fornecedor')    return (a.forn?.nome || '').localeCompare(b.forn?.nome || '') * mult;
    return 0;
  });

  document.getElementById('tabela-previsao-body').innerHTML = linhas.map(l => {
    const diasHtml = l.diasRestantes === null
      ? '<span style="color:#aaa">—</span>'
      : `<span class="${
          l.leadTime && l.diasRestantes <= l.leadTime ? 'duracao-critico'
          : l.leadTime && l.diasRestantes <= Math.round(l.leadTime * 1.5) ? 'duracao-alerta'
          : 'duracao-ok'
        }">${l.diasRestantes}d</span>`;

    const vendHtml = l.vendasDia > 0
      ? l.vendasDia.toFixed(1)
      : '<span style="color:#aaa">—</span>';

    const fornHtml = l.forn
      ? `${esc(l.forn.nome)} <span style="color:#94a3b8;font-size:11px">(${l.leadTime}d)</span>`
      : '<span style="color:#94a3b8">—</span>';

    const pedirHtml = !l.pedirEm
      ? '<span style="color:#aaa">—</span>'
      : l.pedirEm === 'Agora'
        ? '<strong style="color:#dc2626">Agora!</strong>'
        : l.pedirEm;

    return `<tr>
      <td class="td-sku">${l.sku ? esc(l.sku) : '<span style="color:#94a3b8">sem SKU</span>'}</td>
      <td class="td-titulo" title="${esc(l.titulo)}">${esc(l.titulo)}</td>
      <td class="col-num">${l.full}</td>
      <td class="col-num">${l.proprio}</td>
      <td class="col-num"><strong>${l.total}</strong></td>
      <td class="col-num">${vendHtml}</td>
      <td class="col-num">${diasHtml}</td>
      <td>${fornHtml}</td>
      <td class="col-num">${pedirHtml}</td>
      <td><span class="badge-prev ${l.statusClass}">${l.statusLabel}</span></td>
    </tr>`;
  }).join('');

  // Ícones de sort
  document.querySelectorAll('#tabela-previsao .sort-icon[data-sort]').forEach(ic => {
    ic.textContent = ic.dataset.sort === campo ? (direcao === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

function prevOrdenar(campo) {
  prevSortState.direcao = prevSortState.campo === campo && prevSortState.direcao === 'asc' ? 'desc' : 'asc';
  prevSortState.campo = campo;
  renderizarPrevisao();
}
