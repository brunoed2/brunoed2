// ============================================================
// lucro.js — Cálculo de lucro por venda
// ============================================================

let lucroConfig    = { taxa_imposto: 0, frete_medio: 0, custos: {} };
let lucroVendasRaw = []; // dados brutos da API (sem custos/imposto aplicados)
let lucroPeriodo   = 30;
let lucroCarregado = false; // evita recarregar ao trocar de aba sem trocar conta

function lucroContaAtual() {
  return document.querySelector('.conta-btn.active')?.dataset?.conta || '1';
}

function lucroFmt(v) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
    const fmEl = document.getElementById('lucro-frete-medio');
    if (tiEl) tiEl.value = cfg.taxa_imposto || 0;
    if (fmEl) fmEl.value = cfg.frete_medio  || 0;
  } catch {}
}

async function lucroSalvarConfig() {
  const conta        = lucroContaAtual();
  const taxa_imposto = parseFloat(document.getElementById('lucro-taxa-imposto').value) || 0;
  const frete_medio  = parseFloat(document.getElementById('lucro-frete-medio').value)  || 0;
  const btn = document.getElementById('btn-lucro-salvar-cfg');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  try {
    await fetch('/api/lucro/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, taxa_imposto, frete_medio }),
    });
    lucroConfig.taxa_imposto = taxa_imposto;
    lucroConfig.frete_medio  = frete_medio;
    lucroRecalcularERenderizar();
  } catch {}
  if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
}

// ── Custo por produto ─────────────────────────────────────────

async function lucroSalvarCusto(input) {
  const conta = lucroContaAtual();
  const mlb   = input.dataset.mlb;
  const custo = parseFloat(input.value.replace(',', '.')) || 0;
  if (!mlb) return;
  input.style.borderColor = '#cbd5e1'; // neutro enquanto salva
  try {
    await fetch('/api/lucro/custo', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ conta, mlb, custo }),
    });
    lucroConfig.custos[mlb] = custo;
    // Atualiza todos os inputs com o mesmo MLB
    document.querySelectorAll(`.lucro-custo-input[data-mlb="${mlb}"]`).forEach(el => {
      el.value = custo || '';
    });
    lucroRecalcularERenderizar();
    input.style.borderColor = '#86efac'; // verde = salvo
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
  } catch {
    input.style.borderColor = '#fca5a5'; // vermelho = erro
  }
}

// ── Cálculo ──────────────────────────────────────────────────

function lucroCalcular(raw) {
  const { taxa_imposto, frete_medio, custos } = lucroConfig;
  return raw.map(v => {
    const custo   = v.itens.reduce((s, i) => s + (custos[i.mlb] || 0) * i.quantidade, 0);
    const frete   = frete_medio || 0;
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
  const from   = Date.now() - lucroPeriodo * 24 * 60 * 60 * 1000;
  const filtro = lucroVendasRaw.filter(v => new Date(v.data).getTime() >= from);
  const vendas = lucroCalcular(filtro);
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
  set('lucro-sum-taxaml',   lucroFmt(t.taxaML),  true);
  set('lucro-sum-frete',    lucroFmt(t.frete),   true);
  set('lucro-sum-custo',    lucroFmt(t.custo),   true);
  set('lucro-sum-imposto',  lucroFmt(t.imposto), true);
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
    const custoSalvo = lucroConfig.custos[item0.mlb] || 0;
    const margemCls  = v.margem >= 10 ? 'lucro-val-pos' : v.margem < 0 ? 'lucro-val-neg' : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="lucro-td-data">${new Date(v.data).toLocaleDateString('pt-BR')}</td>
      <td class="td-titulo">${item0.titulo || '—'}${multi ? `<span class="lucro-multi"> +${v.itens.length - 1}</span>` : ''}</td>
      <td class="lucro-td-mlb">${item0.mlb || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td class="col-num">${lucroFmt(v.receita)}</td>
      <td class="col-num lucro-neg-leve">-${lucroFmt(v.taxaML)}</td>
      <td class="col-num lucro-neg-leve">-${lucroFmt(v.frete)}</td>
      <td class="col-num">
        <input type="number" class="lucro-custo-input" data-mlb="${item0.mlb}"
          value="${custoSalvo || ''}" placeholder="—"
          onchange="lucroSalvarCusto(this)" step="0.01" min="0">
      </td>
      <td class="col-num lucro-neg-leve">-${lucroFmt(v.imposto)}</td>
      <td class="col-num ${margemCls}"><strong>${lucroFmt(v.lucro)}</strong></td>
      <td class="col-num ${margemCls}">${lucroFmtPct(v.margem)}</td>
    `;
    tbody.appendChild(tr);

    // Sub-linhas para itens adicionais (só MLB + custo)
    for (let i = 1; i < v.itens.length; i++) {
      const item    = v.itens[i];
      const cSalvo2 = lucroConfig.custos[item.mlb] || 0;
      const trSub   = document.createElement('tr');
      trSub.classList.add('lucro-sub-item');
      trSub.innerHTML = `
        <td></td>
        <td class="td-titulo" style="color:#94a3b8;font-size:12px">↳ ${item.titulo || item.mlb}</td>
        <td class="lucro-td-mlb">${item.mlb || '—'}</td>
        <td class="col-num">${item.quantidade}</td>
        <td class="col-num" style="color:#94a3b8">${lucroFmt(item.precoUnit * item.quantidade)}</td>
        <td></td><td></td>
        <td class="col-num">
          <input type="number" class="lucro-custo-input" data-mlb="${item.mlb}"
            value="${cSalvo2 || ''}" placeholder="—"
            onchange="lucroSalvarCusto(this)" step="0.01" min="0">
        </td>
        <td colspan="3"></td>
      `;
      tbody.appendChild(trSub);
    }
  });

  tabela.style.display = 'table';
}

// ── Período ───────────────────────────────────────────────────

function lucroSetPeriodo(dias) {
  lucroPeriodo = dias;
  document.querySelectorAll('[data-lucro-dias]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.lucroDias) === dias);
  });
  lucroRecalcularERenderizar();
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
    const d = await fetch(`/api/lucro/vendas?conta=${conta}`).then(r => r.json());
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

async function lucroInit() {
  await lucroCarregarConfig();
  if (!lucroCarregado) await lucroCarregarVendas();
}

// Recarrega quando conta muda e aba lucro está ativa
document.addEventListener('contaMudou', () => {
  const aba = document.getElementById('tab-lucro');
  if (aba && aba.classList.contains('active')) {
    lucroCarregado = false;
    lucroCarregarConfig().then(() => lucroCarregarVendas());
  }
});
