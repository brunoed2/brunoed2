// ============================================================
// lucro.js — Cálculo de lucro por venda
// ============================================================

let lucroConfig       = { taxa_imposto: 0, taxa_imposto_por_mes: {}, frete_medio: 0, custos: {} };
let lucroVendasRaw    = []; // dados brutos da API (sem custos/imposto aplicados)
let lucroCarregado    = false; // evita recarregar ao trocar de aba sem trocar conta

// Shopee — bloco separado do ML, mesmo período de data e mesma conta ativa (lucroContaAtual())
let lucroShopeeConfig    = { taxa_imposto: 0, taxa_imposto_por_mes: {}, custos: {}, custos_historico: {} };
let lucroShopeeVendasRaw = [];
let lucroShopeeCarregado = false;
let gastosLista       = []; // gastos carregados para o mês atual
let gastosVendasRaw   = []; // vendas do mês completo (exclusivo para aba Gastos)
let gastosAuto        = { ads_cost: null }; // detectados automaticamente
let gastosFixosTravados = new Set(); // nomes dos fixos com cadeado ativo

let lucroSortState  = { campo: null, direcao: 'asc' };
let lucroFiltroSku  = '';
let lucroVendasCalc = []; // último cálculo ML, pra reordenar/filtrar sem recarregar
let lucroShopeeSortState  = { campo: null, direcao: 'asc' };
let lucroShopeeVendasCalc = []; // último cálculo Shopee, pra aplicar o mesmo filtro sem recarregar

let lucroAbcMetrica = 'lucro'; // 'lucro' | 'receita' | 'qtd'
let lucroAbcFiltro  = '';

function lucroHoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Dia local (não toISOString/UTC) de um timestamp/Date — toISOString() mostra o
// dia seguinte a partir das 21h de Brasília e bagunça comparação de custo por data.
function lucroDataLocalStr(dataOuMs) {
  const d = new Date(dataOuMs);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function lucroInitDatas() {
  const hoje = lucroHoje();
  const de  = document.getElementById('lucro-data-de');
  const ate = document.getElementById('lucro-data-ate');
  if (de && !de.value)  de.value  = hoje;
  if (ate && !ate.value) ate.value = hoje;
}

function lucroContaAtual() {
  return window.CONTA_ATIVA || '1';
}

function lucroFmt(v) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function lucroCopiarPedido(el, orderId) {
  navigator.clipboard.writeText(orderId).then(() => {
    const orig = el.style.color;
    el.style.color = '#86efac';
    setTimeout(() => { el.style.color = orig; }, 1000);
  });
}

function lucroBtnPagamento(orderId) {
  if (!orderId) return '';
  return ` <button class="lucro-btn-pagamento" onclick="event.stopPropagation();lucroMostrarPagamento('${orderId}')" title="Ver forma de pagamento" style="border:none;background:none;cursor:pointer;font-size:13px;padding:0 2px">💳</button>`;
}

async function lucroMostrarPagamento(orderId) {
  const modal = document.getElementById('modal-pagamento');
  const corpo = document.getElementById('modal-pagamento-corpo');
  corpo.innerHTML = 'Carregando...';
  modal.style.display = 'flex';
  try {
    const resp = await fetch(`/api/ml/pagamento-pedido/${orderId}?conta=${lucroContaAtual()}`).then(r => r.json());
    if (resp.error) { corpo.innerHTML = `Erro: ${resp.error}`; return; }
    if (!resp.principal) { corpo.innerHTML = 'Nenhum pagamento encontrado para este pedido.'; return; }
    const p = resp.principal;
    const STATUS_LABEL = { approved: 'Aprovado', cancelled: 'Cancelado', rejected: 'Rejeitado', refunded: 'Reembolsado', in_process: 'Em análise' };
    const linhas = [
      ['Pedido',   `#${orderId}`],
      ['Forma',    p.metodo && p.metodo !== p.tipo ? `${p.tipo} (${p.metodo})` : p.tipo],
      ['Parcelas', p.parcelas > 1 ? `${p.parcelas}x${p.valorParcela ? ' de ' + lucroFmt(p.valorParcela) : ''}` : 'À vista'],
      ['Valor',    p.valorTotal != null ? lucroFmt(p.valorTotal) : '—'],
      ['Status',   STATUS_LABEL[p.status] || p.status],
    ];
    corpo.innerHTML = linhas.map(([label, valor]) =>
      `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #1e293b">
        <span style="color:#94a3b8">${label}</span><strong>${valor}</strong>
      </div>`
    ).join('');
    if (resp.todos.length > 1) {
      corpo.innerHTML += `<div style="margin-top:8px;font-size:11px;color:#64748b">Pedido teve ${resp.todos.length} tentativas de pagamento — mostrando a aprovada${resp.principal.status !== 'approved' ? ' (ou a primeira, nenhuma aprovada)' : ''}.</div>`;
    }
  } catch (e) {
    corpo.innerHTML = 'Erro ao conectar com o servidor.';
  }
}

function lucroFmtPct(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

// ── Config ───────────────────────────────────────────────────

async function lucroCarregarConfig() {
  const gen   = contaGen;
  const conta = lucroContaAtual();
  try {
    const cfg = await fetch(`/api/lucro/config?conta=${conta}`).then(r => r.json());
    if (contaGen !== gen) return; // resposta de conta antiga — descarta
    lucroConfig = { taxa_imposto: 0, taxa_imposto_por_mes: {}, frete_medio: 0, custos: {}, ...cfg };
    if (lucroVendasRaw.length || lucroShopeeVendasRaw.length) lucroRecalcularERenderizar();
  } catch {}
}

async function dreSetTaxaMes(input, mes) {
  const conta = lucroContaAtual();
  const taxa  = parseFloat(input.value.replace(',', '.'));
  const val   = isNaN(taxa) ? null : taxa;
  input.style.borderColor = '#cbd5e1';
  try {
    await fetch('/api/lucro/taxa-imposto-mes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, mes, taxa: val ?? 0 }),
    });
    lucroConfig.taxa_imposto_por_mes = lucroConfig.taxa_imposto_por_mes || {};
    if (val !== null) lucroConfig.taxa_imposto_por_mes[mes] = val;
    else delete lucroConfig.taxa_imposto_por_mes[mes];
    if (lucroVendasRaw.length || lucroShopeeVendasRaw.length) lucroRecalcularERenderizar();
    input.style.borderColor = '#86efac';
    setTimeout(() => { input.style.borderColor = ''; }, 1200);
  } catch {
    input.style.borderColor = '#fca5a5';
  }
}

// ── Custo por produto ─────────────────────────────────────────

async function lucroSalvarCusto(input, btn) {
  const conta = lucroContaAtual();
  const sku   = input.dataset.sku;
  const custo = parseFloat(input.value.replace(',', '.')) || 0;
  if (!sku) return;
  const dataInput = input.parentElement?.querySelector(`.lucro-custo-data[data-sku="${sku}"]`);
  const desde = dataInput?.value || input.dataset.vdata || lucroHoje();
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await fetch('/api/lucro/custo', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, sku, custo, desde }),
    }).then(r => r.json());
    lucroConfig.custos_historico = lucroConfig.custos_historico || {};
    if (r.custos_historico) lucroConfig.custos_historico[sku] = r.custos_historico;
    lucroConfig.custos[sku] = r.custo_atual ?? custo;
    lucroCustosRenderHistorico(sku);
    lucroRecalcularERenderizar();
    const custoAtual = r.custo_atual ?? custo;
    document.querySelectorAll(`.lucro-custo-input[data-sku="${sku}"]`).forEach(el => {
      el.value = custoAtual || '';
    });
    // btn pode ter sido destruído pelo rebuild da tabela de vendas; busca os novos botões pelo SKU
    const targets = btn && btn.isConnected
      ? [btn]
      : [...document.querySelectorAll(`.lucro-ok-btn[data-sku="${sku}"]`)];
    targets.forEach(b => {
      b.disabled = false;
      b.textContent = '✓';
      b.classList.add('lucro-ok-btn--ok');
      setTimeout(() => { b.textContent = 'OK'; b.classList.remove('lucro-ok-btn--ok'); }, 1500);
    });
  } catch {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'OK';
      btn.classList.add('lucro-ok-btn--err');
      setTimeout(() => { btn.classList.remove('lucro-ok-btn--err'); }, 1500);
    }
  }
}

// ── Shopee: config e custo por item_id ──────────────────────────
// Produtos Shopee não têm SKU cadastrado ainda, então o custo é indexado
// pelo item_id da Shopee (catálogo separado do custo por SKU do ML).

async function lucroShopeeCarregarConfig() {
  try {
    const cfg = await fetch(`/api/lucro/config-shopee?conta=${lucroContaAtual()}`).then(r => r.json());
    lucroShopeeConfig = { taxa_imposto: 0, taxa_imposto_por_mes: {}, custos: {}, custos_historico: {}, ...cfg };
    if (lucroShopeeVendasRaw.length) lucroRecalcularERenderizar();
  } catch {}
}

// A Shopee permite variações com preços diferentes pro mesmo item_id (ex: "1 unidade" x
// "kit 2 unidades") — o custo precisa ser por item_id+model_id, não só por item_id, senão
// duas variações do mesmo anúncio compartilham o mesmo custo por engano.
function lucroShopeeChave(itemId, modelId) {
  return modelId ? `${itemId}_${modelId}` : String(itemId || '');
}

async function lucroShopeeSalvarCusto(input, btn) {
  const itemId  = input.dataset.itemId;
  const modelId = input.dataset.modelId || '';
  const chave   = lucroShopeeChave(itemId, modelId);
  const custo   = parseFloat(input.value.replace(',', '.')) || 0;
  if (!itemId) return;
  const desde = input.dataset.vdata || lucroHoje();
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await fetch('/api/lucro/custo-shopee', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ item_id: itemId, model_id: modelId, custo, desde, conta: lucroContaAtual() }),
    }).then(r => r.json());
    lucroShopeeConfig.custos_historico = lucroShopeeConfig.custos_historico || {};
    if (r.custos_historico) lucroShopeeConfig.custos_historico[chave] = r.custos_historico;
    lucroShopeeConfig.custos[chave] = r.custo_atual ?? custo;
    lucroRecalcularERenderizar();
    const custoAtual = r.custo_atual ?? custo;
    document.querySelectorAll(`.lucro-shopee-custo-input[data-chave="${chave}"]`).forEach(el => {
      el.value = custoAtual || '';
    });
    const targets = btn && btn.isConnected
      ? [btn]
      : [...document.querySelectorAll(`.lucro-shopee-ok-btn[data-chave="${chave}"]`)];
    targets.forEach(b => {
      b.disabled = false;
      b.textContent = '✓';
      b.classList.add('lucro-ok-btn--ok');
      setTimeout(() => { b.textContent = 'OK'; b.classList.remove('lucro-ok-btn--ok'); }, 1500);
    });
  } catch {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'OK';
      btn.classList.add('lucro-ok-btn--err');
      setTimeout(() => { btn.classList.remove('lucro-ok-btn--err'); }, 1500);
    }
  }
}

function lucroShopeeCustoNaData(itemId, modelId, dataVendaMs) {
  const chave = lucroShopeeChave(itemId, modelId);
  // fallback pro custo antigo (salvo só por item_id, de antes da separação por variação)
  const hist = (lucroShopeeConfig.custos_historico || {})[chave]
            || (lucroShopeeConfig.custos_historico || {})[itemId];
  if (!hist || !hist.length) {
    const custos = lucroShopeeConfig.custos || {};
    return custos[chave] ?? custos[itemId] ?? 0;
  }
  const dataISO = lucroDataLocalStr(dataVendaMs);
  let valor = 0;
  for (const h of hist) {
    if (h.desde <= dataISO) valor = h.valor; else break;
  }
  return valor;
}

// Imposto (Simples Nacional) é sobre a receita total da empresa, não muda por canal —
// usa a mesma taxa mensal configurada na aba DRE (ML), não uma taxa separada da Shopee.
function lucroShopeeCalcular(raw) {
  const { taxa_imposto = 0, taxa_imposto_por_mes = {} } = lucroConfig;
  return raw.map(v => {
    const mes     = lucroDataLocalStr(v.data).slice(0, 7);
    const taxa    = mes in taxa_imposto_por_mes ? taxa_imposto_por_mes[mes] : taxa_imposto;
    const custo   = v.itens.reduce((s, i) => s + lucroShopeeCustoNaData(i.itemId, i.modelId, v.data) * i.quantidade, 0);
    const frete   = v.freteReal ?? 0;
    const imposto = v.receita * (taxa / 100);
    const lucro   = v.receita - v.taxaShopee - frete - custo - imposto;
    const margem  = v.receita > 0 ? (lucro / v.receita) * 100 : 0;
    return { ...v, taxa, custo, frete, imposto, lucro, margem };
  });
}

