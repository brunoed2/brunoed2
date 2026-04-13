// ── Notas de Entrada (SEFAZ NF-e) ──────────────────────────────

let notasCountdownInterval = null;

function notasContaAtual() {
  return document.querySelector('.conta-btn.active')?.dataset?.conta || '1';
}

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

function notasIniciarCountdown(ultimaRejeicao656) {
  if (notasCountdownInterval) clearInterval(notasCountdownInterval);
  const boxEl = document.getElementById('notas-countdown');
  if (!boxEl) return;

  const UMA_HORA = 60 * 60 * 1000;

  function atualizar() {
    const agora     = Date.now();
    const liberadoEm = ultimaRejeicao656 + UMA_HORA;
    const restante  = liberadoEm - agora;

    if (restante <= 0) {
      boxEl.style.display = 'none';
      clearInterval(notasCountdownInterval);
      notasCountdownInterval = null;
      return;
    }

    const min = Math.floor(restante / 60000);
    const seg = Math.floor((restante % 60000) / 1000);
    boxEl.textContent = `⏳ Próxima consulta disponível em ${min}m ${seg}s`;
    boxEl.style.display = 'block';
  }

  atualizar();
  notasCountdownInterval = setInterval(atualizar, 1000);
}

function notasRenderirLinha(n) {
  const conta = notasContaAtual();
  const urlXml = n.zip ? `/api/notas/xml/${n.nsu}?conta=${conta}` : null;
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
    <td style="display:flex;gap:4px">
      ${urlXml ? `<a href="${urlXml}" download class="btn-sm" title="Baixar XML">⬇ XML</a>` : '<span style="color:#cbd5e1;font-size:11px">sem XML</span>'}
    </td>
  `;
  return tr;
}

function notasAtualizarTotal(total) {
  document.getElementById('notas-total').textContent =
    `${total} nota${total !== 1 ? 's' : ''} encontrada${total !== 1 ? 's' : ''}`;
}

async function notasCarregarConfig() {
  const conta = notasContaAtual();
  try {
    const d = await fetch(`/api/notas/config?conta=${conta}`).then(r => r.json());
    const box = document.getElementById('notas-cert-info');
    if (d.cnpj) {
      box.textContent = `Certificado: ${d.titular} — CNPJ ${notasFormatarCnpj(d.cnpj)}`;
      box.style.display = 'block';
    } else {
      box.textContent = '';
      box.style.display = 'none';
    }
    // Inicia countdown se há rejeição 656 recente (< 1h)
    if (d.ultimaRejeicao656 && (Date.now() - d.ultimaRejeicao656) < 60 * 60 * 1000) {
      notasIniciarCountdown(d.ultimaRejeicao656);
    } else {
      if (notasCountdownInterval) clearInterval(notasCountdownInterval);
      const boxEl = document.getElementById('notas-countdown');
      if (boxEl) boxEl.style.display = 'none';
    }
  } catch {}
}

async function notasCarregarLista() {
  const conta  = notasContaAtual();
  const tabela = document.getElementById('tabela-notas');
  const tbody  = document.getElementById('tabela-notas-body');
  tbody.innerHTML = '';
  tabela.style.display = 'none';
  document.getElementById('notas-total').textContent = '';
  try {
    const d = await fetch(`/api/notas/lista?conta=${conta}`).then(r => r.json());
    const notas = d.notas || [];
    if (!notas.length) return;
    notas.forEach(n => tbody.appendChild(notasRenderirLinha(n)));
    tabela.style.display = 'table';
    notasAtualizarTotal(notas.length);
  } catch {}
}

async function notasEnviarCertificado() {
  const fileInput = document.getElementById('notas-cert-file');
  const senha     = document.getElementById('notas-cert-senha').value;
  const msg       = document.getElementById('notas-msg');
  const conta     = notasContaAtual();

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
  form.append('conta', conta);

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

async function notasLimparEBuscar() {
  if (!confirm('Isso apagará a lista salva desta conta e buscará tudo do zero. Continuar?')) return;
  const conta  = notasContaAtual();
  const tbody  = document.getElementById('tabela-notas-body');
  const tabela = document.getElementById('tabela-notas');
  tbody.innerHTML = '';
  tabela.style.display = 'none';
  document.getElementById('notas-total').textContent = '';
  await fetch('/api/notas/limpar', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ conta }) });
  await notasBuscar();
}

async function notasBuscar() {
  const loading = document.getElementById('notas-loading');
  const erroEl  = document.getElementById('notas-erro');
  const tabela  = document.getElementById('tabela-notas');
  const tbody   = document.getElementById('tabela-notas-body');
  const cUF     = document.getElementById('notas-uf').value;
  const conta   = notasContaAtual();

  loading.style.display = 'block';
  erroEl.style.display  = 'none';

  try {
    const d = await fetch(`/api/notas/buscar?cUF=${cUF}&conta=${conta}`).then(r => r.json());
    loading.style.display = 'none';

    if (d.error) {
      erroEl.textContent = d.error; erroEl.style.color = '#c00'; erroEl.style.display = 'block'; return;
    }

    if (d.aviso) {
      erroEl.textContent = d.aviso; erroEl.style.color = '#92400e'; erroEl.style.display = 'block';
      // Recarrega config para iniciar countdown
      await notasCarregarConfig();
    } else {
      erroEl.style.display = 'none';
    }

    const novas = d.novas || [];
    if (novas.length > 0) {
      novas.forEach(n => tbody.insertBefore(notasRenderirLinha(n), tbody.firstChild));
      tabela.style.display = 'table';
    } else if (!d.aviso) {
      erroEl.textContent = 'Nenhuma nota nova encontrada.';
      erroEl.style.color = '#64748b';
      erroEl.style.display = 'block';
    }

    notasAtualizarTotal(d.total || 0);
  } catch {
    loading.style.display = 'none';
    erroEl.textContent = 'Erro ao consultar SEFAZ.';
    erroEl.style.color = '#c00';
    erroEl.style.display = 'block';
  }
}

document.addEventListener('contaMudou', () => {
  const aba = document.getElementById('tab-notas');
  if (aba && aba.classList.contains('active')) {
    if (notasCountdownInterval) { clearInterval(notasCountdownInterval); notasCountdownInterval = null; }
    notasCarregarConfig();
    notasCarregarLista();
  }
});

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
