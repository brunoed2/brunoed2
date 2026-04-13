// ── Shopee ────────────────────────────────────────────────────

async function shopeeVerificarStatus() {
  const dot = document.getElementById('shopee-status-dot');
  const txt = document.getElementById('shopee-status-txt');
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
    if (d.partner_id) document.getElementById('shopee-partner-id').value = d.partner_id;
  } catch {}
}

async function shopeeSalvarEConectar() {
  const partnerId  = document.getElementById('shopee-partner-id').value.trim();
  const partnerKey = document.getElementById('shopee-partner-key').value.trim();
  const msg        = document.getElementById('shopee-msg');

  if (!partnerId || !partnerKey) {
    msg.textContent  = 'Preencha Partner ID e Partner Key.';
    msg.style.color  = '#c00';
    msg.style.display = 'block';
    return;
  }

  msg.textContent   = 'Salvando...';
  msg.style.color   = '#555';
  msg.style.display = 'block';

  try {
    await fetch('/api/shopee/config', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ partner_id: partnerId, partner_key: partnerKey }),
    });
    msg.textContent = 'Credenciais salvas. Redirecionando para autorização...';
    msg.style.color = '#166534';
    setTimeout(() => { location.href = '/api/shopee/auth'; }, 1000);
  } catch {
    msg.textContent  = 'Erro ao salvar.';
    msg.style.color  = '#c00';
  }
}

async function carregarShopeeOrders() {
  const loading = document.getElementById('shopee-loading');
  const erroEl  = document.getElementById('shopee-erro');
  const totalEl = document.getElementById('shopee-total');
  const tabela  = document.getElementById('tabela-shopee');
  const tbody   = document.getElementById('tabela-shopee-body');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  tabela.style.display  = 'none';
  tbody.innerHTML = '';

  try {
    const d = await fetch('/api/shopee/orders').then(r => r.json());
    loading.style.display = 'none';

    if (d.error) {
      erroEl.textContent   = d.error;
      erroEl.style.display = 'block';
      return;
    }

    const orders = d.orders || [];
    totalEl.textContent = `${orders.length} pedido${orders.length !== 1 ? 's' : ''} pronto${orders.length !== 1 ? 's' : ''} para envio`;

    if (!orders.length) { tabela.style.display = 'none'; return; }

    orders.forEach(o => {
      const itens = (o.item_list || []);
      const totalQtd = itens.reduce((s, i) => s + (i.model_quantity_purchased || 1), 0);
      const item0    = itens[0] || {};
      const nomeItem = item0.item_name || '—';
      const variacao = item0.model_name && item0.model_name !== item0.item_name ? ` — ${item0.model_name}` : '';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-order-id">#${o.order_sn}</td>
        <td>${o.buyer_username || '—'}</td>
        <td class="col-num venda-qtd">${totalQtd}</td>
        <td class="td-titulo">${nomeItem}${variacao}${itens.length > 1 ? ` <span style="color:#888;font-size:11px">(+${itens.length - 1} item${itens.length > 2 ? 's' : ''})</span>` : ''}</td>
        <td><span class="badge-deposito badge-ativo">Pronto p/ envio</span></td>
      `;
      tbody.appendChild(tr);
    });

    tabela.style.display = 'table';
  } catch {
    loading.style.display = 'none';
    erroEl.textContent    = 'Erro ao carregar pedidos.';
    erroEl.style.display  = 'block';
  }
}

// Inicializa quando a aba Shopee é aberta
document.addEventListener('DOMContentLoaded', () => {
  // Verifica parâmetros de retorno do OAuth
  const params = new URLSearchParams(location.search);
  if (params.get('shopee_ok')) {
    history.replaceState({}, '', location.pathname);
    // Abre a aba shopee automaticamente
    document.querySelector('[data-tab="shopee"]')?.click();
  }
  if (params.get('shopee_error')) {
    history.replaceState({}, '', location.pathname);
    document.querySelector('[data-tab="shopee"]')?.click();
  }

  // Observa abertura da aba shopee
  const observer = new MutationObserver(() => {
    const aba = document.getElementById('tab-shopee');
    if (aba && aba.classList.contains('active')) {
      shopeeVerificarStatus();
      shopeeCarregarConfig();
      carregarShopeeOrders();
      observer.disconnect();
    }
  });
  const tab = document.getElementById('tab-shopee');
  if (tab) observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
});
