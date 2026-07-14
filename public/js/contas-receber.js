// ── Contas a Receber — reconciliação de liberação de saldo no MP ──────────
'use strict';

let crLista       = [];
let crFiltro      = 'todos'; // todos | pendente | liberado | divergente
let crCarregado   = false;

function contasReceberInit() {
  if (!crCarregado) contasReceberAtualizar();
  contasReceberCarregarExtrato();
  contasReceberCarregarSaldoBase();
}

// Dispara sync (busca pedidos novos) + verificação (reconsulta pendentes) e recarrega a lista
async function contasReceberAtualizar() {
  const loading = document.getElementById('cr-loading');
  const erro    = document.getElementById('cr-erro');
  const btn     = document.getElementById('btn-atualizar-cr');
  if (loading) loading.style.display = 'block';
  if (erro)    erro.style.display    = 'none';
  if (btn)     btn.disabled          = true;

  try {
    const sync = await fetch(`/api/contas-receber/sync?conta=${window.CONTA_ATIVA}`, { method: 'POST' }).then(r => r.json());
    if (sync.error) throw new Error(typeof sync.error === 'string' ? sync.error : JSON.stringify(sync.error));

    const verif = await fetch(`/api/contas-receber/verificar?conta=${window.CONTA_ATIVA}`, { method: 'POST' }).then(r => r.json());
    if (verif.error) throw new Error(typeof verif.error === 'string' ? verif.error : JSON.stringify(verif.error));

    await contasReceberCarregar();
  } catch (err) {
    if (erro) {
      erro.textContent   = 'Erro ao atualizar contas a receber: ' + err.message;
      erro.style.display = 'block';
    }
  }

  if (loading) loading.style.display = 'none';
  if (btn)     btn.disabled          = false;
}

async function contasReceberCarregar() {
  try {
    const d = await fetch(`/api/contas-receber?conta=${window.CONTA_ATIVA}`).then(r => r.json());
    crLista     = d.contas || [];
    crCarregado = true;
  } catch {
    crLista = [];
  }
  contasReceberRenderizar();
}

