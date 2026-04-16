// ── Contas a Pagar ────────────────────────────────────────────
'use strict';

let contasPagarLista   = [];   // lista completa carregada do servidor
let contasPagarFiltro  = 'aberto'; // aberto | vencido | pago | todos
let contasPagarCarregado = false;

// ── Inicialização (chamada ao abrir a aba) ─────────────────────
function contasPagarInit() {
  if (!contasPagarCarregado) contasPagarCarregar();
}

// ── Carrega lista do servidor ──────────────────────────────────
async function contasPagarCarregar() {
  const loading = document.getElementById('contas-loading');
  if (loading) loading.style.display = 'block';
  try {
    const d = await fetch('/api/contas-pagar').then(r => r.json());
    contasPagarLista    = d.contas || [];
    contasPagarCarregado = true;
  } catch {
    contasPagarLista = [];
  }
  if (loading) loading.style.display = 'none';
  contasPagarRenderizar();
}

// ── Filtro ─────────────────────────────────────────────────────
function contasFiltrar(tipo, btn) {
  contasPagarFiltro = tipo;
  document.querySelectorAll('[data-cf]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  contasPagarRenderizar();
}

// ── Renderiza tabela ───────────────────────────────────────────
function contasPagarRenderizar() {
  const tbody    = document.getElementById('tabela-contas-body');
  const tabela   = document.getElementById('tabela-contas');
  const vazio    = document.getElementById('contas-vazio');
  const totalEl  = document.getElementById('contas-total-label');
  if (!tbody) return;

  const hoje = new Date().toISOString().split('T')[0];

  const filtradas = contasPagarLista.filter(c => {
    if (contasPagarFiltro === 'pago')    return c.pago;
    if (contasPagarFiltro === 'aberto')  return !c.pago;
    if (contasPagarFiltro === 'vencido') return !c.pago && c.dVenc < hoje;
    return true; // todos
  });

  // Ordena por data de vencimento
  filtradas.sort((a, b) => a.dVenc.localeCompare(b.dVenc));

  tbody.innerHTML = '';

  if (!filtradas.length) {
    if (tabela) tabela.style.display = 'none';
    if (vazio)  vazio.style.display  = 'block';
    if (totalEl) totalEl.textContent = '';
    contasPagarAtualizarCards();
    return;
  }

  if (vazio)  vazio.style.display  = 'none';
  if (tabela) tabela.style.display = 'table';
  if (totalEl) totalEl.textContent = `${filtradas.length} registro${filtradas.length !== 1 ? 's' : ''}`;

  filtradas.forEach(c => {
    const vencido  = !c.pago && c.dVenc < hoje;
    const statusBadge = c.pago
      ? '<span class="badge-deposito badge-encerrado">Pago</span>'
      : vencido
        ? '<span class="badge-deposito" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5">Vencido</span>'
        : '<span class="badge-deposito badge-ativo">A pagar</span>';

    const dataFmt = c.dVenc
      ? c.dVenc.split('-').reverse().join('/')
      : '—';

    const pagoInfo = c.pago && c.pagoEm
      ? `<br><span style="font-size:11px;color:#94a3b8">Pago em ${c.pagoEm.split('T')[0].split('-').reverse().join('/')}</span>`
      : '';

    const tr = document.createElement('tr');
    if (vencido) tr.style.background = '#fff8f8';
    tr.innerHTML = `
      <td style="${vencido ? 'color:#dc2626;font-weight:600' : ''}">${dataFmt}</td>
      <td title="${escHtml(c.fornecedor)}">${escHtml(c.fornecedor)}</td>
      <td style="font-size:12px;color:#64748b">NF ${escHtml(c.nNF)}${c.serie ? '/' + escHtml(c.serie) : ''}</td>
      <td style="font-size:12px">${escHtml(c.nDup)}</td>
      <td class="col-num" style="font-weight:600">${fmtBRL(c.vDup)}</td>
      <td>${statusBadge}${pagoInfo}</td>
      <td style="text-align:center;white-space:nowrap">
        <button class="btn-secondary" style="font-size:11px;padding:3px 8px;margin-right:4px"
          onclick="contasPagarTogglePago('${c.id}')">${c.pago ? '↩ Reabrir' : '✔ Pago'}</button>
        <button class="lucro-btn-remover" onclick="contasPagarRemover('${c.id}')">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  contasPagarAtualizarCards();
}

// ── Cards de resumo ────────────────────────────────────────────
function contasPagarAtualizarCards() {
  const hoje    = new Date().toISOString().split('T')[0];
  const abertos = contasPagarLista.filter(c => !c.pago);
  const vencidos = abertos.filter(c => c.dVenc < hoje);
  const aVencer  = abertos.filter(c => c.dVenc >= hoje);

  const totalVencido = vencidos.reduce((s, c) => s + c.vDup, 0);
  const totalAVencer = aVencer.reduce((s, c) => s + c.vDup, 0);
  const totalAberto  = abertos.reduce((s, c) => s + c.vDup, 0);

  const el = id => document.getElementById(id);
  if (el('contas-card-vencido')) el('contas-card-vencido').textContent = fmtBRL(totalVencido);
  if (el('contas-card-avencer')) el('contas-card-avencer').textContent = fmtBRL(totalAVencer);
  if (el('contas-card-total'))   el('contas-card-total').textContent   = fmtBRL(totalAberto);

  if (el('contas-card-proximo')) {
    const proximo = aVencer.sort((a, b) => a.dVenc.localeCompare(b.dVenc))[0];
    el('contas-card-proximo').textContent = proximo
      ? `${proximo.dVenc.split('-').reverse().join('/')} — ${fmtBRL(proximo.vDup)}`
      : '—';
  }
}

// ── Importar XML ───────────────────────────────────────────────
async function contasPagarImportarXML() {
  const input  = document.getElementById('contas-xml-input');
  const status = document.getElementById('contas-import-status');
  const btn    = document.getElementById('btn-importar-xml');
  const files  = input?.files;
  if (!files?.length) { if (status) { status.style.color = '#dc2626'; status.textContent = 'Selecione ao menos um arquivo XML.'; } return; }

  if (btn) btn.disabled = true;
  if (status) { status.style.color = '#64748b'; status.textContent = `Processando ${files.length} arquivo${files.length > 1 ? 's' : ''}…`; }

  let importados = 0;
  let duplicados = 0;
  let erros      = 0;

  for (const file of files) {
    try {
      const xmlText = await file.text();
      const form    = new FormData();
      form.append('xml', new Blob([xmlText], { type: 'application/xml' }), file.name);
      const r = await fetch('/api/contas-pagar/xml', { method: 'POST', body: form });
      const d = await r.json();
      if (d.error)      { erros++; }
      else if (d.dup)   { duplicados += d.dup; importados += d.importados || 0; }
      else              { importados += d.importados || 0; }
    } catch { erros++; }
  }

  if (status) {
    const partes = [];
    if (importados) partes.push(`${importados} parcela${importados > 1 ? 's' : ''} importada${importados > 1 ? 's' : ''}`);
    if (duplicados) partes.push(`${duplicados} já existia${duplicados > 1 ? 'm' : ''}`);
    if (erros)      partes.push(`${erros} erro${erros > 1 ? 's' : ''}`);
    status.style.color   = erros && !importados ? '#dc2626' : '#16a34a';
    status.textContent   = partes.length ? partes.join(' · ') : 'Nenhuma parcela encontrada nos XMLs.';
  }

  input.value = '';
  if (btn) btn.disabled = false;
  await contasPagarCarregar(); // recarrega lista
}

// ── Marcar como pago / reabrir ─────────────────────────────────
async function contasPagarTogglePago(id) {
  try {
    await fetch(`/api/contas-pagar/${id}/pago`, { method: 'POST' });
    const item = contasPagarLista.find(c => c.id === id);
    if (item) {
      item.pago   = !item.pago;
      item.pagoEm = item.pago ? new Date().toISOString() : null;
    }
    contasPagarRenderizar();
  } catch { alert('Erro ao salvar. Tente novamente.'); }
}

// ── Remover entrada ────────────────────────────────────────────
async function contasPagarRemover(id) {
  if (!confirm('Remover esta conta a pagar?')) return;
  try {
    await fetch(`/api/contas-pagar/${id}`, { method: 'DELETE' });
    contasPagarLista = contasPagarLista.filter(c => c.id !== id);
    contasPagarRenderizar();
  } catch { alert('Erro ao remover. Tente novamente.'); }
}

// ── Helpers ────────────────────────────────────────────────────
function fmtBRL(v) {
  return 'R$ ' + (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
