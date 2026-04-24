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
    const data = await fetch('/api/bling/pedidos-pendentes-todas').then(r => r.json());
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
      const contaCor = p.conta === '1' ? '#2563eb' : '#7c3aed';
      const contaBadge = `<span style="background:${contaCor};color:#fff;padding:1px 7px;border-radius:4px;font-size:11px">C${p.conta}</span>`;
      const etqBadge = p.temEtiqueta
        ? `<span style="background:#16a34a;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;white-space:nowrap" title="Emitir NF libera a etiqueta de envio">Emitir NF → Etiqueta</span>`
        : `<span style="color:#9ca3af;font-size:11px">Aguardando ML</span>`;
      const btnSuper = p.temEtiqueta
        ? `<button class="btn-sm btn-super" data-bling-super-id="${p.id}" onclick="blingSuperEnvio('${p.id}', this, '${p.conta}')" style="background:#7c3aed;color:#fff;margin-left:4px" title="Gerar NF e enviar em um clique">⚡ Super</button>`
        : '';
      tr.innerHTML = `
        <td><input type="checkbox" class="bling-check-pedido" data-id="${p.id}" data-conta="${p.conta}" data-tem-etiqueta="${p.temEtiqueta}" onchange="blingAtualizarBotaoLote()"></td>
        <td>${contaBadge}</td>
        <td>${escapeHtml(p.numero || String(p.id))}</td>
        <td>${escapeHtml(p.comprador || '—')}</td>
        <td class="col-num">${valor}</td>
        <td>${data_str}</td>
        <td style="text-align:center">${etqBadge}</td>
        <td style="white-space:nowrap"><button class="btn-sm" data-bling-id="${p.id}" onclick="blingEmitirNF('${p.id}', this, '${p.conta}')">Emitir NF</button>${btnSuper}</td>
      `;
      tbody.appendChild(tr);
    }
    tabela.style.display = '';
    blingAtualizarBotaoLote();
  } catch (err) {
    loading.style.display = 'none';
    erro.textContent      = 'Erro ao carregar pedidos: ' + err.message;
    erro.style.display    = '';
  }
}

function blingToggleAll(chk) {
  document.querySelectorAll('.bling-check-pedido').forEach(c => c.checked = chk.checked);
  blingAtualizarBotaoLote();
}

function blingAtualizarBotaoLote() {
  const todos        = [...document.querySelectorAll('.bling-check-pedido:checked')];
  const comEtiqueta  = todos.filter(c => c.dataset.temEtiqueta === 'true');

  const btnEmitir = document.getElementById('btn-emitir-selecionadas');
  if (btnEmitir) {
    btnEmitir.style.display = todos.length > 0 ? '' : 'none';
    btnEmitir.textContent   = `Emitir NF selecionadas (${todos.length})`;
  }

  const btnSuper = document.getElementById('btn-super-selecionadas');
  if (btnSuper) {
    btnSuper.style.display = comEtiqueta.length > 0 ? '' : 'none';
    btnSuper.textContent   = `⚡ Super selecionadas (${comEtiqueta.length})`;
  }
}

async function blingEmitirSelecionadas() {
  const checks = [...document.querySelectorAll('.bling-check-pedido:checked')];
  if (checks.length === 0) return;
  const btn = document.getElementById('btn-emitir-selecionadas');
  btn.disabled    = true;
  btn.textContent = `Emitindo 0/${checks.length}...`;
  let ok = 0, erros = 0;
  for (const chk of checks) {
    const id    = chk.dataset.id;
    const conta = chk.dataset.conta || '1';
    const btnLinha = document.querySelector(`button[data-bling-id="${id}"]`);
    if (btnLinha) { btnLinha.disabled = true; btnLinha.textContent = 'Emitindo...'; }
    const res = await fetch(`/api/bling/emitir-nf/${id}?conta=${conta}`, { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false }));
    if (res.ok) {
      ok++;
      if (btnLinha) { btnLinha.textContent = '✅ Emitida'; btnLinha.style.color = 'green'; }
      chk.checked = false;
    } else {
      erros++;
      if (btnLinha) { btnLinha.disabled = false; btnLinha.textContent = 'Emitir NF'; }
    }
    btn.textContent = `Emitindo ${ok + erros}/${checks.length}...`;
  }
  btn.disabled = false;
  blingAtualizarBotaoLote();
  const checkAll = document.getElementById('bling-check-all');
  if (checkAll) checkAll.checked = false;
  if (erros === 0) setTimeout(() => blingCarregarPedidos(), 1500);
  else alert(`${ok} NF(s) emitida(s) com sucesso. ${erros} erro(s).`);
}

