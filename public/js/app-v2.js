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

// ── Conta ativa (fonte da verdade: URL ?conta=) ───────────────
window.CONTA_ATIVA = new URLSearchParams(location.search).get('conta') || '1';

// ── Estado ────────────────────────────────────────────────────

let contaConfigurando = '1'; // conta sendo editada na aba config
let trocandoConta     = false;
let contaGen          = 0;

// Estado da aba Ads — declarado aqui (não lá embaixo) porque abrirAba() já pode
// chamar carregarAds() antes do resto do script terminar de rodar; se algo no
// meio do script lançar um erro, o restante do arquivo nunca executa e essas
// variáveis ficariam presas em TDZ pra sempre.
let todosAdsItens    = [];
let sortAds          = { campo: null, direcao: 'asc' };
let expandedCamps    = new Set();
let custoLucroPorMlb = {};
let gastoMaxPorMlb   = {}; // valor (sugerido ou editado à mão) usado na simulação de ROAS ideal / lucro após ads
let gastoMaxManual   = {}; // true = usuário já editou esse campo; não sobrescrever com a sugestão
let margemMinimaAds  = 15; // % mínima de lucro sobre o preço, após descontar o ads sugerido

// ── Navegação entre abas ──────────────────────────────────────

const navBtns    = document.querySelectorAll('.nav-btn');
const tabs       = document.querySelectorAll('.tab');
const drawerBtns = document.querySelectorAll('.mobile-drawer-btn');

drawerBtns.forEach(btn => {
  btn.addEventListener('click', () => { abrirAba(btn.dataset.tab); fecharMobileMenu(); });
});

function toggleMobileMenu() {
  document.getElementById('mobileDrawer').classList.toggle('open');
  document.getElementById('mobileOverlay').classList.toggle('open');
}

function fecharMobileMenu() {
  document.getElementById('mobileDrawer').classList.remove('open');
  document.getElementById('mobileOverlay').classList.remove('open');
}

function abrirAba(nome) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  drawerBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));
  localStorage.setItem('ultimaAba', nome);
  history.replaceState(null, '', '/app.html?conta=' + (window.CONTA_ATIVA || '1') + '&tab=' + nome);

  // Atualiza label da barra inferior mobile
  const labelEl = document.getElementById('mobile-tab-label');
  if (labelEl) {
    const ref = document.querySelector(`.nav-btn[data-tab="${nome}"]`);
    if (ref) labelEl.textContent = ref.textContent.trim();
  }
  clog(`abrirAba(${nome}) trocandoConta=${trocandoConta} contaGen=${contaGen}`);
  if (trocandoConta) { clog(`abrirAba bloqueado por trocandoConta`, 'warn'); return; }
  if (nome === 'estoque')       carregarEstoque(true);
  if (nome === 'vendas')        carregarVendas();
  if (nome === 'historico')     { histIniciarDatas(); carregarHistorico(); }
  if (nome === 'ads')           carregarAds();
  if (nome === 'lucro')         lucroInit();
  if (nome === 'promocoes')     carregarPromocoes();
  if (nome === 'contas-pagar')  contasPagarInit();
  if (nome === 'bling')         blingInit();
  if (nome === 'fiscal')        { fiscalCarregar(); fiscalCarregarCerts(); }
  if (nome === 'compras')       comprasAbrirSub('previsao');
  if (nome === 'etiquetas')     etiquetasInit();
  if (nome === 'log-anuncio')  logAnuncioInit();
  if (nome === 'scanner')      scannerInit();
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
  document.getElementById('subtab-btn-usuarios').classList.toggle('active', sub === 'usuarios');
  document.getElementById('subtab-btn-backup')?.classList.toggle('active', sub === 'backup');
  document.getElementById('subtab-ml').style.display       = sub === 'ml'       ? '' : 'none';
  document.getElementById('subtab-conexao').style.display  = sub === 'conexao'  ? '' : 'none';
  document.getElementById('subtab-usuarios').style.display = sub === 'usuarios' ? '' : 'none';
  document.getElementById('subtab-backup').style.display   = sub === 'backup'   ? '' : 'none';
  if (sub === 'ml') carregarConfig(contaConfigurando);
  if (sub === 'usuarios') usuariosCarregar();
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
  btn.addEventListener('click', e => { e.preventDefault(); abrirAba(btn.dataset.tab); });
});

