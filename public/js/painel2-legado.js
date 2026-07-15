// ============================================================
// painel2-legado.js — Painel Legado (Vendas + Scanner)
// Cópia do painel2.js sem ?. / ?? (Safari <13.1 nao entende essa sintaxe)
// Nao sincroniza automaticamente com painel2.js — atualizar manualmente se pedido
// ============================================================

// ── Conta ativa (fonte da verdade: URL ?conta=) ───────────────
window.CONTA_ATIVA = new URLSearchParams(location.search).get('conta') || '1';

// ── Navegação entre abas ──────────────────────────────────────

const navBtns = document.querySelectorAll('.nav-btn');
const tabs    = document.querySelectorAll('.tab');

function abrirAba(nome) {
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === nome));
  tabs.forEach(t => t.classList.toggle('active', t.id === `tab-${nome}`));
  history.replaceState(null, '', '/legado.html?conta=' + (window.CONTA_ATIVA || '1') + '&tab=' + nome);
  if (trocandoConta) return;
  if (nome === 'vendas')       carregarVendas();
  if (nome === 'scanner')      scannerInit();
}

navBtns.forEach(btn => {
  btn.addEventListener('click', e => { e.preventDefault(); abrirAba(btn.dataset.tab); });
});

// ── Troca de conta ────────────────────────────────────────────

let trocandoConta = false;

function trocarConta(num) {
  const elAtivo = document.querySelector('.tab.active');
  const abaAtiva = (elAtivo != null && elAtivo.id != null) ? elAtivo.id.replace('tab-', '') : null;
  location.href = '/legado.html?conta=' + num + '&tab=' + (abaAtiva || 'vendas');
}

// Inicializa seletor de conta — ativo vem da URL, nickname do servidor
async function inicializarSeletorConta() {
  document.querySelectorAll('.conta-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.conta === window.CONTA_ATIVA);
  });
  try {
    const data = await apiFetch('/api/conta/ativa');
    document.querySelectorAll('.conta-btn').forEach(b => {
      const contaInfo = data.contas != null ? data.contas[b.dataset.conta] : undefined;
      const nickname = contaInfo != null ? contaInfo.nickname : undefined;
      if (nickname) b.textContent = nickname;
    });
  } catch {}
}

// ── Geração de conta (evita sobrescrita por respostas atrasadas) ──

let contaGen = 0; // incrementado a cada troca; cada load guarda sua geração

// ── Helpers ───────────────────────────────────────────────────

async function apiFetch(url, opts = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return resp.json();
}

function painel2ContaAtual() {
  return window.CONTA_ATIVA || '1';
}

// ── Estoque ───────────────────────────────────────────────────

let todosItens = [];
let filtros    = { deposito: 'todos', status: 'todos' };
let sortState    = { campo: null, direcao: 'asc' };
let expandedMLBs = new Set();
let estoqueLocal = {}; // Armazenamento local do estoque

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
      const vaTmp = calcularDiasPausado(a.status, a.pausadoDesde);
      const vbTmp = calcularDiasPausado(b.status, b.pausadoDesde);
      va = (vaTmp === null || vaTmp === undefined) ? -1 : vaTmp;
      vb = (vbTmp === null || vbTmp === undefined) ? -1 : vbTmp;
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

// Salva o estoque local no servidor (chaveado por SKU)
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

