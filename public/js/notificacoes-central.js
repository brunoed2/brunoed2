// Central de notificações — sino no topo do app, histórico das últimas 100 notificações enviadas.

let notifCentralAberta = false;

function notifCentralFormatarHora(ts) {
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `${diffMin} min atrás`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h atrás`;
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function notifCentralRenderLista(itens) {
  const lista = document.getElementById('notif-central-lista');
  if (!lista) return;
  if (!itens.length) {
    lista.innerHTML = '<div class="notif-central-vazio">Nenhuma notificação ainda.</div>';
    return;
  }
  lista.innerHTML = itens.map((n, i) => `
    <div class="notif-central-item">
      ${n.categoriaLabel ? `<div class="notif-central-item-cat">${n.categoriaLabel}</div>` : ''}
      <div class="notif-central-item-texto" data-i="${i}"></div>
      <div class="notif-central-item-hora">${notifCentralFormatarHora(n.ts)}</div>
    </div>
  `).join('');
  lista.querySelectorAll('.notif-central-item-texto').forEach(el => {
    el.textContent = itens[Number(el.dataset.i)].texto;
  });
}

async function notifCentralAtualizarBadge() {
  try {
    const d = await fetch('/api/notificacoes').then(r => r.json());
    ['notif-central-badge', 'notif-central-badge-drawer'].forEach(id => {
      const badge = document.getElementById(id);
      if (!badge) return;
      if (d.naoLidas > 0) {
        badge.textContent = d.naoLidas > 99 ? '99+' : d.naoLidas;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    });
    notifCentralRenderLista(d.itens || []);
  } catch {}
}

async function notifCentralToggle() {
  const painel  = document.getElementById('notif-central-painel');
  const overlay = document.getElementById('notif-central-overlay');
  if (!painel || !overlay) return;
  notifCentralAberta = !notifCentralAberta;
  painel.style.display  = notifCentralAberta ? 'flex'  : 'none';
  overlay.style.display = notifCentralAberta ? 'block' : 'none';
  if (notifCentralAberta) {
    await notifCentralAtualizarBadge();
    try { await fetch('/api/notificacoes/marcar-vistas', { method: 'POST' }); } catch {}
    ['notif-central-badge', 'notif-central-badge-drawer'].forEach(id => {
      const badge = document.getElementById(id);
      if (badge) badge.style.display = 'none';
    });
  }
}

function notifCentralFechar() {
  notifCentralAberta = false;
  const painel  = document.getElementById('notif-central-painel');
  const overlay = document.getElementById('notif-central-overlay');
  if (painel)  painel.style.display  = 'none';
  if (overlay) overlay.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', notifCentralAtualizarBadge);
setInterval(notifCentralAtualizarBadge, 60_000);
