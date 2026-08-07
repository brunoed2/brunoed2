// ── Shopee ────────────────────────────────────────────────────

let shopeeCfgContaAtual = '1';

function shopeeAbrirConfigConta(num) {
  shopeeCfgContaAtual = num;
  const tab1 = document.getElementById('shopee-cfg-tab-1');
  const tab2 = document.getElementById('shopee-cfg-tab-2');
  if (tab1) tab1.className = num === '1' ? 'btn-primary' : 'btn-secondary';
  if (tab2) tab2.className = num === '2' ? 'btn-primary' : 'btn-secondary';
  const titulo = document.getElementById('shopee-cfg-titulo');
  if (titulo) titulo.textContent = `Credenciais — Conta ${num}`;
  const cbUrl = document.getElementById('shopee-callback-url');
  if (cbUrl) cbUrl.textContent = `${location.origin}/api/shopee/callback?conta=${num}`;
  shopeeCarregarConfig();
  shopeeVerificarStatus();
  shopeeBoostCarregar();
}

async function shopeeVerificarStatus() {
  const dot = document.getElementById('shopee-status-dot');
  const txt = document.getElementById('shopee-status-txt');
  if (!dot || !txt) return;
  try {
    const d = await fetch(`/api/shopee/status?conta=${shopeeCfgContaAtual}`).then(r => r.json());
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
    const d = await fetch(`/api/shopee/config?conta=${shopeeCfgContaAtual}`).then(r => r.json());
    const elId  = document.getElementById('shopee-partner-id');
    const elKey = document.getElementById('shopee-partner-key');
    if (elId)  elId.value  = d.partner_id || '';
    if (elKey) elKey.value = '';
  } catch {}
}

async function shopeeSalvarEConectar() {
  const partnerId  = document.getElementById('shopee-partner-id').value.trim();
  const partnerKey = document.getElementById('shopee-partner-key').value.trim();
  const msg        = document.getElementById('shopee-msg');
  const conta      = shopeeCfgContaAtual;

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
      body:    JSON.stringify({ partner_id: partnerId, partner_key: partnerKey, conta }),
    });
    msg.textContent = 'Credenciais salvas. Redirecionando para autorização...';
    msg.className   = 'msg ok';
    setTimeout(() => { location.href = `/api/shopee/auth?conta=${conta}`; }, 1000);
  } catch {
    msg.textContent = 'Erro ao salvar.';
    msg.className   = 'msg erro';
  }
}

// ── Impulso automático — ordem de prioridade ────────────────────

let shopeeBoostItens = [];

function shopeeBoostFmtCooldown(seg) {
  if (seg === null || seg === undefined) return 'livre agora';
  if (seg <= 0) return 'livre agora';
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}min restantes`;
}

async function shopeeBoostCarregar() {
  const loading = document.getElementById('shopee-boost-loading');
  const erroEl  = document.getElementById('shopee-boost-erro');
  const lista   = document.getElementById('shopee-boost-lista');
  if (loading) loading.style.display = 'block';
  if (erroEl)  erroEl.style.display  = 'none';
  if (lista)   lista.innerHTML       = '';

  try {
    const d = await fetch(`/api/shopee/boost-config?conta=${shopeeCfgContaAtual}`).then(r => r.json());
    if (loading) loading.style.display = 'none';
    if (d.error) {
      if (erroEl) { erroEl.textContent = d.error; erroEl.style.display = 'block'; }
      return;
    }
    shopeeBoostItens = d.itens || [];
    shopeeBoostRenderizar();
  } catch {
    if (loading) loading.style.display = 'none';
    if (erroEl) { erroEl.textContent = 'Erro ao carregar produtos.'; erroEl.style.display = 'block'; }
  }
}

function shopeeBoostRenderizar() {
  const lista = document.getElementById('shopee-boost-lista');
  if (!lista) return;
  if (!shopeeBoostItens.length) {
    lista.innerHTML = '<p style="color:#94a3b8;font-size:13px">Nenhum produto ativo encontrado.</p>';
    return;
  }
  lista.innerHTML = shopeeBoostItens.map((it, idx) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f5f9">
      <span style="color:#94a3b8;font-size:12px;width:22px;text-align:right">${idx + 1}º</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(it.nome)}</div>
        <div style="font-size:11px;color:${it.cooldown_segundos > 0 ? '#f59e0b' : '#16a34a'}">${shopeeBoostFmtCooldown(it.cooldown_segundos)}</div>
      </div>
      <button class="btn-sm" onclick="shopeeBoostMover(${idx}, -1)" ${idx === 0 ? 'disabled' : ''} title="Subir prioridade">↑</button>
      <button class="btn-sm" onclick="shopeeBoostMover(${idx}, 1)" ${idx === shopeeBoostItens.length - 1 ? 'disabled' : ''} title="Descer prioridade">↓</button>
    </div>
  `).join('');
}

function shopeeBoostMover(idx, direcao) {
  const novoIdx = idx + direcao;
  if (novoIdx < 0 || novoIdx >= shopeeBoostItens.length) return;
  [shopeeBoostItens[idx], shopeeBoostItens[novoIdx]] = [shopeeBoostItens[novoIdx], shopeeBoostItens[idx]];
  shopeeBoostRenderizar();
}

async function shopeeBoostSalvarOrdem() {
  const msg = document.getElementById('shopee-boost-msg');
  if (msg) { msg.textContent = 'Salvando...'; msg.className = 'msg'; msg.style.display = 'block'; }
  try {
    await fetch('/api/shopee/boost-config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ordem: shopeeBoostItens.map(i => i.item_id), conta: shopeeCfgContaAtual }),
    });
    if (msg) { msg.textContent = 'Ordem salva!'; msg.className = 'msg ok'; }
  } catch {
    if (msg) { msg.textContent = 'Erro ao salvar.'; msg.className = 'msg erro'; }
  }
}
