// ── Scanner de QR Code — separação de pedidos ────────────────

let scannerStream    = null;
let scannerAnimFrame = null;
let scannerAtivo     = false;

function scannerInit() {
  scannerParar();
  document.getElementById('scanner-resultado').style.display = 'none';
  document.getElementById('scanner-status').textContent      = '';
}

function scannerIniciar() {
  const status = document.getElementById('scanner-status');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    status.textContent = 'Câmera não suportada neste navegador.';
    return;
  }

  status.textContent = 'Abrindo câmera...';
  document.getElementById('scanner-resultado').style.display   = 'none';
  document.getElementById('scanner-area').style.display        = '';
  document.getElementById('btn-scanner-iniciar').style.display = 'none';
  document.getElementById('btn-scanner-parar').style.display   = '';

  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
    .then(stream => {
      scannerStream = stream;
      const video = document.getElementById('scanner-video');
      video.srcObject = stream;
      video.play();
      scannerAtivo = true;
      status.textContent = 'Aponte para o QR code da etiqueta';
      scannerProcessarFrame();
    })
    .catch(err => {
      status.textContent = 'Erro ao acessar câmera: ' + err.message;
      document.getElementById('scanner-area').style.display        = 'none';
      document.getElementById('btn-scanner-iniciar').style.display = '';
      document.getElementById('btn-scanner-parar').style.display   = 'none';
    });
}

function scannerParar() {
  scannerAtivo = false;
  if (scannerAnimFrame) { cancelAnimationFrame(scannerAnimFrame); scannerAnimFrame = null; }
  if (scannerStream) {
    scannerStream.getTracks().forEach(t => t.stop());
    scannerStream = null;
  }
  const video = document.getElementById('scanner-video');
  if (video) video.srcObject = null;

  const area = document.getElementById('scanner-area');
  if (area) area.style.display = 'none';

  const btnIni = document.getElementById('btn-scanner-iniciar');
  if (btnIni) btnIni.style.display = '';
  const btnPar = document.getElementById('btn-scanner-parar');
  if (btnPar) btnPar.style.display = 'none';
}

function scannerProcessarFrame() {
  if (!scannerAtivo) return;

  const video  = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');

  if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      // Fecha câmera imediatamente ao detectar o QR
      scannerAtivo = false;
      cancelAnimationFrame(scannerAnimFrame);
      scannerParar();
      scannerBuscarPedido(code.data);
      return;
    }
  }

  scannerAnimFrame = requestAnimationFrame(scannerProcessarFrame);
}

async function scannerBuscarPedido(qrData) {
  const status = document.getElementById('scanner-status');

  const match = qrData.match(/\d{8,}/);
  const sid   = match ? match[0] : qrData.trim();

  status.textContent = `Buscando pedido ${sid}...`;

  try {
    const resp  = await fetch(`/api/ml/pedido-por-shipment/${encodeURIComponent(sid)}`);
    const pedido = await resp.json();

    if (!resp.ok || !pedido.encontrado) {
      status.textContent = `Pedido não encontrado para o código: ${sid}`;
      scannerMostrarBtnOutro();
      return;
    }

    status.textContent = '';
    scannerMostrarResultado(pedido, sid);
  } catch (err) {
    status.textContent = 'Erro ao buscar pedido: ' + err.message;
    scannerMostrarBtnOutro();
  }
}

function scannerMostrarResultado(pedido, sid) {
  const resultado = document.getElementById('scanner-resultado');
  const itens     = pedido.itensLista || [];

  const itensHtml = itens.map(i => {
    const thumbHtml = i.thumbnail
      ? `<img src="${i.thumbnail}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid #334155;flex-shrink:0">`
      : `<div style="width:72px;height:72px;border-radius:8px;background:#0f172a;flex-shrink:0"></div>`;
    return `
      <div style="padding:12px 0;border-bottom:1px solid #1e293b;display:flex;gap:12px;align-items:center">
        ${thumbHtml}
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:500;color:#f1f5f9;line-height:1.4">${i.titulo}</div>
          ${i.variacao ? `<div style="font-size:12px;color:#94a3b8;margin-top:3px">${i.variacao}</div>` : ''}
          <div style="font-size:12px;color:#64748b;margin-top:4px">SKU: ${i.sku || '—'}</div>
        </div>
        <div style="font-size:22px;font-weight:700;color:#f1f5f9;white-space:nowrap;padding-left:4px">×${i.quantidade}</div>
      </div>
    `;
  }).join('');

  resultado.style.display = '';
  resultado.innerHTML = `
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="font-size:12px;color:#64748b;font-family:monospace">#${sid}</span>
        <span style="font-size:13px;font-weight:600;color:${pedido.atendida ? '#22c55e' : '#f59e0b'}">${pedido.atendida ? '✅ Atendido' : '📦 Pendente'}</span>
      </div>
      <div style="font-size:14px;color:#94a3b8;padding-bottom:12px;border-bottom:1px solid #334155">
        👤 ${pedido.comprador || '—'}
      </div>
      <div style="margin-top:4px">${itensHtml || '<div style="color:#64748b;font-size:14px;padding:12px 0">Nenhum item encontrado.</div>'}</div>
      <button class="btn-primary" onclick="scannerEscanearOutro()" style="margin-top:16px;width:100%;padding:12px;font-size:15px">
        📷 Escanear outro pedido
      </button>
    </div>
  `;
}

function scannerMostrarBtnOutro() {
  const resultado = document.getElementById('scanner-resultado');
  resultado.style.display = '';
  resultado.innerHTML = `
    <button class="btn-secondary" onclick="scannerEscanearOutro()" style="width:100%;padding:12px;font-size:15px">
      📷 Escanear outro pedido
    </button>
  `;
}

function scannerEscanearOutro() {
  document.getElementById('scanner-resultado').style.display = 'none';
  document.getElementById('scanner-status').textContent      = '';
  scannerIniciar();
}
