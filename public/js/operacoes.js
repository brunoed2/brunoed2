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
let vendasReqId  = 0; // invalida chamadas antigas de carregarVendas() se uma nova começar antes dela terminar

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
  const btnBaixarMl     = document.getElementById('btn-baixar-ml');
  const btnBaixarShopee = document.getElementById('btn-baixar-shopee');
  const btnCompartilharMl     = document.getElementById('btn-compartilhar-ml');
  const btnCompartilharShopee = document.getElementById('btn-compartilhar-shopee');
  const btnAtendido  = document.getElementById('btn-marcar-atendido');

  // ML e Shopee baixam etiqueta por endpoints diferentes — separa os botões pra não
  // misturar as duas no mesmo PDF (limitação física de impressão/separação do usuário).
  if (btnBaixarMl || btnBaixarShopee) {
    const qtdMl     = checks.filter(cb => cb.dataset.canal !== 'shopee').length;
    const qtdShopee = checks.filter(cb => cb.dataset.canal === 'shopee').length;
    if (btnBaixarMl) {
      btnBaixarMl.style.display = qtdMl > 0 ? '' : 'none';
      btnBaixarMl.textContent   = `⬇ Baixar ${qtdMl} ML`;
    }
    if (btnBaixarShopee) {
      btnBaixarShopee.style.display = qtdShopee > 0 ? '' : 'none';
      btnBaixarShopee.textContent   = `⬇ Baixar ${qtdShopee} Shopee`;
    }
    if (btnCompartilharMl) {
      btnCompartilharMl.style.display = qtdMl > 0 ? '' : 'none';
      btnCompartilharMl.textContent   = `🔗 Compartilhar ${qtdMl} ML`;
    }
    if (btnCompartilharShopee) {
      btnCompartilharShopee.style.display = qtdShopee > 0 ? '' : 'none';
      btnCompartilharShopee.textContent   = `🔗 Compartilhar ${qtdShopee} Shopee`;
    }
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

  // Agrupa por conta+canal — os pedidos selecionados podem ser de conta 1 e conta 2,
  // ML e Shopee, tudo ao mesmo tempo (lista de vendas junta tudo), e cada combinação
  // guarda sua própria lista de atendidos (ML em data.contas, Shopee em data.shopee_contas
  // — misturar os dois fazia o flag "atendida" nunca colar nos pedidos Shopee).
  const porContaCanal = {};
  checks.forEach(cb => {
    const conta = cb.dataset.conta || window.CONTA_ATIVA;
    const canal = cb.dataset.canal || 'ml';
    const chave = `${conta}::${canal}`;
    if (!porContaCanal[chave]) porContaCanal[chave] = { conta, canal, shipmentIds: [] };
    porContaCanal[chave].shipmentIds.push(cb.dataset.shipmentId);
  });

  try {
    const resultados = await Promise.all(Object.values(porContaCanal).map(({ conta, canal, shipmentIds }) => {
      const vendasDados = {};
      if (!remover) shipmentIds.forEach(sid => { if (vendaCache[sid]) vendasDados[sid] = vendaCache[sid]; });
      return apiFetch('/api/vendas/atendidas-batch', {
        method: remover ? 'DELETE' : 'POST',
        body: JSON.stringify({ shipmentIds, vendasDados, conta, canal }),
      });
    }));
    const r = { ok: resultados.every(res => res.ok) };
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
      atualizarResumoSeparar();
    } else {
      alert('Erro ao salvar. Tente novamente.');
    }
  } catch {
    alert('Erro ao salvar. Tente novamente.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function baixarSelecionadas(canal) {
  const checks = [...document.querySelectorAll('.check-venda:checked')].filter(cb =>
    canal === 'shopee' ? cb.dataset.canal === 'shopee' : cb.dataset.canal !== 'shopee'
  );
  if (!checks.length) return;
  const porConta = {};
  checks.forEach(cb => {
    const conta = cb.dataset.conta;
    if (!porConta[conta]) porConta[conta] = [];
    porConta[conta].push(cb.dataset.shipmentId);
  });
  const base = canal === 'shopee' ? '/api/shopee/etiquetas' : '/api/ml/etiquetas';
  for (const [conta, ids] of Object.entries(porConta)) {
    window.open(`${base}?ids=${ids.join(',')}&conta=${conta}`, '_blank');
  }
}

function compartilharSelecionadas(canal) {
  const checks = [...document.querySelectorAll('.check-venda:checked')].filter(cb =>
    canal === 'shopee' ? cb.dataset.canal === 'shopee' : cb.dataset.canal !== 'shopee'
  );
  if (!checks.length) return;
  const porConta = {};
  checks.forEach(cb => {
    const conta = cb.dataset.conta;
    if (!porConta[conta]) porConta[conta] = [];
    porConta[conta].push(cb.dataset.shipmentId);
  });
  const base = canal === 'shopee' ? '/api/shopee/etiquetas' : '/api/ml/etiquetas';
  for (const [conta, ids] of Object.entries(porConta)) {
    compartilharPdf(`${base}?ids=${ids.join(',')}&conta=${conta}`, 'etiquetas.pdf');
  }
}

let filtroStatusAtendido = 'todos'; // 'todos' | 'pendentes' | 'atendidos'
let skuFiltroVendas  = null;
let skuFiltroFuturos = null;
let filtroCanalVendas = 'todos';

function filtrarStatusAtendido(btn) {
  filtroStatusAtendido = btn.dataset.valor;
  document.querySelectorAll('[data-filtro-atendidos]').forEach(b => b.classList.toggle('active', b === btn));
  aplicarFiltroAtendidos();
}

function filtrarCanalVendas(btn) {
  filtroCanalVendas = btn.dataset.valor;
  document.querySelectorAll('[data-filtro-canal-vendas]').forEach(b => b.classList.toggle('active', b === btn));
  aplicarFiltroAtendidos();
}

function aplicarFiltroAtendidos() {
  const tbody = document.getElementById('tabela-vendas-body');
  let visiveis = 0;
  for (const tr of tbody.querySelectorAll('tr')) {
    if (tr.classList.contains('venda-sub-item')) continue;
    const atendida = tr.classList.contains('venda-atendida');
    const skuMatch = !skuFiltroVendas || (tr.dataset.skus || '').split(' ').includes(skuFiltroVendas);
    const canalMatch = filtroCanalVendas === 'todos' || tr.dataset.canal === filtroCanalVendas;
    const statusMatch = filtroStatusAtendido === 'todos'
      || (filtroStatusAtendido === 'atendidos' && atendida)
      || (filtroStatusAtendido === 'pendentes' && !atendida);
    const visivel  = statusMatch && skuMatch && canalMatch;
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
  if (filtroStatusAtendido === 'atendidos') {
    totalEl.textContent = `${visiveis} pedido${visiveis !== 1 ? 's' : ''} flagado${visiveis !== 1 ? 's' : ''}`;
  } else if (filtroStatusAtendido === 'pendentes') {
    totalEl.textContent = `${visiveis} pedido${visiveis !== 1 ? 's' : ''} pendente${visiveis !== 1 ? 's' : ''}`;
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

function chaveResumoItem(item) {
  // '—' é o placeholder do backend pra "sem SKU cadastrado" — não pode ser
  // usado como chave de agrupamento, senão produtos diferentes sem SKU
  // se misturam num único grupo. Nesse caso agrupa por título+variação.
  return (item.sku && item.sku !== '—')
    ? `sku:${item.sku}`
    : `titulo:${item.titulo || ''}|${item.variacao || ''}`;
}

function atualizarResumoSeparar() {
  const card      = document.getElementById('vendas-resumo-card');
  const container = document.getElementById('vendas-resumo-lista');
  if (!card || !container) return;

  const skuMap = new Map();
  document.querySelectorAll('#tabela-vendas-body > tr:not(.venda-sub-item)').forEach(tr => {
    const cb    = tr.querySelector('.check-venda');
    const venda = cb && vendaCache[cb.dataset.shipmentId];
    if (!venda) return;
    for (const item of (venda.itensLista || [])) {
      if (!item.titulo && !item.sku) continue;
      const chave = chaveResumoItem(item);
      const atual = skuMap.get(chave);
      if (atual) {
        atual.quantidade += (item.quantidade || 0);
      } else {
        skuMap.set(chave, {
          titulo:     item.titulo || item.sku,
          variacao:   item.variacao || '',
          thumbnail:  item.thumbnail || '',
          quantidade: item.quantidade || 0,
        });
      }
    }
  });

  const lista = [...skuMap.values()].sort((a, b) => b.quantidade - a.quantidade || a.titulo.localeCompare(b.titulo));

  if (!lista.length) {
    card.style.display  = 'none';
    container.innerHTML = '';
    return;
  }

  card.style.display  = '';
  container.innerHTML = lista.map(it => `
    <div class="resumo-item">
      ${it.thumbnail
        ? `<img src="${it.thumbnail}" class="resumo-item-thumb" loading="lazy">`
        : `<div class="resumo-item-thumb-vazio"></div>`}
      <span class="resumo-item-qtd">${it.quantidade}×</span>
      <span class="resumo-item-titulo" title="${it.titulo}${it.variacao ? ` (${it.variacao})` : ''}">${it.titulo}</span>
    </div>
  `).join('');
}

function renderizarResumoFuturosPorDia(resumoPorDia) {
  const card = document.getElementById('futuros-resumo-card');
  if (!card) return;

  if (!resumoPorDia.size) { card.style.display = 'none'; card.innerHTML = ''; return; }

  card.style.display = '';
  card.innerHTML = [...resumoPorDia.values()].map(dia => {
    const lista = [...dia.skuMap.values()].sort((a, b) => b.quantidade - a.quantidade || a.titulo.localeCompare(b.titulo));
    const itensHtml = lista.map(it => `
      <div class="resumo-item">
        ${it.thumbnail
          ? `<img src="${it.thumbnail}" class="resumo-item-thumb" loading="lazy">`
          : `<div class="resumo-item-thumb-vazio"></div>`}
        <span class="resumo-item-qtd">${it.quantidade}×</span>
        <span class="resumo-item-titulo" title="${it.titulo}${it.variacao ? ` (${it.variacao})` : ''}">${it.titulo}</span>
      </div>
    `).join('');
    return `
      <div class="resumo-dia-bloco">
        <div class="resumo-dia-titulo">📅 ${dia.label}</div>
        <div class="resumo-separar">${itensHtml}</div>
      </div>
    `;
  }).join('');
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

// Busca as vendas com etiqueta das duas contas (ML + Shopee) já mescladas —
// cada resposta vem com o campo "conta" em cada venda, então dá pra misturar
// sem perder de onde veio.
async function buscarTodasVendasEtiqueta() {
  const resultados = await Promise.all(['1', '2'].flatMap(num => [
    apiFetch(`/api/ml/vendas-etiquetas?conta=${num}`).catch(() => ({ vendas: [] })),
    apiFetch(`/api/shopee/vendas-etiquetas?conta=${num}`).catch(() => ({ vendas: [] })),
  ]));
  const vendas = [];
  resultados.forEach(r => { if (Array.isArray(r.vendas)) vendas.push(...r.vendas); });
  const erroReal = resultados.find(r => r.error && r.error !== 'Não conectado');
  return { vendas, erro: erroReal ? erroReal.error : null };
}

// Tag no topo da aba Vendas com a contagem por canal — total de pedidos com
// etiqueta disponível pra despachar, separado ML x Shopee. Não desconta quem já
// foi marcado como atendido: "atendida" é só um checklist pessoal do operador,
// não significa que o pedido já saiu da fila de despacho.
function atualizarResumoCanal(vendas) {
  const tag = document.getElementById('vendas-resumo-canal');
  if (!tag) return;
  if (!vendas.length) { tag.style.display = 'none'; return; }
  const ml     = vendas.filter(v => v.canal !== 'shopee').length;
  const shopee = vendas.filter(v => v.canal === 'shopee').length;
  document.getElementById('resumo-canal-ml').textContent     = ml;
  document.getElementById('resumo-canal-shopee').textContent = shopee;
  tag.style.display = 'flex';
}

// ── Instruções de despacho (aba Vendas) ─────────────────────────
// Mesma instrução mostrada no scanner ao escanear a etiqueta — aqui o admin
// cadastra, lá qualquer operador só visualiza. Chave (anúncio+SKU+variação)
// já vem calculada do backend em item.chaveInstrucao.

function instrucaoEscapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function btnInstrucaoHtml(item, shipmentId, idx, isAdmin) {
  if (!item || !item.chaveInstrucao) return '';
  const tem = !!item.instrucaoDespacho;
  if (!isAdmin && !tem) return '';
  const classe    = 'btn-instrucao' + (tem ? ' tem-instrucao' : '');
  const titleAttr = tem ? ` title="${instrucaoEscapeHtml(item.instrucaoDespacho)}"` : ' title="Adicionar instrução de despacho"';
  return isAdmin
    ? `<button type="button" class="${classe}"${titleAttr} onclick="abrirEditorInstrucao('${shipmentId}', ${idx})">📌 Instruções</button>`
    : `<span class="${classe}"${titleAttr}>📌 Instruções</span>`;
}

let instrucaoModalItem = null;

function instrucaoModalOverlay() {
  let overlay = document.getElementById('instrucao-modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'instrucao-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    overlay.addEventListener('click', e => { if (e.target === overlay) fecharEditorInstrucao(); });
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-titulo">Instruções de despacho</div>
        <div class="modal-campo">
          <label id="instrucao-modal-item"></label>
          <textarea id="instrucao-modal-txt" class="input-padrao" style="min-height:90px;resize:vertical" placeholder="O que precisa ser feito ao separar esse item..."></textarea>
        </div>
        <div class="modal-acoes">
          <button class="btn-secondary" onclick="fecharEditorInstrucao()">Cancelar</button>
          <button class="btn-primary" onclick="salvarEditorInstrucao()">Salvar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  return overlay;
}

function abrirEditorInstrucao(shipmentId, idx) {
  const venda = vendaCache[String(shipmentId)];
  const item  = venda?.itensLista?.[idx];
  if (!item) return;
  instrucaoModalItem = item;
  const overlay = instrucaoModalOverlay();
  overlay.querySelector('#instrucao-modal-item').textContent = `${item.titulo || ''}${item.variacao ? ' — ' + item.variacao : ''}`;
  overlay.querySelector('#instrucao-modal-txt').value = item.instrucaoDespacho || '';
  overlay.style.display = 'flex';
  overlay.querySelector('#instrucao-modal-txt').focus();
}

function fecharEditorInstrucao() {
  const overlay = document.getElementById('instrucao-modal-overlay');
  if (overlay) overlay.style.display = 'none';
  instrucaoModalItem = null;
}

async function salvarEditorInstrucao() {
  if (!instrucaoModalItem) return;
  const texto = document.getElementById('instrucao-modal-txt').value.trim();
  try {
    const resp = await fetch('/api/instrucoes-despacho', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chave:    instrucaoModalItem.chaveInstrucao,
        texto,
        titulo:   instrucaoModalItem.titulo,
        sku:      instrucaoModalItem.sku,
        variacao: instrucaoModalItem.variacao,
        senha:    localStorage.getItem('usuarioSenha') || '',
      }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao salvar');
    fecharEditorInstrucao();
    carregarVendas();
    if (pedidosFuturosCarregado) carregarFuturos();
  } catch (err) {
    alert('Erro ao salvar instrução: ' + err.message);
  }
}

// ── Foto ampliada + instrução (aba Vendas) ──────────────────────
// Mesmo overlay do scanner (foto grande + instrução de despacho por cima),
// clicando na miniatura em vez de abrir o link do anúncio. O item vem do
// vendaCache (vendas ativas / pedidos futuros) ou do histFiltradoAtual
// (histórico), conforme quem chamou.

let vendasFotoItem     = null;
let vendasFotoEditando = false;

function vendasThumbHtml(item, onclickExpr) {
  if (!item || !item.thumbnail) return `<div class="venda-thumb-vazio"></div>`;
  const temInstrucao = !!item.instrucaoDespacho;
  const titleAttr   = temInstrucao ? 'Tem instrução de despacho — toque pra ver' : 'Toque pra ampliar';
  const borderStyle = temInstrucao ? ' style="border:2px solid #f59e0b"' : '';
  const badge = temInstrucao
    ? `<span style="position:absolute;top:-8px;right:-8px;width:22px;height:22px;border-radius:50%;background:#f59e0b;color:#fff;font-size:14px;font-weight:900;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #fff;line-height:1">!</span>`
    : '';
  return `<span class="venda-thumb-link" style="cursor:zoom-in;position:relative;display:inline-block" title="${titleAttr}" onclick="${onclickExpr}"><img src="${item.thumbnail}" class="venda-thumb" loading="lazy"${borderStyle}>${badge}</span>`;
}

function vendasFotoOverlay() {
  let overlay = document.getElementById('vendas-foto-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'vendas-foto-overlay';
    overlay.className = 'foto-ampliada-overlay';
    overlay.innerHTML = '<div class="foto-ampliada-conteudo"><img><div class="foto-ampliada-instrucao"></div></div>';
    overlay.addEventListener('click', e => { if (e.target === overlay) vendasFecharFoto(); });
    document.body.appendChild(overlay);
  }
  return overlay;
}

function vendasFecharFoto() {
  const overlay = document.getElementById('vendas-foto-overlay');
  if (overlay) overlay.classList.remove('aberto');
  vendasFotoItem     = null;
  vendasFotoEditando = false;
}

function vendasAmpliarFotoItem(item) {
  if (!item || !item.thumbnail) return;
  vendasFotoItem     = item;
  vendasFotoEditando = false;
  const overlay = vendasFotoOverlay();
  overlay.querySelector('img').src = item.thumbnail;
  vendasRenderInstrucaoFoto();
  overlay.classList.add('aberto');
}

function vendasAmpliarFoto(shipmentId, idx) {
  vendasAmpliarFotoItem(vendaCache[String(shipmentId)]?.itensLista?.[idx]);
}

function vendasAmpliarFotoHistorico(hIdx, idx) {
  vendasAmpliarFotoItem(histFiltradoAtual[hIdx]?.itensLista?.[idx]);
}

function vendasRenderInstrucaoFoto() {
  const item = vendasFotoItem;
  const area = document.querySelector('#vendas-foto-overlay .foto-ampliada-instrucao');
  if (!item || !area) return;
  if (!item.chaveInstrucao) { area.innerHTML = ''; return; }
  const isAdmin = localStorage.getItem('usuarioSenha') === '199412';

  if (vendasFotoEditando) {
    area.innerHTML = `
      <textarea id="vendas-foto-instrucao-txt" placeholder="O que precisa ser feito ao separar esse item...">${instrucaoEscapeHtml(item.instrucaoDespacho || '')}</textarea>
      <div class="foto-ampliada-instrucao-botoes">
        <button class="btn-primary" onclick="vendasSalvarInstrucaoFoto()">Salvar</button>
        <button class="btn-secondary" onclick="vendasFotoEditando = false; vendasRenderInstrucaoFoto()">Cancelar</button>
      </div>
    `;
    document.getElementById('vendas-foto-instrucao-txt')?.focus();
    return;
  }

  if (item.instrucaoDespacho) {
    area.innerHTML = `
      <div class="foto-ampliada-instrucao-texto"><span>📌</span><span class="pin-texto">${instrucaoEscapeHtml(item.instrucaoDespacho)}</span></div>
      ${isAdmin ? `<button class="foto-ampliada-instrucao-editar" onclick="vendasFotoEditando = true; vendasRenderInstrucaoFoto()">✏️ editar instrução</button>` : ''}
    `;
  } else if (isAdmin) {
    area.innerHTML = `<button class="foto-ampliada-instrucao-editar" onclick="vendasFotoEditando = true; vendasRenderInstrucaoFoto()">+ adicionar instrução de despacho</button>`;
  } else {
    area.innerHTML = '';
  }
}

async function vendasSalvarInstrucaoFoto() {
  const item     = vendasFotoItem;
  const textarea = document.getElementById('vendas-foto-instrucao-txt');
  if (!item || !item.chaveInstrucao || !textarea) return;
  const texto = textarea.value.trim();

  try {
    const resp = await fetch('/api/instrucoes-despacho', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chave:    item.chaveInstrucao,
        texto,
        titulo:   item.titulo,
        sku:      item.sku,
        variacao: item.variacao,
        senha:    localStorage.getItem('usuarioSenha') || '',
      }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao salvar');

    item.instrucaoDespacho = texto || null;
    vendasFotoEditando     = false;
    vendasRenderInstrucaoFoto();
    carregarVendas();
    if (pedidosFuturosCarregado) carregarFuturos();
  } catch (err) {
    alert('Erro ao salvar instrução: ' + err.message);
  }
}

async function carregarVendas() {
  const reqId   = ++vendasReqId;
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
    const { vendas: todasVendas, erro } = await buscarTodasVendasEtiqueta();
    // Se outra chamada a carregarVendas() começou depois desta (ex: duplo clique
    // na aba, ou o toque no menu ainda em processo do carregamento inicial da
    // página), essa aqui é obsoleta — não pode mais escrever na tabela, senão as
    // linhas de uma chamada se somam às da outra (pedidos aparecendo duplicados).
    if (reqId !== vendasReqId) return;
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (!todasVendas.length) {
      if (erro) {
        erroEl.textContent   = erro;
        erroEl.style.display = 'block';
        return;
      }
      atualizarResumoCanal(todasVendas);
      atualizarBotaoSelecionadas(); atualizarResumoSeparar(); return;
    }

    atualizarResumoCanal(todasVendas);

    const isAdminInstrucao = localStorage.getItem('usuarioSenha') === '199412';

    todasVendas.forEach(v => {
      vendaCache[String(v.shipmentId)] = v;
      const bStatus = BADGE_VENDA_STATUS[v.status] || 'badge-outro';
      const itens   = v.itensLista || [];
      const item0   = itens[0] || {};
      const multi   = itens.length > 1;

      const tr = document.createElement('tr');
      tr.dataset.skus  = [...new Set(itens.map(i => i.sku).filter(Boolean))].join(' ');
      tr.dataset.canal = v.canal === 'shopee' ? 'shopee' : 'ml';
      if (multi)      tr.classList.add('venda-multi-header');
      if (v.atendida) tr.classList.add('venda-atendida');

      const imgHtml0 = vendasThumbHtml(item0, `vendasAmpliarFoto('${v.shipmentId}', 0)`);

      const flagClass = v.atendida ? 'btn-flag btn-flag-ativo' : 'btn-flag';
      const flagTitle = v.atendida ? 'Remover flag' : 'Marcar como atendido';
      const hrefEtiqueta = v.canal === 'shopee'
        ? `/api/shopee/etiqueta/${v.shipmentId}?conta=${v.conta}`
        : `/api/ml/etiqueta/${v.shipmentId}?conta=${v.conta}`;
      const badgeShopee = v.canal === 'shopee'
        ? `<span style="background:#f97316;color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;margin-left:5px;white-space:nowrap;vertical-align:middle">Shopee</span>`
        : '';
      const contaCor  = v.conta === '1' ? '#2563eb' : '#7c3aed';
      const badgeConta = `<span style="background:${contaCor};color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;margin-left:5px;white-space:nowrap;vertical-align:middle">C${v.conta}</span>`;
      const btnEtiquetaHtml = `<a class="btn-etiqueta" href="${hrefEtiqueta}" target="_blank">${v.acaoLabel}</a>` +
        `<a class="btn-etiqueta" href="#" onclick="compartilharPdf('${hrefEtiqueta}', 'etiqueta-${v.shipmentId}.pdf', this); return false;" title="Compartilhar" style="margin-left:4px;white-space:nowrap">🔗</a>`;
      const instrucaoHtml0 = btnInstrucaoHtml(item0, v.shipmentId, 0, isAdminInstrucao);

      tr.innerHTML = `
        <td><input type="checkbox" class="check-venda" data-shipment-id="${v.shipmentId}" data-conta="${v.conta}" data-canal="${v.canal || 'ml'}" onchange="atualizarBotaoSelecionadas()"></td>
        <td class="td-thumb">${imgHtml0}</td>
        <td class="td-order-id">#${v.orderId}${badgeConta}${badgeShopee}</td>
        <td>${v.comprador}</td>
        <td class="col-num venda-qtd">${item0.quantidade ?? ''}</td>
        <td class="td-sku">${item0.sku || '—'}</td>
        <td class="td-titulo" title="${item0.titulo || ''}${item0.variacao ? ` (${item0.variacao})` : ''}">${item0.titulo || '—'}${item0.variacao ? `<br><span class="venda-variacao">${item0.variacao}</span>` : ''}${instrucaoHtml0 ? `<br>${instrucaoHtml0}` : ''}</td>
        <td><span class="badge-deposito ${bStatus}">${v.statusLabel}</span></td>
        <td>${btnEtiquetaHtml}</td>
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
        const imgHtml = vendasThumbHtml(item, `vendasAmpliarFoto('${v.shipmentId}', ${i})`);
        const instrucaoHtmlSub = btnInstrucaoHtml(item, v.shipmentId, i, isAdminInstrucao);
        trSub.innerHTML = `
          <td class="venda-sub-indent"></td>
          <td class="td-thumb">${imgHtml}</td>
          <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
          <td class="col-num venda-qtd">${item.quantidade ?? ''}</td>
          <td class="td-sku">${item.sku || '—'}</td>
          <td class="td-titulo" title="${item.titulo || ''}${item.variacao ? ` (${item.variacao})` : ''}">${item.titulo || '—'}${item.variacao ? `<span class="venda-variacao"> — ${item.variacao}</span>` : ''}${instrucaoHtmlSub ? `<br>${instrucaoHtmlSub}` : ''}</td>
          <td colspan="3"></td>
        `;
        tbody.appendChild(trSub);
      }
    });

    atualizarBotaoSelecionadas();
    tabela.style.display = 'table';
    renderizarChipsSKU('vendas', todasVendas);
    aplicarFiltroAtendidos();
    atualizarResumoSeparar();
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
    // Junta as duas contas — senão os pedidos futuros da conta que não está
    // ativa no momento somem da lista (mesmo problema que carregarVendas já resolve).
    const [d1, d2] = await Promise.all(['1', '2'].map(num =>
      apiFetch(`/api/ml/pedidos-futuros?conta=${num}`).catch(err => ({ error: String(err) }))
    ));
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (d1.error && d2.error) {
      erroEl.textContent   = d1.error;
      erroEl.style.display = 'block';
      return;
    }

    const pedidos = [...(d1.pedidos || []), ...(d2.pedidos || [])];
    pedidosFuturosCarregado = true;
    totalEl.textContent = `${pedidos.length} pedido${pedidos.length !== 1 ? 's' : ''}`;

    if (!pedidos.length) {
      const resumoCard = document.getElementById('futuros-resumo-card');
      if (resumoCard) { resumoCard.style.display = 'none'; resumoCard.innerHTML = ''; }
      return;
    }

    pedidos.sort((a, b) => {
      if (!a.dataLiberacao && !b.dataLiberacao) return 0;
      if (!a.dataLiberacao) return 1;
      if (!b.dataLiberacao) return -1;
      const dataCmp = a.dataLiberacao.localeCompare(b.dataLiberacao);
      if (dataCmp !== 0) return dataCmp;
      const skuA = String(a.itensLista?.[0]?.sku || '');
      const skuB = String(b.itensLista?.[0]?.sku || '');
      return skuA.localeCompare(skuB, undefined, { numeric: true });
    });

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    let dataGrupoAtual = null;
    const resumoPorDia = new Map();
    const isAdminInstrucao = localStorage.getItem('usuarioSenha') === '199412';

    pedidos.forEach(p => {
      vendaCache[String(p.shipmentId)] = p;
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

      if (!resumoPorDia.has(dataGrupo)) {
        resumoPorDia.set(dataGrupo, { label: liberaHoje ? `${dataStr} — hoje` : dataStr, skuMap: new Map() });
      }
      const skuMap = resumoPorDia.get(dataGrupo).skuMap;
      for (const item of itens) {
        if (!item.titulo && !item.sku) continue;
        const chave = chaveResumoItem(item);
        const atual = skuMap.get(chave);
        if (atual) {
          atual.quantidade += (item.quantidade || 0);
        } else {
          skuMap.set(chave, {
            titulo:     item.titulo || item.sku,
            variacao:   item.variacao || '',
            thumbnail:  item.thumbnail || '',
            quantidade: item.quantidade || 0,
          });
        }
      }

      const tr = document.createElement('tr');
      tr.dataset.skus = [...new Set(itens.map(i => i.sku).filter(Boolean))].join(' ');
      if (multi) tr.classList.add('venda-multi-header');
      if (liberaHoje) tr.style.background = 'rgba(234,179,8,0.08)';

      const imgHtml0 = vendasThumbHtml(item0, `vendasAmpliarFoto('${p.shipmentId}', 0)`);
      const instrucaoHtml0 = btnInstrucaoHtml(item0, p.shipmentId, 0, isAdminInstrucao);

      tr.innerHTML = `
        <td class="td-thumb">${imgHtml0}</td>
        <td class="td-order-id">#${p.orderId}</td>
        <td>${p.comprador}</td>
        <td class="col-num venda-qtd">${item0.quantidade ?? ''}</td>
        <td class="td-sku">${item0.sku || '—'}</td>
        <td class="td-titulo" title="${item0.titulo || ''}${item0.variacao ? ` (${item0.variacao})` : ''}">${item0.titulo || '—'}${item0.variacao ? `<br><span class="venda-variacao">${item0.variacao}</span>` : ''}${instrucaoHtml0 ? `<br>${instrucaoHtml0}` : ''}</td>
        <td></td>
      `;
      tbody.appendChild(tr);

      for (let i = 1; i < itens.length; i++) {
        const item   = itens[i];
        const isLast = i === itens.length - 1;
        const trSub  = document.createElement('tr');
        trSub.classList.add('venda-sub-item');
        if (isLast) trSub.classList.add('venda-sub-last');
        const imgHtml = vendasThumbHtml(item, `vendasAmpliarFoto('${p.shipmentId}', ${i})`);
        const instrucaoHtmlSub = btnInstrucaoHtml(item, p.shipmentId, i, isAdminInstrucao);
        trSub.innerHTML = `
          <td class="td-thumb">${imgHtml}</td>
          <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
          <td class="col-num venda-qtd">${item.quantidade ?? ''}</td>
          <td class="td-sku">${item.sku || '—'}</td>
          <td class="td-titulo" title="${item.titulo || ''}${item.variacao ? ` (${item.variacao})` : ''}">${item.titulo || '—'}${item.variacao ? `<span class="venda-variacao"> — ${item.variacao}</span>` : ''}${instrucaoHtmlSub ? `<br>${instrucaoHtmlSub}` : ''}</td>
          <td></td>
        `;
        tbody.appendChild(trSub);
      }
    });

    tabela.style.display = 'table';
    renderizarChipsSKU('futuros', pedidos);
    renderizarResumoFuturosPorDia(resumoPorDia);
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
  const conta    = vendaCache[sid]?.conta || window.CONTA_ATIVA;
  const canal    = vendaCache[sid]?.canal || 'ml';
  try {
    const vendasDados = {};
    if (!atendida && vendaCache[sid]) vendasDados[sid] = vendaCache[sid];
    await apiFetch('/api/vendas/atendidas-batch', {
      method: atendida ? 'DELETE' : 'POST',
      body: JSON.stringify({ shipmentIds: [sid], vendasDados, conta, canal }),
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
    atualizarResumoSeparar();
  } catch {}
  btn.disabled = false;
}

// ── Histórico de vendas ───────────────────────────────────────

let histDados          = [];
let histFiltradoAtual  = []; // lista filtrada atualmente renderizada — usada por vendasAmpliarFotoHistorico

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
  histFiltradoAtual = filtrado;
  filtrado.forEach((h, hIdx) => {
    const dataFmt = (h.dataDespacho || h.data) ? new Date(h.dataDespacho || h.data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—';
    const qtdTotal = (h.itensLista || []).reduce((s, i) => s + (i.quantidade || 1), 0);
    const skus  = [...new Set((h.itensLista || []).map(i => i.sku).filter(Boolean))].join(', ') || '—';
    const itens = (h.itensLista || []).map(i => `${i.titulo}${i.variacao ? ' — ' + i.variacao : ''}${i.quantidade > 1 ? ' (x' + i.quantidade + ')' : ''}`).join('<br>');
    const atendidoHtml = h.atendida
      ? `<span style="color:#16a34a;font-size:12px">✔ Sim${h.atendidaEm ? '<br><span style="font-size:11px;color:#94a3b8">' + new Date(h.atendidaEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</span>' : ''}</span>`
      : '<span style="color:#94a3b8;font-size:12px">—</span>';
    const item0 = (h.itensLista || [])[0];
    const imgHtml = item0?.thumbnail
      ? vendasThumbHtml(item0, `vendasAmpliarFotoHistorico(${hIdx}, 0)`)
      : '<span style="color:#94a3b8;font-size:11px">—</span>';
    const badgeShopee = h.canal === 'shopee'
      ? '<span style="background:#f97316;color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;margin-left:5px;white-space:nowrap;vertical-align:middle">Shopee</span>'
      : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${dataFmt}</td>
      <td>${imgHtml}</td>
      <td style="white-space:nowrap">#${h.orderId}${badgeShopee}</td>
      <td>${h.comprador || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td style="font-size:12px;color:#64748b">${skus}</td>
      <td style="font-size:12px">${itens}</td>
      <td>${atendidoHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}