async function blingSuperSelecionadas() {
  const checks = [...document.querySelectorAll('.bling-check-pedido:checked')].filter(c => c.dataset.temEtiqueta === 'true');
  if (checks.length === 0) return;
  const btn = document.getElementById('btn-super-selecionadas');
  btn.disabled = true;
  let ok = 0, erros = 0;
  for (const chk of checks) {
    const id    = chk.dataset.id;
    const conta = chk.dataset.conta || '1';
    const btnSuper = document.querySelector(`button[data-bling-super-id="${id}"]`);
    btn.textContent = `⚡ Super ${ok + erros + 1}/${checks.length}...`;

    if (btnSuper) { btnSuper.disabled = true; btnSuper.textContent = '⚡ Gerando...'; }
    const emissao = await fetch(`/api/bling/emitir-nf/${id}?conta=${conta}`, { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false }));
    if (!emissao.ok) {
      erros++;
      if (btnSuper) { btnSuper.disabled = false; btnSuper.textContent = '⚡ Super'; }
      continue;
    }

    if (btnSuper) btnSuper.textContent = '⚡ Enviando...';
    await new Promise(r => setTimeout(r, 2000));
    const envio = await fetch(`/api/bling/enviar-nf/${emissao.nfId}?conta=${conta}`, { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false }));
    if (envio.ok) {
      ok++;
      chk.checked = false;
      if (btnSuper) { btnSuper.textContent = '✅ Enviada'; btnSuper.style.background = '#16a34a'; }
    } else {
      erros++;
      if (btnSuper) { btnSuper.disabled = false; btnSuper.textContent = '⚡ Super'; }
    }
  }
  btn.disabled = false;
  blingAtualizarBotaoLote();
  const checkAll = document.getElementById('bling-check-all');
  if (checkAll) checkAll.checked = false;
  if (erros === 0) setTimeout(() => blingCarregarPedidos(), 1500);
  else alert(`${ok} NF(s) enviada(s) com sucesso. ${erros} erro(s).`);
}

async function blingSuperEnvio(pedidoId, btn, conta) {
  conta = conta || '1';
  btn.disabled    = true;
  btn.textContent = '⚡ Gerando NF...';
  try {
    const emissao = await fetch(`/api/bling/emitir-nf/${pedidoId}?conta=${conta}`, { method: 'POST' }).then(r => r.json());
    if (!emissao.ok) {
      btn.disabled    = false;
      btn.textContent = '⚡ Super';
      alert('Erro ao gerar NF: ' + (emissao.erro || 'Erro desconhecido'));
      return;
    }
    btn.textContent = '⚡ Enviando NF...';
    await new Promise(r => setTimeout(r, 2000));
    const envio = await fetch(`/api/bling/enviar-nf/${emissao.nfId}?conta=${conta}`, { method: 'POST' }).then(r => r.json());
    if (envio.ok) {
      btn.textContent = '✅ Enviada';
      btn.style.background = '#16a34a';
      setTimeout(() => blingCarregarPedidos(), 1500);
    } else {
      btn.disabled    = false;
      btn.textContent = '⚡ Super';
      alert('NF gerada mas erro ao enviar: ' + (envio.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = '⚡ Super';
    alert('Erro: ' + err.message);
  }
}

async function blingEmitirNF(pedidoId, btn, conta) {
  conta = conta || '1';
  btn.disabled    = true;
  btn.textContent = 'Emitindo...';
  try {
    const data = await fetch(`/api/bling/emitir-nf/${pedidoId}?conta=${conta}`, { method: 'POST' }).then(r => r.json());
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
        <td><input type="checkbox" class="bling-check-nota" data-id="${n.id}" onchange="blingAtualizarBotaoLoteNotas()"></td>
        <td>${escapeHtml(n.numero || '—')}</td>
        <td>${escapeHtml(n.destinatario || '—')}</td>
        <td class="col-num">${valor}</td>
        <td><span class="badge">${escapeHtml(n.situacao || '—')}</span></td>
        <td>${data_str}</td>
        <td><button class="btn-sm" data-bling-nota-id="${n.id}" onclick="blingEnviarNF('${n.id}', this)">Enviar</button></td>
      `;
      tbody.appendChild(tr);
    }
    tabela.style.display = '';
    blingAtualizarBotaoLoteNotas();
  } catch (err) {
    loading.style.display = 'none';
    erro.textContent      = 'Erro ao carregar notas: ' + err.message;
    erro.style.display    = '';
  }
}

function blingToggleAllNotas(chk) {
  document.querySelectorAll('.bling-check-nota').forEach(c => c.checked = chk.checked);
  blingAtualizarBotaoLoteNotas();
}

function blingAtualizarBotaoLoteNotas() {
  const selecionados = document.querySelectorAll('.bling-check-nota:checked').length;
  const btn = document.getElementById('btn-enviar-selecionadas');
  if (!btn) return;
  btn.style.display = selecionados > 0 ? '' : 'none';
  btn.textContent   = `Enviar selecionadas (${selecionados})`;
}

async function blingEnviarSelecionadas() {
  const checks = [...document.querySelectorAll('.bling-check-nota:checked')];
  if (checks.length === 0) return;
  const btn = document.getElementById('btn-enviar-selecionadas');
  btn.disabled    = true;
  btn.textContent = `Enviando 0/${checks.length}...`;
  let ok = 0, erros = 0;
  for (const chk of checks) {
    const id      = chk.dataset.id;
    const btnLinha = document.querySelector(`button[data-bling-nota-id="${id}"]`);
    if (btnLinha) { btnLinha.disabled = true; btnLinha.textContent = 'Enviando...'; }
    const res = await fetch(`/api/bling/enviar-nf/${id}`, { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false }));
    if (res.ok) {
      ok++;
      if (btnLinha) { btnLinha.textContent = '✅ Enviada'; btnLinha.style.color = 'green'; }
      chk.checked = false;
    } else {
      erros++;
      if (btnLinha) { btnLinha.disabled = false; btnLinha.textContent = 'Enviar'; }
    }
    btn.textContent = `Enviando ${ok + erros}/${checks.length}...`;
  }
  btn.disabled = false;
  blingAtualizarBotaoLoteNotas();
  const checkAll = document.getElementById('bling-check-all-notas');
  if (checkAll) checkAll.checked = false;
  if (erros === 0) setTimeout(() => blingCarregarNotas(), 1500);
  else alert(`${ok} nota(s) enviada(s) com sucesso. ${erros} erro(s).`);
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
