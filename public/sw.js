// Service worker mínimo — só existe pra habilitar instalação como app (PWA).
// Sem cache de API: tudo passa direto pela rede, pra não mostrar dado velho.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
