// ── Promoções ML ──────────────────────────────────────────────

const PROMO_TIPO_LABEL = {
  DEAL:           'Deal do Dia',
  LIGHTNING_DEAL: 'Oferta Relâmpago',
  PRICE_DISCOUNT: 'Desconto de Preço',
  FREE_SHIPPING:  'Frete Grátis',
};

function promoFormatarData(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('pt-BR'); } catch { return d.slice(0, 10); }
}

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
        ? `Erro da API ML: ${d.erroApi}`
        : 'Nenhuma promoção disponível no momento para seus anúncios.';
      erroEl.innerHTML = msg
        + (d.rawRespostas ? `<details style="margin-top:8px;font-size:11px"><summary style="cursor:pointer">Ver resposta bruta da API</summary><pre style="overflow:auto;max-height:200px;background:#1e293b;padding:8px;border-radius:4px;color:#94a3b8">${JSON.stringify(d.rawRespostas, null, 2)}</pre></details>` : '');
      erroEl.style.color   = d.erroApi ? '#c00' : '#64748b';
      erroEl.style.display = 'block';
      return;
    }

    totalEl.textContent = `${totalItens} anúncio${totalItens !== 1 ? 's' : ''} elegível${totalItens !== 1 ? 'is' : ''}`;

    promocoes.forEach(promo => {
      if (!promo.itens.length) return;

      const tipoLabel = PROMO_TIPO_LABEL[promo.tipo] || promo.tipo;

      const section = document.createElement('div');
      section.style.cssText = 'margin-bottom:32px';

      // Cabeçalho da promoção
      section.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
          <h2 style="margin:0;font-size:16px;font-weight:600;color:#1e293b">${promo.nome}</h2>
          <span class="badge-deposito badge-ativo" style="font-size:11px">${tipoLabel}</span>
          <span style="font-size:12px;color:#94a3b8">${promoFormatarData(promo.inicio)} → ${promoFormatarData(promo.fim)}</span>
        </div>
        <table class="tabela" style="display:table">
          <thead>
            <tr>
              <th></th>
              <th>Anúncio</th>
              <th>SKU</th>
              <th class="col-num">Preço atual</th>
              <th class="col-num">Preço sugerido</th>
              <th class="col-num">Desconto</th>
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

        const desconto = item.descontoMin != null
          ? `${item.descontoMin}%${item.descontoMax != null && item.descontoMax !== item.descontoMin ? `–${item.descontoMax}%` : ''}`
          : '—';

        const statusHtml = item.participando
          ? `<span class="badge-deposito badge-ativo" style="font-size:11px">Participando</span>`
          : `<span class="badge-deposito" style="background:#f1f5f9;color:#64748b;font-size:11px">Elegível</span>`;

        const btnHtml = item.participando
          ? `<button class="btn-sm" disabled style="opacity:.5;cursor:default">✓ Inscrito</button>`
          : `<button class="btn-sm btn-primary" onclick="promoParticipar('${promo.id}','${item.mlb}',${item.precoSugerido ?? 'null'},this)">Participar</button>`;

        tr.innerHTML = `
          <td class="td-thumb">${imgHtml}</td>
          <td class="td-titulo" title="${item.titulo}">${item.permalink ? `<a class="link-anuncio" href="${item.permalink}" target="_blank">${item.titulo}</a>` : item.titulo}</td>
          <td class="td-sku">${item.sku}</td>
          <td class="col-num">${promoFormatarPreco(item.precoAtual)}</td>
          <td class="col-num">${promoFormatarPreco(item.precoSugerido)}</td>
          <td class="col-num" style="color:#7c3aed;font-weight:500">${desconto}</td>
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

async function promoParticipar(promotionId, mlb, precoSugerido, btn) {
  btn.disabled    = true;
  btn.textContent = '...';

  const body = { mlb, promotion_id: promotionId };
  if (precoSugerido != null) body.preco = precoSugerido;

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
      // Atualiza badge de status na mesma linha
      const td = btn.closest('tr')?.querySelector('td:nth-child(7)');
      if (td) td.innerHTML = `<span class="badge-deposito badge-ativo" style="font-size:11px">Participando</span>`;
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