function lucroShopeeTotais(vendas) {
  const t = vendas.reduce((acc, v) => {
    acc.receita    += v.receita;
    acc.taxaShopee += v.taxaShopee;
    acc.frete      += v.frete;
    acc.custo      += v.custo;
    acc.imposto    += v.imposto;
    acc.lucro      += v.lucro;
    return acc;
  }, { receita: 0, taxaShopee: 0, frete: 0, custo: 0, imposto: 0, lucro: 0 });
  t.margem = t.receita > 0 ? (t.lucro / t.receita) * 100 : 0;
  return t;
}

// ── Cálculo ──────────────────────────────────────────────────

// Custo vigente de um SKU numa data 'YYYY-MM-DD' (ou ISO completo) — usa o histórico
// por data de vigência; sem histórico, cai no custo atual flat (compatibilidade).
function lucroCustoNaData(sku, dataVenda) {
  const hist = (lucroConfig.custos_historico || {})[sku];
  if (!hist || !hist.length) return (lucroConfig.custos || {})[sku] || 0;
  const data = (dataVenda || '').slice(0, 10);
  let valor = 0;
  for (const h of hist) {
    if (h.desde <= data) valor = h.valor; else break;
  }
  return valor;
}

function lucroCalcular(raw) {
  const { taxa_imposto = 0, taxa_imposto_por_mes = {} } = lucroConfig;
  return raw.map(v => {
    const mes     = (v.data || '').slice(0, 7);
    const taxa    = mes in taxa_imposto_por_mes ? taxa_imposto_por_mes[mes] : taxa_imposto;
    // Venda devolvida: custo só das unidades que não voltaram (quantidadeCusto, v936)
    const custo   = v.itens.reduce((s, i) => s + lucroCustoNaData(i.sku || i.mlb, v.data) * (i.quantidadeCusto ?? i.quantidade), 0);
    const frete   = v.freteReal ?? 0;
    const imposto = v.receita * (taxa / 100);
    const lucro   = v.receita - v.taxaML - frete - custo - imposto;
    const margem  = v.receita > 0 ? (lucro / v.receita) * 100 : 0;
    return { ...v, taxa, custo, frete, imposto, lucro, margem };
  });
}

function lucroTotais(vendas) {
  const t = vendas.reduce((acc, v) => {
    acc.receita  += v.receita;
    acc.taxaML   += v.taxaML;
    acc.frete    += v.frete;
    acc.custo    += v.custo;
    acc.imposto  += v.imposto;
    acc.lucro    += v.lucro;
    return acc;
  }, { receita: 0, taxaML: 0, frete: 0, custo: 0, imposto: 0, lucro: 0 });
  t.margem = t.receita > 0 ? (t.lucro / t.receita) * 100 : 0;
  return t;
}

// ── Renderização ──────────────────────────────────────────────

function lucroRecalcularERenderizar() {
  if (!lucroVendasRaw.length && !lucroShopeeVendasRaw.length) return;

  const vendasML     = lucroVendasRaw.length     ? lucroCalcular(lucroVendasRaw)             : [];
  const vendasShopee = lucroShopeeVendasRaw.length ? lucroShopeeCalcular(lucroShopeeVendasRaw) : [];
  const ativasML      = vendasML.filter(v => !v.cancelado);
  const ativasShopee  = vendasShopee.filter(v => !v.cancelado);
  const totalML       = lucroTotais(ativasML);
  const totalShopee   = lucroShopeeTotais(ativasShopee);

  // Totalizador do topo soma os dois canais; as tabelas ficam em blocos separados.
  const totalCombinado = {
    receita: totalML.receita + totalShopee.receita,
    taxaML:  totalML.taxaML  + totalShopee.taxaShopee,
    frete:   totalML.frete   + totalShopee.frete,
    custo:   totalML.custo   + totalShopee.custo,
    imposto: totalML.imposto + totalShopee.imposto,
    lucro:   totalML.lucro   + totalShopee.lucro,
  };
  totalCombinado.margem = totalCombinado.receita > 0 ? (totalCombinado.lucro / totalCombinado.receita) * 100 : 0;

  lucroRenderizarCards(totalCombinado, ativasML.length + ativasShopee.length);
  if (lucroVendasRaw.length) {
    lucroVendasCalc = vendasML; // inclui canceladas, mostradas em vermelho sem somar
    lucroRenderizarTabelaComFiltro();
  }
  if (lucroShopeeVendasRaw.length) {
    lucroShopeeVendasCalc = vendasShopee;
    lucroShopeeRenderizarComFiltro();
  }
  lucroAbcRenderizar();
}

// ── Ordenação e filtro por SKU (tabela ML) ──────────────────────

function lucroValorOrdenacao(v, campo) {
  const item0 = v.itens[0] || {};
  switch (campo) {
    case 'data':    return v.data || '';
    case 'pedido':  return v.orderId || '';
    case 'produto': return item0.titulo || '';
    case 'sku':     return item0.sku || item0.mlb || '';
    case 'qtd':     return v.itens.reduce((s, i) => s + i.quantidade, 0);
    case 'receita': return v.receita  || 0;
    case 'taxaML':  return v.taxaML   || 0;
    case 'frete':   return v.frete    || 0;
    case 'custo':   return v.custo    || 0;
    case 'imposto': return v.imposto  || 0;
    case 'lucro':   return v.lucro    || 0;
    case 'margem':  return v.margem   || 0;
    default:        return '';
  }
}

