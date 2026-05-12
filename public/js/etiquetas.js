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

async function converterZpl() {
  if (!etiquetasArquivo) return;

  const tamanho = document.querySelector('input[name="etiqueta-tam"]:checked').value;
  const btn     = document.getElementById('btn-converter-zpl');
  const status  = document.getElementById('etiquetas-status');

  btn.disabled    = true;
  btn.textContent = 'Convertendo...';
  status.style.display = 'none';

  try {
    const zpl  = await etiquetasArquivo.text();
    const resp = await fetch(`/api/zpl-to-pdf?tamanho=${tamanho}`, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    zpl,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = [err.erro, err.detalhe].filter(Boolean).join(' — ');
      throw new Error(msg || `Erro ${resp.status}`);
    }

    const blob     = await resp.blob();
    const url      = URL.createObjectURL(blob);
    const link     = document.createElement('a');
    link.href      = url;
    link.download  = etiquetasArquivo.name.replace(/\.[^.]+$/, '') + '.pdf';
    link.click();
    URL.revokeObjectURL(url);

    status.textContent        = '✓ PDF gerado com sucesso!';
    status.style.background   = '#f0fdf4';
    status.style.color        = '#16a34a';
    status.style.border       = '1px solid #bbf7d0';
    status.style.display      = 'block';
  } catch (err) {
    status.textContent      = '✗ ' + err.message;
    status.style.background = '#fef2f2';
    status.style.color      = '#dc2626';
    status.style.border     = '1px solid #fecaca';
    status.style.display    = 'block';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Converter para PDF';
  }
}
