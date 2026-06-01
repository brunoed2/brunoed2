'use strict';

async function backupDownload() {
  const a = document.createElement('a');
  a.href = '/api/admin/backup';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function backupRestaurar() {
  const input = document.getElementById('backup-file-input');
  const status = document.getElementById('backup-restore-status');
  if (!input?.files?.length) { status.style.color = '#dc2626'; status.textContent = 'Selecione um arquivo .json primeiro.'; return; }
  if (!confirm('Isso vai substituir todos os dados atuais pelo arquivo selecionado. Tem certeza?')) return;
  status.style.color = '#64748b'; status.textContent = 'Restaurando…';
  try {
    const texto = await input.files[0].text();
    const dados = JSON.parse(texto);
    const r = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dados),
    });
    const d = await r.json();
    if (d.ok) { status.style.color = '#16a34a'; status.textContent = 'Restaurado com sucesso! Recarregue a página.'; }
    else { status.style.color = '#dc2626'; status.textContent = d.error || 'Erro ao restaurar.'; }
  } catch (e) { status.style.color = '#dc2626'; status.textContent = 'Arquivo inválido ou erro de rede.'; }
}

async function backupListarSnapshots() {
  const el = document.getElementById('backup-snapshots-lista');
  el.textContent = 'Buscando…';
  try {
    const d = await fetch('/api/admin/backup-snapshots').then(r => r.json());
    if (!d.snapshots?.length) { el.textContent = 'Nenhum snapshot disponível ainda.'; return; }
    el.innerHTML = d.snapshots.map(s => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e2e8f0">
        <span>${s.nome} <span style="color:#94a3b8;font-size:11px">(${s.tamanho})</span></span>
        <div style="display:flex;gap:6px">
          <a href="/api/admin/backup-snapshot/${encodeURIComponent(s.nome)}" download style="font-size:12px;color:#3b82f6">⬇️ Baixar</a>
          <button class="btn-secondary" style="font-size:11px;padding:2px 8px"
            onclick="backupRestaurarSnapshot('${s.nome}')">Restaurar</button>
        </div>
      </div>`).join('');
  } catch { el.textContent = 'Erro ao buscar snapshots.'; }
}

async function backupRestaurarSnapshot(nome) {
  if (!confirm(`Restaurar snapshot "${nome}"? Os dados atuais serão substituídos.`)) return;
  const el = document.getElementById('backup-snapshots-lista');
  try {
    const r = await fetch(`/api/admin/backup-snapshot-restore/${encodeURIComponent(nome)}`, { method: 'POST' });
    const d = await r.json();
    if (d.ok) alert('Restaurado! Recarregue a página para ver os dados.');
    else alert('Erro: ' + (d.error || 'desconhecido'));
  } catch { alert('Erro de rede.'); }
}