function crFiltrar(tipo, btn) {
  crFiltro = tipo;
  document.querySelectorAll('[data-crf]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  contasReceberRenderizar();
}

function contasReceberRenderizar() {
  const tbody   = document.getElementById('tabela-cr-body');
  const tabela  = document.getElementById('tabela-cr');
  const vazio   = document.getElementById('cr-vazio');
  const totalEl = document.getElementById('cr-total-label');
  if (!tbody) return;

  const filtradas = crFiltro === 'todos' ? crLista : crLista.filter(c => c.situacao === crFiltro);
  filtradas.sort((a, b) => (b.dataPedido || '').localeCompare(a.dataPedido || ''));

  tbody.innerHTML = '';

  if (!filtradas.length) {
    if (tabela) tabela.style.display = 'none';
    if (vazio)  vazio.style.display  = 'block';
    if (totalEl) totalEl.textContent = '';
  } else {
    if (vazio)  vazio.style.display  = 'none';
    if (tabela) tabela.style.display = 'table';
    if (totalEl) totalEl.textContent = `${filtradas.length} registro${filtradas.length !== 1 ? 's' : ''}`;

    filtradas.forEach(c => {
      const situacaoBadge = c.situacao === 'liberado'
        ? '<span class="badge-deposito badge-ativo">Liberado</span>'
        : c.situacao === 'divergente'
          ? '<span class="badge-deposito" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5">⚠️ Divergente</span>'
          : '<span class="badge-deposito badge-pausado">Pendente</span>';

      const fmtData = (iso) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';

      const tr = document.createElement('tr');
      if (c.situacao === 'divergente') tr.style.background = '#fff8f8';
      tr.innerHTML = `
        <td><a href="https://www.mercadolivre.com.br/vendas/${escHtml(c.orderId)}/detalhe" target="_blank" rel="noopener">#${escHtml(c.orderId)}</a></td>
        <td>${fmtData(c.dataPedido)}</td>
        <td class="col-num">${c.valorEsperado != null ? fmtBRL(c.valorEsperado) : '—'}</td>
        <td>${fmtData(c.dataLiberacaoEsperada)}</td>
        <td>${situacaoBadge}</td>
        <td class="col-num">${c.valorReal != null ? fmtBRL(c.valorReal) : '—'}</td>
        <td style="font-size:12px;color:#64748b">${c.divergencia ? escHtml(c.divergencia.detalhe) : ''}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  const pendentes   = crLista.filter(c => c.situacao === 'pendente').length;
  const liberados    = crLista.filter(c => c.situacao === 'liberado').length;
  const divergentes = crLista.filter(c => c.situacao === 'divergente').length;

  const elP = document.getElementById('cr-card-pendentes');
  const elL = document.getElementById('cr-card-liberados');
  const elD = document.getElementById('cr-card-divergentes');
  if (elP) elP.textContent = pendentes;
  if (elL) elL.textContent = liberados;
  if (elD) elD.textContent = divergentes;
}

// ── Extrato agregado (settlement_report do Mercado Pago) ────────────────────

// Carrega a última verificação já salva, sem disparar uma nova (rápido, ao abrir a aba)
async function contasReceberCarregarExtrato() {
  try {
    const d = await fetch(`/api/contas-receber/extrato?conta=${window.CONTA_ATIVA}`).then(r => r.json());
    contasReceberRenderizarExtrato(d.extrato);
  } catch {
    contasReceberRenderizarExtrato(null);
  }
}

// Dispara a geração + download do extrato completo no Mercado Pago (pode levar até ~1min)
async function contasReceberVerificarExtrato() {
  const loading = document.getElementById('cr-extrato-loading');
  const erro    = document.getElementById('cr-extrato-erro');
  const btn     = document.getElementById('btn-verificar-extrato');
  if (loading) loading.style.display = 'block';
  if (erro)    erro.style.display    = 'none';
  if (btn)     btn.disabled          = true;

  try {
    const r = await fetch(`/api/contas-receber/sync-extrato?conta=${window.CONTA_ATIVA}`, { method: 'POST' }).then(r => r.json());
    if (r.error) throw new Error(typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
    await contasReceberCarregar();          // pedidos podem ter mudado de situação
    await contasReceberCarregarExtrato();   // recarrega o resumo salvo
  } catch (err) {
    if (erro) {
      erro.textContent   = 'Erro ao verificar extrato: ' + err.message;
      erro.style.display = 'block';
    }
  }

  if (loading) loading.style.display = 'none';
  if (btn)     btn.disabled          = false;
}

function contasReceberRenderizarExtrato(snap) {
  const statusEl = document.getElementById('cr-extrato-status');
  const tabela   = document.getElementById('tabela-cr-extrato');
  const tbody    = document.getElementById('tabela-cr-extrato-body');
  if (!statusEl || !tbody) return;

  if (!snap) {
    statusEl.textContent = 'Ainda não verificado.';
    tabela.style.display = 'none';
    return;
  }

  const dataHora = new Date(snap.ts).toLocaleString('pt-BR');
  const qtd = (snap.naoIdentificados || []).length;
  statusEl.innerHTML = qtd > 0
    ? `<span style="color:#dc2626;font-weight:600">⚠️ ${qtd} movimento${qtd !== 1 ? 's' : ''} não identificado${qtd !== 1 ? 's' : ''}</span> de ${snap.totalMovimentos} no extrato — última verificação em ${dataHora} (últimos ${snap.diasVerificados} dias)`
    : `✅ Nenhum movimento não identificado — última verificação em ${dataHora} (últimos ${snap.diasVerificados} dias, ${snap.totalMovimentos} movimentos no total)`;

  tbody.innerHTML = '';
  if (!qtd) {
    tabela.style.display = 'none';
    return;
  }
  tabela.style.display = 'table';
  snap.naoIdentificados.forEach(m => {
    const fmtData = (iso) => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-size:12px">${escHtml(m.sourceId)}</td>
      <td>${m.orderId ? '#' + escHtml(m.orderId) : '—'}</td>
      <td style="font-size:12px">${escHtml(m.tipo)}</td>
      <td class="col-num">${fmtBRL(m.valor)}</td>
      <td>${fmtData(m.data)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Saldo informado — sem gerar relatório, só com o que já rastreamos por pedido ─────

async function contasReceberCarregarSaldoBase() {
  try {
    const d = await fetch(`/api/contas-receber/saldo-base?conta=${window.CONTA_ATIVA}`).then(r => r.json());
    contasReceberRenderizarSaldoBase(d);
  } catch {
    contasReceberRenderizarSaldoBase(null);
  }
}

async function contasReceberSalvarSaldoBase() {
  const input = document.getElementById('cr-saldo-input');
  const erro  = document.getElementById('cr-saldo-base-erro');
  const valor = parseFloat(input?.value);
  if (isNaN(valor)) {
    if (erro) { erro.textContent = 'Digite um valor válido.'; erro.style.display = 'block'; }
    return;
  }
  if (erro) erro.style.display = 'none';
  try {
    const d = await fetch(`/api/contas-receber/saldo-base?conta=${window.CONTA_ATIVA}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valor }),
    }).then(r => r.json());
    if (d.error) throw new Error(d.error);
    if (input) input.value = '';
    await contasReceberCarregarSaldoBase();
  } catch (err) {
    if (erro) { erro.textContent = 'Erro ao salvar saldo: ' + err.message; erro.style.display = 'block'; }
  }
}

function contasReceberRenderizarSaldoBase(d) {
  const statusEl = document.getElementById('cr-saldo-base-status');
  if (!statusEl) return;

  if (!d || !d.saldoBase) {
    statusEl.textContent = 'Nenhum saldo informado ainda.';
    return;
  }

  const dataBase = new Date(d.saldoBase.ts).toLocaleString('pt-BR');
  statusEl.innerHTML = `Saldo informado: <strong>${fmtBRL(d.saldoBase.valor)}</strong> em ${dataBase}.<br>`
    + `Saldo esperado agora: <strong style="color:#16a34a">${fmtBRL(d.saldoEsperado)}</strong> `
    + `(${d.qtdLiberacoes} liberaç${d.qtdLiberacoes !== 1 ? 'ões' : 'ão'} desde então) — confira com o app do Mercado Pago.`;
}