function lucroRenderizarTabelaComFiltro() {
  let vendas = lucroVendasCalc;

  const termo = lucroFiltroSku.trim().toLowerCase();
  if (termo) {
    vendas = vendas.filter(v => v.itens.some(i => (i.sku || i.mlb || '').toLowerCase().includes(termo)));
  }

  const { campo, direcao } = lucroSortState;
  if (campo) {
    const mult = direcao === 'asc' ? 1 : -1;
    vendas = [...vendas].sort((a, b) => {
      const va = lucroValorOrdenacao(a, campo);
      const vb = lucroValorOrdenacao(b, campo);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
      return String(va).localeCompare(String(vb), 'pt-BR', { numeric: true }) * mult;
    });
  }

  lucroRenderizarTabela(vendas);

  document.querySelectorAll('#tabela-lucro .sort-icon[data-sort]').forEach(ic => {
    ic.textContent = ic.dataset.sort === campo ? (direcao === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

function lucroOrdenar(campo) {
  lucroSortState.direcao = lucroSortState.campo === campo && lucroSortState.direcao === 'asc' ? 'desc' : 'asc';
  lucroSortState.campo   = campo;
  lucroRenderizarTabelaComFiltro();
}

function lucroFiltrarSkuInput(valor) {
  lucroFiltroSku = valor;
  lucroRenderizarTabelaComFiltro();
  if (lucroShopeeVendasCalc.length) lucroShopeeRenderizarComFiltro();
}

// ── Ordenação e filtro por SKU (tabela Shopee) ──────────────────

function lucroShopeeValorOrdenacao(v, campo) {
  const item0 = v.itens[0] || {};
  switch (campo) {
    case 'data':      return v.data || '';
    case 'pedido':    return v.orderId || '';
    case 'produto':   return item0.titulo || '';
    case 'sku':       return item0.sku || String(item0.itemId || '');
    case 'qtd':       return v.itens.reduce((s, i) => s + i.quantidade, 0);
    case 'receita':   return v.receita    || 0;
    case 'taxaShopee':return v.taxaShopee || 0;
    case 'frete':     return v.frete      || 0;
    case 'custo':     return v.custo      || 0;
    case 'imposto':   return v.imposto    || 0;
    case 'lucro':     return v.lucro      || 0;
    case 'margem':    return v.margem     || 0;
    default:          return '';
  }
}

function lucroShopeeRenderizarComFiltro() {
  let vendas = lucroShopeeVendasCalc;

  const termo = lucroFiltroSku.trim().toLowerCase();
  if (termo) {
    vendas = vendas.filter(v => v.itens.some(i =>
      (i.sku || '').toLowerCase().includes(termo) || String(i.itemId || '').toLowerCase().includes(termo)
    ));
  }

  const { campo, direcao } = lucroShopeeSortState;
  if (campo) {
    const mult = direcao === 'asc' ? 1 : -1;
    vendas = [...vendas].sort((a, b) => {
      const va = lucroShopeeValorOrdenacao(a, campo);
      const vb = lucroShopeeValorOrdenacao(b, campo);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
      return String(va).localeCompare(String(vb), 'pt-BR', { numeric: true }) * mult;
    });
  }

  lucroShopeeRenderizarTabela(vendas);

  document.querySelectorAll('#tabela-lucro-shopee .sort-icon[data-sort]').forEach(ic => {
    ic.textContent = ic.dataset.sort === campo ? (direcao === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

function lucroShopeeOrdenar(campo) {
  lucroShopeeSortState.direcao = lucroShopeeSortState.campo === campo && lucroShopeeSortState.direcao === 'asc' ? 'desc' : 'asc';
  lucroShopeeSortState.campo   = campo;
  lucroShopeeRenderizarComFiltro();
}

// ── Curva ABC (ranking de produtos por qtd/receita/lucro) ───────

// Uma venda com vários itens só tem taxa/frete/imposto no nível do pedido (não por item),
// então cada item recebe uma fatia proporcional à sua parte na receita do pedido.
function lucroAbcAcumular(mapa, vendas, canal) {
  for (const v of vendas) {
    if (v.cancelado) continue;
    const taxaCanal = canal === 'ML' ? (v.taxaML || 0) : (v.taxaShopee || 0);
    const descontos = taxaCanal + (v.frete || 0) + (v.imposto || 0);
    const receitaPedido = v.itens.reduce((s, i) => s + i.precoUnit * i.quantidade, 0) || v.receita || 0;

    for (const item of v.itens) {
      const chave     = item.sku || item.mlb || (item.itemId != null ? String(item.itemId) : '') || '—';
      const itemReceita = item.precoUnit * item.quantidade;
      const fatia       = receitaPedido > 0 ? itemReceita / receitaPedido : (1 / v.itens.length);
      const itemCusto   = canal === 'ML'
        ? lucroCustoNaData(item.sku || item.mlb, v.data) * item.quantidade
        : lucroShopeeCustoNaData(item.itemId, item.modelId, v.data) * item.quantidade;
      const itemLucro   = itemReceita - itemCusto - fatia * descontos;

      if (!mapa[chave]) {
        mapa[chave] = { chave, titulo: item.titulo || chave, canais: new Set(), qtd: 0, receita: 0, lucro: 0 };
      }
      const linha = mapa[chave];
      linha.canais.add(canal);
      linha.qtd     += item.quantidade;
      linha.receita += itemReceita;
      linha.lucro   += itemLucro;
    }
  }
}

function lucroAbcSetMetrica(metrica) {
  lucroAbcMetrica = metrica;
  document.querySelectorAll('[data-abc-metrica]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.abcMetrica === metrica);
  });
  lucroAbcRenderizar();
}

function lucroAbcFiltrarInput(valor) {
  lucroAbcFiltro = valor;
  lucroAbcRenderizar();
}

function lucroAbcRenderizar() {
  const tbody  = document.getElementById('tabela-lucro-abc-body');
  const tabela = document.getElementById('tabela-lucro-abc');
  const vazio  = document.getElementById('lucro-abc-vazio');
  if (!tbody || !tabela) return;

  const mapa = {};
  lucroAbcAcumular(mapa, lucroVendasCalc, 'ML');
  lucroAbcAcumular(mapa, lucroShopeeVendasCalc, 'Shopee');

  let linhas = Object.values(mapa);

  const termo = lucroAbcFiltro.trim().toLowerCase();
  if (termo) {
    linhas = linhas.filter(l => l.chave.toLowerCase().includes(termo) || l.titulo.toLowerCase().includes(termo));
  }

  if (!linhas.length) {
    tabela.style.display = 'none';
    if (vazio) vazio.style.display = '';
    tbody.innerHTML = '';
    return;
  }
  if (vazio) vazio.style.display = 'none';

  linhas.sort((a, b) => b[lucroAbcMetrica] - a[lucroAbcMetrica]);

  const total = linhas.reduce((s, l) => s + l[lucroAbcMetrica], 0);
  let acumulado = 0;

  tbody.innerHTML = linhas.map(l => {
    acumulado += l[lucroAbcMetrica];
    const pctTotal     = total !== 0 ? (l[lucroAbcMetrica] / total) * 100 : 0;
    const pctAcumulado = total !== 0 ? (acumulado / total) * 100 : 0;
    const classe = pctAcumulado <= 80 ? 'A' : pctAcumulado <= 95 ? 'B' : 'C';
    const classeCor = classe === 'A' ? '#4ade80' : classe === 'B' ? '#facc15' : '#94a3b8';
    const margem = l.receita > 0 ? (l.lucro / l.receita) * 100 : 0;
    const margemCls = margem >= 10 ? 'lucro-val-pos' : margem < 0 ? 'lucro-val-neg' : '';
    const canalTxt = [...l.canais].join(' + ');

    return `<tr>
      <td><strong style="color:${classeCor}">${classe}</strong></td>
      <td class="td-titulo">${l.titulo}</td>
      <td class="lucro-td-mlb">${l.chave}</td>
      <td>${canalTxt}</td>
      <td class="col-num">${l.qtd}</td>
      <td class="col-num">${lucroFmt(l.receita)}</td>
      <td class="col-num ${l.lucro >= 0 ? 'lucro-val-pos' : 'lucro-val-neg'}"><strong>${lucroFmt(l.lucro)}</strong></td>
      <td class="col-num ${margemCls}">${margem.toFixed(1)}%</td>
      <td class="col-num">${pctTotal.toFixed(1)}%</td>
      <td class="col-num">${pctAcumulado.toFixed(1)}%</td>
    </tr>`;
  }).join('');

  tabela.style.display = 'table';
}

function lucroRenderizarCards(t, qtd) {
  document.getElementById('lucro-cards').style.display = '';
  const set = (id, val, neg) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (neg !== undefined) {
      el.className = 'lucro-card-valor ' + (neg ? 'lucro-val-neg' : (t.lucro >= 0 ? 'lucro-val-pos' : 'lucro-val-neg'));
    }
  };
  set('lucro-sum-receita',  lucroFmt(t.receita));
  set('lucro-sum-taxaml',   t.taxaML  > 0 ? lucroFmt(t.taxaML)  : '—', true);
  set('lucro-sum-frete',    t.frete   > 0 ? lucroFmt(t.frete)   : '—', true);
  set('lucro-sum-custo',    t.custo   > 0 ? lucroFmt(t.custo)   : '—', true);
  set('lucro-sum-imposto',  t.imposto > 0 ? lucroFmt(t.imposto) : '—', true);
  const lucroEl  = document.getElementById('lucro-sum-lucro');
  const margemEl = document.getElementById('lucro-sum-margem');
  if (lucroEl)  { lucroEl.textContent  = lucroFmt(t.lucro);       lucroEl.className  = 'lucro-card-valor ' + (t.lucro  >= 0 ? 'lucro-val-pos' : 'lucro-val-neg'); }
  if (margemEl) { margemEl.textContent = lucroFmtPct(t.margem);   margemEl.className = 'lucro-card-valor ' + (t.margem >= 0 ? 'lucro-val-pos' : 'lucro-val-neg'); }
  const totalEl = document.getElementById('lucro-total');
  if (totalEl) totalEl.textContent = `${qtd} venda${qtd !== 1 ? 's' : ''}`;
}

function lucroRenderizarTabela(vendas) {
  const tbody  = document.getElementById('tabela-lucro-body');
  const tabela = document.getElementById('tabela-lucro');
  tbody.innerHTML = '';

  if (!vendas.length) {
    tabela.style.display = 'none';
    return;
  }

  vendas.forEach(v => {
    const item0      = v.itens[0] || {};
    const multi      = v.itens.length > 1;
    const qtdTotal   = v.itens.reduce((s, i) => s + i.quantidade, 0);
    const chave0     = item0.sku || item0.mlb || '';

    if (v.cancelado) {
      const tr = document.createElement('tr');
      tr.classList.add('lucro-linha-cancelada');
      tr.innerHTML = `
        <td class="lucro-td-data">${new Date(v.data).toLocaleDateString('pt-BR')}</td>
        <td class="lucro-td-pedido" onclick="lucroCopiarPedido(this, '${v.orderId}')" title="Clique para copiar">${v.orderId || '—'}${lucroBtnPagamento(v.orderId)}</td>
        <td class="td-titulo">${item0.titulo || '—'}${multi ? `<span class="lucro-multi"> +${v.itens.length - 1}</span>` : ''}</td>
        <td class="lucro-td-mlb">${chave0 || '—'}</td>
        <td class="col-num">${qtdTotal}</td>
        <td class="col-num" colspan="7">CANCELADO — não entra no total</td>
      `;
      tbody.appendChild(tr);
      return;
    }

    const custoSalvo = lucroCustoNaData(chave0, v.data) || 0;
    const margemCls  = v.margem >= 10 ? 'lucro-val-pos' : v.margem < 0 ? 'lucro-val-neg' : '';
    const qtdCusto   = v.itens[0] ? (v.itens[0].quantidadeCusto ?? v.itens[0].quantidade) : qtdTotal;
    // Venda devolvida/reembolsada (v936): entra no total com o resultado real
    const tagDev = v.devolvida
      ? `<span class="lucro-tag-devolvida" title="${v.devolvida === 'parcial' ? 'Reembolso parcial' : 'Reembolsada'} — R$ ${(v.reembolsado || 0).toFixed(2).replace('.', ',')} devolvidos ao comprador. ${v.voltou ? 'Produto voltou (custo só do que ficou com o comprador).' : 'Produto não voltou (custo conta).'} Frete de volta fica em Outros custos do ML.">↩ ${v.devolvida === 'parcial' ? 'reembolso parcial' : 'devolvida'}</span>`
      : '';

    const tr = document.createElement('tr');
    const fmtCusto = (val) => val > 0 ? lucroFmt(val) : '—';
    tr.innerHTML = `
      <td class="lucro-td-data">${new Date(v.data).toLocaleDateString('pt-BR')}</td>
      <td class="lucro-td-pedido" onclick="lucroCopiarPedido(this, '${v.orderId}')" title="Clique para copiar">${v.orderId || '—'}${lucroBtnPagamento(v.orderId)}${tagDev}</td>
      <td class="td-titulo">${item0.titulo || '—'}${multi ? `<span class="lucro-multi"> +${v.itens.length - 1}</span>` : ''}</td>
      <td class="lucro-td-mlb">${chave0 || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td class="col-num">${lucroFmt(v.receita)}</td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.taxaML)}</td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.frete)}</td>
      <td class="col-num">
        ${chave0
          ? `${custoSalvo > 0 ? `<span class="lucro-custo-total">${fmtCusto(custoSalvo * (multi ? qtdTotal : qtdCusto))}</span>` : ''}
             <input type="number" class="lucro-custo-input" data-sku="${chave0}" data-vdata="${(v.data || '').slice(0,10)}"
              value="${custoSalvo || ''}" placeholder="unit."
              step="0.01" min="0">
             <button class="lucro-ok-btn" data-sku="${chave0}"
              onclick="lucroSalvarCusto(this.previousElementSibling, this)">OK</button>`
          : '—'}
      </td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.imposto)}${v.taxa > 0 ? `<span class="lucro-taxa-pct">${v.taxa}%</span>` : ''}</td>
      <td class="col-num ${margemCls}"><strong>${lucroFmt(v.lucro)}</strong></td>
      <td class="col-num ${margemCls}">${lucroFmtPct(v.margem)}</td>
    `;
    tbody.appendChild(tr);

    // Sub-linhas para itens adicionais
    for (let i = 1; i < v.itens.length; i++) {
      const item    = v.itens[i];
      const chaveI  = item.sku || item.mlb || '';
      const cSalvo2 = lucroCustoNaData(chaveI, v.data) || 0;
      const trSub   = document.createElement('tr');
      trSub.classList.add('lucro-sub-item');
      trSub.innerHTML = `
        <td></td>
        <td></td>
        <td class="td-titulo" style="color:#94a3b8;font-size:12px">↳ ${item.titulo || chaveI}</td>
        <td class="lucro-td-mlb">${chaveI || '—'}</td>
        <td class="col-num">${item.quantidade}</td>
        <td class="col-num" style="color:#94a3b8">${lucroFmt(item.precoUnit * item.quantidade)}</td>
        <td></td><td></td>
        <td class="col-num">
          ${chaveI
            ? `${cSalvo2 > 0 ? `<span class="lucro-custo-total">${lucroFmt(cSalvo2 * item.quantidade)}</span>` : ''}
               <input type="number" class="lucro-custo-input" data-sku="${chaveI}" data-vdata="${(v.data || '').slice(0,10)}"
                value="${cSalvo2 || ''}" placeholder="unit."
                step="0.01" min="0">
               <button class="lucro-ok-btn" data-sku="${chaveI}"
                onclick="lucroSalvarCusto(this.previousElementSibling, this)">OK</button>`
            : ''}
        </td>
        <td colspan="3"></td>
      `;
      tbody.appendChild(trSub);
    }
  });

  tabela.style.display = 'table';
}

function lucroShopeeRenderizarTabela(vendas) {
  const tbody  = document.getElementById('tabela-lucro-shopee-body');
  const tabela = document.getElementById('tabela-lucro-shopee');
  const totalEl = document.getElementById('lucro-shopee-total');
  if (!tbody || !tabela) return;
  tbody.innerHTML = '';

  const ativas = vendas.filter(v => !v.cancelado);
  if (totalEl) totalEl.textContent = `${ativas.length} venda${ativas.length !== 1 ? 's' : ''}`;

  if (!vendas.length) {
    tabela.style.display = 'none';
    return;
  }

  const fmtCusto = (val) => val > 0 ? lucroFmt(val) : '—';
  // freteReal null = Shopee ainda não liberou o escrow desse pedido (frete indisponível),
  // diferente de um frete que realmente é R$0,00 (comum em anúncio com frete grátis, onde a
  // Shopee absorve o custo e o escrow já vem sem desconto de frete nenhum) — os dois casos
  // precisam ficar visualmente diferentes, "—" não pode servir pros dois.
  const fmtFreteShopee = (v) => {
    if (v.freteReal === null) {
      return `<span style="color:#f59e0b" title="Shopee ainda não confirmou o valor do frete desse pedido">pendente</span>`;
    }
    return `<span title="Frete confirmado pela Shopee (pode ser R$0,00 em anúncio com frete grátis)">${lucroFmt(v.frete)}</span>`;
  };

  vendas.forEach(v => {
    const item0    = v.itens[0] || {};
    const multi    = v.itens.length > 1;
    const qtdTotal = v.itens.reduce((s, i) => s + i.quantidade, 0);
    const chave0   = lucroShopeeChave(item0.itemId, item0.modelId);
    const titulo0  = `${item0.titulo || '—'}${item0.variacao ? `<br><span style="color:#94a3b8;font-size:11px">${item0.variacao}</span>` : ''}`;
    const dataVdata = lucroDataLocalStr(v.data);

    if (v.cancelado) {
      const tr = document.createElement('tr');
      tr.classList.add('lucro-linha-cancelada');
      tr.innerHTML = `
        <td class="lucro-td-data">${new Date(v.data).toLocaleDateString('pt-BR')}</td>
        <td class="lucro-td-pedido" onclick="lucroCopiarPedido(this, '${v.orderId}')" title="Clique para copiar">${v.orderId || '—'}</td>
        <td class="td-titulo">${titulo0}${multi ? `<span class="lucro-multi"> +${v.itens.length - 1}</span>` : ''}</td>
        <td class="lucro-td-mlb">${item0.sku || item0.itemId || '—'}</td>
        <td class="col-num">${qtdTotal}</td>
        <td class="col-num" colspan="7">CANCELADO/DEVOLVIDO — não entra no total</td>
      `;
      tbody.appendChild(tr);
      return;
    }

    const custoSalvo = lucroShopeeCustoNaData(item0.itemId, item0.modelId, v.data) || 0;
    const margemCls  = v.margem >= 10 ? 'lucro-val-pos' : v.margem < 0 ? 'lucro-val-neg' : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="lucro-td-data">${new Date(v.data).toLocaleDateString('pt-BR')}</td>
      <td class="lucro-td-pedido" onclick="lucroCopiarPedido(this, '${v.orderId}')" title="Clique para copiar">${v.orderId || '—'}</td>
      <td class="td-titulo">${titulo0}${multi ? `<span class="lucro-multi"> +${v.itens.length - 1}</span>` : ''}</td>
      <td class="lucro-td-mlb">${item0.sku || item0.itemId || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td class="col-num">${lucroFmt(v.receita)}</td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.taxaShopee)}</td>
      <td class="col-num lucro-neg-leve">${fmtFreteShopee(v)}</td>
      <td class="col-num">
        ${item0.itemId
          ? `${custoSalvo > 0 ? `<span class="lucro-custo-total">${fmtCusto(custoSalvo * qtdTotal)}</span>` : ''}
             <input type="number" class="lucro-shopee-custo-input" data-item-id="${item0.itemId}" data-model-id="${item0.modelId || ''}" data-chave="${chave0}" data-vdata="${dataVdata}"
              value="${custoSalvo || ''}" placeholder="unit."
              step="0.01" min="0">
             <button class="lucro-shopee-ok-btn lucro-ok-btn" data-chave="${chave0}"
              onclick="lucroShopeeSalvarCusto(this.previousElementSibling, this)">OK</button>`
          : '—'}
      </td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.imposto)}${v.taxa > 0 ? `<span class="lucro-taxa-pct">${v.taxa}%</span>` : ''}</td>
      <td class="col-num ${margemCls}"><strong>${lucroFmt(v.lucro)}</strong></td>
      <td class="col-num ${margemCls}">${lucroFmtPct(v.margem)}</td>
    `;
    tbody.appendChild(tr);

    for (let i = 1; i < v.itens.length; i++) {
      const item    = v.itens[i];
      const chaveI  = lucroShopeeChave(item.itemId, item.modelId);
      const tituloI = `${item.titulo || item.itemId}${item.variacao ? `<br><span style="color:#94a3b8;font-size:11px">${item.variacao}</span>` : ''}`;
      const cSalvo2 = lucroShopeeCustoNaData(item.itemId, item.modelId, v.data) || 0;
      const trSub   = document.createElement('tr');
      trSub.classList.add('lucro-sub-item');
      trSub.innerHTML = `
        <td></td>
        <td></td>
        <td class="td-titulo" style="color:#94a3b8;font-size:12px">↳ ${tituloI}</td>
        <td class="lucro-td-mlb">${item.sku || item.itemId || '—'}</td>
        <td class="col-num">${item.quantidade}</td>
        <td class="col-num" style="color:#94a3b8">${lucroFmt(item.precoUnit * item.quantidade)}</td>
        <td></td><td></td>
        <td class="col-num">
          ${item.itemId
            ? `${cSalvo2 > 0 ? `<span class="lucro-custo-total">${lucroFmt(cSalvo2 * item.quantidade)}</span>` : ''}
               <input type="number" class="lucro-shopee-custo-input" data-item-id="${item.itemId}" data-model-id="${item.modelId || ''}" data-chave="${chaveI}" data-vdata="${dataVdata}"
                value="${cSalvo2 || ''}" placeholder="unit."
                step="0.01" min="0">
               <button class="lucro-shopee-ok-btn lucro-ok-btn" data-chave="${chaveI}"
                onclick="lucroShopeeSalvarCusto(this.previousElementSibling, this)">OK</button>`
            : ''}
        </td>
        <td colspan="3"></td>
      `;
      tbody.appendChild(trSub);
    }
  });

  tabela.style.display = 'table';
}

// ── Tabela de custos por SKU ──────────────────────────────────

async function lucroCustosCarregar() {
  const loading = document.getElementById('lucro-custos-loading');
  const tabela  = document.getElementById('tabela-custos');
  const tbody   = document.getElementById('tabela-custos-body');
  if (loading) loading.style.display = 'block';
  if (tabela)  tabela.style.display  = 'none';

  try {
    const d = await fetch(`/api/ml/estoque?conta=${lucroContaAtual()}`).then(r => r.json());
    if (loading) loading.style.display = 'none';
    if (d.error || !d.items?.length) return;

    // Deduplica por SKU (ignora itens sem SKU)
    const skuMap = {};
    (d.items || []).forEach(item => {
      if (item.sku && !skuMap[item.sku]) {
        skuMap[item.sku] = { sku: item.sku, titulo: item.titulo };
      }
    });
    const skus = Object.values(skuMap).sort((a, b) => a.sku.localeCompare(b.sku, 'pt-BR', { numeric: true }));

    tbody.innerHTML = '';
    skus.forEach(item => {
      const custoSalvo = lucroConfig.custos[item.sku] || 0;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="lucro-td-mlb">${item.sku}</td>
        <td class="td-titulo">${item.titulo || '—'}</td>
        <td class="col-num">
          <input type="date" class="lucro-custo-data" data-sku="${item.sku}" value="${lucroHoje()}">
          <input type="number" class="lucro-custo-input" data-sku="${item.sku}"
            value="${custoSalvo || ''}" placeholder="—"
            step="0.01" min="0">
          <button class="lucro-ok-btn" data-sku="${item.sku}"
            onclick="lucroSalvarCusto(this.parentElement.querySelector('.lucro-custo-input'), this)">OK</button>
          <button type="button" class="lucro-historico-btn" data-sku="${item.sku}"
            onclick="lucroCustosToggleHistorico('${item.sku}')">histórico</button>
        </td>
      `;
      tbody.appendChild(tr);

      const trHist = document.createElement('tr');
      trHist.className = 'lucro-historico-row';
      trHist.id = `lucro-historico-row-${item.sku}`;
      trHist.style.display = 'none';
      trHist.innerHTML = `<td colspan="3" class="lucro-historico-painel" id="lucro-historico-painel-${item.sku}"></td>`;
      tbody.appendChild(trHist);
    });

    if (tabela) tabela.style.display = 'table';
  } catch {
    if (loading) loading.style.display = 'none';
  }
}

function lucroCustosToggleHistorico(sku) {
  const row = document.getElementById(`lucro-historico-row-${sku}`);
  if (!row) return;
  const abrindo = row.style.display === 'none';
  row.style.display = abrindo ? 'table-row' : 'none';
  if (abrindo) lucroCustosRenderHistorico(sku);
}

function lucroCustosRenderHistorico(sku) {
  const painel = document.getElementById(`lucro-historico-painel-${sku}`);
  if (!painel) return;
  const hist = (lucroConfig.custos_historico || {})[sku] || [];
  if (!hist.length) {
    painel.innerHTML = '<span class="lucro-historico-vazio">Sem histórico — usando valor único.</span>';
    return;
  }
  painel.innerHTML = [...hist].reverse().map(h => `
    <span class="lucro-historico-item">
      ${h.desde} — ${lucroFmt(h.valor)}
      <button type="button" class="lucro-historico-del" onclick="lucroCustoRemoverEntrada('${sku}', '${h.desde}')">×</button>
    </span>
  `).join('');
}

async function lucroCustoRemoverEntrada(sku, desde) {
  const conta = lucroContaAtual();
  try {
    const r = await fetch('/api/lucro/custo-remover', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, sku, desde }),
    }).then(r => r.json());
    lucroConfig.custos_historico = lucroConfig.custos_historico || {};
    lucroConfig.custos_historico[sku] = r.custos_historico || [];
    lucroConfig.custos[sku] = r.custo_atual ?? 0;
    document.querySelectorAll(`.lucro-custo-input[data-sku="${sku}"]`).forEach(el => {
      el.value = lucroConfig.custos[sku] || '';
    });
    lucroCustosRenderHistorico(sku);
    lucroRecalcularERenderizar();
  } catch {}
}

