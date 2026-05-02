// ── Promoções ML ──────────────────────────────────────────────

const PROMO_TIPO_LABEL = {
  SMART:         'Oferta Inteligente',
  PRICE_DISCOUNT: 'Desconto de Preço',
  DEAL:           'Deal do Dia',
  LIGHTNING_DEAL: 'Oferta Relâmpago',
  FREE_SHIPPING:  'Frete Grátis',
};

function promoFormatarPreco(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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

    const promocoes = d.promocoes || [];
    const totalItens = promocoes.reduce((s, p) => s + p.itens.length, 0);

    if (!promocoes.length || !totalItens) {
      const msg = d.erroApi
        ? `Nenhuma promoção encontrada. Detalhe: ${d.erroApi}`
        : 'Nenhuma promoção ativa ou disponível nos seus anúncios.';
      erroEl.innerHTML     = msg;
      erroEl.style.color   = d.erroApi ? '#c00' : '#64748b';
      erroEl.style.display = 'block';
      return;
    }

    totalEl.textContent = `${totalItens} anúncio${totalItens !== 1 ? 's' : ''} com promoção disponível`;

    promocoes.forEach(promo => {
      if (!promo.itens.length) return;

      const tipoLabel = PROMO_TIPO_LABEL[promo.tipo] || promo.tipo;
      const isPriceDiscount = promo.tipo === 'PRICE_DISCOUNT';

      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom:32px';

      section.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <h2 style="margin:0;font-size:16px;font-weight:600;color:#1e293b">${promo.nome || tipoLabel}</h2>
          <span class="badge-deposito badge-ativo" style="font-size:11px">${tipoLabel}</span>
        </div>
        <table class="tabela" style="display:table">
          <thead>
            <tr>
              <th></th>
              <th>Anúncio</th>
              <th>SKU</th>
              <th class="col-num">Preço atual</th>
              <th class="col-num">${isPriceDiscount ? 'Faixa de preço' : 'Preço promo'}</th>
              <th class="col-num">% Seller</th>
              <th class="col-num">% Meli</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="promo-body-${promo.id}"></tbody>
        </table>
      `;
      listaEl.appendChild(section);

      const tbody = document.getElementById(`promo-body-${promo.id}`);

      promo.itens.forEach(item => {
        const tr = document.createElement('tr');

        const imgHtml = item.thumbnail
          ? `<a href="${item.permalink || '#'}" target="_blank"><img src="${item.thumbnail}" class="venda-thumb" loading="lazy"></a>`
          : `<div class="venda-thumb-vazio"></div>`;

        const tituloHtml = item.permalink
          ? `<a class="link-anuncio" href="${item.permalink}" target="_blank">${item.titulo}</a>`
          : item.titulo;

        // Coluna "Preço promo" ou "Faixa de preço"
        let precoPromoHtml;
        if (isPriceDiscount) {
          const pMin = promoFormatarPreco(item.precoOriginal ? (item.descontoMax != null ? item.precoOriginal * (1 - item.descontoMax / 100) : null) : null);
          const pMax = promoFormatarPreco(item.precoPromo);
          precoPromoHtml = pMax !== '—' ? `<span style="font-size:11px;color:#64748b">${pMin !== '—' ? pMin + '–' : ''}${pMax}</span>` : '—';
        } else {
          precoPromoHtml = promoFormatarPreco(item.precoPromo);
        }

        // Coluna % Seller
        let sellerHtml;
        if (isPriceDiscount) {
          if (item.descontoMin != null && item.descontoMax != null && item.descontoMax !== item.descontoMin) {
            sellerHtml = `<span style="color:#7c3aed;font-weight:500">${item.descontoMin}%–${item.descontoMax}%</span>`;
          } else if (item.descontoMin != null) {
            sellerHtml = `<span style="color:#7c3aed;font-weight:500">${item.descontoMin}%</span>`;
          } else {
            sellerHtml = '—';
          }
        } else {
          sellerHtml = item.sellerPct != null
            ? `<span style="color:#7c3aed;font-weight:500">${item.sellerPct}%</span>`
            : '—';
        }

        // Coluna % Meli
        const meliHtml = item.meliPct != null
          ? `<span style="color:#2563eb;font-weight:500">${item.meliPct}%</span>`
          : '—';

        // Badge de status
        const statusHtml = item.participando
          ? `<span class="badge-deposito badge-ativo" style="font-size:11px">Ativa</span>`
          : `<span class="badge-deposito" style="background:#f1f5f9;color:#64748b;font-size:11px">Candidata</span>`;

        // Botão de ação — só para SMART com promotion_id
        let btnHtml = '';
        if (!isPriceDiscount) {
          btnHtml = item.participando
            ? `<button class="btn-sm" disabled style="opacity:.5;cursor:default">✓ Inscrito</button>`
            : `<button class="btn-sm btn-primary" onclick="promoParticipar('${promo.id}','${item.mlb}',${item.precoPromo ?? 'null'},this)">Participar</button>`;
        }

        tr.innerHTML = `
          <td class="td-thumb">${imgHtml}</td>
          <td class="td-titulo" title="${item.titulo}">${tituloHtml}</td>
          <td class="td-sku">${item.sku}</td>
          <td class="col-num">${promoFormatarPreco(item.precoAtual)}</td>
          <td class="col-num">${precoPromoHtml}</td>
          <td class="col-num">${sellerHtml}</td>
          <td class="col-num">${meliHtml}</td>
          <td>${statusHtml}</td>
          <td>${btnHtml}</td>
        `;
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
      const td = btn.closest('tr')?.querySelector('td:nth-child(8)');
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
