// ============================================================
// app-v2.js — Lógica do frontend do painel principal
// ============================================================

// ── Log remoto (diagnóstico) ──────────────────────────────────

function clog(msg, tipo = 'info') {
  fetch('/api/conexao/clientlog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg, tipo }),
  }).catch(() => {});
}

window.onerror = (msg, src, line) => {
  clog(`JS ERROR: ${msg} (${src}:${line})`, 'erro');
};
window.onunhandledrejection = (e) => {
  clog(`Promise rejection: ${e.reason}`, 'erro');
};

// ── Estado ────────────────────────────────────────────────────

let contaConfigurando = '1'; // conta sendo editada na aba config
let trocandoConta     = false;
let contaGen          = 0;

// ── Navegação entre abas ──────────────────────────────────────

const navBtns = document.querySelectorAll('.nav-btn');
const tabs    = document.querySelectorAll('.tab');

function abrirAba(nome) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));
  clog(`abrirAba(${nome}) trocandoConta=${trocandoConta} contaGen=${contaGen}`);
  if (trocandoConta) { clog(`abrirAba bloqueado por trocandoConta`, 'warn'); return; }
  if (nome === 'estoque')       carregarEstoque(true);
  if (nome === 'ads')           carregarAds();
  if (nome === 'lucro')         lucroInit();
  if (nome === 'promocoes')     carregarPromocoes();
  if (nome === 'contas-pagar')  contasPagarInit();
  if (nome === 'bling')         blingInit();
  if (nome === 'compras')       comprasAbrirSub('previsao');
  if (nome === 'configuracoes') { carregarConfig(contaConfigurando); }
  // compatibilidade: ?tab=config ou ?tab=conexao redireciona para configuracoes
  if (nome === 'config' || nome === 'conexao') {
    abrirAba('configuracoes');
    if (nome === 'conexao') setTimeout(() => abrirSubConfig('conexao'), 0);
    return;
  }
}

function abrirSubConfig(sub) {
  document.getElementById('subtab-btn-ml').classList.toggle('active', sub === 'ml');
  document.getElementById('subtab-btn-conexao').classList.toggle('active', sub === 'conexao');
  document.getElementById('subtab-ml').style.display      = sub === 'ml'      ? '' : 'none';
  document.getElementById('subtab-conexao').style.display = sub === 'conexao' ? '' : 'none';
  if (sub === 'ml') carregarConfig(contaConfigurando);
  if (sub === 'conexao') {
    if (typeof cxIniciarStream    === 'function') cxIniciarStream();
    if (typeof verificarConexao   === 'function') verificarConexao();
    if (typeof verificarBling     === 'function') verificarBling();
    if (typeof cxCarregarCredenciais === 'function') cxCarregarCredenciais(typeof cxContaSelecionada !== 'undefined' ? cxContaSelecionada : '1');
  } else {
    if (typeof cxPararStream === 'function') cxPararStream();
  }
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => abrirAba(btn.dataset.tab));
});

(function () {
  const params = new URLSearchParams(location.search);
  const tab    = params.get('tab') || 'estoque';
  abrirAba(tab);

  if (params.get('connected') === 'true') {
    const conta = params.get('conta') || '1';
    mostrarMsg('msg-config', `✅ Conta ${conta} conectada com sucesso ao Mercado Livre!`, 'ok');
  }
  if (params.get('error')) {
    const erros = {
      sem_client_id:  'Client ID não configurado. Salve as credenciais antes.',
      auth_cancelado: 'Autorização cancelada pelo usuário.',
      auth_falhou:    'Falha na autenticação.',
    };
    const detalhe = params.get('detalhe') ? ' Detalhe: ' + params.get('detalhe') : '';
    mostrarMsg('msg-config', '❌ ' + (erros[params.get('error')] || 'Erro desconhecido.') + detalhe, 'erro');
  }

  history.replaceState({}, '', '/app.html');
})();

// ── Helpers ───────────────────────────────────────────────────

function mostrarMsg(id, texto, tipo) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = texto;
  el.className   = `msg ${tipo}`;
}

async function apiFetch(url, opts = {}) {
  const timeout = opts._timeout || 30000; // default 30s
  delete opts._timeout;
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeout),
    ...opts,
  });
  return resp.json();
}