// ── Período ───────────────────────────────────────────────────

function lucroSetMesAtual() {
  const hoje = lucroHoje();
  const d = new Date();
  const primeiroDia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const de  = document.getElementById('lucro-data-de');
  const ate = document.getElementById('lucro-data-ate');
  if (de)  de.value  = primeiroDia;
  if (ate) ate.value = hoje;
  lucroAtualizarAmbos();
}

function lucroSetPeriodoRapido(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  const data = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const ate  = document.getElementById('lucro-data-ate');
  const de   = document.getElementById('lucro-data-de');
  if (ate) ate.value = data;
  if (de)  de.value  = data; // mesmo dia nos dois
  lucroAtualizarAmbos();
}

function lucroAtualizarAmbos() {
  lucroCarregarVendas();
  lucroShopeeCarregarVendas();
}

// ── Carregamento ──────────────────────────────────────────────

async function lucroCarregarVendas() {
  const gen     = contaGen;
  const conta   = lucroContaAtual();
  const loading = document.getElementById('lucro-loading');
  const erroEl  = document.getElementById('lucro-erro');
  const btn     = document.getElementById('btn-atualizar-lucro');
  if (btn) btn.disabled = true;
  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  document.getElementById('tabela-lucro').style.display = 'none';
  document.getElementById('lucro-cards').style.display  = 'none';

  try {
    const de  = document.getElementById('lucro-data-de')?.value  || '';
    const ate = document.getElementById('lucro-data-ate')?.value || '';
    const qs  = new URLSearchParams({ conta, date_from: de, date_to: ate });
    const d = await fetch(`/api/lucro/vendas?${qs}`).then(r => r.json());
    if (contaGen !== gen) return; // resposta de conta antiga — descarta
    loading.style.display = 'none';
    if (d.error) {
      erroEl.textContent = d.error; erroEl.style.display = 'block';
      if (btn) btn.disabled = false;
      return;
    }
    lucroVendasRaw = d.vendas || [];
    lucroCarregado = true;
    lucroRecalcularERenderizar();
  } catch {
    if (contaGen !== gen) return;
    loading.style.display = 'none';
    erroEl.textContent = 'Erro ao carregar vendas.'; erroEl.style.display = 'block';
  }
  if (btn) btn.disabled = false;
}

async function lucroShopeeCarregarVendas() {
  const loading = document.getElementById('lucro-shopee-loading');
  const erroEl  = document.getElementById('lucro-shopee-erro');
  const tabela  = document.getElementById('tabela-lucro-shopee');
  if (loading) loading.style.display = 'block';
  if (erroEl)  erroEl.style.display  = 'none';
  if (tabela)  tabela.style.display  = 'none';

  try {
    const de  = document.getElementById('lucro-data-de')?.value  || '';
    const ate = document.getElementById('lucro-data-ate')?.value || '';
    const qs  = new URLSearchParams({ date_from: de, date_to: ate, conta: lucroContaAtual() });
    const d = await fetch(`/api/lucro/vendas-shopee?${qs}`).then(r => r.json());
    if (loading) loading.style.display = 'none';
    if (d.error) {
      if (erroEl) { erroEl.textContent = d.error; erroEl.style.display = 'block'; }
      return;
    }
    lucroShopeeVendasRaw = d.vendas || [];
    lucroShopeeCarregado = true;
    lucroRecalcularERenderizar();
  } catch {
    if (loading) loading.style.display = 'none';
    if (erroEl) { erroEl.textContent = 'Erro ao carregar vendas Shopee.'; erroEl.style.display = 'block'; }
  }
}

// ── Sub-abas ──────────────────────────────────────────────────

function lucroAba(nome) {
  document.querySelectorAll('.lucro-subaba-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.aba === nome);
  });
  ['vendas', 'custos', 'gastos', 'mensal', 'dre', 'abc'].forEach(a => {
    const el = document.getElementById(`lucro-aba-${a}`);
    if (el) el.style.display = a === nome ? '' : 'none';
  });
  if (nome === 'custos') lucroCustosCarregar();
  if (nome === 'gastos') { gastosInitMes(); gastosAtualizarTudo(); }
  if (nome === 'mensal') lmInit();
  if (nome === 'dre')    dreInit();
  if (nome === 'abc')    lucroAbcRenderizar();
}

// ── Gastos mensais ────────────────────────────────────────────

