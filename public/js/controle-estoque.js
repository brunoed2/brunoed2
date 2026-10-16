// ── Controle de estoque (aba manual) ─────────────────────────────
// Produto cadastrado à mão (nome e SKU livres). O saldo começa em 0 e só muda por
// entrada/saída lançada no histórico (ícone 📜) ou por venda fora do Full com o SKU
// (ML, Shopee, TikTok — o servidor verifica a cada 3 min). Nunca se edita o número direto.

let ceProdutos = [];
let ceProdutoAberto = null;

function ceEsc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ceFotoHtml(p, cls) {
  const clique = cls === 'ce-foto' ? ` onclick="ceAbrirHistorico('${p.id}')"` : '';
  return p.foto
    ? `<img class="${cls}" src="${ceEsc(p.foto)}" alt="" loading="lazy"${clique}>`
    : `<div class="${cls} ce-foto-vazia" title="Sem foto — nenhum anúncio da Shopee ou do ML com esse SKU"${clique}>📦</div>`;
}

function ceSenha() { return localStorage.getItem('usuarioSenha') || ''; }

function ceDataHora(ts) {
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const CE_TIPOS = {
  entrada: { label: 'Entrada',     cls: 'ce-tag-entrada' },
  saida:   { label: 'Saída',       cls: 'ce-tag-saida' },
  venda:   { label: 'Venda',       cls: 'ce-tag-venda' },
  estorno: { label: 'Cancelamento', cls: 'ce-tag-estorno' },
};
const CE_CANAIS = { ml: 'ML', shopee: 'Shopee', tiktok: 'TikTok' };

async function controleEstoqueInit() {
  const lista = document.getElementById('ce-lista');
  if (!lista) return;
  if (!ceProdutos.length) lista.innerHTML = '<div class="ce-vazio">Carregando...</div>';
  try {
    const r = await fetch('/api/controle-estoque').then(r => r.json());
    ceProdutos = r.produtos || [];
    const info = document.getElementById('ce-ultima-verif');
    if (info) info.textContent = r.ultimaVerificacao ? `Vendas verificadas pela última vez às ${new Date(r.ultimaVerificacao).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '';
    ceRenderizar();
  } catch {
    lista.innerHTML = '<div class="ce-vazio" style="color:#dc2626">Erro ao carregar produtos.</div>';
  }
}

function ceRenderizar() {
  const lista = document.getElementById('ce-lista');
  if (!lista) return;
  const filtro = (document.getElementById('ce-filtro')?.value || '').trim().toLowerCase();
  const itens = ceProdutos
    .filter(p => !filtro || p.nome.toLowerCase().includes(filtro) || p.sku.toLowerCase().includes(filtro))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  if (!ceProdutos.length) {
    lista.innerHTML = '<div class="ce-vazio">Nenhum produto cadastrado ainda. Cadastre acima e lance a entrada inicial pelo ícone 📜.</div>';
    return;
  }
  if (!itens.length) {
    lista.innerHTML = '<div class="ce-vazio">Nenhum produto encontrado.</div>';
    return;
  }
  lista.innerHTML = `
    <table class="ce-tabela">
      <thead><tr><th></th><th>Produto</th><th>SKU</th><th class="ce-num">Estoque</th><th>Última movimentação</th><th></th></tr></thead>
      <tbody>
        ${itens.map(p => {
          const u = p.ultimoMov;
          const ultimo = u
            ? `${ceDataHora(u.ts)} · ${CE_TIPOS[u.tipo]?.label || u.tipo} ${u.qtd > 0 ? '+' : ''}${u.qtd}`
            : '<span style="color:#94a3b8">Sem movimentação — lance a entrada inicial</span>';
          return `
            <tr>
              <td class="ce-foto-td">${ceFotoHtml(p, 'ce-foto')}</td>
              <td class="ce-nome">${ceEsc(p.nome)}</td>
              <td><span class="ce-sku">${ceEsc(p.sku)}</span></td>
              <td class="ce-num ce-saldo${p.saldo < 0 ? ' ce-negativo' : ''}">${p.saldo}</td>
              <td class="ce-ultimo">${ultimo}</td>
              <td class="ce-acoes"><button class="ce-btn-hist" title="Histórico / lançar entrada ou saída" onclick="ceAbrirHistorico('${p.id}')">📜</button></td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function ceCadastrar(event) {
  event.preventDefault();
  const nomeEl = document.getElementById('ce-novo-nome');
  const skuEl  = document.getElementById('ce-novo-sku');
  const btn    = document.getElementById('ce-novo-btn');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/controle-estoque', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nome: nomeEl.value, sku: skuEl.value, senha: ceSenha() }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao cadastrar');
    nomeEl.value = ''; skuEl.value = '';
    await controleEstoqueInit();
    ceAbrirHistorico(out.produto.id);
    ceBuscarFoto(out.produto.id, false);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function ceAbrirHistorico(id) {
  ceProdutoAberto = id;
  const modal = document.getElementById('ce-modal');
  modal.style.display = 'flex';
  document.getElementById('ce-mov-qtd').value = '';
  document.getElementById('ce-mov-obs').value = '';
  document.getElementById('ce-modal-excluir').style.display = ceSenha() === '199412' ? '' : 'none';
  document.getElementById('ce-hist-lista').innerHTML = '<div class="ce-vazio">Carregando...</div>';
  await ceCarregarHistorico();
}

function ceFecharHistorico() {
  document.getElementById('ce-modal').style.display = 'none';
  ceProdutoAberto = null;
}

async function ceCarregarHistorico() {
  const id = ceProdutoAberto;
  try {
    const r = await fetch(`/api/controle-estoque/${id}/historico`).then(r => r.json());
    if (id !== ceProdutoAberto) return;
    const p = r.produto;
    document.getElementById('ce-modal-nome').textContent = p.nome;
    if (!ceFotoBuscando) document.getElementById('ce-modal-foto').innerHTML = ceFotoHtml(p, 'ce-foto-grande');
    document.getElementById('ce-modal-sku').textContent = p.sku;
    const saldoEl = document.getElementById('ce-modal-saldo');
    saldoEl.textContent = p.saldo;
    saldoEl.classList.toggle('ce-negativo', p.saldo < 0);
    const movs = r.movs || [];
    document.getElementById('ce-hist-lista').innerHTML = !movs.length
      ? '<div class="ce-vazio">Nenhuma movimentação. Comece lançando a entrada inicial acima.</div>'
      : `<table class="ce-tabela ce-tabela-hist">
          <thead><tr><th>Data</th><th>Tipo</th><th class="ce-num">Qtd</th><th class="ce-num">Saldo</th><th>Quem / origem</th><th>Detalhe</th></tr></thead>
          <tbody>${movs.map(m => {
            const t = CE_TIPOS[m.tipo] || { label: m.tipo, cls: '' };
            const detalhe = m.pedido
              ? `Pedido ${CE_CANAIS[m.canal] || m.canal} ${ceEsc(m.pedido)}`
              : ceEsc(m.obs || '');
            return `<tr>
              <td style="white-space:nowrap">${ceDataHora(m.ts)}</td>
              <td><span class="ce-tag ${t.cls}">${t.label}</span></td>
              <td class="ce-num ${m.qtd > 0 ? 'ce-pos' : 'ce-neg'}">${m.qtd > 0 ? '+' : ''}${m.qtd}</td>
              <td class="ce-num">${m.saldo}</td>
              <td>${ceEsc(m.usuario || '')}</td>
              <td class="ce-detalhe">${detalhe}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
  } catch {
    document.getElementById('ce-hist-lista').innerHTML = '<div class="ce-vazio" style="color:#dc2626">Erro ao carregar histórico.</div>';
  }
}

async function ceLancarMovimento(tipo) {
  const qtdEl = document.getElementById('ce-mov-qtd');
  const obsEl = document.getElementById('ce-mov-obs');
  const qtd = parseInt(qtdEl.value, 10);
  if (!Number.isInteger(qtd) || qtd <= 0) { alert('Digite uma quantidade maior que zero.'); qtdEl.focus(); return; }
  const nome = document.getElementById('ce-modal-nome').textContent;
  if (!confirm(`Lançar ${tipo === 'entrada' ? 'ENTRADA de +' : 'SAÍDA de -'}${qtd} em "${nome}"?`)) return;
  const btns = document.querySelectorAll('.ce-mov-btn');
  btns.forEach(b => b.disabled = true);
  try {
    const resp = await fetch(`/api/controle-estoque/${ceProdutoAberto}/movimento`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo, quantidade: qtd, obs: obsEl.value, senha: ceSenha() }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao lançar');
    qtdEl.value = ''; obsEl.value = '';
    await Promise.all([ceCarregarHistorico(), controleEstoqueInit()]);
  } catch (err) {
    alert(err.message);
  } finally {
    btns.forEach(b => b.disabled = false);
  }
}

// Busca a foto pelo SKU (Shopee primeiro, depois ML). A 1ª busca do dia varre todos
// os anúncios da Shopee, então pode levar alguns segundos.
let ceFotoBuscando = false;
async function ceBuscarFoto(id, forcar) {
  const box = document.getElementById('ce-modal-foto');
  ceFotoBuscando = true;
  if (box && ceProdutoAberto === id) box.innerHTML = '<div class="ce-foto-grande ce-foto-vazia" title="Buscando foto...">⏳</div>';
  try {
    const resp = await fetch(`/api/controle-estoque/${id}/foto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: ceSenha(), forcar }),
    });
    const out = await resp.json().catch(() => ({}));
    if (forcar && resp.ok && !out.foto) alert('Nenhum anúncio da Shopee ou do ML com esse SKU foi encontrado.');
  } finally {
    ceFotoBuscando = false;
  }
  await controleEstoqueInit();
  if (ceProdutoAberto === id) await ceCarregarHistorico();
}

// Foto escolhida à mão: reduz no navegador (máx. 600px, JPEG) antes de mandar
async function ceEnviarFoto(input) {
  const arquivo = input.files?.[0];
  input.value = '';
  if (!arquivo) return;
  const id = ceProdutoAberto;
  try {
    const img = await new Promise((ok, erro) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => erro(new Error('Não consegui abrir essa imagem'));
      i.src = URL.createObjectURL(arquivo);
    });
    const escala = Math.min(1, 600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width  = Math.round(img.width * escala);
    canvas.height = Math.round(img.height * escala);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // PNG transparente não vira fundo preto no JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    document.getElementById('ce-modal-foto').innerHTML = '<div class="ce-foto-grande ce-foto-vazia" title="Enviando...">⏳</div>';
    const resp = await fetch(`/api/controle-estoque/${id}/foto-manual`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: ceSenha(), imagem: canvas.toDataURL('image/jpeg', 0.85) }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao salvar a foto');
  } catch (err) {
    alert(err.message);
  }
  await controleEstoqueInit();
  if (ceProdutoAberto === id) await ceCarregarHistorico();
}

async function ceRenomear() {
  const atual = document.getElementById('ce-modal-nome').textContent;
  const nome = prompt('Novo nome do produto:', atual);
  if (nome === null || !nome.trim() || nome.trim() === atual) return;
  const resp = await fetch(`/api/controle-estoque/${ceProdutoAberto}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, senha: ceSenha() }),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) { alert(out.error || 'Erro ao renomear'); return; }
  await Promise.all([ceCarregarHistorico(), controleEstoqueInit()]);
}

async function ceExcluir() {
  const nome = document.getElementById('ce-modal-nome').textContent;
  if (!confirm(`Excluir "${nome}" e todo o histórico dele? Não dá pra desfazer.`)) return;
  const resp = await fetch(`/api/controle-estoque/${ceProdutoAberto}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: ceSenha() }),
  });
  const out = await resp.json().catch(() => ({}));
  if (!resp.ok) { alert(out.error || 'Erro ao excluir'); return; }
  ceFecharHistorico();
  controleEstoqueInit();
}
