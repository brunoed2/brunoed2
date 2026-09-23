// Busca na página estilo Ctrl+F para o webapp do iPhone (modo standalone não tem "Encontrar na Página").
// Abre/fecha com um toque rápido de 3 dedos em qualquer lugar da tela.
(function () {
  'use strict';
  if (window.__buscaPaginaInit) return;
  window.__buscaPaginaInit = true;

  var MAX_HITS = 500;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, TITLE: 1 };

  var ui = null, input = null, contador = null;
  var aberto = false;
  var hits = [];
  var atual = -1;
  var truncado = false;
  var cacheVis = null;
  var observer = null;
  var timerDigitacao = null, timerObserver = null;

  function norm(s) {
    if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase();
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === ' ') { out += ' '; continue; }
      var d = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (d.length !== 1) d = c;
      var l = d.toLowerCase();
      out += (l.length === 1 ? l : d);
    }
    return out;
  }

  function visivel(el) {
    var v = cacheVis.get(el);
    if (v === undefined) {
      v = el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      cacheVis.set(el, v);
    }
    return v;
  }

  function coletarTextos() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || SKIP_TAGS[p.tagName]) return NodeFilter.FILTER_REJECT;
        if (ui && ui.contains(p)) return NodeFilter.FILTER_REJECT;
        if (!visivel(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function descartarRegistrosProprios() {
    if (observer) observer.takeRecords();
  }

  function limparMarcas() {
    var marks = document.querySelectorAll('mark.bp-hit');
    var pais = [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i], p = m.parentNode;
      if (!p) continue;
      p.replaceChild(document.createTextNode(m.textContent), m);
      pais.push(p);
    }
    for (var j = 0; j < pais.length; j++) pais[j].normalize();
    hits = [];
    atual = -1;
    truncado = false;
  }

  function atualizarContador() {
    if (!contador) return;
    var q = input.value.trim();
    if (!q) { contador.textContent = ''; input.classList.remove('bp-vazio'); return; }
    contador.textContent = (hits.length ? (atual + 1) : 0) + '/' + hits.length + (truncado ? '+' : '');
    input.classList.toggle('bp-vazio', hits.length === 0);
  }

  function destacarAtual(rolar) {
    var prev = document.querySelector('mark.bp-atual');
    if (prev) prev.classList.remove('bp-atual');
    if (atual < 0 || !hits[atual]) { atualizarContador(); return; }
    hits[atual].classList.add('bp-atual');
    if (rolar) hits[atual].scrollIntoView({ block: 'center', inline: 'nearest' });
    atualizarContador();
  }

  function buscar(manterIndice, rolar) {
    var indiceAnterior = atual;
    limparMarcas();
    var bruto = input.value;
    if (!bruto.trim()) { atualizarContador(); descartarRegistrosProprios(); return; }
    var query = norm(bruto);

    cacheVis = new Map();
    var nodes = coletarTextos();
    cacheVis = null;

    var encontrados = [];
    var total = 0;
    for (var i = 0; i < nodes.length && !truncado; i++) {
      var t = norm(nodes[i].nodeValue);
      var pos = [];
      var idx = t.indexOf(query);
      while (idx !== -1) {
        if (total >= MAX_HITS) { truncado = true; break; }
        pos.push(idx);
        total++;
        idx = t.indexOf(query, idx + query.length);
      }
      if (pos.length) encontrados.push({ node: nodes[i], pos: pos });
    }

    for (var e = 0; e < encontrados.length; e++) {
      var node = encontrados[e].node, posicoes = encontrados[e].pos;
      var marcas = [];
      for (var k = posicoes.length - 1; k >= 0; k--) {
        var meio = node.splitText(posicoes[k]);
        meio.splitText(query.length);
        var mark = document.createElement('mark');
        mark.className = 'bp-hit';
        meio.parentNode.insertBefore(mark, meio);
        mark.appendChild(meio);
        marcas.push(mark);
      }
      marcas.reverse();
      for (var m = 0; m < marcas.length; m++) hits.push(marcas[m]);
    }

    if (hits.length) {
      atual = manterIndice ? Math.min(Math.max(indiceAnterior, 0), hits.length - 1) : 0;
    }
    destacarAtual(rolar);
    descartarRegistrosProprios();
  }

  function navegar(delta) {
    if (!hits.length || hits.some(function (m) { return !m.isConnected; })) buscar(true, false);
    if (!hits.length) return;
    atual = (atual + delta + hits.length) % hits.length;
    destacarAtual(true);
  }

  function criarUI() {
    var css = document.createElement('style');
    css.textContent =
      '#bp-bar{position:fixed;left:0;right:0;top:0;z-index:2147483000;display:none;align-items:center;gap:6px;' +
        'padding:calc(env(safe-area-inset-top,0px) + 8px) 8px 8px;background:#1e293b;box-shadow:0 2px 10px rgba(0,0,0,.4);}' +
      '#bp-bar.bp-aberta{display:flex;}' +
      '#bp-bar input{flex:1;min-width:0;font-size:16px;padding:8px 10px;border-radius:8px;border:1px solid #475569;' +
        'background:#0f172a;color:#f8fafc;outline:none;-webkit-appearance:none;}' +
      '#bp-bar input.bp-vazio{border-color:#ef4444;}' +
      '#bp-bar .bp-cont{color:#cbd5e1;font-size:13px;min-width:44px;text-align:center;font-family:system-ui,sans-serif;}' +
      '#bp-bar button{width:40px;height:40px;border:0;border-radius:8px;background:#334155;color:#f8fafc;font-size:16px;' +
        'line-height:1;padding:0;-webkit-appearance:none;}' +
      '#bp-bar button:active{background:#475569;}' +
      'mark.bp-hit{background:#fde047;color:#000;border-radius:2px;padding:0;}' +
      'mark.bp-hit.bp-atual{background:#fb923c;}';
    document.head.appendChild(css);

    ui = document.createElement('div');
    ui.id = 'bp-bar';
    ui.innerHTML =
      '<input type="search" enterkeyhint="search" placeholder="Buscar na página..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">' +
      '<span class="bp-cont"></span>' +
      '<button type="button" data-a="ant" aria-label="Anterior">▲</button>' +
      '<button type="button" data-a="prox" aria-label="Próximo">▼</button>' +
      '<button type="button" data-a="fechar" aria-label="Fechar">✕</button>';
    document.body.appendChild(ui);

    input = ui.querySelector('input');
    contador = ui.querySelector('.bp-cont');

    input.addEventListener('input', function () {
      clearTimeout(timerDigitacao);
      timerDigitacao = setTimeout(function () { buscar(false, true); }, 250);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); navegar(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { fechar(); }
    });
    ui.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (a === 'ant') navegar(-1);
      else if (a === 'prox') navegar(1);
      else if (a === 'fechar') fechar();
    });
  }

  function iniciarObserver() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      var externo = records.some(function (r) { return !(ui && ui.contains(r.target)); });
      if (!externo) return;
      clearTimeout(timerObserver);
      timerObserver = setTimeout(function () {
        if (aberto && input.value.trim()) buscar(true, false);
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function abrir() {
    if (!ui) criarUI();
    aberto = true;
    ui.classList.add('bp-aberta');
    iniciarObserver();
    input.focus();
    input.select();
    if (input.value.trim()) buscar(false, false);
  }

  function fechar() {
    aberto = false;
    clearTimeout(timerDigitacao);
    clearTimeout(timerObserver);
    if (observer) { observer.disconnect(); observer = null; }
    limparMarcas();
    if (ui) { ui.classList.remove('bp-aberta'); input.blur(); }
  }

  function alternar() { if (aberto) fechar(); else abrir(); }

  var g = null;
  document.addEventListener('touchstart', function (e) {
    if (e.touches.length === 1) {
      g = { t: Date.now(), max: 1, x: e.touches[0].clientX, y: e.touches[0].clientY, moveu: false };
    } else if (g) {
      g.max = Math.max(g.max, e.touches.length);
    }
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!g || g.moveu) return;
    var t = e.touches[0];
    if (Math.abs(t.clientX - g.x) > 30 || Math.abs(t.clientY - g.y) > 30) g.moveu = true;
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!g || e.touches.length > 0) return;
    var ok = g.max >= 3 && !g.moveu && (Date.now() - g.t) < 800;
    g = null;
    if (ok) alternar();
  }, { passive: true });
  document.addEventListener('touchcancel', function () { g = null; }, { passive: true });

  window.buscaPagina = { abrir: abrir, fechar: fechar, alternar: alternar };
})();
