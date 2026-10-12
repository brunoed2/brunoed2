'use strict';

// Configurações → Feriados: dias sem despacho. O servidor trata cada data da lista
// como domingo (sem NF automática, sem aviso de prazo do ML, Shopee pula o dia).

const FERIADOS_DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function feriadoFormatar(iso) {
  const [a, m, d] = iso.split('-');
  const dia = FERIADOS_DIAS_SEMANA[new Date(Date.UTC(+a, +m - 1, +d)).getUTCDay()];
  return `${d}/${m}/${a} (${dia})`;
}

function feriadosRenderizar(lista) {
  const el = document.getElementById('feriados-lista');
  if (!el) return;
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  if (!lista.length) { el.innerHTML = '<span style="color:#64748b">Nenhum feriado cadastrado.</span>'; return; }
  el.innerHTML = lista.map(d => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e2e8f0;${d < hoje ? 'opacity:.5' : ''}">
      <span>${feriadoFormatar(d)}${d === hoje ? ' <strong style="color:#dc2626">— hoje</strong>' : ''}</span>
      <button class="btn-secondary" style="font-size:12px;padding:2px 10px" onclick="feriadoRemover('${d}')">🗑️ Excluir</button>
    </div>`).join('');
}

async function feriadosCarregar() {
  try {
    const d = await fetch('/api/feriados').then(r => r.json());
    feriadosRenderizar(d.feriados || []);
  } catch {
    document.getElementById('feriados-lista').textContent = 'Erro ao carregar feriados.';
  }
}

async function feriadoSalvar(data, acao) {
  const msg = document.getElementById('feriados-msg');
  try {
    const r = await fetch('/api/feriados', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, acao, senha: localStorage.getItem('usuarioSenha') || '' }),
    });
    const d = await r.json();
    if (!d.ok) { msg.style.color = '#dc2626'; msg.textContent = d.error || 'Erro ao salvar.'; return; }
    msg.style.color = '#16a34a';
    msg.textContent = acao === 'remover' ? `${feriadoFormatar(data)} removido.` : `${feriadoFormatar(data)} incluído.`;
    feriadosRenderizar(d.feriados || []);
  } catch {
    msg.style.color = '#dc2626'; msg.textContent = 'Erro de rede.';
  }
}

function feriadoIncluir() {
  const input = document.getElementById('feriado-data');
  if (!input.value) {
    const msg = document.getElementById('feriados-msg');
    msg.style.color = '#dc2626'; msg.textContent = 'Escolha uma data.';
    return;
  }
  feriadoSalvar(input.value, 'incluir');
  input.value = '';
}

function feriadoRemover(data) {
  if (!confirm(`Excluir o feriado ${feriadoFormatar(data)}?`)) return;
  feriadoSalvar(data, 'remover');
}
