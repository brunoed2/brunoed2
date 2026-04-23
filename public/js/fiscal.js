const AGENTE_URL = 'http://localhost:4001';

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

async function fiscalCarregar() {
  const container = document.getElementById('fiscal-container');
  if (!container) return;
  try {
    const grupos = await fetch('/api/fiscal/notas').then(r => r.json());
    if (!grupos.length) {
      container.innerHTML = '<p style="color:#888;font-size:14px">Nenhuma nota importada ainda. Clique em Atualizar para sincronizar.</p>';
      return;
    }
    container.innerHTML = grupos.map(g => fiscalRenderGrupo(g)).join('');
  } catch {
    container.innerHTML = '<p style="color:#c00;font-size:14px">Erro ao carregar notas.</p>';
  }
}

function fiscalRenderGrupo(g) {
  const cnpjFmt = (g.cnpj || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  const linhas  = g.notas.map(n => {
    const data  = (n.dtemi || '').replace(/(\d{4})\.(\d{2})\.(\d{2})/, '$3/$2/$1');
    const valor = parseFloat((n.valor || '0').replace(',', '.'));
    const vFmt  = valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const chave = n.chave ? `<span title="${n.chave}" style="cursor:pointer;color:#aaa;font-size:11px" onclick="navigator.clipboard.writeText('${n.chave}')">📋</span>` : '';
    return `<tr>
      <td>${data}</td>
      <td>${n.num || '—'}-${n.serie || ''}</td>
      <td>${n.emitnome || '—'}</td>
      <td style="font-size:11px;color:#888">${(n.emitid || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')}</td>
      <td style="text-align:right;font-weight:600">${vFmt}</td>
      <td style="font-size:11px;color:#888;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${n.natoper || ''}">${n.natoper || '—'}</td>
      <td>${chave}</td>
    </tr>`;
  }).join('');

  return `
    <div style="margin-bottom:28px">
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">
        <h2 style="margin:0;font-size:16px">${g.nome || g.cnpj}</h2>
        <span style="font-size:12px;color:#888">${cnpjFmt}</span>
        <span style="font-size:12px;color:#888;margin-left:auto">${g.notas.length} nota(s)</span>
      </div>
      <div class="tabela-container">
        <table class="tabela">
          <thead><tr>
            <th>Data</th><th>NF / Série</th><th>Fornecedor</th><th>CNPJ Forn.</th>
            <th style="text-align:right">Valor</th><th>Natureza</th><th></th>
          </tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>`;
}

// Carrega ao entrar na aba
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'fiscal') fiscalCarregar();
    });
  });
});
