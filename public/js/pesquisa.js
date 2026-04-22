// ============================================================
// pesquisa.js — Pesquisa de mercado no Mercado Livre
// ============================================================

function pesquisaInit() {
  // foco no input ao abrir a aba
  setTimeout(() => document.getElementById('pesquisa-input')?.focus(), 100);
}

async function pesquisarML() {
  const input = document.getElementById('pesquisa-input');
  const q = input.value.trim();
  if (!q) { input.focus(); return; }

  const erro     = document.getElementById('pesquisa-erro');
  const loading  = document.getElementById('pesquisa-loading');
  const resultado= document.getElementById('pesquisa-resultado');
  const btn      = document.getElementById('btn-pesquisar');

  erro.style.display     = 'none';
  resultado.style.display= 'none';
  loading.style.display  = 'block';
  btn.disabled = true;
  btn.textContent = 'Buscando...';

  try {
    const d = await fetch(`/api/ml/pesquisa?q=${encodeURIComponent(q)}`).then(r => r.json());
    if (d.erro) throw new Error(d.erro);
    pesquisaRenderizar(d);
    resultado.style.display = 'block';
  } catch (err) {
    erro.textContent = `Erro: ${err.message}`;
    erro.style.display = 'block';
  } finally {
    loading.style.display = 'none';
    btn.disabled = false;
    btn.textContent = 'Pesquisar';
  }
}

function pesquisaRenderizar(d) {
  const { stats, produtos } = d;

  const fmt  = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtN = v => v.toLocaleString('pt-BR');

  // Stats
  document.getElementById('pesquisa-stats').innerHTML = `
    <div class="pesquisa-stat">
      <div class="pesquisa-stat-label">Anúncios encontrados</div>
      <div class="pesquisa-stat-valor">${fmtN(stats.total)}</div>
    </div>
    <div class="pesquisa-stat">
      <div class="pesquisa-stat-label">Preço médio (top 50)</div>
      <div class="pesquisa-stat-valor">${fmt(stats.precoMedio)}</div>
    </div>
    <div class="pesquisa-stat">
      <div class="pesquisa-stat-label">Menor preço</div>
      <div class="pesquisa-stat-valor">${fmt(stats.precoMin)}</div>
    </div>
    <div class="pesquisa-stat">
      <div class="pesquisa-stat-label">Maior preço</div>
      <div class="pesquisa-stat-valor">${fmt(stats.precoMax)}</div>
    </div>
    <div class="pesquisa-stat">
      <div class="pesquisa-stat-label">Total de vendas (top 50)</div>
      <div class="pesquisa-stat-valor">${fmtN(stats.totalVendas)}</div>
    </div>
  `;

  // Tabela
  const tbody = document.getElementById('tabela-pesquisa-body');
  tbody.innerHTML = produtos.map(p => {
    const envio = p.fulfillment
      ? '<span class="badge-full">Full</span>'
      : p.fretegratis
        ? '<span class="badge-gratis">Grátis</span>'
        : '—';
    const cond = p.condicao === 'new' ? 'Novo' : 'Usado';
    const thumb = p.thumb
      ? `<img src="${p.thumb}" alt="" style="width:48px;height:48px;object-fit:contain;border-radius:4px">`
      : '';
    return `
      <tr>
        <td class="col-num" style="color:#888;font-size:13px">${p.rank}</td>
        <td style="width:56px;padding:6px 8px">${thumb}</td>
        <td>
          <div style="font-size:13px;font-weight:500;max-width:340px;line-height:1.3">${p.titulo}</div>
          <div style="font-size:11px;color:#888;margin-top:2px">${cond} · estoque: ${fmtN(p.estoque)}</div>
        </td>
        <td class="col-num" style="font-weight:600;color:#111">${fmt(p.preco)}</td>
        <td class="col-num" style="font-weight:600;color:#16a34a">${fmtN(p.vendas)}</td>
        <td style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.vendedor}</td>
        <td>${envio}</td>
        <td><a href="${p.link}" target="_blank" class="pesquisa-link">Ver →</a></td>
      </tr>
    `;
  }).join('');
}