// Transfere o estoque local para o Mercado Livre
async function transferirEstoque(mlb) {
  const item  = todosItens.find(i => i.mlb === mlb);
  const sku   = (item != null && item.sku) ? String(item.sku) : null;
  const valor = sku !== null ? estoqueLocal[sku] : undefined;
  if (valor === undefined || valor === '') {
    alert('Digite um valor de estoque local primeiro.');
    return;
  }
  if (!confirm(`Transferir estoque ${valor} para o anúncio ${mlb}?`)) return;
  try {
    const response = await apiFetch(`/api/ml/estoque/${mlb}?conta=${contaAtual()}`, {
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

// Carrega o estoque local do servidor
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
    const conta = contaAtual();
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

function calcularDuracao(estoque, vendas30d) {
  if (estoque === 0)   return { texto: 'Zerado',  classe: 'duracao-zerado' };
  if (!vendas30d)      return { texto: '∞',        classe: 'duracao-infinito' };
  const dias = Math.round(estoque / (vendas30d / 30));
  let classe = 'duracao-ok';
  if (dias <= 15)      classe = 'duracao-critico';
  else if (dias <= 30) classe = 'duracao-alerta';
  return { texto: `${dias}d`, classe };
}

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
    const conta = painel2ContaAtual();
    const result = await apiFetch(`/api/ml/estoque/${mlb}?conta=${conta}`, {
      method: 'PUT',
      body:   JSON.stringify({ quantidade: novaQtd, variacao_id: variacaoId }),
    });
    if (result.error) {
      btn.textContent = '✗';
      btn.classList.add('btn-confirmar-erro');
      btn.title = `${result.error} (conta ML ${result.conta || conta})`;
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
  const input   = btn.previousElementSibling;
  const novaQtd = parseInt(input.value, 10);
  if (isNaN(novaQtd) || novaQtd < 0) return;

  btn.disabled    = true;
  btn.textContent = '...';

  try {
    const conta = painel2ContaAtual();
    const result = await apiFetch(`/api/ml/estoque/${mlb}?conta=${conta}`, {
      method: 'PUT',
      body:   JSON.stringify({ quantidade: novaQtd }),
    });
    if (result.error) {
      btn.textContent = '✗';
      btn.classList.add('btn-confirmar-erro');
      btn.title = `${result.error} (conta ML ${result.conta || conta})`;
      setTimeout(() => {
        btn.textContent = '✓';
        btn.classList.remove('btn-confirmar-erro');
        btn.title    = '';
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
  const elSku = document.getElementById('filtro-sku');
  const elTitulo = document.getElementById('filtro-titulo');
  const skuFiltro    = ((elSku != null ? elSku.value : '') || '').trim().toLowerCase();
  const tituloFiltro = ((elTitulo != null ? elTitulo.value : '') || '').trim().toLowerCase();
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

  // Adicionar event listeners para os inputs de estoque local
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

async function carregarEstoque(reiniciar = false) {
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
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (estoqueData.error) {
      erroEl.textContent   = estoqueData.error;
      erroEl.style.display = 'block';
      return;
    }

    todosItens = estoqueData.items.map(item => ({ ...item, vendas30d: null }));
    await sincronizarEstoqueLocal(todosItens);
    renderizarTabela();
  } catch {
    if (contaGen !== gen) return;
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar estoque.';
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

// ── Vendas com etiqueta ───────────────────────────────────────

function formatarPrazo(iso) {
  if (!iso) return '<span style="color:#aaa">—</span>';
  const prazo = new Date(iso);
  const diff  = prazo - Date.now();
  const h     = diff / 3600000;
  const d     = String(prazo.getDate()).padStart(2, '0');
  const mo    = String(prazo.getMonth() + 1).padStart(2, '0');
  const hh    = String(prazo.getHours()).padStart(2, '0');
  const mi    = String(prazo.getMinutes()).padStart(2, '0');
  const txt   = `${d}/${mo} ${hh}:${mi}`;
  if (h < 2)  return `<span style="color:#dc2626;font-weight:700">${txt}</span>`;
  if (h < 6)  return `<span style="color:#d97706;font-weight:600">${txt}</span>`;
  return txt;
}

const vendaCache = {}; // shipmentId → dados completos da venda

const BADGE_VENDA_STATUS = {
  handling:      'badge-pausado',
  ready_to_ship: 'badge-ativo',
  shipped:       'badge-encerrado',
};

function toggleTodasVendas(master) {
  document.querySelectorAll('.check-venda').forEach(cb => cb.checked = master.checked);
  atualizarBotaoSelecionadas();
}

function atualizarBotaoSelecionadas() {
  const checks      = [...document.querySelectorAll('.check-venda:checked')];
  const selecionadas = checks.length;
  const btnBaixar   = document.getElementById('btn-baixar-selecionadas');
  const btnAtendido = document.getElementById('btn-marcar-atendido');

  if (btnBaixar) {
    btnBaixar.style.display = selecionadas > 0 ? '' : 'none';
    btnBaixar.textContent   = `⬇ Baixar ${selecionadas} etiqueta${selecionadas !== 1 ? 's' : ''}`;
  }
  if (btnAtendido) {
    if (selecionadas === 0) {
      btnAtendido.style.display = 'none';
    } else {
      // Se TODOS os selecionados já são atendidos → botão vira "Remover"
      const todosAtendidos = checks.every(cb => {
        const tr = cb.closest('tr');
        return tr != null && tr.classList.contains('venda-atendida');
      });
      btnAtendido.style.display   = '';
      btnAtendido.dataset.remover = todosAtendidos ? '1' : '0';
      if (todosAtendidos) {
        btnAtendido.textContent       = `✕ Remover atendido (${selecionadas})`;
        btnAtendido.style.background  = '#dc2626';
      } else {
        btnAtendido.textContent       = `✔ Marcar atendido (${selecionadas})`;
        btnAtendido.style.background  = '#16a34a';
      }
    }
  }
  // Atualiza estado do checkbox "todas"
  const total  = document.querySelectorAll('.check-venda').length;
  const master = document.getElementById('check-todas');
  if (master) {
    master.checked       = selecionadas === total && total > 0;
    master.indeterminate = selecionadas > 0 && selecionadas < total;
  }
}

async function marcarAtendidoSelecionadas() {
  const checks = [...document.querySelectorAll('.check-venda:checked')];
  if (!checks.length) return;
  const btn     = document.getElementById('btn-marcar-atendido');
  const remover = (btn != null && btn.dataset.remover === '1');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }

  const shipmentIds = checks.map(cb => cb.dataset.shipmentId);
  const vendasDados = {};
  if (!remover) shipmentIds.forEach(sid => { if (vendaCache[sid]) vendasDados[sid] = vendaCache[sid]; });

  try {
    const r = await apiFetch('/api/vendas/atendidas-batch', {
      method: remover ? 'DELETE' : 'POST',
      body: JSON.stringify({ shipmentIds, vendasDados, conta: window.CONTA_ATIVA }),
    });
    if (r.ok) {
      checks.forEach(cb => {
        const tr = cb.closest('tr');
        if (!tr) return;
        if (remover) {
          tr.classList.remove('venda-atendida');
          const flagBtn = tr.querySelector('.btn-flag');
          if (flagBtn) { flagBtn.classList.remove('btn-flag-ativo'); flagBtn.title = 'Marcar como atendido'; }
        } else {
          tr.classList.add('venda-atendida');
          const flagBtn = tr.querySelector('.btn-flag');
          if (flagBtn) { flagBtn.classList.add('btn-flag-ativo'); flagBtn.title = 'Remover flag'; }
        }
        let next = tr.nextElementSibling;
        while (next && next.classList.contains('venda-sub-item')) {
          next.classList.toggle('venda-atendida', !remover);
          next = next.nextElementSibling;
        }
        cb.checked = false;
      });
      atualizarBotaoSelecionadas();
      aplicarFiltroAtendidos();
    } else {
      alert('Erro ao salvar. Tente novamente.');
    }
  } catch {
    alert('Erro ao salvar. Tente novamente.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function baixarSelecionadas() {
  const checks = document.querySelectorAll('.check-venda:checked');
  if (!checks.length) return;

  // Agrupa por conta para montar as URLs corretas
  const porConta = {};
  checks.forEach(cb => {
    const conta = cb.dataset.conta;
    if (!porConta[conta]) porConta[conta] = [];
    porConta[conta].push(cb.dataset.shipmentId);
  });

  for (const [conta, ids] of Object.entries(porConta)) {
    window.open(`/api/ml/etiquetas?ids=${ids.join(',')}&conta=${conta}`, '_blank');
  }
}

let filtroAtendidos  = false;
let skuFiltroVendas  = null;
let skuFiltroFuturos = null;

function toggleFiltroAtendidos() {
  filtroAtendidos = !filtroAtendidos;
  const btn = document.getElementById('btn-filtro-atendidos');
  btn.classList.toggle('btn-primary', filtroAtendidos);
  btn.classList.toggle('btn-secondary', !filtroAtendidos);
  aplicarFiltroAtendidos();
}

function aplicarFiltroAtendidos() {
  const tbody = document.getElementById('tabela-vendas-body');
  let visiveis = 0;
  for (const tr of tbody.querySelectorAll('tr')) {
    if (tr.classList.contains('venda-sub-item')) continue;
    const atendida = tr.classList.contains('venda-atendida');
    const skuMatch = !skuFiltroVendas || (tr.dataset.skus || '').split(' ').includes(skuFiltroVendas);
    const visivel  = (!filtroAtendidos || atendida) && skuMatch;
    tr.style.display = visivel ? '' : 'none';
    let next = tr.nextElementSibling;
    while (next && next.classList.contains('venda-sub-item')) {
      next.style.display = visivel ? '' : 'none';
      next = next.nextElementSibling;
    }
    if (visivel) visiveis++;
  }
  const totalEl = document.getElementById('vendas-total');
  const total   = tbody.querySelectorAll('tr:not(.venda-sub-item)').length;
  if (filtroAtendidos) {
    totalEl.textContent = `${visiveis} pedido${visiveis !== 1 ? 's' : ''} flagado${visiveis !== 1 ? 's' : ''}`;
  } else if (skuFiltroVendas) {
    totalEl.textContent = `${visiveis} de ${total} pedido${total !== 1 ? 's' : ''}`;
  } else {
    const atendidos = tbody.querySelectorAll('tr.venda-atendida:not(.venda-sub-item)').length;
    totalEl.textContent = `${total} pedido${total !== 1 ? 's' : ''}${atendidos ? ` · ${atendidos} flagado${atendidos !== 1 ? 's' : ''}` : ''}`;
  }
}

function aplicarFiltroFuturos() {
  const tbody = document.getElementById('tabela-futuros-body');
  if (!tbody) return;
  let visiveis = 0;
  for (const tr of tbody.querySelectorAll('tr')) {
    if (tr.classList.contains('venda-sub-item')) continue;
    if (tr.classList.contains('futuros-data-sep')) continue;
    const skuMatch = !skuFiltroFuturos || (tr.dataset.skus || '').split(' ').includes(skuFiltroFuturos);
    tr.style.display = skuMatch ? '' : 'none';
    let next = tr.nextElementSibling;
    while (next && next.classList.contains('venda-sub-item')) {
      next.style.display = skuMatch ? '' : 'none';
      next = next.nextElementSibling;
    }
    if (skuMatch) visiveis++;
  }
  const totalEl = document.getElementById('futuros-total');
  const total   = tbody.querySelectorAll('tr:not(.venda-sub-item)').length;
  totalEl.textContent = skuFiltroFuturos
    ? `${visiveis} de ${total} pedido${total !== 1 ? 's' : ''}`
    : `${total} pedido${total !== 1 ? 's' : ''}`;
}

function renderizarChipsSKU(tipo, lista) {
  const container = document.getElementById(tipo === 'vendas' ? 'vendas-sku-chips' : 'futuros-sku-chips');
  if (!container) return;
  const skuMap = new Map();
  for (const venda of lista) {
    for (const item of (venda.itensLista || [])) {
      if (!item.sku) continue;
      skuMap.set(item.sku, (skuMap.get(item.sku) || 0) + (item.quantidade || 0));
    }
  }
  if (!skuMap.size) { container.innerHTML = ''; return; }
  const skus = [...skuMap.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  container.innerHTML = skus.map(sku =>
    `<button class="chip-sku" data-sku="${sku}" onclick="filtrarPorSku('${tipo}', this.dataset.sku)">${sku} · ${skuMap.get(sku)}un</button>`
  ).join('');
}

function filtrarPorSku(tipo, sku) {
  if (tipo === 'vendas') {
    skuFiltroVendas = skuFiltroVendas === sku ? null : sku;
    document.querySelectorAll('#vendas-sku-chips .chip-sku').forEach(btn =>
      btn.classList.toggle('chip-sku-ativo', btn.dataset.sku === skuFiltroVendas)
    );
    aplicarFiltroAtendidos();
  } else {
    skuFiltroFuturos = skuFiltroFuturos === sku ? null : sku;
    document.querySelectorAll('#futuros-sku-chips .chip-sku').forEach(btn =>
      btn.classList.toggle('chip-sku-ativo', btn.dataset.sku === skuFiltroFuturos)
    );
    aplicarFiltroFuturos();
  }
}

async function carregarVendas() {
  const gen     = contaGen;
  const loading = document.getElementById('vendas-loading');
  const erroEl  = document.getElementById('vendas-erro');
  const totalEl = document.getElementById('vendas-total');
  const tabela  = document.getElementById('tabela-vendas');
  const tbody   = document.getElementById('tabela-vendas-body');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  tabela.style.display  = 'none';
  totalEl.textContent   = '';
  tbody.innerHTML       = '';
  skuFiltroVendas       = null;

  try {
    const data = await apiFetch(`/api/ml/vendas-etiquetas?conta=${window.CONTA_ATIVA}`);
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    const todasVendas = data.vendas || [];
    if (!todasVendas.length) { atualizarBotaoSelecionadas(); return; }

    todasVendas.forEach(v => {
      vendaCache[String(v.shipmentId)] = v;
      const bStatus = BADGE_VENDA_STATUS[v.status] || 'badge-outro';
      const itens   = v.itensLista || [];
      const item0   = itens[0] || {};
      const multi   = itens.length > 1;

      const tr = document.createElement('tr');
      tr.dataset.skus = [...new Set(itens.map(i => i.sku).filter(Boolean))].join(' ');
      if (multi)      tr.classList.add('venda-multi-header');
      if (v.atendida) tr.classList.add('venda-atendida');

      const imgHtml0 = item0.thumbnail
        ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb" loading="lazy"></a>`
        : `<div class="venda-thumb-vazio"></div>`;

      const flagClass = v.atendida ? 'btn-flag btn-flag-ativo' : 'btn-flag';
      const flagTitle = v.atendida ? 'Remover flag' : 'Marcar como atendido';

      tr.innerHTML = `
        <td><input type="checkbox" class="check-venda" data-shipment-id="${v.shipmentId}" data-conta="${v.conta}" onchange="atualizarBotaoSelecionadas()"></td>
        <td class="td-thumb">${imgHtml0}</td>
        <td class="td-order-id">#${v.orderId}</td>
        <td>${v.comprador}</td>
        <td class="col-num venda-qtd">${(item0.quantidade === null || item0.quantidade === undefined) ? '' : item0.quantidade}</td>
        <td class="td-sku">${item0.sku || '—'}</td>
        <td class="td-titulo" title="${item0.titulo || ''}${item0.variacao ? ` (${item0.variacao})` : ''}">${item0.titulo || '—'}${item0.variacao ? `<br><span class="venda-variacao">${item0.variacao}</span>` : ''}</td>
        <td><span class="badge-deposito ${bStatus}">${v.statusLabel}</span></td>
        <td><a class="btn-etiqueta" href="/api/ml/etiqueta/${v.shipmentId}?conta=${v.conta}" target="_blank">${v.acaoLabel}</a></td>
        <td><button class="${flagClass}" data-sid="${v.shipmentId}" title="${flagTitle}" onclick="toggleFlag('${v.shipmentId}', this)">✔</button></td>
      `;
      tbody.appendChild(tr);

      for (let i = 1; i < itens.length; i++) {
        const item   = itens[i];
        const isLast = i === itens.length - 1;
        const trSub  = document.createElement('tr');
        trSub.classList.add('venda-sub-item');
        if (isLast) trSub.classList.add('venda-sub-last');
        if (v.atendida) trSub.classList.add('venda-atendida');
        const imgHtml = item.thumbnail
          ? `<a href="${item.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item.thumbnail}" class="venda-thumb" loading="lazy"></a>`
          : `<div class="venda-thumb-vazio"></div>`;
        trSub.innerHTML = `
          <td class="venda-sub-indent"></td>
          <td class="td-thumb">${imgHtml}</td>
          <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
          <td class="col-num venda-qtd">${(item.quantidade === null || item.quantidade === undefined) ? '' : item.quantidade}</td>
          <td class="td-sku">${item.sku || '—'}</td>
          <td class="td-titulo" title="${item.titulo || ''}${item.variacao ? ` (${item.variacao})` : ''}">${item.titulo || '—'}${item.variacao ? `<span class="venda-variacao"> — ${item.variacao}</span>` : ''}</td>
          <td colspan="3"></td>
        `;
        tbody.appendChild(trSub);
      }
    });

    atualizarBotaoSelecionadas();
    tabela.style.display = 'table';
    renderizarChipsSKU('vendas', todasVendas);
    aplicarFiltroAtendidos();
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar vendas.';
    erroEl.style.display = 'block';
  }
}

// ── Pedidos Futuros ──────────────────────────────────────────
let pedidosFuturosAberto    = false;
let pedidosFuturosCarregado = false;

function togglePedidosFuturos() {
  pedidosFuturosAberto = !pedidosFuturosAberto;
  const conteudo  = document.getElementById('futuros-conteudo');
  const chevron   = document.getElementById('futuros-chevron');
  const btnAtu    = document.getElementById('btn-atualizar-futuros');
  conteudo.style.display  = pedidosFuturosAberto ? 'block' : 'none';
  chevron.style.transform = pedidosFuturosAberto ? 'rotate(90deg)' : '';
  btnAtu.style.display    = pedidosFuturosAberto ? '' : 'none';
  if (pedidosFuturosAberto && !pedidosFuturosCarregado) carregarFuturos();
}

async function carregarFuturos() {
  const gen     = contaGen;
  const loading = document.getElementById('futuros-loading');
  const erroEl  = document.getElementById('futuros-erro');
  const totalEl = document.getElementById('futuros-total');
  const tabela  = document.getElementById('tabela-futuros');
  const tbody   = document.getElementById('tabela-futuros-body');

  loading.style.display = 'block';
  erroEl.style.display  = 'none';
  tabela.style.display  = 'none';
  totalEl.textContent   = '';
  tbody.innerHTML       = '';
  skuFiltroFuturos      = null;

  try {
    const data = await apiFetch(`/api/ml/pedidos-futuros?conta=${window.CONTA_ATIVA}`);
    if (contaGen !== gen) return;
    loading.style.display = 'none';

    if (data.error) {
      erroEl.textContent   = data.error;
      erroEl.style.display = 'block';
      return;
    }

    const pedidos = data.pedidos || [];
    pedidosFuturosCarregado = true;
    totalEl.textContent = `${pedidos.length} pedido${pedidos.length !== 1 ? 's' : ''}`;

    if (!pedidos.length) return;

    pedidos.sort((a, b) => {
      if (!a.dataLiberacao && !b.dataLiberacao) return 0;
      if (!a.dataLiberacao) return 1;
      if (!b.dataLiberacao) return -1;
      const dataCmp = a.dataLiberacao.localeCompare(b.dataLiberacao);
      if (dataCmp !== 0) return dataCmp;
      const itemA0 = (a.itensLista && a.itensLista[0]) ? a.itensLista[0] : null;
      const itemB0 = (b.itensLista && b.itensLista[0]) ? b.itensLista[0] : null;
      const skuA = String((itemA0 && itemA0.sku) || '');
      const skuB = String((itemB0 && itemB0.sku) || '');
      return skuA.localeCompare(skuB, undefined, { numeric: true });
    });

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    let dataGrupoAtual = null;

    pedidos.forEach(p => {
      const itens  = p.itensLista || [];
      const item0  = itens[0] || {};
      const multi  = itens.length > 1;
      const dataLib = p.dataLiberacao ? new Date(p.dataLiberacao) : null;
      // Usa a data UTC para evitar que meia-noite UTC vire dia anterior em BRT
      const dataStr = p.dataLiberacao
        ? p.dataLiberacao.slice(0, 10).split('-').reverse().join('/')
        : '—';
      const liberaHoje = dataLib && dataLib <= hoje;

      const dataGrupo = p.dataLiberacao ? p.dataLiberacao.slice(0, 10) : '__sem_data__';
      if (dataGrupo !== dataGrupoAtual) {
        dataGrupoAtual = dataGrupo;
        const trSep = document.createElement('tr');
        trSep.className = 'futuros-data-sep';
        const labelData = liberaHoje
          ? `<span style="color:#d97706">${dataStr} — hoje</span>`
          : dataStr;
        trSep.innerHTML = `<td colspan="7">${labelData}</td>`;
        tbody.appendChild(trSep);
      }

      const tr = document.createElement('tr');
      tr.dataset.skus = [...new Set(itens.map(i => i.sku).filter(Boolean))].join(' ');
      if (multi) tr.classList.add('venda-multi-header');
      if (liberaHoje) tr.style.background = 'rgba(234,179,8,0.08)';

      const imgHtml0 = item0.thumbnail
        ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb" loading="lazy"></a>`
        : `<div class="venda-thumb-vazio"></div>`;

      tr.innerHTML = `
        <td class="td-thumb">${imgHtml0}</td>
        <td class="td-order-id">#${p.orderId}</td>
        <td>${p.comprador}</td>
        <td class="col-num venda-qtd">${(item0.quantidade === null || item0.quantidade === undefined) ? '' : item0.quantidade}</td>
        <td class="td-sku">${item0.sku || '—'}</td>
        <td class="td-titulo" title="${item0.titulo || ''}${item0.variacao ? ` (${item0.variacao})` : ''}">${item0.titulo || '—'}${item0.variacao ? `<br><span class="venda-variacao">${item0.variacao}</span>` : ''}</td>
        <td></td>
      `;
      tbody.appendChild(tr);

      for (let i = 1; i < itens.length; i++) {
        const item   = itens[i];
        const isLast = i === itens.length - 1;
        const trSub  = document.createElement('tr');
        trSub.classList.add('venda-sub-item');
        if (isLast) trSub.classList.add('venda-sub-last');
        const imgHtml = item.thumbnail
          ? `<a href="${item.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item.thumbnail}" class="venda-thumb" loading="lazy"></a>`
          : `<div class="venda-thumb-vazio"></div>`;
        trSub.innerHTML = `
          <td class="td-thumb">${imgHtml}</td>
          <td colspan="2" class="venda-sub-mais">↳ mesmo pedido</td>
          <td class="col-num venda-qtd">${(item.quantidade === null || item.quantidade === undefined) ? '' : item.quantidade}</td>
          <td class="td-sku">${item.sku || '—'}</td>
          <td class="td-titulo" title="${item.titulo || ''}${item.variacao ? ` (${item.variacao})` : ''}">${item.titulo || '—'}${item.variacao ? `<span class="venda-variacao"> — ${item.variacao}</span>` : ''}</td>
          <td></td>
        `;
        tbody.appendChild(trSub);
      }
    });

    tabela.style.display = 'table';
    renderizarChipsSKU('futuros', pedidos);
  } catch {
    loading.style.display = 'none';
    erroEl.textContent   = 'Erro ao carregar pedidos futuros.';
    erroEl.style.display = 'block';
  }
}

// ── Flag ──────────────────────────────────────────────────────

async function toggleFlag(shipmentId, btn) {
  btn.disabled = true;
  const tr       = btn.closest('tr');
  const atendida = tr.classList.contains('venda-atendida');
  const sid      = String(shipmentId);
  try {
    // Usa o endpoint batch (aguarda sync Railway) mesmo para item único
    const vendasDados = {};
    if (!atendida && vendaCache[sid]) vendasDados[sid] = vendaCache[sid];
    await apiFetch('/api/vendas/atendidas-batch', {
      method: atendida ? 'DELETE' : 'POST',
      body: JSON.stringify({ shipmentIds: [sid], vendasDados, conta: window.CONTA_ATIVA }),
    });
    tr.classList.toggle('venda-atendida');
    btn.classList.toggle('btn-flag-ativo');
    btn.title = tr.classList.contains('venda-atendida') ? 'Remover flag' : 'Marcar como atendido';
    let next = tr.nextElementSibling;
    while (next && next.classList.contains('venda-sub-item')) {
      next.classList.toggle('venda-atendida', tr.classList.contains('venda-atendida'));
      next = next.nextElementSibling;
    }
    aplicarFiltroAtendidos();
  } catch {}
  btn.disabled = false;
}

// ── Sair ──────────────────────────────────────────────────────

function sair() {
  localStorage.removeItem('auth');
  localStorage.removeItem('abasPermitidas');
  location.href = '/';
}

// ── Histórico de vendas ───────────────────────────────────────

let histDados = []; // cache local para busca sem nova chamada ao servidor

function histIniciarDatas() {
  const ini = document.getElementById('hist-data-ini');
  const fim = document.getElementById('hist-data-fim');
  if (!ini || !fim || ini.value) return;
  const hoje = new Date();
  const fim7 = hoje.toISOString().split('T')[0];
  const ini7 = new Date(hoje);
  ini7.setDate(hoje.getDate() - 6);
  ini.value = ini7.toISOString().split('T')[0];
  fim.value = fim7;
}

async function carregarHistorico() {
  const loading = document.getElementById('hist-loading');
  const vazio   = document.getElementById('hist-vazio');
  const tabela  = document.getElementById('tabela-hist');
  const tbody   = document.getElementById('tabela-hist-body');
  if (!tbody) return;

  const elIni = document.getElementById('hist-data-ini');
  const elFim = document.getElementById('hist-data-fim');
  const ini = (elIni != null ? elIni.value : '') || '';
  const fim = (elFim != null ? elFim.value : '') || '';

  if (loading) loading.style.display = 'block';
  if (tabela)  tabela.style.display  = 'none';
  if (vazio)   vazio.style.display   = 'none';

  try {
    await apiFetch('/api/vendas/historico/sincronizar', { method: 'POST', body: JSON.stringify({ conta: window.CONTA_ATIVA }) });
  } catch {}

  try {
    const params = new URLSearchParams();
    if (ini) params.set('de', ini);
    if (fim) params.set('ate', fim);
    params.set('conta', window.CONTA_ATIVA);
    const d = await apiFetch(`/api/vendas/historico?${params}`);
    histDados = d.historico || [];
  } catch {
    histDados = [];
  }

  if (loading) loading.style.display = 'none';
  renderizarHistorico();
}

function renderizarHistorico() {
  const vazio   = document.getElementById('hist-vazio');
  const tabela  = document.getElementById('tabela-hist');
  const tbody   = document.getElementById('tabela-hist-body');
  const totalEl = document.getElementById('hist-total');
  if (!tbody) return;

  const elBusca = document.getElementById('hist-busca');
  const termo = ((elBusca != null ? elBusca.value : '') || '').toLowerCase().trim();

  const filtrado = termo ? histDados.filter(h => {
    const skus  = (h.itensLista || []).map(i => i.sku).join(' ');
    const itens = (h.itensLista || []).map(i => i.titulo + ' ' + (i.variacao || '')).join(' ');
    return [String(h.orderId), h.comprador || '', skus, itens].some(s => s.toLowerCase().includes(termo));
  }) : histDados;

  if (totalEl) totalEl.textContent = filtrado.length ? `${filtrado.length} pedido${filtrado.length !== 1 ? 's' : ''}` : '';

  if (!filtrado.length) {
    if (tabela) tabela.style.display = 'none';
    if (vazio)  vazio.style.display  = 'block';
    if (vazio)  vazio.textContent    = 'Nenhum pedido encontrado neste período.';
    return;
  }

  if (vazio)  vazio.style.display  = 'none';
  if (tabela) tabela.style.display = 'table';

  tbody.innerHTML = '';
  for (const h of filtrado) {
    const dataFmt = (h.dataDespacho || h.data) ? new Date(h.dataDespacho || h.data).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—';
    const qtdTotal = (h.itensLista || []).reduce((s, i) => s + (i.quantidade || 1), 0);
    const skus  = [...new Set((h.itensLista || []).map(i => i.sku).filter(Boolean))].join(', ') || '—';
    const itens = (h.itensLista || []).map(i => `${i.titulo}${i.variacao ? ' — ' + i.variacao : ''}${i.quantidade > 1 ? ' (x' + i.quantidade + ')' : ''}`).join('<br>');
    const atendidoHtml = h.atendida
      ? `<span style="color:#16a34a;font-size:12px">✔ Sim${h.atendidaEm ? '<br><span style="font-size:11px;color:#94a3b8">' + new Date(h.atendidaEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</span>' : ''}</span>`
      : '<span style="color:#94a3b8;font-size:12px">—</span>';
    const item0 = (h.itensLista || [])[0];
    const imgHtml = (item0 != null && item0.thumbnail)
      ? `<a href="${item0.permalink || '#'}" target="_blank" class="venda-thumb-link"><img src="${item0.thumbnail}" class="venda-thumb" loading="lazy"></a>`
      : '<span style="color:#94a3b8;font-size:11px">—</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="white-space:nowrap">${dataFmt}</td>
      <td>${imgHtml}</td>
      <td style="white-space:nowrap">#${h.orderId}</td>
      <td>${h.comprador || '—'}</td>
      <td class="col-num">${qtdTotal}</td>
      <td style="font-size:12px;color:#64748b">${skus}</td>
      <td style="font-size:12px">${itens}</td>
      <td>${atendidoHtml}</td>
    `;
    tbody.appendChild(tr);
  }
}


// ── Sair do Full ─────────────────────────────────────────────

function sairFull(mlb) {
  window.open(`https://www.mercadolivre.com.br/anuncios/lista/space_management?search=${mlb.replace('MLB','')}`, '_blank');
}

// ── Inicialização ─────────────────────────────────────────────

function aplicarPermissoesAbas() {
  const permitidas = JSON.parse(localStorage.getItem('abasPermitidas') || 'null');
  if (permitidas && Array.isArray(permitidas)) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      if (!permitidas.includes(btn.dataset.tab)) btn.style.display = 'none';
    });
    document.querySelectorAll('.tab').forEach(tab => {
      const nome = tab.id.replace('tab-', '');
      if (!permitidas.includes(nome)) {
        tab.classList.remove('active');
        tab.style.display = 'none';
      }
    });
    const tabParam2 = new URLSearchParams(location.search).get('tab');
    const tabInicial = (tabParam2 && permitidas.includes(tabParam2)) ? tabParam2 : (permitidas.length > 0 ? permitidas[0] : 'vendas');
    abrirAba(tabInicial);
  } else {
    const tabParam2 = new URLSearchParams(location.search).get('tab');
    abrirAba(tabParam2 || 'vendas');
  }
}

inicializarSeletorConta();
aplicarPermissoesAbas();
