// ============================================================
// bling.js — Aba Bling ERP
// Pedidos pendentes de NF + Notas pendentes de envio
// ============================================================

let blingSubAtual = 'pedidos';

function blingInit() {
  blingAbrirSub(blingSubAtual);
}

function blingAbrirSub(sub) {
  blingSubAtual = sub;
  document.getElementById('bling-sub-pedidos').classList.toggle('active', sub === 'pedidos');
  document.getElementById('bling-sub-notas').classList.toggle('active', sub === 'notas');
  document.getElementById('bling-painel-pedidos').style.display = sub === 'pedidos' ? '' : 'none';
  document.getElementById('bling-painel-notas').style.display   = sub === 'notas'   ? '' : 'none';

  if (sub === 'pedidos') blingCarregarPedidos();
  if (sub === 'notas')   blingCarregarNotas();
}

// ── Pedidos pendentes de NF ───────────────────────────────────

async function blingCarregarPedidos() {
  const loading = document.getElementById('bling-pedidos-loading');
  const erro    = document.getElementById('bling-pedidos-erro');
  const tabela  = document.getElementById('tabela-bling-pedidos');
  const tbody   = document.getElementById('tabela-bling-pedidos-body');
  const total   = document.getElementById('bling-pedidos-total');

  loading.style.display = '';
  erro.style.display    = 'none';
  tabela.style.display  = 'none';
  tbody.innerHTML       = '';
  total.textContent     = '';

  try {
    const data = await fetch('/api/bling/pedidos-pendentes').then(r => r.json());
    loading.style.display = 'none';

    if (data.erro) {
      erro.textContent    = data.erro;
      erro.style.display  = '';
      return;
    }

    const pedidos = data.pedidos || [];
    total.textContent = `${pedidos.length} pedido${pedidos.length !== 1 ? 's' : ''} sem nota fiscal`;

    if (pedidos.length === 0) {
      erro.textContent   = 'Nenhum pedido pendente de nota fiscal.';
      erro.style.display = '';
      return;
    }

    for (const p of pedidos) {
      const tr = document.createElement('tr');
      if (p.temEtiqueta) tr.style.background = 'rgba(34,197,94,0.07)';
      const valor    = (p.valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const data_str = p.data ? new Date(p.data).toLocaleDateString('pt-BR') : '—';
      const etqBadge = p.temEtiqueta
        ? `<span style="background:#16a34a;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;white-space:nowrap" title="Emitir NF libera a etiqueta de envio">Emitir NF → Etiqueta</span>`
        : `<span style="color:#9ca3af;font-size:11px">Aguardando ML</span>`;
      tr.innerHTML = `
        <td>${escapeHtml(p.numero || String(p.id))}</td>
        <td>${escapeHtml(p.comprador || '—')}</td>
        <td class="col-num">${valor}</td>
        <td>${data_str}</td>
        <td style="text-align:center">${etqBadge}</td>
        <td><button class="btn-sm" onclick="blingEmitirNF('${p.id}', this)">Emitir NF</button></td>
      `;
      tbody.appendChild(tr);
    }
    tabela.style.display = '';
  } catch (err) {
    loading.style.display = 'none';
    erro.textContent      = 'Erro ao carregar pedidos: ' + err.message;
    erro.style.display    = '';
  }
}

async function blingEmitirNF(pedidoId, btn) {
  btn.disabled    = true;
  btn.textContent = 'Emitindo...';
  try {
    const data = await fetch(`/api/bling/emitir-nf/${pedidoId}`, { method: 'POST' }).then(r => r.json());
    if (data.ok) {
      btn.textContent = '✅ Emitida';
      btn.style.color = 'green';
      setTimeout(() => blingCarregarPedidos(), 1500);
    } else {
      btn.disabled    = false;
      btn.textContent = 'Emitir NF';
      alert('Erro ao emitir NF: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Emitir NF';
    alert('Erro: ' + err.message);
  }
}

// ── Notas pendentes de envio ──────────────────────────────────

async function blingCarregarNotas() {
  const loading = document.getElementById('bling-notas-loading');
  const erro    = document.getElementById('bling-notas-erro');
  const tabela  = document.getElementById('tabela-bling-notas');
  const tbody   = document.getElementById('tabela-bling-notas-body');
  const total   = document.getElementById('bling-notas-total');

  loading.style.display = '';
  erro.style.display    = 'none';
  tabela.style.display  = 'none';
  tbody.innerHTML       = '';
  total.textContent     = '';

  try {
    const data = await fetch('/api/bling/notas-pendentes').then(r => r.json());
    loading.style.display = 'none';

    if (data.erro) {
      erro.textContent   = data.erro;
      erro.style.display = '';
      return;
    }

    const notas = data.notas || [];
    total.textContent = `${notas.length} nota${notas.length !== 1 ? 's' : ''} pendente${notas.length !== 1 ? 's' : ''} de envio`;

    if (notas.length === 0) {
      erro.textContent   = 'Nenhuma nota pendente de envio.';
      erro.style.display = '';
      return;
    }

    for (const n of notas) {
      const tr = document.createElement('tr');
      const valor = (n.valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const data_str = n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—';
      tr.innerHTML = `
        <td>${escapeHtml(n.numero || '—')}</td>
        <td>${escapeHtml(n.destinatario || '—')}</td>
        <td class="col-num">${valor}</td>
        <td><span class="badge">${escapeHtml(n.situacao || '—')}</span></td>
        <td>${data_str}</td>
        <td><button class="btn-sm" onclick="blingEnviarNF('${n.id}', this)">Enviar</button></td>
      `;
      tbody.appendChild(tr);
    }
    tabela.style.display = '';
  } catch (err) {
    loading.style.display = 'none';
    erro.textContent      = 'Erro ao carregar notas: ' + err.message;
    erro.style.display    = '';
  }
}

async function blingEnviarNF(notaId, btn) {
  btn.disabled    = true;
  btn.textContent = 'Enviando...';
  try {
    const data = await fetch(`/api/bling/enviar-nf/${notaId}`, { method: 'POST' }).then(r => r.json());
    if (data.ok) {
      btn.textContent = '✅ Enviada';
      btn.style.color = 'green';
      setTimeout(() => blingCarregarNotas(), 1500);
    } else {
      btn.disabled    = false;
      btn.textContent = 'Enviar';
      alert('Erro ao enviar NF: ' + (data.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Enviar';
    alert('Erro: ' + err.message);
  }
}

// ── Helper ────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