function gastosInitMes() {
  const mesEl = document.getElementById('gastos-mes');
  if (mesEl && !mesEl.value) {
    const d = new Date();
    mesEl.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
}

function gastosMesAtual() {
  return document.getElementById('gastos-mes')?.value || new Date().toISOString().slice(0, 7);
}

// Retorna { de: 'YYYY-MM-DD', ate: 'YYYY-MM-DD' } para o mês selecionado
function gastosPeriodoMes() {
  const mes  = gastosMesAtual(); // 'YYYY-MM'
  const hoje = lucroHoje();
  const [ano, m] = mes.split('-').map(Number);
  const de  = `${mes}-01`;
  // Último dia do mês
  const ultimoDia = new Date(ano, m, 0).getDate();
  const ate_full  = `${mes}-${String(ultimoDia).padStart(2,'0')}`;
  // Se for o mês atual, usa hoje como limite
  const ate = ate_full > hoje ? hoje : ate_full;
  return { de, ate };
}

async function gastosCarregarLucroMes() {
  const conta      = lucroContaAtual();
  const { de, ate } = gastosPeriodoMes();
  const loadingEl  = document.getElementById('gastos-lucro-loading');
  const periodoEl  = document.getElementById('gastos-lucro-periodo');
  const resultadoEl = document.getElementById('gastos-resultado');
  if (loadingEl)   loadingEl.style.display = 'inline';
  if (periodoEl)   { periodoEl.textContent = '—'; periodoEl.className = 'lucro-card-valor'; }
  if (resultadoEl) { resultadoEl.textContent = '—'; resultadoEl.className = 'lucro-card-valor'; }
  try {
    const qs = new URLSearchParams({ conta, date_from: de, date_to: ate });
    const d  = await fetch(`/api/lucro/vendas?${qs}`).then(r => r.json());
    gastosVendasRaw = d.vendas || [];
    if (loadingEl) loadingEl.style.display = 'none';
  } catch {
    gastosVendasRaw = [];
    if (loadingEl) { loadingEl.textContent = 'erro — clique em Atualizar'; loadingEl.style.display = 'inline'; }
  }
  gastosAtualizarCards();
}

async function gastosAtualizarTudo() {
  const btn = document.getElementById('btn-gastos-atualizar');
  if (btn) btn.disabled = true;
  // Só dados locais — sem chamada à API do ML para evitar resultados instáveis
  // Ads tem seu próprio botão "↻ Atualizar" na seção "Detectado automaticamente"
  await Promise.all([
    gastosCarregar(),
    gastosFixosCarregar(),
  ]);
  if (btn) btn.disabled = false;
}

// ── Gastos fixos ──────────────────────────────────────────────

let gastosFixosTipos      = [];
let gastosFixosValores    = {};
let gastosFixosValoresMes = {}; // valores explicitamente salvos neste mês (sem auto-fill)
let gastosFixosRemovidoEm = {}; // { nome: 'YYYY-MM' } mês em que o item foi excluído da lista

async function gastosFixosCarregar() {
  const conta = lucroContaAtual();
  const mes   = gastosMesAtual();
  try {
    const d = await fetch(`/api/lucro/gastos-fixos?conta=${conta}&mes=${mes}`).then(r => r.json());
    gastosFixosTipos      = d.tipos      || [];
    gastosFixosValores    = d.valores    || {};
    gastosFixosValoresMes = d.valoresMes || {};
    gastosFixosTravados   = new Set(d.travados || []);
    gastosFixosRemovidoEm = d.removidoEm || {};
  } catch {
    gastosFixosTipos      = [];
    gastosFixosValores    = {};
    gastosFixosValoresMes = {};
    gastosFixosTravados   = new Set();
    gastosFixosRemovidoEm = {};
  }
  gastosFixosRenderizar();
}

function gastosFixosRenderizar() {
  const tbody     = document.getElementById('tabela-gastos-fixos-body');
  const tabela    = document.getElementById('tabela-gastos-fixos');
  const vazio     = document.getElementById('gastos-fixos-vazio');
  const salvarWrap = document.getElementById('gastos-fixos-salvar-wrap');
  if (!tbody) return;
  tbody.innerHTML = '';

  const mesAtual = gastosMesAtual();
  // Itens com valor salvo explicitamente neste mês mas removidos da lista ativa.
  // A partir do mês da exclusão (inclusive) o item some de vez — só aparece
  // normalmente nos meses anteriores a isso, como se nunca tivesse sido excluído.
  const historicos = Object.entries(gastosFixosValoresMes)
    .filter(([nome, val]) => !gastosFixosTipos.includes(nome) && parseFloat(val) > 0)
    .filter(([nome]) => {
      const removidoEm = gastosFixosRemovidoEm[nome];
      return !removidoEm || mesAtual < removidoEm;
    });

  const temAtivos    = gastosFixosTipos.length > 0;
  const temHistorico = historicos.length > 0;

  if (!temAtivos && !temHistorico) {
    if (tabela)     tabela.style.display     = 'none';
    if (vazio)      vazio.style.display      = 'block';
    if (salvarWrap) salvarWrap.style.display = 'none';
    gastosAtualizarCards();
    return;
  }
  if (vazio)      vazio.style.display      = 'none';
  if (tabela)     tabela.style.display     = 'table';
  if (salvarWrap) salvarWrap.style.display = temAtivos ? 'flex' : 'none';

  // Limpa status ao renderizar (ex: ao trocar mês)
  const statusEl = document.getElementById('gastos-fixos-salvar-status');
  if (statusEl) statusEl.textContent = '';

  gastosFixosTipos.forEach(nome => {
    const valor   = gastosFixosValores[nome] ?? 0;
    const travado = gastosFixosTravados.has(nome);
    const escNome = nome.replace(/'/g, "\\'");
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${nome}</td>
      <td class="col-num">
        <input type="number" step="0.01" min="0" value="${valor || ''}" placeholder="0,00"
          class="lucro-custo-input" style="width:110px"
          data-nome="${nome}"
          oninput="gastosAtualizarCards()">
      </td>
      <td style="text-align:center">
        <button class="lucro-btn-lock${travado ? ' ativo' : ''}"
          onclick="gastosFixoToggleTravado('${escNome}')"
          title="${travado ? 'Valor fixo ativo — clique para desativar' : 'Clique para repetir este valor automaticamente todo mês'}">
          ${travado ? '&#128274;' : '&#128275;'}
        </button>
      </td>
      <td style="text-align:center">
        <button class="lucro-btn-remover" onclick="gastosFixoRemoverTipo('${escNome}')">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Itens excluídos da lista de tipos ativos, mas com valor salvo em mês anterior
  // ao da exclusão — mostra normal, editável, como se nunca tivesse sido excluído.
  // A partir do mês da exclusão (inclusive) nem entra nessa lista (filtro acima).
  historicos.forEach(([nome, valor]) => {
    const escNome = nome.replace(/'/g, "\\'");
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${nome}</td>
      <td class="col-num">
        <input type="number" step="0.01" min="0" value="${valor || ''}" placeholder="0,00"
          class="lucro-custo-input" style="width:110px"
          data-nome="${nome}"
          oninput="gastosAtualizarCards()">
      </td>
      <td></td>
      <td style="text-align:center">
        <button class="lucro-btn-remover" onclick="gastosFixoRemoverTipo('${escNome}')"
          title="Excluir a partir deste mês (empurra o corte pra cá)">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  gastosAtualizarCards();
}

async function gastosFixoAdicionar() {
  const input = document.getElementById('gastos-fixo-novo-nome');
  const nome  = input?.value?.trim();
  if (!nome) return;
  const conta = lucroContaAtual();
  try {
    await fetch('/api/lucro/gastos-fixo-tipo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, nome }),
    });
    if (!gastosFixosTipos.includes(nome)) gastosFixosTipos.push(nome);
    if (input) input.value = '';
    gastosFixosRenderizar();
  } catch {}
}

async function gastosFixoRemoverTipo(nome) {
  const conta = lucroContaAtual();
  const mes   = gastosMesAtual();
  try {
    await fetch('/api/lucro/gastos-fixo-tipo', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, nome, mes }),
    });
    gastosFixosTipos   = gastosFixosTipos.filter(t => t !== nome);
    delete gastosFixosValores[nome];
    gastosFixosRemovidoEm[nome] = mes;
    gastosFixosRenderizar();
  } catch {}
}

async function gastosFixoToggleTravado(nome) {
  const conta   = lucroContaAtual();
  const travado = !gastosFixosTravados.has(nome);
  const inp     = document.querySelector(`input[data-nome="${nome}"]`);
  const valorAtual = inp ? parseFloat(inp.value.replace(',', '.')) || 0 : 0;
  try {
    await fetch('/api/lucro/gastos-fixo-travado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, nome, travado, valor: valorAtual }),
    });
    if (travado) gastosFixosTravados.add(nome); else gastosFixosTravados.delete(nome);
    gastosFixosRenderizar();
  } catch {}
}

async function gastosFixosSalvarBtn() {
  const conta    = lucroContaAtual();
  const mes      = gastosMesAtual();
  const btn      = document.getElementById('btn-gastos-fixos-salvar');
  const statusEl = document.getElementById('gastos-fixos-salvar-status');

  // Coleta todos os valores dos inputs
  const tbody = document.getElementById('tabela-gastos-fixos-body');
  const valores = {};
  if (tbody) {
    // Inclui tudo que está renderizado nesta tela: ativos + históricos de meses
    // anteriores ao da exclusão. Itens excluídos não aparecem mais a partir do
    // mês da exclusão (filtro de `historicos`), então nunca vazam pra cá.
    tbody.querySelectorAll('input[data-nome]').forEach(inp => {
      valores[inp.dataset.nome] = parseFloat(inp.value.replace(',', '.')) || 0;
    });
  }

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Salvando…';

  try {
    await fetch('/api/lucro/gastos-fixos-valores-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, mes, valores }),
    });
    Object.assign(gastosFixosValores, valores);
    gastosAtualizarCards();
    if (statusEl) {
      statusEl.style.color = '#16a34a';
      statusEl.textContent = 'Salvo!';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    }
  } catch {
    if (statusEl) {
      statusEl.style.color = '#dc2626';
      statusEl.textContent = 'Erro ao salvar — tente novamente';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function gastosAutoCarregar() {
  const conta   = lucroContaAtual();
  const mes     = gastosMesAtual();
  const loading = document.getElementById('gastos-auto-loading');
  const tabela  = document.getElementById('tabela-gastos-auto');
  const adsEl   = document.getElementById('gastos-auto-ads');
  const btn     = document.getElementById('btn-gastos-auto');

  if (loading) loading.style.display = 'block';
  if (tabela)  tabela.style.display  = 'none';
  if (btn)     btn.disabled = true;
  if (adsEl)   adsEl.textContent  = '…';

  // Reseta enquanto carrega
  gastosAuto = { ads_cost: null };

  try {
    const qs = new URLSearchParams({ conta, mes });
    const d  = await fetch(`/api/lucro/gastos-auto?${qs}`).then(r => r.json());
    gastosAuto.ads_cost = d.ads_cost ?? 0;
    if (adsEl) adsEl.textContent = lucroFmt(gastosAuto.ads_cost);
  } catch {
    if (adsEl)  adsEl.textContent  = 'Erro';
  }

  if (loading) loading.style.display = 'none';
  if (tabela)  tabela.style.display  = 'table';
  if (btn)     btn.disabled = false;
  gastosAtualizarCards(); // recalcula total com os automáticos
}

async function gastosCarregar() {
  const conta   = lucroContaAtual();
  const mes     = gastosMesAtual();
  const loading = document.getElementById('gastos-loading');
  if (loading) loading.style.display = 'block';
  document.getElementById('tabela-gastos').style.display = 'none';
  document.getElementById('gastos-vazio').style.display  = 'none';
  try {
    const d = await fetch(`/api/lucro/gastos?conta=${conta}&mes=${mes}`).then(r => r.json());
    gastosLista = d.gastos || [];
    gastosRenderizar();
  } catch {}
  if (loading) loading.style.display = 'none';
}

function gastosRenderizar() {
  const tbody  = document.getElementById('tabela-gastos-body');
  const tabela = document.getElementById('tabela-gastos');
  const vazio  = document.getElementById('gastos-vazio');
  tbody.innerHTML = '';
  if (!gastosLista.length) {
    tabela.style.display = 'none';
    vazio.style.display  = 'block';
  } else {
    vazio.style.display  = 'none';
    const mes = gastosMesAtual();
    gastosLista.forEach(g => {
      const isEntrada = g.tipo === 'entrada';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <span class="gastos-tipo-badge ${isEntrada ? 'entrada' : 'gasto'}">${isEntrada ? '+ Entrada' : '− Gasto'}</span>${g.descricao || '—'}
        </td>
        <td class="col-num ${isEntrada ? 'lucro-val-pos' : 'lucro-val-neg'}">${isEntrada ? '+' : ''}${lucroFmt(g.valor)}</td>
        <td style="text-align:center">
          <button class="lucro-btn-remover" onclick="gastosRemover('${g.id}')" title="Remover">✕</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
    tabela.style.display = 'table';
  }
  gastosAtualizarCards();
}

function gastosAtualizarCards() {
  const totalGastosManuais = gastosLista.reduce((s, g) => g.tipo === 'entrada' ? s : s + g.valor, 0);
  const totalEntradas      = gastosLista.reduce((s, g) => g.tipo === 'entrada' ? s + g.valor : s, 0);
  const totalAuto          = (gastosAuto.ads_cost ?? 0);
  // Lê inputs diretamente para refletir digitação antes de salvar
  const tbody = document.getElementById('tabela-gastos-fixos-body');
  let totalFixos = 0;
  if (tbody) {
    tbody.querySelectorAll('input[data-nome]').forEach(inp => {
      totalFixos += parseFloat(inp.value.replace(',', '.')) || 0;
    });
  } else {
    totalFixos = gastosFixosTipos.reduce((s, n) => s + (gastosFixosValores[n] ?? 0), 0);
  }
  const totalGastos  = totalGastosManuais + totalAuto + totalFixos;
  // Lucro do mês completo (buscado independentemente da aba Vendas)
  const vendas  = gastosVendasRaw.length ? lucroCalcular(gastosVendasRaw).filter(v => !v.cancelado) : [];
  const totais  = vendas.length ? lucroTotais(vendas) : null;
  const lucroPeriodo = totais ? totais.lucro : null;

  const periodoEl    = document.getElementById('gastos-lucro-periodo');
  const totalEl      = document.getElementById('gastos-total');
  const resultadoEl  = document.getElementById('gastos-resultado');
  const labelEl      = document.getElementById('gastos-label-periodo');
  const entradasEl   = document.getElementById('gastos-entradas');
  const entradasCard = document.getElementById('gastos-entradas-card');

  // Atualiza label com o período real
  if (labelEl) {
    const { de, ate } = gastosPeriodoMes();
    const fmt = s => new Date(s + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    labelEl.textContent = `Lucro ${fmt(de)} → ${fmt(ate)}`;
  }

  if (periodoEl) {
    periodoEl.textContent = lucroPeriodo !== null ? lucroFmt(lucroPeriodo) : '—';
    periodoEl.className   = 'lucro-card-valor' + (lucroPeriodo !== null ? (lucroPeriodo >= 0 ? ' lucro-val-pos' : ' lucro-val-neg') : '');
  }
  if (entradasCard) entradasCard.style.display = totalEntradas > 0 ? '' : 'none';
  if (entradasEl)   entradasEl.textContent      = totalEntradas > 0 ? lucroFmt(totalEntradas) : '—';
  if (totalEl) {
    totalEl.textContent = totalGastos > 0 ? lucroFmt(totalGastos) : '—';
  }
  if (resultadoEl) {
    if (lucroPeriodo !== null) {
      const resultado = lucroPeriodo + totalEntradas - totalGastos;
      resultadoEl.textContent = lucroFmt(resultado);
      resultadoEl.className   = 'lucro-card-valor ' + (resultado >= 0 ? 'lucro-val-pos' : 'lucro-val-neg');
    } else {
      resultadoEl.textContent = '—';
      resultadoEl.className   = 'lucro-card-valor';
    }
  }
}

function gastosTipoSel(tipo) {
  const btnG = document.getElementById('gastos-tipo-gasto');
  const btnE = document.getElementById('gastos-tipo-entrada');
  if (btnG) btnG.classList.toggle('active', tipo === 'gasto');
  if (btnE) btnE.classList.toggle('active', tipo === 'entrada');
}

async function gastosAdicionar() {
  const conta      = lucroContaAtual();
  const mes        = gastosMesAtual();
  const descricao  = document.getElementById('gastos-descricao')?.value?.trim();
  const valorInput = document.getElementById('gastos-valor');
  const valor      = parseFloat(valorInput?.value?.replace(',', '.')) || 0;
  const tipo       = document.getElementById('gastos-tipo-entrada')?.classList.contains('active') ? 'entrada' : 'gasto';

  if (!descricao) { alert('Informe a descrição.'); return; }
  if (valor <= 0)  { alert('Informe um valor maior que zero.'); return; }

  try {
    const r = await fetch('/api/lucro/gasto', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, mes, descricao, valor, tipo }),
    }).then(r => r.json());
    if (r.ok) {
      gastosLista.push({ id: r.id, descricao, valor, tipo });
      document.getElementById('gastos-descricao').value = '';
      if (valorInput) valorInput.value = '';
      gastosRenderizar();
    }
  } catch {}
}

async function gastosRemover(id) {
  const conta = lucroContaAtual();
  const mes   = gastosMesAtual();
  try {
    await fetch('/api/lucro/gasto', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, mes, id }),
    });
    gastosLista = gastosLista.filter(g => g.id !== id);
    gastosRenderizar();
  } catch {}
}

async function lucroInit() {
  lucroInitDatas();
  await lucroCarregarConfig();
  await lucroShopeeCarregarConfig();
  if (!lucroCarregado) {
    await lucroCarregarVendas();
  }
  if (!lucroShopeeCarregado) {
    await lucroShopeeCarregarVendas();
  }
  // Recarrega tudo ao trocar o mês
  const mesEl = document.getElementById('gastos-mes');
  if (mesEl && !mesEl._listenerOk) {
    mesEl.addEventListener('change', gastosAtualizarTudo);
    mesEl._listenerOk = true;
  }
}

// Recarrega quando conta muda e aba lucro está ativa
document.addEventListener('contaMudou', () => {
  const aba = document.getElementById('tab-lucro');
  if (aba && aba.classList.contains('active')) {
    lucroCarregado = false;
    lucroShopeeCarregado = false;
    lucroCarregarConfig().then(() => lucroCarregarVendas());
    lucroShopeeCarregarConfig().then(() => lucroShopeeCarregarVendas());
  }
});

// ── DRE (Demonstração do Resultado) ──────────────────────────

const NOMES_MES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// Retorna { de, ate } para qualquer mês 'YYYY-MM', respeitando data de hoje
function drePeriodoMes(mes) {
  const hoje = lucroHoje();
  const [ano, m] = mes.split('-').map(Number);
  const de = `${mes}-01`;
  const ultimoDia = new Date(ano, m, 0).getDate();
  const ate_full  = `${mes}-${String(ultimoDia).padStart(2,'0')}`;
  return { de, ate: ate_full > hoje ? hoje : ate_full };
}

async function dreInit() {
  const anoEl = document.getElementById('dre-ano');
  if (anoEl && !anoEl.value) anoEl.value = new Date().getFullYear();
  // Carrega do cache instantaneamente (sem chamada ao ML)
  await dreCarregarDoCache();
}

// Carrega cache + dados locais e renderiza sem chamar API ML
async function dreCarregarDoCache() {
  const conta   = lucroContaAtual();
  const ano     = parseInt(document.getElementById('dre-ano')?.value) || new Date().getFullYear();
  const loading = document.getElementById('dre-loading');
  const tabela  = document.getElementById('tabela-dre');
  const vazio   = document.getElementById('dre-vazio');
  if (tabela) tabela.style.display = 'none';
  if (vazio)  vazio.style.display  = 'none';
  try {
    const [localResp, cacheResp] = await Promise.all([
      fetch(`/api/lucro/dre-local?conta=${conta}&ano=${ano}`).then(r => r.json()),
      fetch(`/api/lucro/dre-cache?conta=${conta}&ano=${ano}`).then(r => r.json()),
    ]);
    dreRenderizar(localResp.meses || [], ano, cacheResp.cache || {});
  } catch {}
}

// Atualiza todos os meses via ML (mês a mês para não sobrecarregar a API)
async function dreCarregar() {
  const conta   = lucroContaAtual();
  const ano     = parseInt(document.getElementById('dre-ano')?.value) || new Date().getFullYear();
  const btn     = document.getElementById('btn-dre-carregar');
  const loading = document.getElementById('dre-loading');
  const vazio   = document.getElementById('dre-vazio');
  if (btn)     btn.disabled = true;
  if (loading) { loading.textContent = 'Preparando…'; loading.style.display = 'block'; }
  if (vazio)   vazio.style.display = 'none';
  try {
    await lucroCarregarConfig();
    const hoje       = new Date();
    const mesAtual   = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
    const localResp  = await fetch(`/api/lucro/dre-local?conta=${conta}&ano=${ano}`).then(r => r.json());
    // Processa só meses passados/atual (futuros não têm dados)
    const meses = (localResp.meses || []).filter(m => m.mes <= mesAtual);
    for (let i = 0; i < meses.length; i++) {
      const m = meses[i];
      if (loading) loading.textContent = `Buscando ${m.mes} (${i + 1}/${meses.length})…`;
      try {
        const { de, ate } = drePeriodoMes(m.mes);
        const [vendasResp, adsResp] = await Promise.all([
          fetch(`/api/lucro/vendas?conta=${conta}&date_from=${de}&date_to=${ate}`).then(r => r.json()),
          fetch(`/api/lucro/gastos-auto?conta=${conta}&mes=${m.mes}`).then(r => r.json()),
        ]);
        const vendas  = vendasResp.vendas || [];
        const calc    = vendas.length ? lucroCalcular(vendas).filter(v => !v.cancelado) : [];
        const totais  = calc.length  ? lucroTotais(calc)     : null;
        const lucroML = totais ? totais.lucro   : null;
        const taxaML  = totais ? totais.taxaML  : null;
        const frete   = totais ? totais.frete   : null;
        const custo   = totais ? totais.custo   : null;
        const imposto = totais ? totais.imposto : null;
        const ads     = adsResp.ads_cost ?? 0;
        // Só salva se a API retornou dados — evita sobrescrever cache bom com null em caso de erro/timeout
        if (lucroML !== null) {
          await fetch('/api/lucro/dre-cache-mes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conta, mes: m.mes, lucroML, taxaML, frete, custo, imposto, ads }),
          }).catch(() => {});
        }
      } catch {}
      // Atualiza a tabela a cada mês para mostrar progresso visual
      await dreCarregarDoCache();
    }
    await dreCarregarDoCache();
  } catch (e) {
    if (vazio) { vazio.textContent = 'Erro ao carregar. Tente novamente.'; vazio.style.display = 'block'; }
  } finally {
    if (btn)     btn.disabled = false;
    if (loading) loading.style.display = 'none';
  }
}

