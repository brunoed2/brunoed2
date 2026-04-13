// ── Notas de Entrada (SEFAZ NF-e) ──────────────────────────────

let notasUltNSU = '0';
let todasNotas  = [];

const UF_NOMES = {
  '11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO',
  '21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL','28':'SE','29':'BA',
  '31':'MG','32':'ES','33':'RJ','35':'SP',
  '41':'PR','42':'SC','43':'RS',
  '50':'MS','51':'MT','52':'GO','53':'DF',
};

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

async function notasBuscar(mais = false) {
  const loading = document.getElementById('notas-loading');
  const erroEl  = document.getElementById('notas-erro');
  const totalEl = document.getElementById('notas-total');
  const tabela  = document.getElementById('tabela-notas');
  const tbody   = document.getElementById('tabela-notas-body');
  const btnMais = document.getElementById('notas-btn-mais');
  const cUF     = document.getElementById('notas-uf').value;

  if (!mais) {
    notasUltNSU = '0';
    todasNotas  = [];
    tbody.innerHTML = '';
    tabela.style.display = 'none';
    btnMais.style.display = 'none';
  }

  loading.style.display = 'block';
  erroEl.style.display  = 'none';

  try {
    const d = await fetch(`/api/notas/buscar?ultNSU=${notasUltNSU}&cUF=${cUF}`).then(r => r.json());
    loading.style.display = 'none';

    if (d.error) {
      erroEl.textContent = d.error; erroEl.style.display = 'block'; return;
    }

    const novas = d.notas || [];
    todasNotas.push(...novas);
    notasUltNSU = d.ultNSU || notasUltNSU;

    const tot = todasNotas.length;
    totalEl.textContent = `${tot} nota${tot !== 1 ? 's' : ''} encontrada${tot !== 1 ? 's' : ''}`;

    if (!tot) {
      erroEl.textContent = 'Nenhuma nota encontrada para este CNPJ.';
      erroEl.style.display = 'block'; return;
    }

    // Renderiza a partir das novas (se carregando mais) ou reconstrói tudo
    if (!mais) tbody.innerHTML = '';
    for (const n of novas) {
      const tr = document.createElement('tr');
      const urlDanfe = n.chNFe
        ? `https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=completa&tipoConteudo=7PhJ+gAVw2g=&nfe=${n.chNFe}`
        : null;
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
      tbody.appendChild(tr);
    }

    tabela.style.display = 'table';

    // Mostra "carregar mais" se ainda há documentos
    const maxNSU = parseInt(d.maxNSU || '0');
    const ult    = parseInt(notasUltNSU || '0');
    if (novas.length >= 50 || ult < maxNSU) {
      btnMais.style.display = 'inline-block';
    } else {
      btnMais.style.display = 'none';
    }
  } catch {
    loading.style.display = 'none';
    erroEl.textContent = 'Erro ao consultar SEFAZ.';
    erroEl.style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const observer = new MutationObserver(() => {
    const aba = document.getElementById('tab-notas');
    if (aba && aba.classList.contains('active')) {
      notasCarregarConfig();
      observer.disconnect();
    }
  });
  const tab = document.getElementById('tab-notas');
  if (tab) observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
});
