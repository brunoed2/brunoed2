// ============================================================
// lucro.js — Cálculo de lucro por venda
// ============================================================

let lucroConfig       = { taxa_imposto: 0, taxa_imposto_por_mes: {}, frete_medio: 0, custos: {} };
let lucroVendasRaw    = []; // dados brutos da API (sem custos/imposto aplicados)
let lucroCarregado    = false; // evita recarregar ao trocar de aba sem trocar conta
let gastosLista       = []; // gastos carregados para o mês atual
let gastosVendasRaw   = []; // vendas do mês completo (exclusivo para aba Gastos)
let gastosAuto        = { ads_cost: null }; // detectados automaticamente
let gastosFixosTravados = new Set(); // nomes dos fixos com cadeado ativo

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
  const gen   = contaGen;
  const conta = lucroContaAtual();
  try {
    const cfg = await fetch(`/api/lucro/config?conta=${conta}`).then(r => r.json());
    if (contaGen !== gen) return; // resposta de conta antiga — descarta
    lucroConfig = { taxa_imposto: 0, taxa_imposto_por_mes: {}, frete_medio: 0, custos: {}, ...cfg };
    if (lucroVendasRaw.length) lucroRecalcularERenderizar();
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
    if (lucroVendasRaw.length) lucroRecalcularERenderizar();
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
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    await fetch('/api/lucro/custo', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, sku, custo }),
    });
    lucroConfig.custos[sku] = custo;
    lucroRecalcularERenderizar();
    document.querySelectorAll(`.lucro-custo-input[data-sku="${sku}"]`).forEach(el => {
      el.value = custo || '';
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

// ── Cálculo ──────────────────────────────────────────────────

function lucroCalcular(raw) {
  const { taxa_imposto = 0, taxa_imposto_por_mes = {}, custos } = lucroConfig;
  return raw.map(v => {
    const mes     = (v.data || '').slice(0, 7);
    const taxa    = mes in taxa_imposto_por_mes ? taxa_imposto_por_mes[mes] : taxa_imposto;
    const custo   = v.itens.reduce((s, i) => s + (custos[i.sku || i.mlb] || 0) * i.quantidade, 0);
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
      <td class="lucro-td-pedido" onclick="lucroCopiarPedido(this, '${v.orderId}')" title="Clique para copiar">${v.orderId || '—'}</td>
      <td class="td-titulo">${item0.titulo || '—'}${multi ? `<span class="lucro-multi"> +${v.itens.length - 1}</span>` : ''}</td>
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
      const cSalvo2 = lucroConfig.custos[chaveI] || 0;
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
               <input type="number" class="lucro-custo-input" data-sku="${chaveI}"
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
            step="0.01" min="0">
          <button class="lucro-ok-btn" data-sku="${item.sku}"
            onclick="lucroSalvarCusto(this.previousElementSibling, this)">OK</button>
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

// ── Sub-abas ──────────────────────────────────────────────────

function lucroAba(nome) {
  document.querySelectorAll('.lucro-subaba-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.aba === nome);
  });
  ['vendas', 'custos', 'gastos', 'dre'].forEach(a => {
    const el = document.getElementById(`lucro-aba-${a}`);
    if (el) el.style.display = a === nome ? '' : 'none';
  });
  if (nome === 'custos') lucroCustosCarregar();
  if (nome === 'gastos') { gastosInitMes(); gastosAtualizarTudo(); }
  if (nome === 'dre')    dreInit();
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

let gastosFixosTipos   = [];
let gastosFixosValores = {};

async function gastosFixosCarregar() {
  const conta = lucroContaAtual();
  const mes   = gastosMesAtual();
  try {
    const d = await fetch(`/api/lucro/gastos-fixos?conta=${conta}&mes=${mes}`).then(r => r.json());
    gastosFixosTipos    = d.tipos    || [];
    gastosFixosValores  = d.valores  || {};
    gastosFixosTravados = new Set(d.travados || []);
  } catch {
    gastosFixosTipos    = [];
    gastosFixosValores  = {};
    gastosFixosTravados = new Set();
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

  if (!gastosFixosTipos.length) {
    if (tabela)     tabela.style.display     = 'none';
    if (vazio)      vazio.style.display      = 'block';
    if (salvarWrap) salvarWrap.style.display = 'none';
    gastosAtualizarCards();
    return;
  }
  if (vazio)      vazio.style.display      = 'none';
  if (tabela)     tabela.style.display     = 'table';
  if (salvarWrap) salvarWrap.style.display = 'flex';

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
  const vendas  = gastosVendasRaw.length ? lucroCalcular(gastosVendasRaw) : [];
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
  if (!lucroCarregado) {
    await lucroCarregarVendas();
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
    lucroCarregarConfig().then(() => lucroCarregarVendas());
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
        const calc    = vendas.length ? lucroCalcular(vendas) : [];
        const totais  = calc.length  ? lucroTotais(calc)     : null;
        const lucroML = totais ? totais.lucro   : null;
        const taxaML  = totais ? totais.taxaML  : null;
        const frete   = totais ? totais.frete   : null;
        const custo   = totais ? totais.custo   : null;
        const imposto = totais ? totais.imposto : null;
        const ads     = adsResp.ads_cost ?? 0;
        await fetch('/api/lucro/dre-cache-mes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conta, mes: m.mes, lucroML, taxaML, frete, custo, imposto, ads }),
        }).catch(() => {});
      } catch {}
      // Atualiza a tabela a cada mês para mostrar progresso visual
      dreCarregarDoCache();
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
    await fetch('/api/lucro/dre-cache-mes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta, mes, lucroML, taxaML, frete, custo, imposto, ads }),
    });
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
        <div style="padding:6px 16px 10px 32px;background:#0f1117;border-bottom:1px solid #1e2130">
          <table style="font-size:12px;border-collapse:collapse;color:#94a3b8">
            <tr><td style="padding:3px 48px 3px 0">Tarifas ML</td>
                <td class="col-num" style="color:#fca5a5">${taxaML_b !== null ? lucroFmt(taxaML_b) : dash}</td></tr>
            <tr><td style="padding:3px 48px 3px 0">Frete vendedor</td>
                <td class="col-num" style="color:#fca5a5">${frete_b !== null ? lucroFmt(frete_b) : dash}</td></tr>
            <tr><td style="padding:3px 48px 3px 0">Custo dos produtos</td>
                <td class="col-num" style="color:#fca5a5">${custo_b !== null ? lucroFmt(custo_b) : dash}</td></tr>
            <tr><td style="padding:3px 48px 3px 0">Imposto</td>
                <td class="col-num" style="color:#fca5a5">${imposto_b !== null ? lucroFmt(imposto_b) : dash}</td></tr>
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
