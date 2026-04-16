// ============================================================
// lucro.js — Cálculo de lucro por venda
// ============================================================

let lucroConfig       = { taxa_imposto: 0, frete_medio: 0, custos: {} };
let lucroVendasRaw    = []; // dados brutos da API (sem custos/imposto aplicados)
let lucroCarregado    = false; // evita recarregar ao trocar de aba sem trocar conta
let gastosLista       = []; // gastos carregados para o mês atual
let gastosVendasRaw   = []; // vendas do mês completo (exclusivo para aba Gastos)
let gastosAuto        = { ads_cost: null }; // detectados automaticamente

function lucroHoje() {
  const d = new Date();
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
  return document.querySelector('.conta-btn.active')?.dataset?.conta || '1';
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

function lucroFmtPct(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

// ── Config ───────────────────────────────────────────────────

async function lucroCarregarConfig() {
  const conta = lucroContaAtual();
  try {
    const cfg = await fetch(`/api/lucro/config?conta=${conta}`).then(r => r.json());
    lucroConfig = cfg;
    const tiEl = document.getElementById('lucro-taxa-imposto');
    if (tiEl) tiEl.value = cfg.taxa_imposto || 0;
    // Re-renderiza se já há vendas carregadas (ex: usuário volta para a aba)
    if (lucroVendasRaw.length) lucroRecalcularERenderizar();
  } catch {}
}

async function lucroSalvarConfig() {
  const conta        = lucroContaAtual();
  const taxa_imposto = parseFloat(document.getElementById('lucro-taxa-imposto').value) || 0;
  const btn = document.getElementById('btn-lucro-salvar-cfg');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  try {
    await fetch('/api/lucro/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, taxa_imposto }),
    });
    lucroConfig.taxa_imposto = taxa_imposto;
    lucroRecalcularERenderizar();
  } catch {}
  if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
}

// ── Custo por produto ─────────────────────────────────────────

async function lucroSalvarCusto(input) {
  const conta = lucroContaAtual();
  const sku   = input.dataset.sku;
  const custo = parseFloat(input.value.replace(',', '.')) || 0;
  if (!sku) return;
  input.style.borderColor = '#cbd5e1';
  try {
    await fetch('/api/lucro/custo', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, sku, custo }),
    });
    lucroConfig.custos[sku] = custo;
    lucroRecalcularERenderizar(); // reconstrói tabela de vendas com novo custo
    // Atualiza inputs com mesmo SKU em todas as tabelas (custos + vendas reconstruída)
    document.querySelectorAll(`.lucro-custo-input[data-sku="${sku}"]`).forEach(el => {
      el.value = custo || '';
    });
    input.style.borderColor = '#86efac';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
  } catch {
    input.style.borderColor = '#fca5a5'; // vermelho = erro
  }
}

// ── Cálculo ──────────────────────────────────────────────────

