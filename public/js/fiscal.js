const AGENTE_URL = 'http://localhost:4001';

let fiscalGruposCache = [];

async function fiscalSincronizar() {
  const btn    = document.getElementById('btn-fiscal-sync');
  const status = document.getElementById('fiscal-status');
  const erroEl = document.getElementById('fiscal-agente-erro');

  btn.disabled = true;
  btn.textContent = '⏳ Sincronizando...';
  status.textContent = '';
  erroEl.style.display = 'none';

  try {
    const resp = await fetch(`${AGENTE_URL}/sync`, { method: 'GET', signal: AbortSignal.timeout(60000) });
    const d = await resp.json();
    if (d.ok) {
      status.textContent = `✅ ${d.novas ?? 0} notas novas importadas`;
      await fiscalCarregar();
    } else {
      status.textContent = `⚠️ ${d.erro || 'Erro ao sincronizar'}`;
    }
  } catch {
    erroEl.style.display = 'block';
    status.textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇️ Atualizar';
  }
}

function fiscalDataCorte(meses) {
  if (!meses) return null;
  const d = new Date();
  d.setMonth(d.getMonth() - meses);
  // Formato dtemi: YYYY.MM.DD
  return d.toISOString().slice(0, 10).replace(/-/g, '.');
}

function fiscalFiltrar() {
  const sel   = document.getElementById('fiscal-periodo');
  const meses = sel ? parseInt(sel.value) : 3;
  const corte = fiscalDataCorte(meses);
  const container = document.getElementById('fiscal-container');
  if (!fiscalGruposCache.length) return;

  const html = fiscalGruposCache.map(g => {
    const notasFiltradas = corte
      ? g.notas.filter(n => (n.dtemi || '') >= corte)
      : g.notas;
    if (!notasFiltradas.length) return '';
    return fiscalRenderGrupo({ ...g, notas: notasFiltradas });
  }).filter(Boolean).join('');

  container.innerHTML = html || '<p style="color:#888;font-size:14px">Nenhuma nota no período selecionado.</p>';
}

async function fiscalCarregar() {
  const container = document.getElementById('fiscal-container');
  if (!container) return;
  try {
    const grupos = await fetch('/api/fiscal/notas').then(r => r.json());
    fiscalGruposCache = grupos;
    if (!grupos.length) {
      container.innerHTML = '<p style="color:#888;font-size:14px">Nenhuma nota importada ainda. Clique em Atualizar para sincronizar.</p>';
      return;
    }
    fiscalFiltrar();
  } catch {
    container.innerHTML = '<p style="color:#c00;font-size:14px">Erro ao carregar notas.</p>';
  }
}

function fiscalRenderGrupo(g) {
  const cnpjFmt = (g.cnpj || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  const total   = g.notas.reduce((s, n) => s + parseFloat((n.valor || '0').replace(',', '.')), 0);
  const totalFmt = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const linhas = g.notas.map(n => {
    const data  = (n.dtemi || '').replace(/(\d{4})\.(\d{2})\.(\d{2})/, '$3/$2/$1');
    const valor = parseFloat((n.valor || '0').replace(',', '.'));
    const vFmt  = valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const chave   = n.chave ? `<span title="${n.chave}" style="cursor:pointer;color:#aaa;font-size:11px" onclick="navigator.clipboard.writeText('${n.chave}')">📋</span>` : '';
    const xmlCol  = n.temXml
      ? `<span title="XML baixado" style="background:#16a34a;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;cursor:default">XML</span>`
      : (n.chave
          ? `<button onclick="fiscalBaixarXml('${n.chave}', this)" style="background:none;border:1px solid #475569;color:#94a3b8;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer" title="Baixar XML da SEFAZ">📥</button>`
          : '');
    return `<tr>
      <td>${data}</td>
      <td>${n.num || '—'}-${n.serie || ''}</td>
      <td>${n.emitnome || '—'}</td>
      <td style="font-size:11px;color:#888">${(n.emitid || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')}</td>
      <td style="text-align:right;font-weight:600">${vFmt}</td>
      <td style="font-size:11px;color:#888;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${n.natoper || ''}">${n.natoper || '—'}</td>
      <td style="text-align:center">${xmlCol}</td>
      <td>${chave}</td>
    </tr>`;
  }).join('');

  return `
    <div style="margin-bottom:28px">
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:16px">${g.nome || g.cnpj}</h2>
        <span style="font-size:12px;color:#888">${cnpjFmt}</span>
        <span style="font-size:12px;color:#888">${g.notas.length} nota(s)</span>
        <span style="font-size:12px;font-weight:600;margin-left:auto">${totalFmt}</span>
      </div>
      <div class="tabela-container">
        <table class="tabela">
          <thead><tr>
            <th>Data</th><th>NF / Série</th><th>Fornecedor</th><th>CNPJ Forn.</th>
            <th style="text-align:right">Valor</th><th>Natureza</th><th style="text-align:center">XML</th><th></th>
          </tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>`;
}

async function fiscalBaixarXml(chave, btn) {
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const r = await fetch('/api/fiscal/baixar-xml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave }),
    }).then(r => r.json());
    if (r.ok) {
      btn.outerHTML = `<span title="XML baixado" style="background:#16a34a;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">XML</span>`;
    } else {
      btn.disabled = false;
      btn.textContent = '📥';
      alert('Erro ao baixar XML: ' + (r.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '📥';
    alert('Erro: ' + err.message);
  }
}

// Carrega ao entrar na aba
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'fiscal') fiscalCarregar();
    });
  });
});