// Atualiza apenas um mês via ML e salva no cache
async function dreRefreshMes(mes) {
  const conta  = lucroContaAtual();
  const rowEl  = document.getElementById(`dre-row-${mes}`);
  const btnEl  = document.getElementById(`dre-btn-${mes}`);
  if (rowEl)  rowEl.style.opacity = '0.4';
  if (btnEl)  { btnEl.disabled = true; btnEl.textContent = '…'; }
  try {
    // Garante que taxas/custos estão carregados antes de calcular
    await lucroCarregarConfig();
    const { de, ate } = drePeriodoMes(mes);
    const [vendasResp, adsResp] = await Promise.all([
      fetch(`/api/lucro/vendas?conta=${conta}&date_from=${de}&date_to=${ate}`).then(r => r.json()),
      fetch(`/api/lucro/gastos-auto?conta=${conta}&mes=${mes}`).then(r => r.json()),
    ]);
    const vendas  = vendasResp.vendas || [];
    const calc    = vendas.length ? lucroCalcular(vendas) : [];
    const totais  = calc.length  ? lucroTotais(calc)     : null;
    const lucroML = totais ? totais.lucro   : null;
    const taxaML  = totais ? totais.taxaML  : null;
    const frete   = totais ? totais.frete   : null;
    const custo   = totais ? totais.custo   : null;
    const imposto = totais ? totais.imposto : null;
    const ads     = adsResp.ads_cost ?? 0;
    // Só salva no cache se a API retornou dados reais — evita sobrescrever cache bom com null em caso de erro/timeout
    if (lucroML !== null) {
      await fetch('/api/lucro/dre-cache-mes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conta, mes, lucroML, taxaML, frete, custo, imposto, ads }),
      });
    } else {
      if (btnEl) btnEl.title = 'Nenhuma venda encontrada — cache anterior mantido';
    }
    await dreCarregarDoCache();
  } catch {}
  // Row re-rendered by dreCarregarDoCache — opacity reset happens via new DOM
}

function dreRenderizar(meses, ano, cacheML = {}) {
  const tbody  = document.getElementById('tabela-dre-body');
  const tabela = document.getElementById('tabela-dre');
  const vazio  = document.getElementById('dre-vazio');
  if (!tbody) return;
  tbody.innerHTML = '';

  const hoje     = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
  let totML = 0, totEnt = 0, totVar = 0, totFix = 0, totAds = 0, totRes = 0;
  let temDados = false;

  const dash = '<span style="color:#94a3b8">—</span>';
  for (const m of meses) {
    const isFuturo = m.mes > mesAtual;
    const temLocal = m.totalEntradas > 0 || m.totalGastosVar > 0 || m.totalFixos > 0;
    const cached   = cacheML[m.mes];
    if (isFuturo && !temLocal && !cached) continue;

    const lucroML  = cached ? cached.lucroML : null;
    const ads      = cached ? (cached.ads ?? 0) : 0;
    const resultado = lucroML !== null
      ? lucroML + m.totalEntradas - m.totalGastosVar - m.totalFixos - ads
      : null;
    const taxaML_b  = cached?.taxaML  ?? null;
    const frete_b   = cached?.frete   ?? null;
    const custo_b   = cached?.custo   ?? null;
    const imposto_b = cached?.imposto ?? null;

    totML  += lucroML ?? 0;
    totEnt += m.totalEntradas;
    totVar += m.totalGastosVar;
    totFix += m.totalFixos;
    totAds += ads;
    totRes += resultado ?? 0;
    temDados = true;

    const [y, mo] = m.mes.split('-');
    const nomeMes = `${NOMES_MES[parseInt(mo)-1]}/${y.slice(2)}`;
    const resCls  = resultado !== null ? (resultado >= 0 ? 'lucro-val-pos' : 'lucro-val-neg') : '';
    const mlCls   = lucroML   !== null ? (lucroML   >= 0 ? 'lucro-val-pos' : 'lucro-val-neg') : '';
    const semCache = !cached && !isFuturo;
    const titleAtualizar = cached
      ? `Atualizado em ${cached.updatedAt} — clique para buscar novamente`
      : 'Clique para buscar dados do ML para este mês';

    const taxaMes = (lucroConfig.taxa_imposto_por_mes || {})[m.mes];
    const taxaVal = taxaMes !== undefined ? taxaMes : '';

    const tr = document.createElement('tr');
    tr.id = `dre-row-${m.mes}`;
    tr.style.cursor = 'pointer';
    tr.setAttribute('onclick', `dreToggleExpand('${m.mes}')`);
    if (semCache) tr.style.color = '#94a3b8';
    tr.innerHTML = `
      <td style="white-space:nowrap;font-weight:500">
        <span id="dre-expand-icon-${m.mes}" style="display:inline-block;font-size:9px;margin-right:5px;color:#64748b">▶</span>${nomeMes}
      </td>
      <td class="col-num" onclick="event.stopPropagation()">
        <input type="number" class="lucro-custo-input dre-taxa-input" step="0.1" min="0" max="100"
          value="${taxaVal}" placeholder="—"
          onchange="dreSetTaxaMes(this, '${m.mes}')"
          title="Imposto sobre receita para ${nomeMes} (%)">
      </td>
      <td class="col-num ${mlCls}">${lucroML !== null ? lucroFmt(lucroML) : dash}</td>
      <td class="col-num lucro-val-pos">${m.totalEntradas > 0 ? '+' + lucroFmt(m.totalEntradas) : dash}</td>
      <td class="col-num lucro-val-neg">${m.totalGastosVar > 0 ? lucroFmt(m.totalGastosVar) : dash}</td>
      <td class="col-num lucro-val-neg">${m.totalFixos > 0 ? lucroFmt(m.totalFixos) : dash}</td>
      <td class="col-num lucro-val-neg">${ads > 0 ? lucroFmt(ads) : dash}</td>
      <td class="col-num ${resCls}"><strong>${resultado !== null ? lucroFmt(resultado) : dash}</strong></td>
      <td style="text-align:center">
        ${!isFuturo ? `<button id="dre-btn-${m.mes}" class="lucro-btn-lock" style="opacity:.5;font-size:13px"
          onclick="event.stopPropagation(); dreRefreshMes('${m.mes}')" title="${titleAtualizar}">↻</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);

    const trExp = document.createElement('tr');
    trExp.id = `dre-expand-${m.mes}`;
    trExp.style.display = 'none';
    trExp.innerHTML = `
      <td colspan="9" style="padding:0">
        <div style="padding:6px 16px 10px 32px;background:#f1f5f9;border-bottom:1px solid #e2e8f0">
          <table style="font-size:12px;border-collapse:collapse;color:#64748b">
            <tr><td style="padding:3px 48px 3px 0">Tarifas ML</td>
                <td class="col-num" style="color:#dc2626">${taxaML_b !== null ? lucroFmt(taxaML_b) : '<span style="color:#94a3b8">—</span>'}</td></tr>
            <tr><td style="padding:3px 48px 3px 0">Frete vendedor</td>
                <td class="col-num" style="color:#dc2626">${frete_b !== null ? lucroFmt(frete_b) : '<span style="color:#94a3b8">—</span>'}</td></tr>
            <tr><td style="padding:3px 48px 3px 0">Custo dos produtos</td>
                <td class="col-num" style="color:#dc2626">${custo_b !== null ? lucroFmt(custo_b) : '<span style="color:#94a3b8">—</span>'}</td></tr>
            <tr><td style="padding:3px 48px 3px 0">Imposto</td>
                <td class="col-num" style="color:#dc2626">${imposto_b !== null ? lucroFmt(imposto_b) : '<span style="color:#94a3b8">—</span>'}</td></tr>
          </table>
        </div>
      </td>
    `;
    tbody.appendChild(trExp);
  }

  if (!temDados) {
    if (vazio) { vazio.textContent = 'Nenhum dado no cache. Clique "↻ Atualizar tudo" para carregar.'; vazio.style.display = 'block'; }
    return;
  }

  // Linha de totais
  const totResCls = totRes >= 0 ? 'lucro-val-pos' : 'lucro-val-neg';
  const trTot = document.createElement('tr');
  trTot.style.cssText = 'border-top:2px solid #334155;font-weight:700';
  trTot.innerHTML = `
    <td>Total ${ano}</td>
    <td></td>
    <td class="col-num ${totML >= 0 ? 'lucro-val-pos' : 'lucro-val-neg'}">${lucroFmt(totML)}</td>
    <td class="col-num lucro-val-pos">${totEnt > 0 ? '+' + lucroFmt(totEnt) : '—'}</td>
    <td class="col-num lucro-val-neg">${totVar > 0 ? lucroFmt(totVar) : '—'}</td>
    <td class="col-num lucro-val-neg">${totFix > 0 ? lucroFmt(totFix) : '—'}</td>
    <td class="col-num lucro-val-neg">${totAds > 0 ? lucroFmt(totAds) : '—'}</td>
    <td class="col-num ${totResCls}">${lucroFmt(totRes)}</td>
    <td></td>
  `;
  tbody.appendChild(trTot);

  if (tabela) tabela.style.display = 'table';
}