function lucroCalcular(raw) {
  const { taxa_imposto, custos } = lucroConfig;
  return raw.map(v => {
    const custo   = v.itens.reduce((s, i) => s + (custos[i.sku || i.mlb] || 0) * i.quantidade, 0);
    const frete   = v.freteReal ?? 0; // custo real de frete do vendedor (sender_cost da API)
    const imposto = v.receita * (taxa_imposto / 100);
    const lucro   = v.receita - v.taxaML - frete - custo - imposto;
    const margem  = v.receita > 0 ? (lucro / v.receita) * 100 : 0;
    return { ...v, custo, frete, imposto, lucro, margem };
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
  if (!lucroVendasRaw.length) return;
  const vendas = lucroCalcular(lucroVendasRaw);
  const total  = lucroTotais(vendas);
  lucroRenderizarCards(total, vendas.length);
  lucroRenderizarTabela(vendas);
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
    const custoSalvo = lucroConfig.custos[chave0] || 0;
    const margemCls  = v.margem >= 10 ? 'lucro-val-pos' : v.margem < 0 ? 'lucro-val-neg' : '';

    const tr = document.createElement('tr');
    const fmtCusto = (val) => val > 0 ? lucroFmt(val) : '—';
    tr.innerHTML = `
      <td class="lucro-td-data">${new Date(v.data).toLocaleDateString('pt-BR')}</td>
      <td class="td-titulo lucro-titulo-copy" onclick="lucroCopiarPedido(this, '${v.orderId}')" title="Clique para copiar o número do pedido">${item0.titulo || '—'}${multi ? `<span class="lucro-multi"> +${v.itens.length - 1}</span>` : ''}</td>
      <td class="lucro-td-mlb">${chave0 || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td class="col-num">${lucroFmt(v.receita)}</td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.taxaML)}</td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.frete)}</td>
      <td class="col-num">
        ${chave0
          ? `${custoSalvo > 0 ? `<span class="lucro-custo-total">${fmtCusto(custoSalvo * qtdTotal)}</span>` : ''}
             <input type="number" class="lucro-custo-input" data-sku="${chave0}"
              value="${custoSalvo || ''}" placeholder="unit."
              onchange="lucroSalvarCusto(this)" step="0.01" min="0">`
          : '—'}
      </td>
      <td class="col-num lucro-neg-leve">${fmtCusto(v.imposto)}</td>
      <td class="col-num ${margemCls}"><strong>${lucroFmt(v.lucro)}</strong></td>
      <td class="col-num ${margemCls}">${lucroFmtPct(v.margem)}</td>
    `;
    tbody.appendChild(tr);

    // Sub-linhas para itens adicionais
    for (let i = 1; i < v.itens.length; i++) {
      const item    = v.itens[i];
      const chaveI  = item.sku || item.mlb || '';
      const cSalvo2 = lucroConfig.custos[chaveI] || 0;
      const trSub   = document.createElement('tr');
      trSub.classList.add('lucro-sub-item');
      trSub.innerHTML = `
        <td></td>
        <td class="td-titulo" style="color:#94a3b8;font-size:12px">↳ ${item.titulo || chaveI}</td>
        <td class="lucro-td-mlb">${chaveI || '—'}</td>
        <td class="col-num">${item.quantidade}</td>
        <td class="col-num" style="color:#94a3b8">${lucroFmt(item.precoUnit * item.quantidade)}</td>
        <td></td><td></td>
        <td class="col-num">
          ${chaveI
            ? `${cSalvo2 > 0 ? `<span class="lucro-custo-total">${lucroFmt(cSalvo2 * item.quantidade)}</span>` : ''}
               <input type="number" class="lucro-custo-input" data-sku="${chaveI}"
                value="${cSalvo2 || ''}" placeholder="unit."
                onchange="lucroSalvarCusto(this)" step="0.01" min="0">`
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
    const d = await fetch('/api/ml/estoque').then(r => r.json());
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
          <input type="number" class="lucro-custo-input" data-sku="${item.sku}"
            value="${custoSalvo || ''}" placeholder="—"
            onchange="lucroSalvarCusto(this)" step="0.01" min="0">
        </td>
      `;
      tbody.appendChild(tr);
    });

    if (tabela) tabela.style.display = 'table';
  } catch {
    if (loading) loading.style.display = 'none';
  }
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
  lucroCarregarVendas();
}

function lucroSetPeriodoRapido(dias) {
  const hoje = lucroHoje();
  const ate  = document.getElementById('lucro-data-ate');
  const de   = document.getElementById('lucro-data-de');
  if (ate) ate.value = hoje;
  if (de)  de.value  = hoje; // "Hoje" = mesmo dia nos dois
  lucroCarregarVendas();
}

// ── Carregamento ──────────────────────────────────────────────

async function lucroCarregarVendas() {
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
    loading.style.display = 'none';
    erroEl.textContent = 'Erro ao carregar vendas.'; erroEl.style.display = 'block';
  }
  if (btn) btn.disabled = false;
}

