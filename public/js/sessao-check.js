// Checa periodicamente se um admin "derrubou todas as sessões" (aba Configurações
// > Acessos). Se a versão da sessão no servidor for maior que a salva no login,
// força logout nesta aba.
(function () {
  function encerrarSessao() {
    localStorage.removeItem('auth');
    localStorage.removeItem('sessionVersion');
    localStorage.removeItem('abasPermitidas');
    localStorage.removeItem('usuarioNome');
    localStorage.removeItem('usuarioSenha');
    location.href = '/';
  }

  async function checarSessao() {
    if (!localStorage.getItem('auth')) return;
    try {
      const resp = await fetch('/api/sessao/versao');
      const data = await resp.json();
      const local = Number(localStorage.getItem('sessionVersion') || '0');
      if (data.version > local) encerrarSessao();
    } catch {}
  }

  checarSessao();
  setInterval(checarSessao, 20000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checarSessao();
  });
})();
