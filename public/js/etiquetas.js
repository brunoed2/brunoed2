let etiquetasArquivo = null;
let etiquetasIniciado = false;

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

async function converterZpl() {
  if (!etiquetasArquivo) return;

  const tamanho = document.querySelector('input[name="etiqueta-tam"]:checked').value;
  const btn     = document.getElementById('btn-converter-zpl');
  const status  = document.getElementById('etiquetas-status');

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

    // 2 workers em paralelo, 350 ms entre cada chamada por worker
    const ctx = { idx: 0 };
    async function worker() {
      while (ctx.idx < labels.length) {
        const i = ctx.idx++;
        if (i > 0) await new Promise(r => setTimeout(r, 350));

        const resp = await fetch(`/api/zpl-to-pdf?tamanho=${tamanho}`, {
          method:  'POST',
          headers: { 'Content-Type': 'text/plain' },
          body:    labels[i],
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error([err.erro, err.detalhe].filter(Boolean).join(' — ') || `Erro ${resp.status}`);
        }

        results[i] = await resp.arrayBuffer();
        concluidas++;
        setStatus(`Convertendo etiqueta ${concluidas} de ${labels.length}...`);
      }
    }

    await Promise.all([worker(), worker()]);

    // Mescla em ordem
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
