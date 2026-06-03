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
    const data = await fetch(`/api/bling/pedidos-pendentes-todas?conta=${window.CONTA_ATIVA}`).then(r => r.json());
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
      const isShopee = /shopee/i.test(p.canal || '');
      if (p.temEtiqueta && !isShopee) tr.style.background = 'rgba(34,197,94,0.07)';
      if (isShopee) tr.style.background = 'rgba(249,115,22,0.06)';
      const valor    = (p.valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const data_str = p.data ? new Date(p.data).toLocaleDateString('pt-BR') : '—';
      const contaCor = p.conta === '1' ? '#2563eb' : '#7c3aed';
      const contaBadge = `<span style="background:${contaCor};color:#fff;padding:1px 7px;border-radius:4px;font-size:11px">C${p.conta}</span>`;
      const etqBadge = isShopee
        ? `<span style="background:#f97316;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;white-space:nowrap">Shopee</span>`
        : p.temEtiqueta
          ? `<span style="background:#16a34a;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;white-space:nowrap" title="Emitir NF libera a etiqueta de envio">Emitir NF → Etiqueta</span>`
          : `<span style="color:#9ca3af;font-size:11px">Aguardando ML</span>`;
      const btnSuper = (!isShopee && p.temEtiqueta)
        ? `<button class="btn-sm btn-super" data-bling-super-id="${p.id}" onclick="blingSuperEnvio('${p.id}', this, '${p.conta}')" style="background:#7c3aed;color:#fff;margin-left:4px" title="Gerar NF e enviar em um clique">⚡ Super</button>`
        : '';
      const blingEditUrl = `https://www.bling.com.br/vendas.php#edit/${p.id}`;
      const pendencias = p.pendencias || [];
      const btnPendencia = pendencias.length > 0
        ? `<a href="${blingEditUrl}" target="_blank" rel="noopener" class="btn-sm" style="background:#f59e0b;color:#fff;margin-left:4px;text-decoration:none;display:inline-block" title="Pendências: ${escapeHtml(pendencias.join(' | '))}">⚠ Pendências</a>`
        : `<a href="${blingEditUrl}" target="_blank" rel="noopener" style="color:#64748b;margin-left:6px;font-size:13px;text-decoration:none" title="Editar pedido no Bling">✎</a>`;
      tr.innerHTML = `
        <td><input type="checkbox" class="bling-check-pedido" data-id="${p.id}" data-conta="${p.conta}" data-tem-etiqueta="${p.temEtiqueta}" onchange="blingAtualizarBotaoLote()"></td>
        <td>${contaBadge}</td>
        <td>${escapeHtml(p.numero || String(p.id))}</td>
        <td>${escapeHtml(p.comprador || '—')}</td>
        <td class="col-num">${valor}</td>
        <td>${data_str}</td>
        <td style="text-align:center">${etqBadge}</td>
        <td style="white-space:nowrap"><button class="btn-sm" data-bling-id="${p.id}" onclick="blingEmitirNF('${p.id}', this, '${p.conta}')">Emitir NF</button>${btnSuper}${btnPendencia}</td>
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
    await new Promise(r => setTimeout(r, 3500));
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
  setTimeout(() => blingCarregarPedidos(), 1500);
  if (erros > 0) alert(`${ok} NF(s) enviada(s) com sucesso. ${erros} com erro — verifique no Bling.`);
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
    await new Promise(r => setTimeout(r, 3500));
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

async function blingShopeeSuper(pedidoId, btn, conta, lojaId) {
  conta = conta || '1';
  btn.disabled    = true;
  btn.textContent = 'Gerando NF...';
  let res;
  try {
    res = await fetch(`/api/bling/shopee-super/${pedidoId}?conta=${conta}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lojaId }),
    }).then(r => r.json());
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = '⚡ Shopee Super';
    alert('Erro de rede: ' + err.message);
    return;
  }
  if (res.ok) {
    btn.textContent      = '✅ NF transmitida';
    btn.style.background = '#16a34a';
    const urlNF = `https://www.bling.com.br/nfe.php#edit/${res.nfId}`;
    const ir = confirm('NF gerada e transmitida para SEFAZ!\n\nFalta só 1 passo manual no Bling:\n"Enviar dados para loja virtual → Shopee"\n\nAbrir a NF no Bling agora?');
    if (ir) window.open(urlNF, '_blank');
    setTimeout(() => blingCarregarPedidos(), 1500);
  } else {
    btn.disabled    = false;
    btn.textContent = '⚡ Shopee Super';
    alert('Erro no Shopee Super\nEtapa: ' + (res.etapa || '?') + '\n\n' + (res.erro || 'Sem detalhe'));
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
    const data = await fetch(`/api/bling/notas-pendentes?conta=${window.CONTA_ATIVA}`).then(r => r.json());
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
    const res = await fetch(`/api/bling/enviar-nf/${id}?conta=${window.CONTA_ATIVA}`, { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false }));
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
    const data = await fetch(`/api/bling/enviar-nf/${notaId}?conta=${window.CONTA_ATIVA}`, { method: 'POST' }).then(r => r.json());
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

