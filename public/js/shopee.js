// ── Shopee ────────────────────────────────────────────────────

async function shopeeVerificarStatus() {
  const dot = document.getElementById('shopee-status-dot');
  const txt = document.getElementById('shopee-status-txt');
  if (!dot || !txt) return;
  try {
    const d = await fetch('/api/shopee/status').then(r => r.json());
    if (d.connected) {
      dot.className = 'dot dot-ok';
      txt.textContent = `Conectado — ${d.shop_name} (ID: ${d.shop_id})`;
    } else {
      dot.className = 'dot dot-erro';
      txt.textContent = d.error ? `Desconectado: ${d.error}` : 'Desconectado';
    }
  } catch {
    dot.className = 'dot dot-erro';
    txt.textContent = 'Erro ao verificar status';
  }
}

async function shopeeCarregarConfig() {
  try {
    const d = await fetch('/api/shopee/config').then(r => r.json());
    const elId = document.getElementById('shopee-partner-id');
    if (elId && d.partner_id) elId.value = d.partner_id;
  } catch {}
}

async function shopeeSalvarEConectar() {
  const partnerId  = document.getElementById('shopee-partner-id').value.trim();
  const partnerKey = document.getElementById('shopee-partner-key').value.trim();
  const msg        = document.getElementById('shopee-msg');

  if (!partnerId || !partnerKey) {
    msg.textContent  = 'Preencha Partner ID e Partner Key.';
    msg.className    = 'msg erro';
    msg.style.display = 'block';
    return;
  }

  msg.textContent   = 'Salvando...';
  msg.className     = 'msg';
  msg.style.display = 'block';

  try {
    await fetch('/api/shopee/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ partner_id: partnerId, partner_key: partnerKey }),
    });
    msg.textContent = 'Credenciais salvas. Redirecionando para autorização...';
    msg.className   = 'msg ok';
    setTimeout(() => { location.href = '/api/shopee/auth'; }, 1000);
  } catch {
    msg.textContent = 'Erro ao salvar.';
    msg.className   = 'msg erro';
  }
}