// ── Sub-abas ──────────────────────────────────────────────────

function lucroAba(nome) {
  // Atualiza botões
  document.querySelectorAll('.lucro-subaba-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.trim().toLowerCase().startsWith(nome === 'vendas' ? 'ven' : nome === 'custos' ? 'cus' : 'gas'));
  });
  // Mostra/oculta abas
  document.getElementById('lucro-aba-vendas').style.display  = nome === 'vendas'  ? '' : 'none';
  document.getElementById('lucro-aba-custos').style.display  = nome === 'custos'  ? '' : 'none';
  document.getElementById('lucro-aba-gastos').style.display  = nome === 'gastos'  ? '' : 'none';
  // Carrega conteúdo sob demanda
  if (nome === 'custos') lucroCustosCarregar();
  if (nome === 'gastos') { gastosInitMes(); gastosCarregar(); gastosFixosCarregar(); gastosCarregarLucroMes(); gastosAutoCarregar(); }
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
  const conta   = lucroContaAtual();
  const { de, ate } = gastosPeriodoMes();
  const periodoEl   = document.getElementById('gastos-lucro-periodo');
  const resultadoEl = document.getElementById('gastos-resultado');
  if (periodoEl)   { periodoEl.textContent = '…'; periodoEl.className = 'lucro-card-valor'; }
  if (resultadoEl) { resultadoEl.textContent = '…'; resultadoEl.className = 'lucro-card-valor'; }
  try {
    const qs = new URLSearchParams({ conta, date_from: de, date_to: ate });
    const d  = await fetch(`/api/lucro/vendas?${qs}`).then(r => r.json());
    gastosVendasRaw = d.vendas || [];
  } catch {
    gastosVendasRaw = [];
  }
  gastosAtualizarCards();
}

// ── Gastos fixos ──────────────────────────────────────────────

let gastosFixosTipos   = [];
let gastosFixosValores = {};

async function gastosFixosCarregar() {
  const conta = lucroContaAtual();
  const mes   = gastosMesAtual();
  try {
    const d = await fetch(`/api/lucro/gastos-fixos?conta=${conta}&mes=${mes}`).then(r => r.json());
    gastosFixosTipos   = d.tipos   || [];
    gastosFixosValores = d.valores || {};
  } catch {
    gastosFixosTipos   = [];
    gastosFixosValores = {};
  }
  gastosFixosRenderizar();
}

function gastosFixosRenderizar() {
  const tbody = document.getElementById('tabela-gastos-fixos-body');
  const tabela = document.getElementById('tabela-gastos-fixos');
  const vazio  = document.getElementById('gastos-fixos-vazio');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!gastosFixosTipos.length) {
    if (tabela) tabela.style.display = 'none';
    if (vazio)  vazio.style.display  = 'block';
    gastosAtualizarCards();
    return;
  }
  if (vazio)  vazio.style.display  = 'none';
  if (tabela) tabela.style.display = 'table';

  gastosFixosTipos.forEach(nome => {
    const valor = gastosFixosValores[nome] ?? 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${nome}</td>
      <td class="col-num">
        <input type="number" step="0.01" min="0" value="${valor || ''}" placeholder="0,00"
          class="lucro-custo-input" style="width:110px"
          data-nome="${nome}"
          onchange="gastosFixoSalvarValor(this)">
      </td>
      <td style="text-align:center">
        <button class="lucro-btn-remover" onclick="gastosFixoRemoverTipo('${nome.replace(/'/g,"\\'")}')">✕</button>
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
  try {
    await fetch('/api/lucro/gastos-fixo-tipo', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, nome }),
    });
    gastosFixosTipos   = gastosFixosTipos.filter(t => t !== nome);
    delete gastosFixosValores[nome];
    gastosFixosRenderizar();
  } catch {}
}

