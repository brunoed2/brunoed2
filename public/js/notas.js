// ── Notas de Entrada (SEFAZ NF-e) ──────────────────────────────

function notasFormatarCnpj(c) {
  if (!c || c.length !== 14) return c || '—';
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
}

function notasFormatarData(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('pt-BR'); } catch { return d.slice(0,10); }
}

function notasFormatarValor(v) {
  if (!v) return '—';
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function notasRenderirLinha(n) {
  const urlDanfe = n.chNFe
    ? `https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=completa&tipoConteudo=7PhJ+gAVw2g=&nfe=${n.chNFe}`
    : null;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="col-num" style="font-size:11px;color:#94a3b8">${n.nsu || '—'}</td>
    <td class="col-num">${n.nNF || '—'}</td>
    <td>${notasFormatarData(n.dhEmi)}</td>
    <td class="td-titulo">${n.xNome || '—'}</td>
    <td style="font-size:12px">${n.CNPJ_emit ? notasFormatarCnpj(n.CNPJ_emit) : '—'}</td>
    <td class="col-num">${notasFormatarValor(n.vNF)}</td>
    <td>${n.tipo === 'resumo'
      ? '<span class="badge-deposito" style="background:#e2e8f0;color:#475569;font-size:11px">Resumo</span>'
      : '<span class="badge-deposito badge-ativo" style="font-size:11px">Completa</span>'}</td>
    <td>${urlDanfe ? `<a href="${urlDanfe}" target="_blank" class="btn-sm">🔍 Ver</a>` : '—'}</td>
  `;
  return tr;
}

function notasAtualizarTotal(total) {
  document.getElementById('notas-total').textContent =
    `${total} nota${total !== 1 ? 's' : ''} encontrada${total !== 1 ? 's' : ''}`;
}

async function notasCarregarConfig() {
  try {
    const d = await fetch('/api/notas/config').then(r => r.json());
    const box = document.getElementById('notas-cert-info');
    if (d.cnpj) {
      box.textContent = `Certificado: ${d.titular} — CNPJ ${notasFormatarCnpj(d.cnpj)}`;
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
  } catch {}
}

async function notasCarregarLista() {
  const tabela = document.getElementById('tabela-notas');
  const tbody  = document.getElementById('tabela-notas-body');
  try {
    const d = await fetch('/api/notas/lista').then(r => r.json());
    const notas = d.notas || [];
    if (!notas.length) return;
    tbody.innerHTML = '';
    notas.forEach(n => tbody.appendChild(notasRenderirLinha(n)));
    tabela.style.display = 'table';
    notasAtualizarTotal(notas.length);
  } catch {}
}

async function notasEnviarCertificado() {
  const fileInput = document.getElementById('notas-cert-file');
  const senha     = document.getElementById('notas-cert-senha').value;
  const msg       = document.getElementById('notas-msg');

  if (!fileInput.files[0]) {
    msg.textContent = 'Selecione o arquivo .pfx do certificado.';
    msg.style.color = '#c00'; msg.style.display = 'block'; return;
  }
  if (!senha) {
    msg.textContent = 'Informe a senha do certificado.';
    msg.style.color = '#c00'; msg.style.display = 'block'; return;
  }

  msg.textContent = 'Processando certificado...';
  msg.style.color = '#555'; msg.style.display = 'block';

  const form = new FormData();
  form.append('cert', fileInput.files[0]);
  form.append('senha', senha);

  try {
    const d = await fetch('/api/notas/certificado', { method: 'POST', body: form }).then(r => r.json());
    if (d.error) { msg.textContent = d.error; msg.style.color = '#c00'; return; }
    msg.textContent = `Certificado salvo. CNPJ: ${notasFormatarCnpj(d.cnpj)} — ${d.titular}`;
    msg.style.color = '#166534';
    const box = document.getElementById('notas-cert-info');
    box.textContent = `Certificado: ${d.titular} — CNPJ ${notasFormatarCnpj(d.cnpj)}`;
    box.style.display = 'block';
  } catch {
    msg.textContent = 'Erro ao enviar certificado.'; msg.style.color = '#c00';
  }
}

async function notasBuscar() {
  const loading = document.getElementById('notas-loading');
  const erroEl  = document.getElementById('notas-erro');
  const tabela  = document.getElementById('tabela-notas');
  const tbody   = document.getElementById('tabela-notas-body');
  const cUF     = document.getElementById('notas-uf').value;

  loading.style.display = 'block';
  erroEl.style.display  = 'none';

  try {
    const d = await fetch(`/api/notas/buscar?cUF=${cUF}`).then(r => r.json());
    loading.style.display = 'none';

    if (d.error) {
      erroEl.textContent = d.error; erroEl.style.display = 'block'; return;
    }

    if (d.aviso) {
      erroEl.textContent = d.aviso; erroEl.style.display = 'block';
      // Mantém tabela como está — não limpa
      return;
    }

    const novas = d.novas || [];
    if (novas.length === 0) {
      erroEl.textContent = 'Nenhuma nota nova encontrada.';
      erroEl.style.color = '#64748b';
      erroEl.style.display = 'block';
    } else {
      erroEl.style.display = 'none';
      // Insere novas no topo da tabela
      novas.forEach(n => tbody.insertBefore(notasRenderirLinha(n), tbody.firstChild));
      tabela.style.display = 'table';
    }

    notasAtualizarTotal(d.total || parseInt(document.getElementById('notas-total').textContent) || 0);
  } catch {
    loading.style.display = 'none';
    erroEl.textContent = 'Erro ao consultar SEFAZ.';
    erroEl.style.color = '#c00';
    erroEl.style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const observer = new MutationObserver(() => {
    const aba = document.getElementById('tab-notas');
    if (aba && aba.classList.contains('active')) {
      notasCarregarConfig();
      notasCarregarLista();
      observer.disconnect();
    }
  });
  const tab = document.getElementById('tab-notas');
  if (tab) observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
});
