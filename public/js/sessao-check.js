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

  // Reaplica em tempo real quando um admin muda as abas liberadas ou pausa o
  // usuário — sem isso a mudança só valia depois do próximo login. Só faz
  // sentido nos painéis que filtram menu por abas (app.html=1, painel2.html=2).
  async function checarPermissoes() {
    const auth = localStorage.getItem('auth');
    if (auth !== '1' && auth !== '2') return;
    const senha = localStorage.getItem('usuarioSenha');
    if (!senha) return;
    try {
      const resp = await fetch(`/api/usuarios/${encodeURIComponent(senha)}/permissoes`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.ativo === false) { encerrarSessao(); return; }
      const atuais = localStorage.getItem('abasPermitidas');
      const novas  = JSON.stringify(Array.isArray(data.abas) ? data.abas : []);
      if (atuais !== novas) {
        localStorage.setItem('abasPermitidas', novas);
        location.reload();
      }
    } catch {}
  }

  function checarTudo() {
    checarSessao();
    checarPermissoes();
  }

  checarTudo();
  setInterval(checarTudo, 20000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checarTudo();
  });
})();
