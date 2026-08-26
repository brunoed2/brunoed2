// ── Scanner de QR Code — separação de pedidos ────────────────

let scannerStream          = null;
let scannerAnimFrame       = null;
let scannerAtivo           = false;
let scannerPedidoAtual     = null;
let scannerSidAtual        = null;
let scannerInstrucaoEditando = null; // índice do item com o campo de edição aberto

function scannerEscapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scannerInit() {
  scannerParar();
  document.getElementById('scanner-resultado').style.display = 'none';
  document.getElementById('scanner-status').textContent      = '';
  scannerFecharFoto();
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
      scannerAtivo = false;
      cancelAnimationFrame(scannerAnimFrame);
      scannerParar();
      // Mantém o botão "Escanear Etiqueta" escondido — o resultado terá seu próprio botão
      document.getElementById('btn-scanner-iniciar').style.display = 'none';
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

    if (resp.ok && pedido.encontrado) {
      status.textContent = '';
      scannerMostrarResultado(pedido, sid);
      return;
    }

    // Não achou no ML — tenta como tracking Shopee (QR das etiquetas Shopee traz o código
    // dos Correios, ex: BR267135109340H, não um shipment ID numérico do ML)
    const trackingBruto = qrData.trim();
    status.textContent = `Buscando pedido Shopee ${trackingBruto}...`;
    const respShopee  = await fetch(`/api/shopee/pedido-por-tracking/${encodeURIComponent(trackingBruto)}`);
    const pedidoShopee = await respShopee.json();

    if (!respShopee.ok || !pedidoShopee.encontrado) {
      status.textContent = `Pedido não encontrado para o código: ${trackingBruto}`;
      scannerMostrarBtnOutro();
      return;
    }

    status.textContent = '';
    scannerMostrarResultado(pedidoShopee, pedidoShopee.shipmentId);
  } catch (err) {
    status.textContent = 'Erro ao buscar pedido: ' + err.message;
    scannerMostrarBtnOutro();
  }
}

function scannerMostrarResultado(pedido, sid) {
  scannerPedidoAtual = pedido;
  scannerSidAtual    = sid;

  const resultado = document.getElementById('scanner-resultado');
  const itens     = pedido.itensLista || [];

  const itensHtml = itens.map((i, idx) => {
    const thumb = i.thumbnail ? i.thumbnail.replace(/^http:\/\//, 'https://') : null;
    const temInstrucao = !!i.instrucaoDespacho;
    const thumbHtml = thumb
      ? `<img src="${thumb}" onclick="scannerAmpliarFoto(${idx})" title="${temInstrucao ? 'Tem instrução de despacho — toque pra ver' : 'Toque pra ampliar'}" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid ${temInstrucao ? '#f59e0b' : '#334155'};flex-shrink:0;cursor:zoom-in">`
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
  scannerFecharFoto();
  scannerIniciar();
}

// ── Foto ampliada + instrução de despacho ──────────────────────
// A instrução é fixada por anúncio + SKU + variação (não só SKU — o backend usa
// '—' quando o produto não tem SKU cadastrado, e isso misturaria produtos
// diferentes). A chave já vem calculada do backend em item.chaveInstrucao.

function scannerFotoOverlay() {
  let overlay = document.getElementById('foto-ampliada-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'foto-ampliada-overlay';
    overlay.className = 'foto-ampliada-overlay';
    overlay.innerHTML = '<div class="foto-ampliada-conteudo"><img><div class="foto-ampliada-instrucao"></div></div>';
    overlay.addEventListener('click', e => { if (e.target === overlay) scannerFecharFoto(); });
    document.body.appendChild(overlay);
  }
  return overlay;
}

function scannerFecharFoto() {
  const overlay = document.getElementById('foto-ampliada-overlay');
  if (overlay) overlay.classList.remove('aberto');
  scannerInstrucaoEditando = null;
}

function scannerAmpliarFoto(idx) {
  const item = scannerPedidoAtual?.itensLista?.[idx];
  if (!item) return;
  const thumb = item.thumbnail ? item.thumbnail.replace(/^http:\/\//, 'https://') : null;
  if (!thumb) return;

  const overlay = scannerFotoOverlay();
  overlay.querySelector('img').src = thumb;
  scannerRenderInstrucao(idx);
  overlay.classList.add('aberto');
}

function scannerRenderInstrucao(idx) {
  const item = scannerPedidoAtual?.itensLista?.[idx];
  const area = document.querySelector('#foto-ampliada-overlay .foto-ampliada-instrucao');
  if (!item || !area) return;
  const isAdmin = localStorage.getItem('usuarioSenha') === '199412';

  if (scannerInstrucaoEditando === idx) {
    area.innerHTML = `
      <textarea id="instrucao-txt" placeholder="O que precisa ser feito ao separar esse item...">${scannerEscapeHtml(item.instrucaoDespacho || '')}</textarea>
      <div class="foto-ampliada-instrucao-botoes">
        <button class="btn-primary" onclick="scannerSalvarInstrucao(${idx})">Salvar</button>
        <button class="btn-secondary" onclick="scannerRenderInstrucao(${idx})">Cancelar</button>
      </div>
    `;
    document.getElementById('instrucao-txt')?.focus();
    return;
  }

  if (item.instrucaoDespacho) {
    area.innerHTML = `
      <div class="foto-ampliada-instrucao-texto">📌 ${scannerEscapeHtml(item.instrucaoDespacho)}</div>
      ${isAdmin ? `<button class="foto-ampliada-instrucao-editar" onclick="scannerEditarInstrucao(${idx})">✏️ editar instrução</button>` : ''}
    `;
  } else if (isAdmin) {
    area.innerHTML = `<button class="foto-ampliada-instrucao-editar" onclick="scannerEditarInstrucao(${idx})">+ adicionar instrução de despacho</button>`;
  } else {
    area.innerHTML = '';
  }
}

function scannerEditarInstrucao(idx) {
  scannerInstrucaoEditando = idx;
  scannerRenderInstrucao(idx);
}

async function scannerSalvarInstrucao(idx) {
  const item     = scannerPedidoAtual?.itensLista?.[idx];
  const textarea = document.getElementById('instrucao-txt');
  if (!item || !textarea) return;
  const texto = textarea.value.trim();

  try {
    const resp = await fetch('/api/instrucoes-despacho', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chave:    item.chaveInstrucao,
        texto,
        titulo:   item.titulo,
        sku:      item.sku,
        variacao: item.variacao,
        senha:    localStorage.getItem('usuarioSenha') || '',
      }),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(out.error || 'Erro ao salvar');

    item.instrucaoDespacho   = texto || null;
    scannerInstrucaoEditando = null;
    scannerRenderInstrucao(idx);
    // Atualiza a borda âmbar do card do item sem fechar o overlay
    scannerMostrarResultado(scannerPedidoAtual, scannerSidAtual);
  } catch (err) {
    alert('Erro ao salvar instrução: ' + err.message);
  }
}