function dreToggleExpand(mes) {
  const row  = document.getElementById(`dre-expand-${mes}`);
  const icon = document.getElementById(`dre-expand-icon-${mes}`);
  if (!row) return;
  const open = row.style.display !== 'none';
  row.style.display = open ? 'none' : '';
  if (icon) icon.textContent = open ? '▶' : '▼';
}

// ── Lucro mensal ─────────────────────────────────────────────
// Lucro das vendas do mês (ML + Shopee da conta ativa, mesma regra da sub-aba Vendas)
// − Ads (API do ML e da Shopee) − linhas de gasto livres, salvas por mês.
// O resultado das APIs fica salvo como snapshot no servidor pra abrir o mês na hora;
// mês atual (ou mês sem snapshot) busca de novo sozinho ao abrir.

let lmEstado = { conta: null, mes: null, linhas: [], snapshot: null, linhasMesAnterior: [], billing: null };
let lmVendasML = null;    // vendas ML (sem canceladas) da última busca — pra conferir com a fatura
let lmBillingTimer = null;
let lmGen = 0;            // descarta respostas de mês/conta que já não estão na tela
let lmSalvarTimer = null;

function lmMesAtualStr() {
  return lucroHoje().slice(0, 7);
}

function lmEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lmNovoId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function lmInit() {
  const mesEl = document.getElementById('lm-mes');
  if (mesEl && !mesEl.value) mesEl.value = lmMesAtualStr();
  lmCarregar();
}

function lmMudarMes(delta) {
  const mesEl = document.getElementById('lm-mes');
  const [a, m] = (mesEl.value || lmMesAtualStr()).split('-').map(Number);
  const d = new Date(a, m - 1 + delta, 1);
  mesEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  lmCarregar();
}

async function lmCarregar() {
  const mes   = document.getElementById('lm-mes')?.value || lmMesAtualStr();
  const conta = lucroContaAtual();
  const gen   = ++lmGen;
  lmEstado = { conta, mes, linhas: [], snapshot: null, linhasMesAnterior: [], billing: null };
  lmVendasML = null;
  lmStatus('');
  lmRenderizar();
  lmCarregarBilling();
  try {
    const d = await fetch(`/api/lucro/mensal?conta=${conta}&mes=${mes}`).then(r => r.json());
    if (gen !== lmGen) return;
    lmEstado.linhas            = d.linhas || [];
    lmEstado.snapshot          = d.snapshot || null;
    lmEstado.linhasMesAnterior = d.linhasMesAnterior || [];
  } catch {
    if (gen !== lmGen) return;
    lmStatus('Erro ao carregar o mês.', true);
  }
  lmRenderizar();
  if (mes <= lmMesAtualStr() && (!lmEstado.snapshot || mes === lmMesAtualStr())) lmAtualizarApis();
}

function lmStatus(texto, erro) {
  const el = document.getElementById('lm-status');
  if (!el) return;
  el.textContent = texto || '';
  el.style.color = erro ? '#dc2626' : '#64748b';
}

let lmBuscando = false;

async function lmAtualizarApis() {
  const { conta, mes } = lmEstado;
  if (!mes) return;
  if (mes > lmMesAtualStr()) { lmStatus('Mês futuro — sem vendas ainda.'); return; }
  const gen = lmGen;
  const btn = document.getElementById('btn-lm-atualizar');
  if (btn) btn.disabled = true;
  lmBuscando = true;
  lmStatus('Buscando vendas e Ads do mês… (pode levar alguns segundos)');
  try {
    // Custos e imposto precisam estar carregados pra calcular o lucro igual à sub-aba Vendas
    await Promise.all([lucroCarregarConfig(), lucroShopeeCarregarConfig()]);
    const { de, ate } = drePeriodoMes(mes);
    const qs = new URLSearchParams({ conta, date_from: de, date_to: ate });
    const pegar = url => fetch(url).then(r => r.json()).catch(e => ({ error: e.message || 'falha de conexão' }));
    const [vML, vSh, aML, aSh] = await Promise.all([
      pegar(`/api/lucro/vendas?${qs}`),
      pegar(`/api/lucro/vendas-shopee?${qs}`),
      pegar(`/api/lucro/gastos-auto?conta=${conta}&mes=${mes}&so_ads=1`),
      pegar(`/api/lucro/ads-shopee?conta=${conta}&mes=${mes}`),
    ]);
    if (gen !== lmGen) return;

    // Pedaço que falhou mantém o valor do snapshot anterior (não zera um número bom por erro de API)
    const snap = { ...(lmEstado.snapshot || {}) };
    const naoConectada = r => /não conectad/i.test(r.error || '');
    const erros = [];

    if (!vML.error) {
      const calc = lucroCalcular(vML.vendas || []).filter(v => !v.cancelado);
      lmVendasML = calc;
      const t = lucroTotais(calc);
      Object.assign(snap, { receitaML: t.receita, lucroML: t.lucro, pedidosML: calc.length });
    } else if (naoConectada(vML)) {
      Object.assign(snap, { receitaML: 0, lucroML: 0, pedidosML: 0 });
    } else erros.push('vendas ML');

    if (!vSh.error) {
      const calc = lucroShopeeCalcular(vSh.vendas || []).filter(v => !v.cancelado);
      const t = lucroShopeeTotais(calc);
      Object.assign(snap, { receitaShopee: t.receita, lucroShopee: t.lucro, pedidosShopee: calc.length });
    } else if (naoConectada(vSh)) {
      Object.assign(snap, { receitaShopee: 0, lucroShopee: 0, pedidosShopee: 0 });
    } else erros.push('vendas Shopee');

    if (!aML.error) snap.adsML = aML.ads_cost ?? 0;
    else if (naoConectada(aML)) snap.adsML = 0;
    else erros.push('Ads ML');

    if (!aSh.error) { snap.adsShopee = aSh.ads_cost ?? 0; snap.adsShopeeErro = null; }
    else if (naoConectada(aSh)) { snap.adsShopee = 0; snap.adsShopeeErro = null; }
    else snap.adsShopeeErro = aSh.error;

    snap.atualizadoEm = new Date().toISOString();
    lmEstado.snapshot = snap;
    lmBuscando = false;
    lmRenderizar();
    fetch('/api/lucro/mensal/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, mes, snapshot: snap }),
    }).catch(() => {});
    if (erros.length) lmStatus(`Falhou: ${erros.join(', ')} — mantido o último valor salvo. Tente de novo.`, true);
  } catch {
    if (gen === lmGen) lmStatus('Erro ao buscar vendas/Ads. Tente de novo.', true);
  } finally {
    lmBuscando = false;
    if (btn) btn.disabled = false;
  }
}

function lmTotais() {
  const s = lmEstado.snapshot || {};
  const receita     = (s.receitaML || 0) + (s.receitaShopee || 0);
  const lucroVendas = (s.lucroML || 0) + (s.lucroShopee || 0);
  const ads         = (s.adsML || 0) + (s.adsShopee || 0);
  const outrosML    = lmOutrosML().reduce((acc, t) => acc + t.total, 0);
  const gastos      = lmEstado.linhas.reduce((acc, l) => acc + (parseFloat(l.valor) || 0), 0) + outrosML;
  const liquido     = lucroVendas - ads - gastos;
  return { receita, lucroVendas, ads, gastos, liquido, margem: receita > 0 ? liquido / receita * 100 : null };
}

// Atualiza só os números (cards + linhas de total) — usado enquanto digita, sem
// redesenhar os inputs e perder o foco.
function lmAtualizarTotais() {
  const temSnap = !!lmEstado.snapshot;
  const t   = lmTotais();
  const cls = v => v >= 0 ? 'lucro-val-pos' : 'lucro-val-neg';
  const set = (id, txt, c) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = txt;
    if (c !== undefined) el.className = c;
  };
  set('lm-card-receita',  temSnap ? lucroFmt(t.receita) : '—');
  set('lm-card-vendas',   temSnap ? lucroFmt(t.lucroVendas) : '—', 'lucro-card-valor ' + (temSnap ? cls(t.lucroVendas) : ''));
  set('lm-card-gastos',   lucroFmt(t.ads + t.gastos));
  set('lm-card-liquido',  temSnap ? lucroFmt(t.liquido) : '—', 'lucro-card-valor ' + (temSnap ? cls(t.liquido) : ''));
  set('lm-card-margem',   temSnap && t.margem !== null ? `${t.margem.toFixed(1).replace('.', ',')}% do faturamento` : '');
  set('lm-total-gastos',  '− ' + lucroFmt(t.ads + t.gastos));
  set('lm-total-liquido', temSnap ? lucroFmt(t.liquido) : '—', 'col-num ' + (temSnap ? cls(t.liquido) : ''));
}