// ── Troca de conta ────────────────────────────────────────────

async function trocarConta(num) {
  if (trocandoConta) return;
  trocandoConta = true;
  contaGen++;

  // Desabilita botões durante a troca
  document.querySelectorAll('.conta-btn').forEach(b => b.disabled = true);

  try {
    await apiFetch('/api/conta/ativa', {
      method: 'POST',
      body:   JSON.stringify({ conta: num }),
    });

    // Atualiza visual do seletor
    document.querySelectorAll('.conta-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.conta === num);
    });

    // Recarrega dados da aba atual só após o servidor confirmar a troca
    const abaAtiva = document.querySelector('.tab.active')?.id?.replace('tab-', '');
    if (abaAtiva === 'loja')    carregarLoja();
    if (abaAtiva === 'estoque') carregarEstoque(true);
    if (abaAtiva === 'lucro')   { lucroCarregado = false; lucroCarregarConfig().then(() => lucroCarregarVendas()); }
    atualizarStatus();
    document.dispatchEvent(new CustomEvent('contaMudou', { detail: { conta: num } }));
  } finally {
    document.querySelectorAll('.conta-btn').forEach(b => b.disabled = false);
    trocandoConta = false;
  }
}

// Inicializa seletor de conta com o estado do servidor
async function inicializarSeletorConta() {
  try {
    const data = await apiFetch('/api/conta/ativa');
    document.querySelectorAll('.conta-btn').forEach(b => {
      const num      = b.dataset.conta;
      const nickname = data.contas?.[num]?.nickname;
      if (nickname) b.textContent = nickname;
      b.classList.toggle('active', num === data.conta_ativa);
    });
  } catch {}
}

// ── Status de conexão ─────────────────────────────────────────