(function () {
 try {
  const permitidas = JSON.parse(localStorage.getItem('abasPermitidas') || 'null');
  if (permitidas && Array.isArray(permitidas)) {
    navBtns.forEach(btn => {
      if (!permitidas.includes(btn.dataset.tab)) btn.style.display = 'none';
    });
  }

  const params      = new URLSearchParams(location.search);
  const tabParam    = params.get('tab');
  const ultimaAba   = localStorage.getItem('ultimaAba');
  const primeiraAba = permitidas && permitidas.length ? permitidas[0] : 'estoque';
  const tabSalva    = ultimaAba && (!permitidas || permitidas.includes(ultimaAba)) ? ultimaAba : primeiraAba;
  const tab = (tabParam && (!permitidas || permitidas.includes(tabParam))) ? tabParam : tabSalva;
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

  history.replaceState({}, '', '/app.html?conta=' + window.CONTA_ATIVA);
 } catch (e) {
  clog(`Erro na inicialização da aba: ${e.message}`, 'erro');
 }
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

function app2ContaAtual() {
  return window.CONTA_ATIVA || '1';
}

// ── Troca de conta ────────────────────────────────────────────

function trocarConta(num) {
  const abaAtiva = document.querySelector('.tab.active')?.id?.replace('tab-', '') || 'estoque';
  location.href = '/app.html?conta=' + num + '&tab=' + abaAtiva;
}

// Inicializa seletor de conta — ativo vem da URL, nickname do servidor
async function inicializarSeletorConta() {
  document.querySelectorAll('.conta-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.conta === window.CONTA_ATIVA);
  });
  try {
    const data = await apiFetch('/api/conta/ativa');
    document.querySelectorAll('.conta-btn').forEach(b => {
      const nickname = data.contas?.[b.dataset.conta]?.nickname;
      if (nickname) b.textContent = nickname;
    });
  } catch {}
}

// ── Status de conexão ─────────────────────────────────────────

async function atualizarStatus() {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  try {
    const resp = await fetch(`/api/ml/status?conta=${window.CONTA_ATIVA}`, { signal: AbortSignal.timeout(5000) });
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

const elCallbackUrl = document.getElementById('callback-url');
if (elCallbackUrl) elCallbackUrl.textContent = `${location.origin}/api/ml/callback`;

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
    const data = await apiFetch(`/api/ml/store?conta=${window.CONTA_ATIVA}`);
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
let estoqueLocal = {};

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
    const conta = app2ContaAtual();
    const result = await apiFetch(`/api/ml/estoque/${mlb}?conta=${conta}`, {
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

async function salvarEstoqueLocal(event) {
  const input = event.target;
  const sku   = input.dataset.sku;
  const valor = input.value.trim();
  try {
    const response = await apiFetch('/api/estoque-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku, quantidade: valor, usuario: localStorage.getItem('usuarioNome') || 'Desconhecido' })
    });
    if (response.erro) { console.error('Erro ao salvar estoque local:', response.erro); return; }
    if (valor === '') {
      delete estoqueLocal[sku];
    } else {
      const num = parseInt(valor);
      if (!isNaN(num) && num >= 0) estoqueLocal[sku] = num;
    }
  } catch (error) {
    console.error('Erro ao conectar com o servidor:', error);
  }
}

async function abrirHistoricoEstoque(sku) {
  document.getElementById('hist-estoque-sku').textContent = sku;
  document.getElementById('hist-estoque-body').innerHTML = '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:16px">Carregando...</td></tr>';
  document.getElementById('modal-hist-estoque').style.display = 'flex';
  try {
    const resp = await apiFetch(`/api/estoque-local/historico?sku=${encodeURIComponent(sku)}`);
    const hist = resp.historico || [];
    const TIPO = { manual: 'Manual', venda: 'Venda', cancelamento: 'Cancelamento' };
    if (hist.length === 0) {
      document.getElementById('hist-estoque-body').innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:16px">Nenhum registro ainda</td></tr>';
      return;
    }
    document.getElementById('hist-estoque-body').innerHTML = hist.map(e => {
      const dt   = new Date(e.ts).toLocaleString('pt-BR');
      const de   = e.anterior !== null && e.anterior !== undefined ? e.anterior : '—';
      const para = e.novo    !== null && e.novo    !== undefined ? e.novo    : '—';
      const tipo = TIPO[e.tipo] || e.tipo;
      const pedido = e.pedido_id ? `#${e.pedido_id}` : '—';
      return `<tr style="border-bottom:1px solid #1e293b">
        <td style="padding:6px 8px;color:#e2e8f0">${dt}</td>
        <td style="padding:6px 8px;color:#e2e8f0">${e.usuario || '—'}</td>
        <td style="padding:6px 8px;color:#e2e8f0">${de} → ${para}</td>
        <td style="padding:6px 8px;color:#94a3b8">${tipo}</td>
        <td style="padding:6px 8px;color:#94a3b8">${pedido}</td>
      </tr>`;
    }).join('');
  } catch {
    document.getElementById('hist-estoque-body').innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:#f87171;padding:16px">Erro ao carregar histórico</td></tr>';
  }
}

async function transferirEstoque(mlb) {
  const item  = todosItens.find(i => i.mlb === mlb);
  const sku   = item?.sku ? String(item.sku) : null;
  const valor = sku !== null ? estoqueLocal[sku] : undefined;
  if (valor === undefined || valor === '') {
    alert('Digite um valor de estoque local primeiro.');
    return;
  }
  if (!confirm(`Transferir estoque ${valor} para o anúncio ${mlb}?`)) return;
  try {
    const conta = app2ContaAtual();
    const response = await apiFetch(`/api/ml/estoque/${mlb}?conta=${conta}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantidade: parseInt(valor, 10) })
    });
    if (response.error) { alert('Erro ao atualizar estoque: ' + response.error + (response.detalhe ? '\n\n' + response.detalhe : '')); return; }
    alert('Estoque atualizado com sucesso!');
    await carregarEstoque(true);
  } catch (error) {
    alert('Erro ao conectar com o servidor.');
  }
}

async function carregarEstoqueLocal() {
  try {
    const response = await apiFetch('/api/estoque-local');
    if (response.estoque_local) estoqueLocal = response.estoque_local;
  } catch (error) {
    console.error('Erro ao carregar estoque local:', error);
    estoqueLocal = {};
  }
}

async function salvarEstoqueLocalDireto(chave, valor) {
  await apiFetch('/api/estoque-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: chave, quantidade: String(valor) })
  });
}

async function sincronizarEstoqueLocal(itens) {
  try {
    const items = itens.filter(i => i.sku && i.sku !== '—').map(i => ({ mlb: i.mlb, sku: String(i.sku) }));
    const conta = app2ContaAtual();
    const response = await apiFetch('/api/estoque-local/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, conta })
    });
    if (response.estoque_local) estoqueLocal = response.estoque_local;
  } catch (error) {
    console.error('Erro ao sincronizar estoque local:', error);
    if (Object.keys(estoqueLocal).length === 0) await carregarEstoqueLocal();
  }
  // Migra chaves MLB → SKU para itens que ganharam SKU desde a última vez
  for (const item of itens) {
    if (!item.sku || item.sku === '—') continue;
    const mlbKey = `_mlb_${item.mlb}`;
    if (estoqueLocal[mlbKey] !== undefined && estoqueLocal[item.sku] === undefined) {
      const valor = estoqueLocal[mlbKey];
      await salvarEstoqueLocalDireto(item.sku, valor);
      await salvarEstoqueLocalDireto(mlbKey, '');
      estoqueLocal[item.sku] = valor;
      delete estoqueLocal[mlbKey];
    }
  }
}

async function atualizarEstoque(mlb, btn) {
  const input  = btn.previousElementSibling;
  const novaQtd = parseInt(input.value, 10);
  if (isNaN(novaQtd) || novaQtd < 0) return;

  btn.disabled    = true;
  btn.textContent = '...';

  try {
    const conta = app2ContaAtual();
    const result = await apiFetch(`/api/ml/estoque/${mlb}?conta=${conta}`, {
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

    const isFull  = item.deposito === 'fulfillment';
    const skuKey  = (item.sku && item.sku !== '—') ? String(item.sku) : `_mlb_${item.mlb}`;
    const estoqueLocalValor = skuKey !== null && estoqueLocal[skuKey] !== undefined ? estoqueLocal[skuKey] : '';

    const estoqueLocalCell = (skuKey && !temVariacoes)
      ? `<td class="col-num" style="white-space:nowrap"><input type="number" class="estoque-local-input" data-sku="${skuKey}" value="${estoqueLocalValor}" placeholder="—" min="0" style="width:58px;text-align:center"> <button class="btn-hist-estoque" data-sku="${skuKey}" title="Histórico de alterações">📋</button></td>`
      : `<td class="col-num"></td>`;

    const transferirCell = (isFull || temVariacoes)
      ? `<td class="col-num"></td>`
      : `<td class="col-num"><button class="btn-transferir" data-mlb="${item.mlb}" onclick="transferirEstoque('${item.mlb}')" title="Transferir estoque local para ML">→</button></td>`;

    let estoqueForaFullCell;
    if (isFull) {
      estoqueForaFullCell = `<td class="col-num"></td>`;
    } else if (temVariacoes) {
      const aberto = expandedMLBs.has(item.mlb);
      estoqueForaFullCell = `<td class="col-num"><div class="estoque-edit-wrap"><span id="estoque-total-${item.mlb}" class="${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}</span><button id="btn-expandir-${item.mlb}" class="btn-expandir-var" onclick="toggleVariacoes('${item.mlb}')">${aberto ? '▲' : '▼'}</button></div></td>`;
    } else {
      const localDef = skuKey && estoqueLocal[skuKey] !== undefined;
      const diverge  = localDef && item.estoque !== estoqueLocal[skuKey];
      const avisoDiv = diverge ? ` <span title="Diverge do Estoque Local" style="color:#f59e0b;font-weight:bold;cursor:default">!</span>` : '';
      estoqueForaFullCell = `<td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">${item.estoque}${avisoDiv}</td>`;
    }

    let estoqueFullCell;
    if (isFull) {
      estoqueFullCell = `<td class="col-num ${item.estoque === 0 ? 'estoque-zero' : ''}">
        ${item.estoque}
        <button class="btn-sm" onclick="sairFull('${item.mlb}')" style="font-size:10px;margin-left:5px;background:#f59e0b;color:#fff;padding:1px 6px" title="Abrir painel do ML para sair do Full">Sair Full</button>
      </td>`;
    } else {
      estoqueFullCell = `<td class="col-num"></td>`;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-sku">${item.sku}</td>
      <td class="td-titulo" title="${item.titulo}">${item.permalink ? `<a class="link-anuncio" href="${item.permalink}" target="_blank">${item.titulo}</a>` : item.titulo}</td>
      <td class="td-mlb">${item.mlb}</td>
      <td><span class="badge-deposito ${bDeposito}">${item.depositoLabel}</span></td>
      <td><span class="badge-deposito ${bStatus}">${STATUS_LABEL[item.status] || item.status}</span></td>
      ${estoqueLocalCell}
      ${transferirCell}
      ${estoqueForaFullCell}
      ${estoqueFullCell}
      <td class="col-num">${item.vendas30d === null ? '...' : (item.vendas30d || '—')}</td>
      <td class="col-num ${duracao.classe}">${item.vendas30d === null ? '...' : duracao.texto}</td>
    `;
    tbody.appendChild(tr);

    if (temVariacoes) {
      const aberto = expandedMLBs.has(item.mlb);
      item.variacoes.forEach(v => {
        const trVar = document.createElement('tr');
        trVar.className = `variacao-row variacao-row-${item.mlb}`;
        trVar.style.display = aberto ? '' : 'none';
        trVar.innerHTML = `
          <td colspan="5" class="variacao-indent"></td>
          <td colspan="2" class="variacao-nome">↳ ${v.nome}</td>
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

  document.querySelectorAll('.estoque-local-input').forEach(input => {
    input.addEventListener('change', salvarEstoqueLocal);
    input.addEventListener('input', salvarEstoqueLocal);
  });

  document.querySelectorAll('.btn-hist-estoque').forEach(btn => {
    btn.addEventListener('click', () => abrirHistoricoEstoque(btn.dataset.sku));
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
    estoqueData = await apiFetch(`/api/ml/estoque?conta=${window.CONTA_ATIVA}`);
    clog(`carregarEstoque() resposta: ${JSON.stringify(estoqueData).slice(0,100)}`);
    if (contaGen !== gen) { clog(`carregarEstoque() descartado (gen mudou)`, 'warn'); return; }
    loading.style.display = 'none';

    if (estoqueData.error) {
      erroEl.textContent   = estoqueData.error;
      erroEl.style.display = 'block';
      return;
    }

    todosItens = estoqueData.items.map(item => ({ ...item, vendas30d: null }));
    await sincronizarEstoqueLocal(todosItens);
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
    const resp = await fetch(`/api/ml/vendas30dias?conta=${window.CONTA_ATIVA}`, { signal: controller.signal });
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
// (estado todosAdsItens/sortAds/expandedCamps declarado no topo do arquivo)

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

// Preço (última venda, refletindo promoção) e lucro unitário (sem ads) de um produto
function precoELucroDoMlb(mlb) {
  const info = custoLucroPorMlb[mlb];
  return {
    preco:     info?.ultimaVenda?.precoUnit ?? info?.preco ?? null,
    lucroUnit: info?.ultimaVenda?.lucroUnitario ?? null,
  };
}

// Maior gasto de ads por venda que ainda mantém a margem mínima definida pelo usuário.
// margem% = (lucroUnit - gasto) / preco  →  gasto = lucroUnit - margem% * preco
function gastoSugeridoAds(mlb) {
  const { preco, lucroUnit } = precoELucroDoMlb(mlb);
  if (!preco || lucroUnit == null) return null;
  const sugerido = lucroUnit - (margemMinimaAds / 100) * preco;
  return Math.max(0, sugerido);
}

// Simulação: dado o preço e o lucro (sem ads) da última venda, calcula o ROAS
// necessário e o lucro resultante pro "gasto máx. por venda" em uso
function calcSimulacaoAds(mlb) {
  const fmtBRL = v => v != null ? `R$ ${v.toFixed(2).replace('.', ',')}` : '—';
  const { preco, lucroUnit } = precoELucroDoMlb(mlb);
  const gastoMax = gastoMaxPorMlb[mlb];

  if (!preco || !gastoMax || gastoMax <= 0) return { roas: '—', lucro: '—' };

  const roasIdeal = preco / gastoMax;
  if (lucroUnit == null) return { roas: `${roasIdeal.toFixed(2)}x`, lucro: '—' };

  const lucroApos = lucroUnit - gastoMax;
  const lucroPct  = preco > 0 ? (lucroApos / preco * 100) : null;
  return {
    roas:  `${roasIdeal.toFixed(2)}x`,
    lucro: `${fmtBRL(lucroApos)}${lucroPct != null ? ` (${lucroPct.toFixed(1)}%)` : ''}`,
  };
}

function atualizarSimulacaoAds(mlb, valor) {
  gastoMaxManual[mlb] = true;
  const num = parseFloat(String(valor).replace(',', '.'));
  gastoMaxPorMlb[mlb] = isNaN(num) || num <= 0 ? null : num;
  const { roas, lucro } = calcSimulacaoAds(mlb);
  const roasEl  = document.getElementById(`roas-ideal-${mlb}`);
  const lucroEl = document.getElementById(`lucro-apos-${mlb}`);
  if (roasEl)  roasEl.textContent  = roas;
  if (lucroEl) lucroEl.textContent = lucro;
}

function resetGastoSugeridoAds(mlb) {
  gastoMaxManual[mlb] = false;
  gastoMaxPorMlb[mlb] = gastoSugeridoAds(mlb);
  const inputEl = document.getElementById(`gasto-max-${mlb}`);
  if (inputEl) inputEl.value = gastoMaxPorMlb[mlb] != null ? gastoMaxPorMlb[mlb].toFixed(2) : '';
  const { roas, lucro } = calcSimulacaoAds(mlb);
  const roasEl  = document.getElementById(`roas-ideal-${mlb}`);
  const lucroEl = document.getElementById(`lucro-apos-${mlb}`);
  if (roasEl)  roasEl.textContent  = roas;
  if (lucroEl) lucroEl.textContent = lucro;
}

function mudarMargemMinimaAds(valor) {
  const num = parseFloat(String(valor).replace(',', '.'));
  margemMinimaAds = isNaN(num) ? 0 : num;
  renderizarAds();
}

function tdsSimulacaoAds(mlb) {
  const fmtBRL = v => v != null ? `R$ ${v.toFixed(2).replace('.', ',')}` : '—';
  const { preco } = precoELucroDoMlb(mlb);

  if (!gastoMaxManual[mlb]) gastoMaxPorMlb[mlb] = gastoSugeridoAds(mlb);
  const gastoMax = gastoMaxPorMlb[mlb];
  const { roas, lucro } = calcSimulacaoAds(mlb);

  return `
    <td class="col-num">${fmtBRL(preco)}</td>
    <td class="col-num">
      <div style="display:flex;align-items:center;gap:4px;justify-content:flex-end">
        <input type="number" id="gasto-max-${mlb}" step="0.01" min="0" style="width:64px" placeholder="R$" value="${gastoMax != null ? gastoMax.toFixed(2) : ''}" oninput="atualizarSimulacaoAds('${mlb}', this.value)">
        <button class="btn-expandir-var" title="Voltar pra sugestão automática" onclick="resetGastoSugeridoAds('${mlb}')">↺</button>
      </div>
    </td>
    <td class="col-num" id="roas-ideal-${mlb}">${roas}</td>
    <td class="col-num" id="lucro-apos-${mlb}">${lucro}</td>
  `;
}

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

    // Custo cadastrado / lucro da última venda — só dá pra mostrar direto quando é 1 produto só
    const soUmAd = item.adsLista && item.adsLista.length === 1 ? item.adsLista[0] : null;
    const infoUm = soUmAd ? custoLucroPorMlb[soUmAd.id] : null;
    const custoCell = infoUm ? `<td class="col-num">${fmtBRL(infoUm.custo)}</td>` : '<td class="col-num">—</td>';
    const lucroCell = infoUm?.ultimaVenda
      ? `<td class="col-num" title="Venda de ${infoUm.ultimaVenda.data?.slice(0,10) || '?'}">${fmtBRL(infoUm.ultimaVenda.lucro)}</td>`
      : '<td class="col-num">—</td>';
    const simCells = soUmAd
      ? tdsSimulacaoAds(soUmAd.id)
      : '<td class="col-num">—</td><td class="col-num">—</td><td class="col-num">—</td><td class="col-num">—</td>';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-campanha" title="${item.campanha}">${item.campanha}</td>
      ${anunciosCell}
      <td class="col-num">${fmtRoas(item.targetRoas)}</td>
      <td class="col-num ${roasClass}">${fmtRoas(item.roasEntregando)}</td>
      <td class="col-num">${fmtBRL(item.custoPorUnidade)}</td>
      <td class="col-num">${fmtBRL(item.cost)}</td>
      <td class="col-num">${item.units || '—'}</td>
      ${custoCell}
      ${lucroCell}
      ${simCells}
    `;
    tbody.appendChild(tr);

    // Sub-linhas para cada anúncio (só quando tem múltiplos)
    if (temMultiplos) {
      item.adsLista.forEach(ad => {
        const info = custoLucroPorMlb[ad.id];
        const detalhe = info
          ? ` — Custo: ${fmtBRL(info.custo)} | Lucro últ. venda: ${info.ultimaVenda ? fmtBRL(info.ultimaVenda.lucro) : '—'}`
          : '';
        const trAd = document.createElement('tr');
        trAd.className = `camp-row camp-row-${campId}`;
        trAd.style.display = aberto ? '' : 'none';
        trAd.innerHTML = `
          <td class="variacao-indent"></td>
          <td colspan="8" class="variacao-nome">↳ ${ad.title}${detalhe}</td>
          ${tdsSimulacaoAds(ad.id)}
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
    const data = await apiFetch(`/api/ml/ads-roas?conta=${window.CONTA_ATIVA}`, { _timeout: 90000 });
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
    carregarCustoLucroAds();
  } catch (e) {
    loading.style.display = 'none';
    const motivo = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? 'demorou demais e foi cancelado (a conta pode ter muitas campanhas)'
      : (e?.message || 'motivo desconhecido');
    erroEl.textContent   = `Erro ao carregar dados de ads: ${motivo}`;
    erroEl.style.display = 'block';
  }
}

async function carregarCustoLucroAds() {
  const mlbs = [...new Set(todosAdsItens.flatMap(item => (item.adsLista || []).map(ad => ad.id)))];
  if (!mlbs.length) return;

  try {
    const data = await apiFetch(`/api/ml/ads-custo-lucro?conta=${window.CONTA_ATIVA}&mlbs=${mlbs.join(',')}`, { _timeout: 60000 });
    if (data.error) return;
    custoLucroPorMlb = data.resultado || {};
    renderizarAds();
  } catch {}
}

// ── Sair ──────────────────────────────────────────────────────

function sair() {
  localStorage.removeItem('auth');
  localStorage.removeItem('abasPermitidas');
  location.href = '/';
}

// ── Sair do Full ─────────────────────────────────────────────

function sairFull(mlb) {
  window.open(`https://www.mercadolivre.com.br/anuncios/lista/space_management?search=${mlb.replace('MLB','')}`, '_blank');
}

// ── Inicialização ─────────────────────────────────────────────

inicializarSeletorConta();
carregarConfig('1');
atualizarStatus();
setInterval(atualizarStatus, 60_000);
