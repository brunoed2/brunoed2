// ── Log Anúncio ────────────────────────────────────────────────

function logAnuncioInit() {}

async function logAnuncioBuscar() {
  const input = document.getElementById('log-mlb-input');
  const mlb   = (input.value || '').trim().toUpperCase();
  if (!mlb) return;

  const resultDiv = document.getElementById('log-resultado');
  resultDiv.innerHTML = '<p style="color:#94a3b8;font-size:14px">Buscando...</p>';

  try {
    const resp = await fetch(`/api/ml/item-log/${mlb}`);
    const data = await resp.json();
    if (data.error) {
      resultDiv.innerHTML = `<p style="color:#e74c3c;font-size:14px">Erro: ${data.error}</p>`;
      return;
    }
    logAnuncioRenderizar(mlb, data);
  } catch {
    resultDiv.innerHTML = '<p style="color:#e74c3c;font-size:14px">Erro ao buscar dados.</p>';
  }
}

function logAnuncioRenderizar(mlb, { item, health, snapshots }) {
  const resultDiv = document.getElementById('log-resultado');

  const statusColor = { active: '#22c55e', paused: '#f59e0b', closed: '#ef4444', under_review: '#a78bfa' }[item.status] || '#94a3b8';

  const subStatusLabels = {
    out_of_stock:       'Sem estoque',
    payment_required:   'Pagamento pendente',
    suspended_by_user:  'Pausado pelo vendedor',
    under_review:       'Em revisão',
    deleted:            'Excluído',
  };

  const subList = item.sub_status || [];
  const subHtml = subList.length
    ? subList.map(s => `<span style="background:#fef3c7;color:#92400e;border-radius:4px;padding:2px 8px;font-size:12px">${subStatusLabels[s] || s}</span>`).join(' ')
    : '<span style="color:#64748b;font-size:13px">—</span>';

  // Health issues
  let healthHtml = '';
  if (health) {
    const issues = (health.issues || health.problems || []);
    if (issues.length) {
      const issueItems = issues.map(i => {
        const titulo = i.code || i.type || i.id || 'Problema';
        const descr  = i.description || i.message || i.detail || '';
        return `<div style="padding:8px 12px;background:#1e293b;border-radius:6px;margin-bottom:6px">
          <div style="font-weight:600;color:#fbbf24;font-size:13px">${titulo}</div>
          ${descr ? `<div style="color:#94a3b8;font-size:12px;margin-top:2px">${descr}</div>` : ''}
        </div>`;
      }).join('');
      healthHtml = `<div style="margin-bottom:24px">
        <h3 style="color:#f1f5f9;font-size:14px;font-weight:600;margin-bottom:10px">Problemas detectados</h3>
        ${issueItems}
      </div>`;
    } else {
      healthHtml = `<div style="margin-bottom:24px;color:#22c55e;font-size:13px">✓ Nenhum problema de saúde encontrado</div>`;
    }
  }

  // Snapshots table
  let histHtml = '';
  if (snapshots && snapshots.length) {
    const reversed = snapshots.slice().reverse();
    const rows = reversed.map((s, i) => {
      const prev    = reversed[i + 1];
      const changes = [];
      if (prev) {
        if (s.status !== prev.status)
          changes.push(`Status: <b>${prev.status}</b> → <b>${s.status}</b>`);
        if (JSON.stringify(s.sub_status) !== JSON.stringify(prev.sub_status))
          changes.push(`Sub-status: [${(prev.sub_status || []).join(', ') || '—'}] → [${(s.sub_status || []).join(', ') || '—'}]`);
        if (s.price !== prev.price)
          changes.push(`Preço: R$ ${prev.price?.toFixed(2)} → R$ ${s.price?.toFixed(2)}`);
        if (s.available_quantity !== prev.available_quantity)
          changes.push(`Estoque: ${prev.available_quantity} → ${s.available_quantity}`);
      }
      const changesHtml = changes.length
        ? changes.map(c => `<div style="font-size:12px;color:#fbbf24">${c}</div>`).join('')
        : `<div style="font-size:12px;color:#475569">${i === reversed.length - 1 ? 'Primeiro registro' : 'Sem alterações'}</div>`;

      const sc = { active: '#22c55e', paused: '#f59e0b', closed: '#ef4444' }[s.status] || '#94a3b8';
      const dt = new Date(s.ts).toLocaleString('pt-BR');
      return `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:8px 12px;color:#64748b;font-size:12px;white-space:nowrap">${dt}</td>
        <td style="padding:8px 12px"><span style="color:${sc};font-size:13px;font-weight:600">${s.status}</span></td>
        <td style="padding:8px 12px;font-size:13px;color:#e2e8f0">R$ ${s.price != null ? s.price.toFixed(2) : '—'}</td>
        <td style="padding:8px 12px;font-size:13px;color:#e2e8f0">${s.available_quantity ?? '—'}</td>
        <td style="padding:8px 12px">${changesHtml}</td>
      </tr>`;
    }).join('');

    histHtml = `<div>
      <h3 style="color:#f1f5f9;font-size:14px;font-weight:600;margin-bottom:10px">Histórico (${snapshots.length} registros)</h3>
      <div style="overflow-x:auto;border-radius:8px;border:1px solid #1e293b">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#1e293b">
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Data/Hora</th>
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Status</th>
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Preço</th>
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Estoque</th>
            <th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500">Alterações</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  const permaLink = item.permalink
    ? `<a href="${item.permalink}" target="_blank" rel="noopener" style="color:#3b82f6;font-size:12px">${item.id}</a>`
    : `<span style="color:#64748b;font-size:12px">${item.id}</span>`;

  resultDiv.innerHTML = `
    <div style="margin-bottom:20px">
      <div style="font-size:17px;font-weight:600;color:#f1f5f9;margin-bottom:4px">${item.title || mlb}</div>
      ${permaLink}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px">
      <div style="background:#1e293b;border-radius:8px;padding:12px">
        <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Status</div>
        <div style="font-size:16px;font-weight:700;color:${statusColor}">${item.status}</div>
      </div>
      <div style="background:#1e293b;border-radius:8px;padding:12px">
        <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Sub-status</div>
        <div style="margin-top:4px">${subHtml}</div>
      </div>
      <div style="background:#1e293b;border-radius:8px;padding:12px">
        <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Preço</div>
        <div style="font-size:16px;font-weight:700;color:#f1f5f9">R$ ${item.price != null ? item.price.toFixed(2) : '—'}</div>
      </div>
      <div style="background:#1e293b;border-radius:8px;padding:12px">
        <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Estoque</div>
        <div style="font-size:16px;font-weight:700;color:#f1f5f9">${item.available_quantity ?? '—'}</div>
      </div>
    </div>

    ${healthHtml}
    ${histHtml}
  `;
}
