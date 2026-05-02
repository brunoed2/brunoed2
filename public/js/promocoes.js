// ── Promoções ML ──────────────────────────────────────────────

const PROMO_TIPO_LABEL = {
  SMART:          'Oferta Inteligente',
  DOD:            'Oferta do Dia',
  DEAL:           'Deal do Dia',
  LIGHTNING_DEAL: 'Oferta Relâmpago',
  PRICE_DISCOUNT: 'Saia na Frente',
  FREE_SHIPPING:  'Frete Grátis',
};

function promoFormatarPreco(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Taxa ML estimada por tipo de anúncio (% sobre preço + R$6 fixo acima de R$79)
const TAXA_ML_PCT = {
  gold_special:  0.11,
  gold_pro:      0.16,
  gold_premium:  0.16,
  gold_extra:    0.09,
  gold:          0.11,
  silver:        0.06,
  bronze:        0.06,
  free:          0.00,
};
function promoTaxaML(preco, listingType) {
  const pct  = TAXA_ML_PCT[listingType] ?? 0.11;
  const fixo = preco >= 79 ? 6 : 0;
  return preco * pct + fixo;
}
function promoCalcMargem(preco, sku, listingType, lucroConfig) {
  if (!preco || preco <= 0 || !lucroConfig) return null;
  const custo   = lucroConfig.custos[sku] || 0;
  const taxaML  = promoTaxaML(preco, listingType);
  const freteSku = lucroConfig.frete_por_sku?.[sku];
  const frete   = freteSku != null ? freteSku : (lucroConfig.frete_medio || 0);
  const imposto = preco * ((lucroConfig.taxa_imposto || 0) / 100);
  const lucro   = preco - taxaML - frete - custo - imposto;
  return { pct: (lucro / preco) * 100, lucroR: lucro };
}
function promoFmtMargem(resultado) {
  if (resultado == null) return '—';
  const { pct, lucroR } = resultado;
  const cor = pct >= 10 ? '#16a34a' : pct >= 0 ? '#d97706' : '#dc2626';
  const pctStr  = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  const reaisStr = lucroR.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return `<span style="font-weight:600;color:${cor}">${pctStr}</span><br><span style="font-size:11px;color:${cor}">${reaisStr}</span>`;
}

async function carregarPromocoes() {
  const loadingEl = document.getElementById('promocoes-loading');
  const erroEl    = document.getElementById('promocoes-erro');
  const listaEl   = document.getElementById('promocoes-lista');
  const totalEl   = document.getElementById('promocoes-total');

  loadingEl.style.display = 'block';
  erroEl.style.display    = 'none';
  listaEl.innerHTML       = '';
  totalEl.textContent     = '';

  try {
    const d = await fetch('/api/ml/promocoes').then(r => r.json());
    loadingEl.style.display = 'none';

    if (d.error) {
      erroEl.textContent   = d.error;
      erroEl.style.display = 'block';
      return;
    }

    const itens       = d.itens       || [];
    const lucroConfig = d.lucroConfig || null;
    const totalPromos = itens.reduce((s, i) => s + i.promocoes.length, 0);

    if (!itens.length) {
      const msg = d.erroApi
        ? `Nenhuma promoção encontrada. Detalhe: ${d.erroApi}`
        : 'Nenhum anúncio com promoção disponível.';
      erroEl.innerHTML     = msg;
      erroEl.style.color   = d.erroApi ? '#c00' : '#64748b';
      erroEl.style.display = 'block';
      return;
    }

    totalEl.textContent = `${itens.length} anúncio${itens.length !== 1 ? 's' : ''} com promoção disponível (${totalPromos} oportunidade${totalPromos !== 1 ? 's' : ''})`;

    const table = document.createElement('table');
    table.className = 'tabela';
    table.style.display = 'table';
    table.innerHTML = `
      <thead>
        <tr>
          <th></th>
          <th>Anúncio</th>
          <th>SKU</th>
          <th class="col-num">Preço atual</th>
          <th>Promoção</th>
          <th>Tipo</th>
          <th class="col-num">Preço promo</th>
          <th class="col-num">% Seller</th>
          <th class="col-num">% Meli</th>
          <th class="col-num" title="Margem atual estimada (taxa ML, custo, frete médio e imposto)">Margem</th>
          <th class="col-num" title="Margem estimada se participar da promoção">c/ promo</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    listaEl.appendChild(table);

    itens.forEach((item, itemIdx) => {
      const n = item.promocoes.length;
      const FAIXA_TIPOS = new Set(['PRICE_DISCOUNT', 'DOD', 'DEAL']);
      const bgItem = itemIdx % 2 === 0 ? '#ffffff' : '#f8fafc';

      const imgHtml = item.thumbnail
        ? `<a href="${item.permalink || '#'}" target="_blank"><img src="${item.thumbnail}" class="venda-thumb" loading="lazy"></a>`
        : `<div class="venda-thumb-vazio"></div>`;

      const tituloHtml = item.permalink
        ? `<a class="link-anuncio" href="${item.permalink}" target="_blank">${item.titulo}</a>`
        : item.titulo;

      item.promocoes.forEach((promo, idx) => {
        const tr = document.createElement('tr');
        tr.style.background = bgItem;
        const isPD = FAIXA_TIPOS.has(promo.tipo);

        // Colunas fixas do item — só na primeira linha (rowspan)
        if (idx === 0) {
          const tdImg = document.createElement('td');
          tdImg.rowSpan = n;
          tdImg.className = 'td-thumb';
          tdImg.innerHTML = imgHtml;
          tr.appendChild(tdImg);

          const tdTit = document.createElement('td');
          tdTit.rowSpan = n;
          tdTit.className = 'td-titulo';
          tdTit.title = item.titulo;
          tdTit.innerHTML = tituloHtml;
          tr.appendChild(tdTit);

          const tdSku = document.createElement('td');
          tdSku.rowSpan = n;
          tdSku.className = 'td-sku';
          tdSku.textContent = item.sku;
          tr.appendChild(tdSku);

          const tdPreco = document.createElement('td');
          tdPreco.rowSpan = n;
          tdPreco.className = 'col-num';
          tdPreco.textContent = promoFormatarPreco(item.precoAtual);
          tr.appendChild(tdPreco);
        }

        // Nome da promoção
        const tdNome = document.createElement('td');
        tdNome.style.fontWeight = '500';
        tdNome.textContent = promo.nome;
        tr.appendChild(tdNome);

        // Tipo badge
        const tdTipo = document.createElement('td');
        tdTipo.innerHTML = `<span class="badge-deposito" style="background:${isPD ? '#f0fdf4' : '#eff6ff'};color:${isPD ? '#16a34a' : '#2563eb'};font-size:11px">${PROMO_TIPO_LABEL[promo.tipo] || promo.tipo}</span>`;
        tr.appendChild(tdTipo);

        // Preço promo
        const tdPrecoP = document.createElement('td');
        tdPrecoP.className = 'col-num';
        if (isPD && promo.descontoMin != null && promo.descontoMax != null) {
          const pMin = promoFormatarPreco(promo.precoOriginal ? promo.precoOriginal * (1 - promo.descontoMax / 100) : null);
          const pMax = promoFormatarPreco(promo.precoPromo);
          tdPrecoP.innerHTML = `<span style="font-size:11px;color:#64748b">${pMin !== '—' ? pMin + '–' : ''}${pMax}</span>`;
        } else {
          tdPrecoP.textContent = promoFormatarPreco(promo.precoPromo);
        }
        tr.appendChild(tdPrecoP);

        // % Seller
        const tdSeller = document.createElement('td');
        tdSeller.className = 'col-num';
        if (isPD && promo.descontoMin != null) {
          const range = promo.descontoMax != null && promo.descontoMax !== promo.descontoMin
            ? `${promo.descontoMin}%–${promo.descontoMax}%`
            : `${promo.descontoMin}%`;
          tdSeller.innerHTML = `<span style="color:#7c3aed;font-weight:500">${range}</span>`;
        } else if (promo.sellerPct != null) {
          tdSeller.innerHTML = `<span style="color:#7c3aed;font-weight:500">${promo.sellerPct}%</span>`;
        } else {
          tdSeller.textContent = '—';
        }
        tr.appendChild(tdSeller);

        // % Meli
        const tdMeli = document.createElement('td');
        tdMeli.className = 'col-num';
        tdMeli.innerHTML = promo.meliPct != null
          ? `<span style="color:#2563eb;font-weight:500">${promo.meliPct}%</span>`
          : '—';
        tr.appendChild(tdMeli);

        // Margem atual (rowspan = n, só na 1ª linha do item)
        if (idx === 0) {
          const mAtual   = promoCalcMargem(item.precoAtual, item.sku, item.listingType, lucroConfig);
          const tdMargem = document.createElement('td');
          tdMargem.className = 'col-num';
          tdMargem.rowSpan   = n;
          tdMargem.innerHTML = promoFmtMargem(mAtual);
          tr.appendChild(tdMargem);
        }

        // Margem com promoção (uma por linha)
        const mPromo    = promoCalcMargem(promo.precoPromo, item.sku, item.listingType, lucroConfig);
        const tdMargemP = document.createElement('td');
        tdMargemP.className = 'col-num';
        tdMargemP.innerHTML = promoFmtMargem(mPromo);
        tr.appendChild(tdMargemP);

        // Status
        const tdStatus = document.createElement('td');
        tdStatus.innerHTML = promo.participando
          ? `<span class="badge-deposito badge-ativo" style="font-size:11px">Ativa</span>`
          : `<span class="badge-deposito" style="background:#f1f5f9;color:#64748b;font-size:11px">Candidata</span>`;
        tr.appendChild(tdStatus);

        // Ação — qualquer tipo com promotion_id pode participar
        const tdAcao = document.createElement('td');
        if (promo.id) {
          if (promo.participando) {
            tdAcao.innerHTML = `<button class="btn-sm" disabled style="opacity:.5;cursor:default">✓ Inscrito</button>`;
          } else {
            const promoId  = promo.id;
            const mlb      = item.mlb;
            const precoArg = promo.precoPromo ?? null;
            tdAcao.innerHTML = `<button class="btn-sm btn-primary" onclick="promoParticipar('${promoId}','${mlb}',${precoArg},this)">Participar</button>`;
          }
        }
        tr.appendChild(tdAcao);

        // Borda inferior mais grossa na última linha de cada item
        if (idx === n - 1) tr.style.borderBottom = '3px solid #cbd5e1';

        tbody.appendChild(tr);
      });
    });

  } catch {
    loadingEl.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar promoções.';
    erroEl.style.color   = '#c00';
    erroEl.style.display = 'block';
  }
}

async function promoParticipar(promotionId, mlb, precoPromo, btn) {
  btn.disabled    = true;
  btn.textContent = '...';

  const body = { mlb, promotion_id: promotionId };
  if (precoPromo != null) body.preco = precoPromo;

  try {
    const d = await fetch('/api/ml/promocoes/participar', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }).then(r => r.json());

    if (d.error) {
      btn.textContent = '✗ Erro';
      btn.title       = d.error;
      btn.classList.add('btn-secondary');
      btn.classList.remove('btn-primary');
      setTimeout(() => {
        btn.textContent = 'Participar';
        btn.title       = '';
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-primary');
        btn.disabled    = false;
      }, 4000);
    } else {
      btn.textContent = '✓ Inscrito';
      btn.classList.remove('btn-primary');
      const td = btn.closest('tr')?.querySelector('td:nth-child(10)');
      if (td) td.innerHTML = `<span class="badge-deposito badge-ativo" style="font-size:11px">Ativa</span>`;
    }
  } catch {
    btn.textContent = '✗ Erro';
    setTimeout(() => { btn.textContent = 'Participar'; btn.disabled = false; }, 3000);
  }
}

// Carrega ao abrir a aba
document.addEventListener('DOMContentLoaded', () => {
  const observer = new MutationObserver(() => {
    const aba = document.getElementById('tab-promocoes');
    if (aba && aba.classList.contains('active')) {
      carregarPromocoes();
      observer.disconnect();
    }
  });
  const tab = document.getElementById('tab-promocoes');
  if (tab) observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
});
