// ── Devoluções (Mercado Livre + Shopee) ─────────────────────────
// Relatório das devoluções a caminho e das que já chegaram, com marcação de
// "NF de devolução emitida" (pra abater o imposto sem se perder). Os dados vêm
// da rotina do servidor que acompanha cada devolução pelo envio de volta.

let devItens = [];
let devFiltro = { situacao: 'todas', nf: 'pendente', conta: 'todas', canal: 'todos', busca: '' };
let devPollTimer = null;
let devErros = [];

function devEsc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function devData(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'America/Sao_Paulo' });
}
// Bling devolve "006961", ML/Shopee "6961" — mostra sem zeros à esquerda
function devNumNf(n) { return /^\d+$/.test(String(n)) ? String(Number(n)) : String(n); }
function devMoeda(v) {
  return v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function devolucoesInit() {
  await devolucoesCarregar();
}

async function devolucoesCarregar() {
  const status = document.getElementById('dev-status');
  try {
    const d = await fetch('/api/devolucoes').then(r => r.json());
    devItens = d.itens || [];
    devRenderStatus(d);
    devRenderContas();
    devRender();
    // Enquanto a rotina roda (principalmente na primeira carga, que varre 12 meses),
    // recarrega sozinho pra ir mostrando o que já foi encontrado.
    clearTimeout(devPollTimer);
    const abaAberta = document.getElementById('tab-devolucoes')?.classList.contains('active');
    if ((d.rodando || d.carregando_historico) && abaAberta) devPollTimer = setTimeout(devolucoesCarregar, 10000);
  } catch {
    if (status) status.textContent = 'Erro ao carregar devoluções.';
  }
}

function devRenderStatus(d) {
  const el = document.getElementById('dev-status');
  if (!el) return;
  let txt = '';
  if (d.rodando) txt = `🔄 Atualizando${d.progresso ? ' — ' + d.progresso : '...'}`;
  else if (d.ultima_execucao) txt = `Atualizado às ${new Date(d.ultima_execucao).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}`;
  if (d.carregando_historico) txt += ' · primeira carga (últimos 12 meses) em andamento — pode levar mais de meia hora';
  el.textContent = txt;
  devErros = d.erros || [];
  if (devErros.length) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'dev-erros-link';
    a.textContent = ` · ⚠️ ${devErros.length} erro(s) na última leitura`;
    a.title = devErros.join('\n');
    a.onclick = (ev) => { ev.preventDefault(); alert('Erros na última leitura:\n\n' + devErros.join('\n')); };
    el.appendChild(a);
  }
}

async function devolucoesAtualizar() {
  const btn = document.getElementById('dev-btn-atualizar');
  if (btn) { btn.disabled = true; setTimeout(() => { btn.disabled = false; }, 5000); }
  await fetch('/api/devolucoes/atualizar', { method: 'POST' }).catch(() => {});
  setTimeout(devolucoesCarregar, 1500);
}

function devRenderContas() {
  const box = document.getElementById('dev-filtro-conta');
  if (!box) return;
  // Conta = empresa: loja Shopee N é a mesma empresa da conta ML N
  const contas = [...new Map(devItens.map(i => [String(i.conta), i.nickname || 'Conta ' + i.conta])).entries()].sort();
  box.innerHTML = [['todas', 'Todas'], ...contas].map(([id, nome]) =>
    `<button class="filtro-btn${devFiltro.conta === id ? ' active' : ''}" onclick="devSetFiltro('conta','${devEsc(id)}')">${devEsc(nome)}</button>`
  ).join('');
}

function devSetFiltro(campo, valor) {
  devFiltro[campo] = valor;
  document.querySelectorAll(`[data-dev-filtro="${campo}"] .filtro-btn`).forEach(b => b.classList.toggle('active', b.dataset.valor === valor));
  if (campo === 'conta') devRenderContas();
  devRender();
}

// Situação a partir do envio de volta
function devSituacao(i) {
  // Chegou sem reembolso (contestação ganha / dinheiro retido): a venda continua
  // valendo, mas o produto voltou e a NF de devolução precisa ser emitida do mesmo jeito.
  if (i.chegou_em && i.canal === 'shopee' && i.status_devolucao === 'CLOSED')
                                           return { txt: 'Chegou · contestação ganha', cls: 'badge-pausado' };
  if (i.chegou_em && i.canal === 'shopee' && i.status_devolucao && i.status_devolucao !== 'ACCEPTED')
                                           return { txt: 'Chegou · reembolso em análise', cls: 'badge-pausado' };
  if (i.chegou_em && i.canal !== 'shopee' && i.reembolso === 'retained')
                                           return { txt: 'Chegou · sem reembolso', cls: 'badge-pausado' };
  if (i.chegou_em)                         return { txt: 'Chegou', cls: 'badge-ativo' };
  if (i.status === 'cancelled')            return { txt: 'Cancelada', cls: 'badge-encerrado' };
  if (i.status === 'not_delivered')        return { txt: 'Não entregue', cls: 'badge-encerrado' };
  if (i.substatus === 'out_for_delivery')  return { txt: 'Saiu pra entrega', cls: 'badge-pausado' };
  if (i.status === 'shipped' || ['picked_up', 'in_hub', 'in_transit', 'dropped_off'].includes(i.substatus)) return { txt: 'A caminho', cls: 'badge-full' };
  return { txt: 'Aguardando postagem', cls: 'badge-outro' };
}

