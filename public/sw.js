// Service worker mínimo — só existe pra habilitar instalação como app (PWA).
// Sem cache de API: tudo passa direto pela rede, pra não mostrar dado velho.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Painel', body: 'Você tem uma nova notificação.' };
  try { if (event.data) data = event.data.json(); } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Painel', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/app.html');
    })
  );
});
