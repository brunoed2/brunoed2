// ── Código de recebimento de mercadoria ─────────────────────────
// Aba manual: admin preenche todo dia o código de cada conta (a API do ML/Shopee
// não expõe esse dado), operador só clica pra copiar e passar pro entregador.

function codigoEscapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function codigoInit() {
  const container = document.getElementById('codigo-lista');
  if (!container) return;
  container.innerHTML = '<div style="color:#94a3b8;font-size:14px;padding:12px 0">Carregando...</div>';
  try {
    const dados = await fetch('/api/codigos-recebimento').then(r => r.json());
    codigoRenderizar(dados);
  } catch {
    container.innerHTML = '<div style="color:#dc2626;font-size:14px;padding:12px 0">Erro ao carregar códigos.</div>';
  }
}

function codigoRenderizar(dados) {
  const container = document.getElementById('codigo-lista');
  if (!container) return;
  const isAdmin = localStorage.getItem('usuarioSenha') === '199412';

  container.innerHTML = Object.entries(dados).map(([chave, item]) => {
    const codigo = item.codigo || '';
    if (isAdmin) {
      return `
        <div class="codigo-card">
          <div class="codigo-card-label">${codigoEscapeHtml(item.label)}</div>
          <div class="codigo-card-edit">
            <input type="text" class="input-padrao codigo-card-input" id="codigo-input-${chave}" value="${codigoEscapeHtml(codigo)}" placeholder="Digite o código de hoje...">
            <button class="btn-primary" id="codigo-btn-${chave}" onclick="codigoSalvar('${chave}')">Salvar</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="codigo-card">
        <div class="codigo-card-label">${codigoEscapeHtml(item.label)}</div>
        <div class="codigo-card-valor${codigo ? '' : ' codigo-vazio'}" data-codigo="${codigoEscapeHtml(codigo)}" onclick="codigoCopiar(this)">
          ${codigo ? codigoEscapeHtml(codigo) : 'Ainda não preenchido hoje'}
        </div>
      </div>
    `;
  }).join('');
}

async function codigoSalvar(chave) {
  const input = document.getElementById(`codigo-input-${chave}`);
  const btn   = document.getElementById(`codigo-btn-${chave}`);
  if (!input) return;
  const codigo = input.value.trim();
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  try {
    const resp = await fetch('/api/codigos-recebimento', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave, codigo, senha: localStorage.getItem('usuarioSenha') || '' }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao salvar');
    if (btn) {
      btn.textContent = '✔ Salvo';
      setTimeout(() => { btn.textContent = 'Salvar'; btn.disabled = false; }, 1200);
    }
  } catch (err) {
    alert('Erro ao salvar código: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
  }
}

async function codigoCopiar(el) {
  const codigo = el.dataset.codigo;
  if (!codigo) return;
  try {
    await navigator.clipboard.writeText(codigo);
    const original = el.textContent;
    el.classList.add('codigo-copiado');
    el.textContent = '✔ Copiado!';
    setTimeout(() => { el.textContent = original; el.classList.remove('codigo-copiado'); }, 1200);
  } catch {
    alert('Não foi possível copiar automaticamente. Código: ' + codigo);
  }
}
