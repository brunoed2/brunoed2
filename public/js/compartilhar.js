// compartilhar.js — compartilhamento de PDFs (etiquetas, etc.)
//
// No PWA instalado no iPhone (modo "app", não Safari), abrir um PDF direto
// num link não dá acesso ao botão de compartilhar do Safari — o iOS mostra
// o PDF num visualizador sem nenhuma barra de ferramentas. A Web Share API
// resolve isso: baixa o arquivo aqui e chama o menu nativo de compartilhar
// (AirDrop, WhatsApp, Salvar em Arquivos, Imprimir, etc.) diretamente.

async function compartilharPdf(url, nomeArquivo) {
  try {
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const file = new File([blob], nomeArquivo, { type: blob.type || 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // usuário cancelou o compartilhamento
  }
  // Sem suporte a Web Share (ex: desktop) ou falha no fetch — volta ao comportamento antigo
  window.open(url, '_blank');
}

// Usado no onclick de links <a href target="_blank"> — intercepta o clique
// e compartilha via Web Share quando disponível, senão deixa o link abrir normal.
function compartilharPdfClick(event, url, nomeArquivo) {
  if (navigator.share) {
    event.preventDefault();
    compartilharPdf(url, nomeArquivo);
    return false;
  }
  return true;
}