async function atualizarStatus() {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  try {
    const resp = await fetch('/api/ml/status', { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    if (data.connected) {
      dot.className   = 'dot conectado';
      txt.textContent = `Conectado${data.nickname ? ` como ${data.nickname}` : ''}`;
    } else {
      dot.className   = 'dot desconectado';
      txt.textContent = 'Desconectado';
    }
  } catch {
    dot.className   = 'dot desconectado';
    txt.textContent = 'Sem resposta do servidor';
  }
}

// ── Configurações ─────────────────────────────────────────────

document.getElementById('callback-url').textContent = `${location.origin}/api/ml/callback`;

function abrirConfigConta(num) {
  contaConfigurando = num;
  document.getElementById('cfg-titulo').textContent = `Credenciais — Conta ${num}`;
  document.getElementById('cfg-tab-1').className = num === '1' ? 'btn-primary' : 'btn-secondary';
  document.getElementById('cfg-tab-2').className = num === '2' ? 'btn-primary' : 'btn-secondary';
  carregarConfig(num);
}

async function carregarConfig(num) {
  try {
    const data = await apiFetch(`/api/config?conta=${num}`);
    document.getElementById('client_id').value     = data.client_id    || '';
    document.getElementById('access_token').value  = data.access_token || '';
    document.getElementById('refresh_token').value = data.refresh_token || '';
    document.getElementById('client_secret').value = '';
  } catch {}
}

async function salvarConfig(event) {
  event.preventDefault();
  const payload = {
    conta:         contaConfigurando,
    client_id:     document.getElementById('client_id').value.trim(),
    client_secret: document.getElementById('client_secret').value.trim(),
    access_token:  document.getElementById('access_token').value.trim(),
    refresh_token: document.getElementById('refresh_token').value.trim(),
  };
  Object.keys(payload).forEach(k => { if (!payload[k]) delete payload[k]; });

  try {
    await apiFetch('/api/config', { method: 'POST', body: JSON.stringify(payload) });
    mostrarMsg('msg-config', `✅ Conta ${contaConfigurando} salva com sucesso.`, 'ok');
    atualizarStatus();
  } catch {
    mostrarMsg('msg-config', '❌ Erro ao salvar. Tente novamente.', 'erro');
  }
}

function conectarOAuth() {
  location.href = `/api/ml/auth?conta=${contaConfigurando}`;
}

// ── Loja ──────────────────────────────────────────────────────

async function carregarLoja() {
  clog(`carregarLoja() iniciando, gen=${contaGen}`);
  const gen     = contaGen;
  const loading = document.getElementById('loja-loading');
  const info    = document.getElementById('loja-info');
  const erroEl  = document.getElementById('loja-erro');

  loading.style.display = 'block';
  info.style.display    = 'none';
  erroEl.style.display  = 'none';

  try {
    const data = await apiFetch('/api/ml/store');
    clog(`carregarLoja() resposta recebida: ${JSON.stringify(data).slice(0,100)}`);
    if (contaGen !== gen) { clog(`carregarLoja() descartado (gen mudou)`, 'warn'); return; }
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    document.getElementById('loja-nome').textContent  = data.name    || '—';
    document.getElementById('loja-id').textContent    = data.id      || '—';
    document.getElementById('loja-pais').textContent  = data.country || '—';
    info.style.display = 'block';
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao conectar com o servidor.';
    erroEl.style.display = 'block';
  }
}

// ── Estoque ───────────────────────────────────────────────────

let todosItens = [];
let filtros    = { deposito: 'todos', status: 'todos' };
let sortState    = { campo: null, direcao: 'asc' };
let expandedMLBs = new Set();

function calcularDiasPausado(status, pausadoDesde) {
  if (status !== 'paused' || !pausadoDesde) return null;
  const ms = Date.now() - new Date(pausadoDesde).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function diasEstoqueNum(estoque, vendas30d) {
  if (estoque === 0 || estoque === '—') return -1;
  if (!vendas30d) return Infinity;
  return Math.round(estoque / (vendas30d / 30));
}

function sortarItens(itens) {
  if (!sortState.campo) return itens;
  return [...itens].sort((a, b) => {
    let va, vb;
    if (sortState.campo === 'diasEstoque') {
      va = diasEstoqueNum(a.estoque, a.vendas30d);
      vb = diasEstoqueNum(b.estoque, b.vendas30d);
    } else if (sortState.campo === 'diasPausado') {
      va = calcularDiasPausado(a.status, a.pausadoDesde) ?? -1;
      vb = calcularDiasPausado(b.status, b.pausadoDesde) ?? -1;
    } else {
      va = a[sortState.campo];
      vb = b[sortState.campo];
    }
    if (va == null || va === '—') return 1;
    if (vb == null || vb === '—') return -1;
    if (typeof va === 'number' && typeof vb === 'number') {
      return sortState.direcao === 'asc' ? va - vb : vb - va;
    }
    const cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
    return sortState.direcao === 'asc' ? cmp : -cmp;
  });
}

function atualizarIconesSort() {
  document.querySelectorAll('.th-sort').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (th.dataset.sort === sortState.campo) {
      icon.textContent = sortState.direcao === 'asc' ? ' ▲' : ' ▼';
      th.classList.add('th-ativo');
    } else {
      icon.textContent = '';
      th.classList.remove('th-ativo');
    }
  });
}

const BADGE_DEPOSITO = {
  fulfillment:   'badge-full',
  self_service:  'badge-proprio',
  cross_docking: 'badge-flex',
};

const BADGE_STATUS = {
  active: 'badge-ativo',
  paused: 'badge-pausado',
  closed: 'badge-encerrado',
};

const STATUS_LABEL = {
  active: 'Ativo',
  paused: 'Pausado',
  closed: 'Encerrado',
};

document.querySelectorAll('.th-sort').forEach(th => {
  th.addEventListener('click', () => {
    if (sortState.campo === th.dataset.sort) {
      sortState.direcao = sortState.direcao === 'asc' ? 'desc' : 'asc';
    } else {
      sortState.campo   = th.dataset.sort;
      sortState.direcao = 'asc';
    }
    renderizarTabela();
  });
});

document.querySelectorAll('.filtro-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const grupo = btn.dataset.filtro;
    document.querySelectorAll(`.filtro-btn[data-filtro="${grupo}"]`)
      .forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filtros[grupo] = btn.dataset.valor;
    renderizarTabela();
  });
});

