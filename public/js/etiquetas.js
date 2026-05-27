let etiquetasArquivo = null;
let etiquetasIniciado = false;

const LABELARY_SIZES = { '100x150': '3.94x5.91', '104x29': '4.09x1.14' };

function etiquetasInit() {
  if (etiquetasIniciado) return;
  etiquetasIniciado = true;

  const dropzone = document.getElementById('etiquetas-dropzone');
  const fileInput = document.getElementById('etiquetas-file');

  dropzone.addEventListener('click', () => fileInput.click());

  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) etiquetasSelecionarArquivo(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) etiquetasSelecionarArquivo(fileInput.files[0]);
  });
}

function etiquetasSelecionarArquivo(file) {
  etiquetasArquivo = file;
  const nome = document.getElementById('etiquetas-nome');
  nome.textContent = '📄 ' + file.name;
  nome.style.display = 'block';
  document.getElementById('btn-converter-zpl').style.display = 'block';
  document.getElementById('etiquetas-status').style.display = 'none';
}

function zplSplitLabels(zpl) {
  return zpl.match(/\^XA[\s\S]*?\^XZ/gi) || [];
}

async function labelaryConvert(labelZpl, labelSize) {
  const url = `https://api.labelary.com/v1/printers/8dpmm/labels/${labelSize}/0/`;
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([labelZpl], { type: 'text/plain' }), 'label.zpl');
    const resp = await fetch(url, { method: 'POST', headers: { Accept: 'application/pdf' }, body: form });
    if (resp.ok) return resp.arrayBuffer();
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    throw new Error(`Labelary: Erro ${resp.status} — tente novamente em alguns minutos`);
  }
}

async function converterZpl() {
  if (!etiquetasArquivo) return;

  const tamanho   = document.querySelector('input[name="etiqueta-tam"]:checked').value;
  const labelSize = LABELARY_SIZES[tamanho];
  const btn       = document.getElementById('btn-converter-zpl');
  const status    = document.getElementById('etiquetas-status');

  btn.disabled    = true;
  btn.textContent = 'Convertendo...';

  const setStatus = (text, type = 'info') => {
    const cores = {
      info:    ['#eff6ff', '#1d4ed8', '#bfdbfe'],
      success: ['#f0fdf4', '#16a34a', '#bbf7d0'],
      error:   ['#fef2f2', '#dc2626', '#fecaca'],
    };
    const [bg, color, border] = cores[type];
    status.textContent      = text;
    status.style.background = bg;
    status.style.color      = color;
    status.style.border     = `1px solid ${border}`;
    status.style.display    = 'block';
  };

  try {
    const zpl    = await etiquetasArquivo.text();
    const labels = zplSplitLabels(zpl);

    if (labels.length === 0) throw new Error('Nenhuma etiqueta encontrada no ZPL (^XA...^XZ)');

    setStatus(`Iniciando: ${labels.length} etiqueta(s) encontrada(s)...`);

    const { PDFDocument } = PDFLib;
    const merged   = await PDFDocument.create();
    const results  = new Array(labels.length);
    let concluidas = 0;

    // 2 workers paralelos, 350 ms entre chamadas para respeitar rate limit
    const ctx = { idx: 0 };
    async function worker() {
      while (ctx.idx < labels.length) {
        const i = ctx.idx++;
        if (i > 0) await new Promise(r => setTimeout(r, 350));
        results[i] = await labelaryConvert(labels[i], labelSize);
        concluidas++;
        setStatus(`Convertendo etiqueta ${concluidas} de ${labels.length}...`);
      }
    }

    await Promise.all([worker(), worker()]);

    for (const buf of results) {
      const doc   = await PDFDocument.load(buf);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    const finalPdf = await merged.save();
    const blob     = new Blob([finalPdf], { type: 'application/pdf' });
    const url      = URL.createObjectURL(blob);
    const link     = document.createElement('a');
    link.href      = url;
    link.download  = etiquetasArquivo.name.replace(/\.[^.]+$/, '') + '.pdf';
    link.click();
    URL.revokeObjectURL(url);

    setStatus(`✓ PDF gerado: ${labels.length} etiqueta(s) convertidas`, 'success');
  } catch (err) {
    setStatus('✗ ' + err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Converter para PDF';
  }
}