async function gastosFixoSalvarValor(input) {
  const conta = lucroContaAtual();
  const mes   = gastosMesAtual();
  const nome  = input.dataset.nome;
  const valor = parseFloat(input.value.replace(',', '.')) || 0;
  input.style.borderColor = '#cbd5e1';
  try {
    await fetch('/api/lucro/gastos-fixo-valor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, mes, nome, valor }),
    });
    gastosFixosValores[nome] = valor;
    input.style.borderColor = '#86efac';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
  } catch {
    input.style.borderColor = '#fca5a5';
  }
  gastosAtualizarCards();
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
    gastosAuto.ads_cost  = d.ads_cost  ?? 0;
    gastosAuto.full_cost = d.full_cost ?? 0;
    if (adsEl)  adsEl.textContent  = gastosAuto.ads_cost  > 0 ? lucroFmt(gastosAuto.ads_cost)  : '—';
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
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${g.descricao || '—'}</td>
        <td class="col-num lucro-val-neg">${lucroFmt(g.valor)}</td>
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
  const totalManuais  = gastosLista.reduce((s, g) => s + g.valor, 0);
  const totalAuto     = (gastosAuto.ads_cost ?? 0);
  const totalFixos    = gastosFixosTipos.reduce((s, n) => s + (gastosFixosValores[n] ?? 0), 0);
  const totalGastos   = totalManuais + totalAuto + totalFixos;
  // Lucro do mês completo (buscado independentemente da aba Vendas)
  const vendas  = gastosVendasRaw.length ? lucroCalcular(gastosVendasRaw) : [];
  const totais  = vendas.length ? lucroTotais(vendas) : null;
  const lucroPeriodo = totais ? totais.lucro : null;

  const periodoEl   = document.getElementById('gastos-lucro-periodo');
  const totalEl     = document.getElementById('gastos-total');
  const resultadoEl = document.getElementById('gastos-resultado');
  const labelEl     = document.getElementById('gastos-label-periodo');

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
  if (totalEl) {
    totalEl.textContent = totalGastos > 0 ? lucroFmt(totalGastos) : '—';
  }
  if (resultadoEl) {
    if (lucroPeriodo !== null) {
      const resultado = lucroPeriodo - totalGastos;
      resultadoEl.textContent = lucroFmt(resultado);
      resultadoEl.className   = 'lucro-card-valor ' + (resultado >= 0 ? 'lucro-val-pos' : 'lucro-val-neg');
    } else {
      resultadoEl.textContent = '—';
      resultadoEl.className   = 'lucro-card-valor';
    }
  }
}

async function gastosAdicionar() {
  const conta      = lucroContaAtual();
  const mes        = gastosMesAtual();
  const descricao  = document.getElementById('gastos-descricao')?.value?.trim();
  const valorInput = document.getElementById('gastos-valor');
  const valor      = parseFloat(valorInput?.value?.replace(',', '.')) || 0;

  if (!descricao) { alert('Informe a descrição do gasto.'); return; }
  if (valor <= 0)  { alert('Informe um valor maior que zero.'); return; }

  try {
    const r = await fetch('/api/lucro/gasto', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, mes, descricao, valor }),
    }).then(r => r.json());
    if (r.ok) {
      gastosLista.push({ id: r.id, descricao, valor });
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
  if (!lucroCarregado) {
    await lucroCarregarVendas();
  }
  // Recarrega gastos e lucro do mês ao trocar o mês
  const mesEl = document.getElementById('gastos-mes');
  if (mesEl && !mesEl._listenerOk) {
    mesEl.addEventListener('change', () => { gastosCarregar(); gastosFixosCarregar(); gastosCarregarLucroMes(); gastosAutoCarregar(); });
    mesEl._listenerOk = true;
  }
}

// Recarrega quando conta muda e aba lucro está ativa
document.addEventListener('contaMudou', () => {
  const aba = document.getElementById('tab-lucro');
  if (aba && aba.classList.contains('active')) {
    lucroCarregado = false;
    lucroCarregarConfig().then(() => lucroCarregarVendas());
  }
});