// ── Shopee Marketplace: NFs autorizadas pendentes de envio para Shopee ──

async function blingCarregarMarketplace() {
  const loading  = document.getElementById('bling-marketplace-loading');
  const erro     = document.getElementById('bling-marketplace-erro');
  const tabela   = document.getElementById('tabela-bling-marketplace');
  const tbody    = document.getElementById('tabela-bling-marketplace-body');
  const total    = document.getElementById('bling-marketplace-total');
  const resultado = document.getElementById('bling-marketplace-resultado');

  loading.style.display  = '';
  erro.style.display     = 'none';
  tabela.style.display   = 'none';
  resultado.style.display = 'none';
  tbody.innerHTML        = '';
  total.textContent      = '';

  try {
    const data = await fetch(`/api/bling/nfs-shopee-marketplace?conta=${window.CONTA_ATIVA || '1'}`).then(r => r.json());
    loading.style.display = 'none';

    if (data.erro) {
      erro.textContent   = data.erro;
      erro.style.display = '';
      return;
    }

    const nfs = data.nfs || [];
    total.textContent = `${nfs.length} NF${nfs.length !== 1 ? 's' : ''} de marketplace (últimas 50)`;

    if (nfs.length === 0) {
      erro.textContent   = 'Nenhuma NF com pedido de loja encontrada nas últimas 50.';
      erro.style.display = '';
      return;
    }

    for (const n of nfs) {
      const tr = document.createElement('tr');
      const valor    = (n.valor_total || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      const data_str = n.data ? new Date(n.data).toLocaleDateString('pt-BR') : '—';
      const sitCor   = n.situacao === '5' || n.situacao === 5 ? '#16a34a' : '#f59e0b';
      const sitLabel = n.situacao === '5' || n.situacao === 5 ? 'Autorizada' : `sit.${n.situacao}`;
      tr.innerHTML = `
        <td>${escapeHtml(n.numero)}</td>
        <td>${escapeHtml(n.destinatario)}</td>
        <td class="col-num">${valor}</td>
        <td><span style="color:${sitCor};font-weight:600">${sitLabel}</span></td>
        <td>${data_str}</td>
        <td style="font-size:11px;color:#f97316;font-weight:600">${escapeHtml(n.numeroPedidoLoja)}</td>
        <td style="font-size:11px">${n.lojaId ? `id=${n.lojaId}` : '—'}</td>
        <td><button class="btn-sm" style="background:#f97316;color:#fff" onclick="blingEnviarParaShopee('${n.id}','${n.lojaId||''}','${n.numeroPedidoLoja}','${n.chaveAcesso}',this)">Enviar</button></td>
      `;
      tbody.appendChild(tr);
    }
    tabela.style.display = '';
  } catch (err) {
    loading.style.display = 'none';
    erro.textContent      = 'Erro: ' + err.message;
    erro.style.display    = '';
  }
}

async function blingEnviarParaShopee(nfId, lojaId, orderSn, chaveAcesso, btn) {
  btn.disabled    = true;
  btn.textContent = 'Enviando...';
  const resultado = document.getElementById('bling-marketplace-resultado');
  resultado.style.display  = '';
  resultado.style.color    = '#e0e0e0';
  resultado.textContent    = `⏳ Enviando NF para Shopee\nPedido: ${orderSn}\nChave: ${chaveAcesso ? chaveAcesso.slice(0,20)+'...' : '(sem chave)'}`;
  resultado.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    // Tenta primeiro via API Shopee direta; se não conectada, tenta via Bling
    let res = await fetch('/api/shopee/enviar-nf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderSn, chaveAcesso }),
    }).then(r => r.json());
    if (res.erro && res.erro.includes('não conectada')) {
      // Fallback: tenta via Bling REST API (situação 6 / enviar-dados-lojas-virtuais)
      res = await fetch(`/api/bling/enviar-marketplace/${nfId}?conta=${window.CONTA_ATIVA}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lojaId: Number(lojaId) || null, numeroPedidoLoja: orderSn, chaveAcesso }),
      }).then(r => r.json());
    }

    resultado.textContent = JSON.stringify(res, null, 2);
    if (res.ok) {
      btn.textContent      = '✅ Enviado';
      btn.style.background = '#16a34a';
      resultado.style.color = '#4ade80';
    } else {
      btn.disabled    = false;
      btn.textContent = 'Tentar novamente';
      resultado.style.color = '#f87171';
    }
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Tentar novamente';
    resultado.textContent = 'Erro de rede: ' + err.message;
    resultado.style.color = '#f87171';
  }
}
