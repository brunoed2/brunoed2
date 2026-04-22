// ============================================================
// home.js — Dashboard / Painel inicial
// ============================================================

let homeDados = null;

async function homeInit() {
  await homeCarregar();
}

async function homeCarregar() {
  const grid = document.getElementById('home-grid');
  grid.innerHTML = '<div class="home-loading">Carregando painel...</div>';

  try {
    const d = await fetch('/api/dashboard').then(r => r.json());
    homeDados = d;
    homeRenderizar(d);
  } catch (err) {
    grid.innerHTML = `<div class="home-loading">Erro ao carregar painel: ${err.message}</div>`;
  }
}

function homeRenderizar(d) {
  const grid = document.getElementById('home-grid');
  const b1 = d.bling['1'], b2 = d.bling['2'];
  const m1 = d.ml['1'],    m2 = d.ml['2'];
  const cp = d.contasPagar;

  const totalPedidos    = b1.pedidos + b2.pedidos;
  const totalNotas      = b1.notas   + b2.notas;
  const totalPerguntas  = m1.perguntas  + m2.perguntas;
  const totalReclamacoes = m1.reclamacoes + m2.reclamacoes;
  const vendasHoje      = m1.vendasHoje  + m2.vendasHoje;
  const vendasSemana    = m1.vendasSemana + m2.vendasSemana;
  const cpUrgente       = cp.vencidas + cp.venceHoje;

  function status(urgente, aviso) {
    if (urgente) return 'vermelho';
    if (aviso)   return 'amarelo';
    return 'verde';
  }

  const cards = [
    {
      icon: '🧾',
      titulo: 'Pedidos sem NF',
      valor: totalPedidos,
      detalhe: `C1: ${b1.pedidos} &nbsp;|&nbsp; C2: ${b2.pedidos}`,
      status: status(totalPedidos > 0, false),
      acao: "abrirAba('bling')",
      acaoLabel: 'Ver pedidos',
    },
    {
      icon: '📤',
      titulo: 'Notas p/ Envio',
      valor: totalNotas,
      detalhe: `C1: ${b1.notas} &nbsp;|&nbsp; C2: ${b2.notas}`,
      status: status(totalNotas > 0, false),
      acao: "abrirAba('bling'); blingAbrirSub('notas')",
      acaoLabel: 'Ver notas',
    },
    {
      icon: '❓',
      titulo: 'Perguntas s/ Resposta',
      valor: totalPerguntas,
      detalhe: `C1: ${m1.perguntas} &nbsp;|&nbsp; C2: ${m2.perguntas}`,
      status: status(totalPerguntas > 0, false),
      acao: null,
      acaoLabel: null,
    },
    {
      icon: '⚠️',
      titulo: 'Reclamações Abertas',
      valor: totalReclamacoes,
      detalhe: `C1: ${m1.reclamacoes} &nbsp;|&nbsp; C2: ${m2.reclamacoes}`,
      status: status(totalReclamacoes > 0, false),
      acao: null,
      acaoLabel: null,
    },
    {
      icon: '🛒',
      titulo: 'Vendas Hoje',
      valor: vendasHoje,
      detalhe: `Esta semana: ${vendasSemana}`,
      status: status(false, vendasHoje === 0),
      acao: "abrirAba('lucro')",
      acaoLabel: 'Ver lucro',
    },
    {
      icon: '💳',
      titulo: 'Contas a Pagar',
      valor: cpUrgente,
      detalhe: cp.vencidas > 0
        ? `${cp.vencidas} vencida${cp.vencidas !== 1 ? 's' : ''} · ${cp.venceHoje} hoje · ${cp.venceSemana} na semana`
        : `${cp.venceHoje} hoje · ${cp.venceSemana} esta semana`,
      status: status(cp.vencidas > 0, cp.venceHoje > 0),
      acao: "abrirAba('contas-pagar')",
      acaoLabel: 'Ver contas',
    },
  ];

  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  grid.innerHTML = `
    <div class="home-header">
      <span class="home-atualizado">Atualizado às ${hora}</span>
      <button class="btn-secondary" onclick="homeCarregar()">↻ Atualizar</button>
    </div>
    <div class="home-cards">
      ${cards.map(c => `
        <div class="home-card home-card-${c.status}">
          <div class="home-card-icon">${c.icon}</div>
          <div class="home-card-titulo">${c.titulo}</div>
          <div class="home-card-valor">${c.valor}</div>
          <div class="home-card-detalhe">${c.detalhe}</div>
          ${c.acao ? `<button class="home-card-btn" onclick="${c.acao}">${c.acaoLabel} →</button>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}