function lmRenderizar() {
  const corpo = document.getElementById('lm-corpo');
  if (!corpo) return;
  const s   = lmEstado.snapshot;
  const val = (v, sinal) => s ? `${sinal}${lucroFmt(v || 0)}` : '<span style="color:#94a3b8">—</span>';
  const sub = txt => `<div class="lm-sub">${txt}</div>`;
  const pedidos = (n, rec) => s ? sub(`${n || 0} pedido${n === 1 ? '' : 's'} · faturamento ${lucroFmt(rec || 0)}`) : '';
  const adsShopeeSub = s?.adsShopeeErro
    ? `<span style="color:#b45309" title="${lmEsc(s.adsShopeeErro)}">API da Shopee não liberou o Ads — lance como gasto abaixo</span>`
    : 'automático, pela API';

  let html = `
    <tr class="lm-secao"><td colspan="3">Vendas</td></tr>
    <tr><td>Lucro das vendas — Mercado Livre${pedidos(s?.pedidosML, s?.receitaML)}</td>
        <td class="col-num lucro-val-pos">${val(s?.lucroML, '')}</td><td></td></tr>
    <tr><td>Lucro das vendas — Shopee${pedidos(s?.pedidosShopee, s?.receitaShopee)}</td>
        <td class="col-num lucro-val-pos">${val(s?.lucroShopee, '')}</td><td></td></tr>
    <tr class="lm-secao"><td colspan="3">Ads</td></tr>
    <tr><td>Ads Mercado Livre${sub('automático, pela API')}</td>
        <td class="col-num lucro-val-neg">${val(s?.adsML, '− ')}</td><td></td></tr>
    <tr><td>Ads Shopee${sub(adsShopeeSub)}</td>
        <td class="col-num lucro-val-neg">${s?.adsShopeeErro ? '<span style="color:#94a3b8">—</span>' : val(s?.adsShopee, '− ')}</td><td></td></tr>
    ${lmHtmlOutrosML()}
    <tr class="lm-secao"><td colspan="3">Seus gastos</td></tr>`;

  lmEstado.linhas.forEach(l => {
    const id = lmEsc(l.id);
    html += `
    <tr data-lm-id="${id}">
      <td><input type="text" class="lm-input-desc" value="${lmEsc(l.descricao)}" placeholder="Descrição (ex: Aluguel, Embalagens)"
            oninput="lmEditar('${id}','descricao',this.value)" onchange="lmSalvarLinhas()"></td>
      <td class="col-num"><input type="number" step="0.01" class="lm-input-valor" value="${l.valor || ''}" placeholder="0,00"
            oninput="lmEditar('${id}','valor',this.value)" onchange="lmSalvarLinhas()"></td>
      <td style="text-align:center"><button class="lucro-btn-remover" onclick="lmRemoverLinha('${id}')" title="Remover">✕</button></td>
    </tr>`;
  });
  if (!lmEstado.linhas.length) {
    html += `<tr><td colspan="3" style="color:#94a3b8;font-size:13px">Nenhum gasto lançado neste mês.</td></tr>`;
  }

  html += `
    <tr class="lm-subtotal"><td>Total Ads + custos + gastos</td><td class="col-num lucro-val-neg" id="lm-total-gastos"></td><td></td></tr>
    <tr class="lm-total"><td>Lucro líquido do mês</td><td class="col-num" id="lm-total-liquido"></td><td></td></tr>`;
  corpo.innerHTML = html;

  const btnCopiar = document.getElementById('btn-lm-copiar');
  if (btnCopiar) btnCopiar.style.display = (!lmEstado.linhas.length && lmEstado.linhasMesAnterior.length) ? '' : 'none';

  if (s?.atualizadoEm && !lmBuscando) {
    const d = new Date(s.atualizadoEm);
    lmStatus(`Vendas e Ads atualizados em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
  }
  lmAtualizarTotais();
  lmRenderizarConferencia();
}

// ── Fatura do ML: "Outros custos do ML" + conferência ──
// O servidor lê a fatura 1x por dia (leva ~10min por período) e guarda só o resumo;
// aqui só consulta. Enquanto uma leitura estiver rodando, consulta de novo a cada 15s.

async function lmCarregarBilling() {
  clearTimeout(lmBillingTimer);
  const { conta, mes } = lmEstado;
  const gen = lmGen;
  try {
    const b = await fetch(`/api/lucro/billing-ml?conta=${conta}&mes=${mes}`).then(r => r.json());
    if (gen !== lmGen || b.error) return;
    lmEstado.billing = b;
    // Não redesenha a tabela com o cursor num campo de gasto (perderia o que está digitando)
    if (document.activeElement?.closest?.('#lm-corpo')) lmAtualizarTotais();
    else lmRenderizar();
    if (b.leitura?.rodando) {
      lmBillingTimer = setTimeout(() => {
        if (gen === lmGen && document.getElementById('lucro-aba-mensal')?.style.display !== 'none') lmCarregarBilling();
      }, 15000);
    }
  } catch {}
}

async function lmLerFaturaAgora() {
  try { await fetch('/api/lucro/billing-ml/atualizar', { method: 'POST' }); } catch {}
  lmCarregarBilling();
}

// Só o que não está no cálculo por venda (comissão/frete) nem no Ads
function lmOutrosML() {
  return (lmEstado.billing?.tipos || []).filter(t => t.grupo === 'outros' && Math.abs(t.total) >= 0.005);
}

function lmHtmlOutrosML() {
  const b = lmEstado.billing;
  const sub = txt => `<div class="lm-sub">${txt}</div>`;
  let h = `<tr class="lm-secao"><td colspan="3">Outros custos do ML — pela fatura</td></tr>`;
  if (!b) return h + `<tr><td colspan="3" style="color:#94a3b8;font-size:13px">Carregando…</td></tr>`;
  const l = b.leitura || {};
  const lendo = l.rodando
    ? `<span style="color:#2563eb">Lendo a fatura agora (conta ${lmEsc(l.conta || '…')}: ${l.lidos || 0}${l.total ? ' de ' + l.total : ''} cobranças) — pode levar vários minutos, a tela atualiza sozinha.</span>`
    : '';
  const btnLer = l.rodando ? ''
    : ` <button class="btn-secondary" onclick="lmLerFaturaAgora()" style="font-size:12px;padding:3px 10px;margin-left:6px">Ler fatura agora</button>`;
  const outros = lmOutrosML();
  if (!outros.length) {
    const msg = b.tem_dados ? 'Nenhum outro custo na fatura neste mês.'
      : b.atualizado_em ? 'A fatura lida não tem cobranças deste mês.'
      : 'A fatura do ML ainda não foi lida (é lida sozinha todo dia de madrugada).';
    return h + `<tr><td colspan="3" style="font-size:13px;color:#94a3b8">${msg}${btnLer}${lendo ? sub(lendo) : ''}</td></tr>`;
  }
  outros.forEach(t => {
    const valor = t.total >= 0 ? `− ${lucroFmt(t.total)}` : `+ ${lucroFmt(-t.total)}`;
    h += `<tr><td>${lmEsc(t.descricao || t.codigo)}${sub(`${t.quantidade} cobrança${t.quantidade === 1 ? '' : 's'} · código ${lmEsc(t.codigo)}`)}</td>
      <td class="col-num lucro-val-neg">${valor}</td><td></td></tr>`;
  });
  let rodape = '';
  if (b.atualizado_em) {
    const d = new Date(b.atualizado_em);
    rodape = `Fatura lida em ${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (!b.completo) rodape += ` · <span style="color:#b45309">parcial: faltam cobranças deste mês na leitura</span>`;
  h += `<tr><td colspan="3">${sub(rodape + btnLer)}${lendo ? sub(lendo) : ''}</td></tr>`;
  return h;
}

// Compara, pedido a pedido, comissão e frete que o sistema calcula (sub-aba Vendas)
// com o que o ML cobrou de fato na fatura. Só pedidos que estão nos dois lados.
function lmRenderizarConferencia() {
  const el = document.getElementById('lm-conferencia');
  if (!el) return;
  const b = lmEstado.billing;
  if (!b?.tem_dados) { el.style.display = 'none'; return; }
  if (!lmVendasML) {
    el.innerHTML = '<div class="lm-sub" style="font-size:13px">Pra conferir comissão e frete com a fatura do ML, clique em <strong>↻ Atualizar vendas e Ads</strong>.</div>';
    el.style.display = '';
    return;
  }
  const pedidosFatura = b.pedidos || {};
  let n = 0, semFatura = 0, sisC = 0, fatC = 0, sisF = 0, fatF = 0;
  const difs = [];
  for (const v of lmVendasML) {
    const p = pedidosFatura[String(v.orderId)];
    if (!p) { semFatura++; continue; }
    n++;
    sisC += v.taxaML; fatC += p.c;
    sisF += v.frete;  fatF += p.f;
    const dc = p.c - v.taxaML, df = p.f - v.frete;
    if (Math.abs(dc) + Math.abs(df) >= 1) difs.push({ v, p, dc, df });
  }
  if (!n) { el.style.display = 'none'; return; }
  difs.sort((a, c) => (Math.abs(c.dc) + Math.abs(c.df)) - (Math.abs(a.dc) + Math.abs(a.df)));

  const fmtDif = d => Math.abs(d) < 0.5
    ? '<span style="color:#16a34a">bate</span>'
    : `<span class="${d > 0 ? 'lucro-val-neg' : 'lucro-val-pos'}">${d > 0 ? 'ML cobrou ' + lucroFmt(d) + ' a mais' : 'ML cobrou ' + lucroFmt(-d) + ' a menos'}</span>`;
  let h = `<h2 style="margin:0 0 4px">Conferência com a fatura do ML</h2>
    <p class="card-desc" style="margin:0 0 10px">${n} pedido${n === 1 ? '' : 's'} do ML deste mês comparado${n === 1 ? '' : 's'} com o que o ML cobrou de fato${semFatura ? ` · ${semFatura} ainda não aparece${semFatura === 1 ? '' : 'm'} na fatura (normal para vendas dos últimos dias)` : ''}.</p>
    <table class="tabela lm-tabela">
      <thead><tr><th></th><th class="col-num">Sistema calcula</th><th class="col-num">Fatura do ML</th><th class="col-num">Diferença</th></tr></thead>
      <tbody>
        <tr><td>Comissão</td><td class="col-num">${lucroFmt(sisC)}</td><td class="col-num">${lucroFmt(fatC)}</td><td class="col-num">${fmtDif(fatC - sisC)}</td></tr>
        <tr><td>Frete</td><td class="col-num">${lucroFmt(sisF)}</td><td class="col-num">${lucroFmt(fatF)}</td><td class="col-num">${fmtDif(fatF - sisF)}</td></tr>
      </tbody>
    </table>`;
  if (difs.length) {
    h += `<div class="lm-sub" style="margin:12px 0 4px;font-size:12px">Pedidos com diferença (${difs.length}${difs.length > 15 ? ', mostrando os 15 maiores' : ''}). Comissão zerada na fatura costuma ser venda devolvida/reembolsada que o sistema ainda conta como venda.</div>
      <table class="tabela lm-tabela">
        <thead><tr><th>Pedido</th><th class="col-num">Comissão (sistema → fatura)</th><th class="col-num">Frete (sistema → fatura)</th></tr></thead><tbody>`;
    difs.slice(0, 15).forEach(({ v, p, dc, df }) => {
      const cel = (sis, fat, d) => Math.abs(d) < 0.5 ? `<span style="color:#94a3b8">${lucroFmt(sis)}</span>`
        : `${lucroFmt(sis)} → <strong class="${d > 0 ? 'lucro-val-neg' : 'lucro-val-pos'}">${lucroFmt(fat)}</strong>`;
      h += `<tr><td><span style="cursor:pointer" title="Copiar número do pedido" onclick="lucroCopiarPedido(this,'${v.orderId}')">#${v.orderId}</span></td>
        <td class="col-num">${cel(v.taxaML, p.c, dc)}</td><td class="col-num">${cel(v.frete, p.f, df)}</td></tr>`;
    });
    h += `</tbody></table>`;
  }
  el.innerHTML = h;
  el.style.display = '';
}

function lmEditar(id, campo, valor) {
  const l = lmEstado.linhas.find(x => x.id === id);
  if (!l) return;
  l[campo] = campo === 'valor' ? (parseFloat(String(valor).replace(',', '.')) || 0) : valor;
  lmAtualizarTotais();
}

function lmAdicionarLinha() {
  if (!lmEstado.mes) return;
  const id = lmNovoId();
  lmEstado.linhas.push({ id, descricao: '', valor: 0 });
  lmRenderizar();
  document.querySelector(`tr[data-lm-id="${id}"] .lm-input-desc`)?.focus();
}

function lmRemoverLinha(id) {
  const l = lmEstado.linhas.find(x => x.id === id);
  if (l && (l.descricao || l.valor) && !confirm(`Remover "${l.descricao || 'gasto'}"?`)) return;
  lmEstado.linhas = lmEstado.linhas.filter(x => x.id !== id);
  lmRenderizar();
  lmSalvarLinhas();
}

function lmCopiarMesAnterior() {
  lmEstado.linhas = lmEstado.linhasMesAnterior.map(l => ({ id: lmNovoId(), descricao: l.descricao, valor: l.valor }));
  lmRenderizar();
  lmSalvarLinhas();
}

// Debounce curto: vários "change" seguidos (tab entre campos) viram um save só
function lmSalvarLinhas() {
  clearTimeout(lmSalvarTimer);
  const { conta, mes } = lmEstado;
  const linhas   = lmEstado.linhas.map(l => ({ ...l }));
  const statusEl = document.getElementById('lm-salvar-status');
  if (statusEl) { statusEl.textContent = 'Salvando…'; statusEl.style.color = '#64748b'; }
  lmSalvarTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/lucro/mensal/linhas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conta, mes, linhas }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error);
      if (statusEl) {
        statusEl.textContent = 'Salvo ✓'; statusEl.style.color = '#16a34a';
        setTimeout(() => { if (statusEl.textContent === 'Salvo ✓') statusEl.textContent = ''; }, 2000);
      }
    } catch {
      if (statusEl) { statusEl.textContent = 'Erro ao salvar — tente de novo'; statusEl.style.color = '#dc2626'; }
    }
  }, 300);
}

document.addEventListener('contaMudou', () => {
  const aba = document.getElementById('lucro-aba-mensal');
  const tab = document.getElementById('tab-lucro');
  if (aba && aba.style.display !== 'none' && tab && tab.classList.contains('active')) lmCarregar();
});
