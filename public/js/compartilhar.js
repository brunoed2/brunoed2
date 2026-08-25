// compartilhar.js — compartilhamento de PDFs (etiquetas, etc.)
//
// No PWA instalado no iPhone (modo "app", não Safari), abrir um PDF direto
// num link não dá acesso ao botão de compartilhar do Safari — o iOS mostra
// o PDF num visualizador sem nenhuma barra de ferramentas. Botão dedicado
// "Compartilhar" (separado do "Baixar", que continua abrindo normal): baixa
// o arquivo aqui e chama o menu nativo de compartilhar (AirDrop, WhatsApp,
// Salvar em Arquivos, Imprimir, etc.) diretamente.
//
// iOS Safari só reconhece o navigator.share() como resposta a um toque do
// usuário se ele for chamado bem coladinho no clique — depois de esperar o
// fetch do PDF (rede), o "gesto" já expirou e o share() falha em silêncio,
// caindo pro comportamento de abrir igual o Baixar. Quando isso acontece,
// deixa o arquivo já baixado pronto e pede só mais um toque — dessa vez sem
// rede no meio, então o iOS ainda reconhece como gesto do usuário.

function compartilharPdfRestaurarLabel(el) {
  if (el && el.dataset.labelOriginal) el.textContent = el.dataset.labelOriginal;
}

async function compartilharPdf(url, nomeArquivo, el) {
  // Segundo toque — arquivo já baixado no toque anterior, compartilha sem tocar na rede.
  if (el && el._arquivoPronto) {
    const file = el._arquivoPronto;
    delete el._arquivoPronto;
    compartilharPdfRestaurarLabel(el);
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (!(err && err.name === 'AbortError')) window.open(url, '_blank');
    }
    return;
  }

  if (el) {
    if (!el.dataset.labelOriginal) el.dataset.labelOriginal = el.textContent;
    el.textContent = '⏳';
  }

  let file;
  try {
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    file = new File([blob], nomeArquivo, { type: blob.type || 'application/pdf' });
  } catch {
    compartilharPdfRestaurarLabel(el);
    window.open(url, '_blank');
    return;
  }

  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
    compartilharPdfRestaurarLabel(el);
    window.open(url, '_blank');
    return;
  }

  try {
    await navigator.share({ files: [file] });
    compartilharPdfRestaurarLabel(el);
  } catch (err) {
    if (err && err.name === 'AbortError') { compartilharPdfRestaurarLabel(el); return; }
    if (el) {
      el._arquivoPronto = file;
      el.textContent = '✅ Toque p/ compartilhar';
    } else {
      window.open(url, '_blank');
    }
  }
}
