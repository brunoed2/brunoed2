// ── Contas a Receber — reconciliação de liberação de saldo no MP ──────────
'use strict';

let crLista       = [];
let crFiltro      = 'todos'; // todos | pendente | liberado | divergente
let crCarregado   = false;

function contasReceberInit() {
  if (!crCarregado) contasReceberAtualizar();
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
    await contasReceberCarregarSaldoBase(); // pedidos novos/liberados mudam a projeção
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
          : c.situacao === 'cancelado'
            ? '<span class="badge-deposito badge-encerrado">Cancelado</span>'
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

  const pendentes    = crLista.filter(c => c.situacao === 'pendente').length;
  const liberados    = crLista.filter(c => c.situacao === 'liberado').length;
  const divergentes  = crLista.filter(c => c.situacao === 'divergente').length;
  const cancelados   = crLista.filter(c => c.situacao === 'cancelado').length;

  const elP = document.getElementById('cr-card-pendentes');
  const elL = document.getElementById('cr-card-liberados');
  const elD = document.getElementById('cr-card-divergentes');
  const elC = document.getElementById('cr-card-cancelados');
  if (elP) elP.textContent = pendentes;
  if (elL) elL.textContent = liberados;
  if (elD) elD.textContent = divergentes;
  if (elC) elC.textContent = cancelados;
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
  const inputLiberado = document.getElementById('cr-saldo-liberado-input');
  const inputALiberar = document.getElementById('cr-saldo-aliberar-input');
  const erro          = document.getElementById('cr-saldo-base-erro');
  const liberado = parseFloat(inputLiberado?.value);
  const aLiberar = parseFloat(inputALiberar?.value);
  if (isNaN(liberado) || isNaN(aLiberar)) {
    if (erro) { erro.textContent = 'Preencha os dois valores.'; erro.style.display = 'block'; }
    return;
  }
  if (erro) erro.style.display = 'none';
  try {
    const d = await fetch(`/api/contas-receber/saldo-base?conta=${window.CONTA_ATIVA}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liberado, aLiberar }),
    }).then(r => r.json());
    if (d.error) throw new Error(d.error);
    if (inputLiberado) inputLiberado.value = '';
    if (inputALiberar) inputALiberar.value = '';
    await contasReceberCarregarSaldoBase();
  } catch (err) {
    if (erro) { erro.textContent = 'Erro ao salvar saldo: ' + err.message; erro.style.display = 'block'; }
  }
}

function contasReceberRenderizarSaldoBase(d) {
  const statusEl   = document.getElementById('cr-saldo-base-status');
  const elLiberado = document.getElementById('cr-saldo-out-liberado');
  const elALiberar = document.getElementById('cr-saldo-out-aliberar');
  const elTotal    = document.getElementById('cr-saldo-out-total');
  if (!statusEl) return;

  if (!d || !d.saldoBase) {
    statusEl.textContent = 'Nenhum saldo informado ainda.';
    if (elLiberado) elLiberado.textContent = '—';
    if (elALiberar) elALiberar.textContent = '—';
    if (elTotal)    elTotal.textContent    = '—';
    return;
  }

  if (elLiberado) elLiberado.textContent = fmtBRL(d.liberadoEsperado);
  if (elALiberar) elALiberar.textContent = fmtBRL(d.aLiberarEsperado);
  if (elTotal)    elTotal.textContent    = fmtBRL(d.totalEsperado);

  const dataBase = new Date(d.saldoBase.ts).toLocaleString('pt-BR');
  statusEl.innerHTML = `Informado em ${dataBase}: liberado ${fmtBRL(d.saldoBase.liberado)} + a liberar ${fmtBRL(d.saldoBase.aLiberar)}. `
    + `Desde então: ${d.qtdNovos} pedido${d.qtdNovos !== 1 ? 's' : ''} novo${d.qtdNovos !== 1 ? 's' : ''}, ${d.qtdLiberacoes} liberaç${d.qtdLiberacoes !== 1 ? 'ões' : 'ão'}.`;
}