function toggleVariacoes(mlb) {
  if (expandedMLBs.has(mlb)) {
    expandedMLBs.delete(mlb);
  } else {
    expandedMLBs.add(mlb);
  }
  const aberto = expandedMLBs.has(mlb);
  document.querySelectorAll(`.variacao-row-${mlb}`).forEach(row => {
    row.style.display = aberto ? '' : 'none';
  });
  const btn = document.getElementById(`btn-expandir-${mlb}`);
  if (btn) btn.textContent = aberto ? '▲' : '▼';
}

async function atualizarEstoqueVariacao(mlb, variacaoId, btn) {
  const input   = btn.previousElementSibling;
  const novaQtd = parseInt(input.value, 10);
  if (isNaN(novaQtd) || novaQtd < 0) return;

  btn.disabled    = true;
  btn.textContent = '...';

  try {
    const result = await apiFetch(`/api/ml/estoque/${mlb}`, {
      method: 'PUT',
      body:   JSON.stringify({ quantidade: novaQtd, variacao_id: variacaoId }),
    });
    if (result.error) {
      btn.textContent = '✗';
      btn.classList.add('btn-confirmar-erro');
      btn.title = result.error;
      setTimeout(() => {
        btn.textContent = '✓';
        btn.classList.remove('btn-confirmar-erro');
        btn.title = '';
        btn.disabled = false;
      }, 3000);
    } else {
      btn.textContent = '✓';
      btn.classList.add('btn-confirmar-ok');
      input.defaultValue = novaQtd;
      const item = todosItens.find(i => i.mlb === mlb);
      if (item && item.variacoes) {
        const v = item.variacoes.find(v => v.id === variacaoId);
        if (v) v.estoque = novaQtd;
        const total = item.variacoes.reduce((s, v) => s + v.estoque, 0);
        item.estoque = total;
        const totalEl = document.getElementById(`estoque-total-${mlb}`);
        if (totalEl) totalEl.textContent = total;
      }
      setTimeout(() => {
        btn.classList.remove('btn-confirmar-ok');
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    btn.textContent = '✗';
    btn.classList.add('btn-confirmar-erro');
    btn.title = e.message;
    setTimeout(() => {
      btn.textContent = '✓';
      btn.classList.remove('btn-confirmar-erro');
      btn.title = '';
      btn.disabled = false;
    }, 3000);
  }
}

function isProprio(deposito) {
  return deposito === 'self_service' || deposito === 'xd_drop_off';
}

async function atualizarEstoque(mlb, btn) {
  const input  = btn.previousElementSibling;
  const novaQtd = parseInt(input.value, 10);
  if (isNaN(novaQtd) || novaQtd < 0) return;

  btn.disabled    = true;
  btn.textContent = '...';

  try {
    const result = await apiFetch(`/api/ml/estoque/${mlb}`, {
      method: 'PUT',
      body:   JSON.stringify({ quantidade: novaQtd }),
    });
    if (result.error) {
      btn.textContent = '✗';
      btn.classList.add('btn-confirmar-erro');
      btn.title = result.error;
      setTimeout(() => {
        btn.textContent = '✓';
        btn.classList.remove('btn-confirmar-erro');
        btn.title  = '';
        btn.disabled = false;
      }, 3000);
    } else {
      btn.textContent = '✓';
      btn.classList.add('btn-confirmar-ok');
      const item = todosItens.find(i => i.mlb === mlb);
      if (item) item.estoque = novaQtd;
      input.defaultValue = novaQtd;
      setTimeout(() => {
        btn.classList.remove('btn-confirmar-ok');
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    btn.textContent = '✗';
    btn.classList.add('btn-confirmar-erro');
    btn.title = e.message;
    setTimeout(() => {
      btn.textContent = '✓';
      btn.classList.remove('btn-confirmar-erro');
      btn.title    = '';
      btn.disabled = false;
    }, 3000);
  }
}

function renderizarTabela() {
  let itens = todosItens;
  const skuFiltro    = (document.getElementById('filtro-sku')?.value    || '').trim().toLowerCase();
  const tituloFiltro = (document.getElementById('filtro-titulo')?.value || '').trim().toLowerCase();
  if (skuFiltro)    itens = itens.filter(i => String(i.sku).toLowerCase().includes(skuFiltro));
  if (tituloFiltro) itens = itens.filter(i => String(i.titulo).toLowerCase().includes(tituloFiltro));
  if (filtros.deposito === 'proprio') {
    itens = itens.filter(i => i.deposito === 'self_service' || i.deposito === 'xd_drop_off');
  } else if (filtros.deposito !== 'todos') {
    itens = itens.filter(i => i.deposito === filtros.deposito);
  }
  if (filtros.status !== 'todos') itens = itens.filter(i => i.status === filtros.status);
  itens = sortarItens(itens);
  atualizarIconesSort();

  const tbody = document.getElementById('tabela-estoque-body');
  tbody.innerHTML = '';

  itens.forEach(item => {
    const bDeposito    = BADGE_DEPOSITO[item.deposito] || 'badge-outro';
    const bStatus      = BADGE_STATUS[item.status]     || 'badge-outro';
    const duracao      = calcularDuracao(item.estoque, item.vendas30d);
    const diasPausado  = calcularDiasPausado(item.status, item.pausadoDesde);
    const temVariacoes = isProprio(item.deposito) && item.variacoes && item.variacoes.length > 0;

    let estoqueCell;
    if (temVariacoes) {
      const aberto = expandedMLBs.has(item.mlb);
      estoqueCell = `<td class="col-num"><div class="estoque-edit-wrap"><span id="estoque-total-${item.mlb}" class="${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</span><button id="btn-expandir-${item.mlb}" class="btn-expandir-var" onclick="toggleVariacoes('${item.mlb}')">${aberto ? '▲' : '▼'}</button></div></td>`;
    } else if (isProprio(item.deposito)) {
      estoqueCell = `<td class="col-num"><div class="estoque-edit-wrap"><input type="number" class="estoque-input" value="${item.estoque}" min="0"><button class="btn-confirmar-estoque" onclick="atualizarEstoque('${item.mlb}', this)">✓</button></div></td>`;
    } else {
      estoqueCell = `<td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</td>`;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-sku">${item.sku}</td>
      <td class="td-titulo" title="${item.titulo}">${item.permalink ? `<a class="link-anuncio" href="${item.permalink}" target="_blank">${item.titulo}</a>` : item.titulo}</td>
      <td class="td-mlb">${item.mlb}</td>
      <td><span class="badge-deposito ${bDeposito}">${item.depositoLabel}</span></td>
      <td><span class="badge-deposito ${bStatus}">${STATUS_LABEL[item.status] || item.status}</span></td>
      ${estoqueCell}
      <td class="col-num">${item.vendas30d === null ? '...' : (item.vendas30d || '—')}</td>
      <td class="col-num ${duracao.classe}">${item.vendas30d === null ? '...' : duracao.texto}</td>
      <td class="col-num ${diasPausado !== null ? 'pausado-dias' : ''}">${diasPausado !== null ? diasPausado + 'd' : ''}</td>
    `;
    tbody.appendChild(tr);

    if (temVariacoes) {
      const aberto = expandedMLBs.has(item.mlb);
      item.variacoes.forEach(v => {
        const trVar = document.createElement('tr');
        trVar.className = `variacao-row variacao-row-${item.mlb}`;
        trVar.style.display = aberto ? '' : 'none';
        trVar.innerHTML = `
          <td colspan="2" class="variacao-indent"></td>
          <td colspan="3" class="variacao-nome">↳ ${v.nome}</td>
          <td class="col-num">
            <div class="estoque-edit-wrap">
              <input type="number" class="estoque-input" value="${v.estoque}" min="0">
              <button class="btn-confirmar-estoque" onclick="atualizarEstoqueVariacao('${item.mlb}', ${v.id}, this)">✓</button>
            </div>
          </td>
          <td colspan="3"></td>
        `;
        tbody.appendChild(trVar);
      });
    }
  });

  document.getElementById('tabela-estoque').style.display = itens.length ? 'table' : 'none';
  const filtroAtivo = filtros.deposito !== 'todos' || filtros.status !== 'todos';
  document.getElementById('estoque-total').textContent =
    `${itens.length} de ${todosItens.length} anúncios` +
    (filtroAtivo ? ' (filtro ativo)' : '');
}

function calcularDuracao(estoque, vendas30d) {
  if (estoque === 0)   return { texto: 'Zerado',  classe: 'duracao-zerado' };
  if (!vendas30d)      return { texto: '∞',        classe: 'duracao-infinito' };
  const dias = Math.round(estoque / (vendas30d / 30));
  let classe = 'duracao-ok';
  if (dias <= 15)      classe = 'duracao-critico';
  else if (dias <= 30) classe = 'duracao-alerta';
  return { texto: `${dias}d`, classe };
}

async function carregarEstoque(reiniciar = false) {
  clog(`carregarEstoque(${reiniciar}) iniciando, gen=${contaGen}`);
  const gen = contaGen;

  if (reiniciar) {
    todosItens = [];
    document.getElementById('tabela-estoque-body').innerHTML = '';
    document.getElementById('tabela-estoque').style.display  = 'none';
    document.getElementById('estoque-total').textContent     = '';
  }

  const loading = document.getElementById('estoque-loading');
  const erroEl  = document.getElementById('estoque-erro');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';

  let estoqueData;
  try {
    estoqueData = await apiFetch('/api/ml/estoque');
    clog(`carregarEstoque() resposta: ${JSON.stringify(estoqueData).slice(0,100)}`);
    if (contaGen !== gen) { clog(`carregarEstoque() descartado (gen mudou)`, 'warn'); return; }
    loading.style.display = 'none';

    if (estoqueData.error) {
      erroEl.textContent   = estoqueData.error;
      erroEl.style.display = 'block';
      return;
    }

    todosItens = estoqueData.items.map(item => ({ ...item, vendas30d: null }));
    renderizarTabela();
  } catch (err) {
    clog(`carregarEstoque() catch: ${err.message}`, 'erro');
    if (contaGen !== gen) return;
    loading.style.display = 'none';
    erroEl.textContent   = `Erro ao carregar estoque: ${err.message}`;
    erroEl.style.display = 'block';
    return;
  }

  document.getElementById('estoque-total').textContent += '  (carregando vendas...)';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    const resp = await fetch('/api/ml/vendas30dias', { signal: controller.signal });
    clearTimeout(timer);
    if (contaGen !== gen) return;
    const vendasData = await resp.json();
    const vendas = (vendasData && !vendasData.error) ? vendasData : {};

    todosItens = todosItens.map(item => ({
      ...item,
      vendas30d: vendas[item.mlb] || 0,
    }));
    renderizarTabela();
  } catch (err) {
    if (contaGen !== gen) return;
    console.error('Vendas:', err.message);
    todosItens = todosItens.map(item => ({ ...item, vendas30d: 0 }));
    renderizarTabela();
  }
}

// ── Ads ───────────────────────────────────────────────────────

let todosAdsItens  = [];
let sortAds        = { campo: null, direcao: 'asc' };
let expandedCamps  = new Set();

function toggleCampanha(campId) {
  if (expandedCamps.has(campId)) {
    expandedCamps.delete(campId);
  } else {
    expandedCamps.add(campId);
  }
  const aberto = expandedCamps.has(campId);
  document.querySelectorAll(`.camp-row-${campId}`).forEach(row => {
    row.style.display = aberto ? '' : 'none';
  });
  const btn = document.getElementById(`btn-camp-${campId}`);
  if (btn) btn.textContent = aberto ? '▲' : '▼';
}

document.querySelectorAll('.th-sort-ads').forEach(th => {
  th.addEventListener('click', () => {
    if (sortAds.campo === th.dataset.sortAds) {
      sortAds.direcao = sortAds.direcao === 'asc' ? 'desc' : 'asc';
    } else {
      sortAds.campo   = th.dataset.sortAds;
      sortAds.direcao = 'asc';
    }
    renderizarAds();
  });
});

function renderizarAds() {
  let itens = [...todosAdsItens];
  if (sortAds.campo) {
    itens.sort((a, b) => {
      let va = a[sortAds.campo], vb = b[sortAds.campo];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') {
        return sortAds.direcao === 'asc' ? va - vb : vb - va;
      }
      const cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric: true });
      return sortAds.direcao === 'asc' ? cmp : -cmp;
    });
  }

  // Atualiza ícones de sort
  document.querySelectorAll('.th-sort-ads').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    if (th.dataset.sortAds === sortAds.campo) {
      icon.textContent = sortAds.direcao === 'asc' ? ' ▲' : ' ▼';
      th.classList.add('th-ativo');
    } else {
      icon.textContent = '';
      th.classList.remove('th-ativo');
    }
  });

  const tbody = document.getElementById('tabela-ads-body');
  tbody.innerHTML = '';

  const fmtBRL  = v => v != null ? `R$ ${v.toFixed(2).replace('.', ',')}` : '—';
  const fmtRoas = v => v != null ? v.toFixed(2) : '—';

  itens.forEach(item => {
    let roasClass = '';
    if (item.roasEntregando != null && item.targetRoas != null) {
      const diff = (item.roasEntregando - item.targetRoas) / item.targetRoas;
      if (diff < -0.05)      roasClass = 'roas-abaixo';
      else if (diff > 0.05)  roasClass = 'roas-acima';
      else                   roasClass = 'roas-ok';
    }

    const campId      = item.campId || item.campanha;
    const temMultiplos = item.adsLista && item.adsLista.length > 1;
    const aberto      = expandedCamps.has(campId);

    // Coluna "Anúncios": se tem múltiplos, mostra contagem + botão expandir
    let anunciosCell;
    if (temMultiplos) {
      anunciosCell = `<td class="td-titulo"><div class="estoque-edit-wrap" style="justify-content:flex-start;gap:6px"><button id="btn-camp-${campId}" class="btn-expandir-var" onclick="toggleCampanha('${campId}')">${aberto ? '▲' : '▼'}</button><span>${item.qtdAnuncios} anúncios</span></div></td>`;
    } else {
      const titulo = (item.adsLista && item.adsLista[0]?.title) || item.titulos || '—';
      anunciosCell = `<td class="td-titulo" title="${titulo}">${titulo}</td>`;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-campanha" title="${item.campanha}">${item.campanha}</td>
      ${anunciosCell}
      <td class="col-num">${fmtRoas(item.targetRoas)}</td>
      <td class="col-num ${roasClass}">${fmtRoas(item.roasEntregando)}</td>
      <td class="col-num">${fmtBRL(item.custoPorUnidade)}</td>
      <td class="col-num">${fmtBRL(item.cost)}</td>
      <td class="col-num">${item.units || '—'}</td>
    `;
    tbody.appendChild(tr);

    // Sub-linhas para cada anúncio (só quando tem múltiplos)
    if (temMultiplos) {
      item.adsLista.forEach(ad => {
        const trAd = document.createElement('tr');
        trAd.className = `camp-row camp-row-${campId}`;
        trAd.style.display = aberto ? '' : 'none';
        trAd.innerHTML = `
          <td class="variacao-indent"></td>
          <td colspan="6" class="variacao-nome">↳ ${ad.title}</td>
        `;
        tbody.appendChild(trAd);
      });
    }
  });

  document.getElementById('tabela-ads').style.display = itens.length ? 'table' : 'none';
  document.getElementById('ads-total').textContent = `${itens.length} produto${itens.length !== 1 ? 's' : ''} com ads ativos (últimos 30 dias)`;
}

async function carregarAds() {
  const loading = document.getElementById('ads-loading');
  const erroEl  = document.getElementById('ads-erro');
  const tabela  = document.getElementById('tabela-ads');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  tabela.style.display  = 'none';
  document.getElementById('ads-total').textContent   = '';
  document.getElementById('tabela-ads-body').innerHTML = '';

  try {
    const data = await apiFetch('/api/ml/ads-roas');
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error + (data.detalhe ? ` — ${data.detalhe}` : '');
      erroEl.style.display = 'block';
      return;
    }

    if (data.aviso) {
      erroEl.textContent   = data.aviso;
      erroEl.style.display = 'block';
    }

    todosAdsItens = data.itens || [];
    renderizarAds();
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar dados de ads.';
    erroEl.style.display = 'block';
  }
}

// ── Sair ──────────────────────────────────────────────────────

function sair() {
  sessionStorage.removeItem('auth');
  location.href = '/';
}

// ── Inicialização ─────────────────────────────────────────────

inicializarSeletorConta();
carregarConfig('1');
atualizarStatus();
setInterval(atualizarStatus, 60_000);