function devFiltrar() {
  const busca = devFiltro.busca.trim().toLowerCase();
  return devItens.filter(i => {
    if (devFiltro.situacao === 'caminho' && i.chegou_em) return false;
    if (devFiltro.situacao === 'chegou' && !i.chegou_em) return false;
    if (devFiltro.nf === 'pendente' && i.nf) return false;
    if (devFiltro.nf === 'emitida' && !i.nf) return false;
    if (devFiltro.conta !== 'todas' && String(i.conta) !== devFiltro.conta) return false;
    if (devFiltro.canal !== 'todos' && (i.canal || 'ml') !== devFiltro.canal) return false;
    if (busca && !`${i.order_id} ${i.comprador || ''} ${i.titulo || ''} ${i.tracking || ''} ${i.nf_venda?.numero ? devNumNf(i.nf_venda.numero) : ''}`.toLowerCase().includes(busca)) return false;
    return true;
  }).sort((a, b) => {
    // Chegadas primeiro (mais recentes no topo), depois as que estão a caminho
    if (!!a.chegou_em !== !!b.chegou_em) return a.chegou_em ? -1 : 1;
    const da = a.chegou_em || a.devolucao_em || '', db = b.chegou_em || b.devolucao_em || '';
    return db.localeCompare(da);
  });
}

function devRender() {
  // Cartões de resumo (sobre tudo, ignorando os filtros)
  const aCaminho   = devItens.filter(i => !i.chegou_em);
  const semNf      = devItens.filter(i => i.chegou_em && !i.nf);
  const comNf      = devItens.filter(i => i.nf);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('dev-card-caminho', aCaminho.length);
  set('dev-card-semnf', semNf.length);
  set('dev-card-semnf-valor', devMoeda(semNf.reduce((s, i) => s + (i.valor || 0), 0)));
  set('dev-card-comnf', comNf.length);

  const tbody = document.getElementById('dev-tbody');
  if (!tbody) return;
  const lista = devFiltrar();
  set('dev-contagem', `${lista.length} devolução(ões)`);
  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:28px">Nenhuma devolução com esses filtros.</td></tr>`;
    return;
  }
  tbody.innerHTML = lista.map(i => {
    const sit = devSituacao(i);
    const nfInfo = i.nf ? `<div class="dev-nf-info">${devData(i.nf.em)} · ${devEsc(i.nf.por)}</div>` : '';
    const shopee = i.canal === 'shopee';
    const pedido = shopee
      ? `<span class="td-mlb">${devEsc(i.order_id)}</span>`
      : `<a class="td-mlb" href="https://www.mercadolivre.com.br/vendas/${devEsc(i.order_id)}/detalhe" target="_blank" rel="noopener">${devEsc(i.order_id)}</a>`;
    return `<tr class="${i.nf ? 'dev-linha-ok' : ''}">
      <td><span class="badge-deposito ${shopee ? 'dev-badge-shopee' : 'dev-badge-ml'}">${shopee ? 'Shopee' : 'Mercado Livre'}</span></td>
      <td>${devEsc(i.nickname || 'Conta ' + i.conta)}</td>
      <td>${pedido}${i.comprador ? `<div class="dev-comprador">${devEsc(i.comprador)}</div>` : ''}${i.venda_em ? `<div class="dev-sub">venda ${devData(i.venda_em)}</div>` : ''}</td>
      <td class="td-titulo" title="${devEsc(i.titulo)}">${devEsc(i.titulo || '—')}</td>
      <td>${i.nf_venda?.numero ? `<b>${devEsc(devNumNf(i.nf_venda.numero))}</b>${i.nf_venda.serie != null ? `<div class="dev-sub">série ${devEsc(i.nf_venda.serie)}</div>` : ''}`
        : `<span class="dev-sub">${(i.nf_busca && (i.nf_tentativas || 0) >= 3) ? 'NF não encontrada' : 'buscando...'}</span>`}</td>
      <td class="col-num">${devMoeda(i.valor)}</td>
      <td><span class="badge-deposito ${sit.cls}">${sit.txt}</span>
        ${i.tracking ? `<div class="dev-sub">${devEsc(i.tracking)}</div>` : ''}</td>
      <td>${i.chegou_em ? devData(i.chegou_em) : `<span class="dev-sub">devolução aberta ${devData(i.devolucao_em)}</span>`}</td>
      <td style="text-align:center">
        <label class="dev-nf-check"><input type="checkbox" ${i.nf ? 'checked' : ''} onchange="devMarcarNf('${devEsc(i.id)}', this)"> NF emitida</label>
        ${nfInfo}
      </td>
    </tr>`;
  }).join('');
}

async function devMarcarNf(id, checkbox) {
  const emitida = checkbox.checked;
  checkbox.disabled = true;
  try {
    const resp = await fetch('/api/devolucoes/nf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, emitida, senha: localStorage.getItem('usuarioSenha') || '' }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao salvar');
    const item = devItens.find(i => i.id === id);
    if (item) item.nf = out.nf;
    devRender();
  } catch (err) {
    alert('Erro ao marcar NF: ' + err.message);
    checkbox.checked = !emitida;
    checkbox.disabled = false;
  }
}
