const AGENTE_URL = 'http://localhost:4001';

let fiscalGruposCache = [];

async function fiscalSincronizar() {
  const btn    = document.getElementById('btn-fiscal-sync');
  const status = document.getElementById('fiscal-status');
  const erroEl = document.getElementById('fiscal-agente-erro');

  btn.disabled = true;
  btn.textContent = '⏳ Importando...';
  status.textContent = '';
  erroEl.style.display = 'none';

  try {
    const resp = await fetch(`${AGENTE_URL}/sync`, { method: 'GET', signal: AbortSignal.timeout(60000) });
    const d = await resp.json();
    if (d.ok) {
      status.textContent = `✅ ${d.novas ?? 0} notas novas importadas`;
      await fiscalCarregar();
    } else {
      status.textContent = `⚠️ ${d.erro || 'Erro ao sincronizar'}`;
    }
  } catch {
    erroEl.style.display = 'block';
    status.textContent = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇️ Importar do Fiscal.io';
  }
}

function fiscalDataCorte(meses) {
  if (!meses) return null;
  const d = new Date();
  d.setMonth(d.getMonth() - meses);
  // Formato dtemi: YYYY.MM.DD
  return d.toISOString().slice(0, 10).replace(/-/g, '.');
}

function fiscalFiltrar() {
  const sel   = document.getElementById('fiscal-periodo');
  const meses = sel ? parseInt(sel.value) : 3;
  const corte = fiscalDataCorte(meses);
  const container = document.getElementById('fiscal-container');
  if (!fiscalGruposCache.length) return;

  const html = fiscalGruposCache.map(g => {
    const notasFiltradas = corte
      ? g.notas.filter(n => (n.dtemi || '') >= corte)
      : g.notas;
    if (!notasFiltradas.length) return '';
    return fiscalRenderGrupo({ ...g, notas: notasFiltradas });
  }).filter(Boolean).join('');

  container.innerHTML = html || '<p style="color:#888;font-size:14px">Nenhuma nota no período selecionado.</p>';
}

function fiscalHora(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fiscalResumoTexto(resumo, ultNSU, maxNSU) {
  if (!resumo) return '';
  const tipos = Object.entries(resumo.porSchema || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  const falta = Math.max(0, parseInt(maxNSU || 0, 10) - parseInt(ultNSU || 0, 10));
  return `Tipos: ${tipos || '—'}
Notas de compra: ${resumo.notasCompra} (já existiam: ${resumo.jaExistiam}) · ignorados (vendas próprias/eventos): ${resumo.ignorados} · cancelamentos: ${resumo.cancelamentos}${resumo.erros ? ` · erros: ${resumo.erros}` : ''}
NSU ${parseInt(ultNSU || 0, 10)}/${parseInt(maxNSU || 0, 10)}${falta ? ` — faltam ${falta} documento(s)` : ' — em dia'}`;
}

const fiscalEsc = s => String(s || '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Resposta da SEFAZ em linguagem simples (o código técnico fica nos detalhes)
function fiscalStatusSefaz(st) {
  if (!st) return { txt: 'Ainda não consultou', cls: '' };
  if (st.cStat === '138') return { txt: 'Notas encontradas', cls: 'fiscal-card-ok' };
  if (st.cStat === '137') return { txt: 'Nada novo', cls: 'fiscal-card-ok' };
  if (st.cStat === '656') return { txt: 'SEFAZ pediu pra esperar 1h', cls: 'fiscal-card-erro' };
  return { txt: `Erro ${st.cStat}`, cls: 'fiscal-card-erro' };
}

let fiscalSefazContas = [];

async function fiscalCarregarSefazStatus() {
  const box = document.getElementById('fiscal-sefaz-cards');
  if (!box) return;
  const d = await fetch('/api/sefaz-dfe/status').then(r => r.json()).catch(() => null);
  if (!d || !d.contas) return;
  fiscalSefazContas = d.contas;
  const card = (label, valor, sub, extra = '') =>
    `<div class="lucro-card ${extra}"><div class="lucro-card-label">${label}</div><div class="lucro-card-valor">${valor}</div>${sub ? `<div class="fiscal-card-sub">${sub}</div>` : ''}</div>`;
  const hora = ts => ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  const dia  = ts => ts ? new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';

  box.innerHTML = d.contas.map(c => {
    if (!c.temCert) return card(`SEFAZ C${c.conta}`, 'Sem certificado', 'Salve o certificado em 🔐 Certificados digitais');
    const st = fiscalStatusSefaz(c.ultimoStatus);
    const ult = parseInt(c.ultNSU || 0, 10), max = parseInt(c.maxNSU || 0, 10);
    const falta = Math.max(0, max - ult);
    const fila = !max ? card('Fila da SEFAZ', '—', 'ainda não consultou')
      : falta
        ? card('Carga inicial', `${Math.floor(ult / max * 100)}%`, `faltam ${falta.toLocaleString('pt-BR')} documentos<div class="fiscal-progresso"><div style="width:${Math.floor(ult / max * 100)}%"></div></div>`)
        : card('Fila da SEFAZ', 'Em dia', c.ultimasNovas ? `últimas novas: ${c.ultimasNovas.qtd} em ${dia(c.ultimasNovas.ts)} ${hora(c.ultimasNovas.ts)}` : '');
    return card('Última consulta', hora(c.ultimaConsulta), `<span class="${st.cls}">${st.txt}</span> · ${dia(c.ultimaConsulta)}`)
      + card('Próxima consulta', hora(c.proximaConsulta), 'automática')
      + card('Aguardando ciência', c.aguardandoCiencia || 0, c.aguardandoXml ? `+ ${c.aguardandoXml} com ciência, esperando XML` : 'notas sem XML (90 dias)', c.aguardandoCiencia ? 'fiscal-card-aviso' : '')
      + fila;
  }).join('');
  box.style.display = 'flex';

  const tec = document.getElementById('fiscal-sefaz-tecnico');
  if (tec) tec.textContent = d.contas.map(c =>
    `C${c.conta} — ${c.titular || ''} (${c.cnpj || 'sem CNPJ'})
Última resposta: ${c.ultimoStatus ? `${c.ultimoStatus.cStat} — ${c.ultimoStatus.xMotivo}` : '—'}
${fiscalResumoTexto(c.ultimoResumo, c.ultNSU, c.maxNSU)}`
  ).join('\n\n');
}

async function fiscalDiagnosticoSefaz(btn) {
  const conta = fiscalSefazContas[0]?.conta || '1';
  btn.disabled = true;
  btn.textContent = '⏳ Testando...';
  const out = document.getElementById('fiscal-sefaz-diag');
  try {
    const r = await fetch(`/api/sefaz-dfe/diagnostico?conta=${conta}`).then(r => r.json());
    out.textContent = JSON.stringify(r, null, 2);
  } catch (err) {
    out.textContent = 'Erro: ' + err.message;
  }
  out.style.display = 'block';
  btn.disabled = false;
  btn.textContent = 'Testar conexão (diagnóstico)';
}

async function fiscalConsultarSefaz(btn) {
  const conta = fiscalSefazContas[0]?.conta || '1';
  const msg = document.getElementById('fiscal-status');
  const textoBtn = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Consultando...';
  msg.textContent = '';
  try {
    const r = await fetch('/api/sefaz-dfe/consultar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conta }),
    }).then(r => r.json());
    if (!r.ok) msg.textContent = '⚠️ ' + (r.erro || 'Erro ao consultar SEFAZ');
    else if (r.pulou) msg.textContent = '⏳ A SEFAZ ainda não liberou nova consulta (regra de 1h).';
    else {
      const st = fiscalStatusSefaz(r.status);
      msg.textContent = `${st.cls === 'fiscal-card-erro' ? '⚠️' : '✅'} ${st.txt} — ${r.docs || 0} documento(s) lido(s), ${r.novas || 0} nota(s) nova(s)`;
      await fiscalCarregar();
    }
  } catch (err) {
    msg.textContent = '⚠️ Erro: ' + err.message;
  }
  btn.disabled = false;
  btn.textContent = textoBtn;
  await fiscalCarregarSefazStatus();
}

async function fiscalCarregar() {
  const container = document.getElementById('fiscal-container');
  if (!container) return;
  fiscalCarregarSefazStatus();
  try {
    const grupos = await fetch(`/api/fiscal/notas?conta=${window.CONTA_ATIVA}`).then(r => r.json());
    fiscalGruposCache = grupos;
    if (!grupos.length) {
      container.innerHTML = '<p style="color:#888;font-size:14px">Nenhuma nota ainda. A consulta automática da SEFAZ traz as notas sozinha.</p>';
      return;
    }
    fiscalFiltrar();
  } catch {
    container.innerHTML = '<p style="color:#c00;font-size:14px">Erro ao carregar notas.</p>';
  }
}

function fiscalRenderGrupo(g) {
  const cnpjFmt = (g.cnpj || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  const total   = g.notas.reduce((s, n) => s + parseFloat((n.valor || '0').replace(',', '.')), 0);
  const totalFmt = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const linhas = g.notas.map(n => {
    const data  = (n.dtemi || '').replace(/(\d{4})\.(\d{2})\.(\d{2})/, '$3/$2/$1');
    const valor = parseFloat((n.valor || '0').replace(',', '.'));
    const vFmt  = valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const chave   = n.chave ? `<span title="${n.chave}" style="cursor:pointer;color:#aaa;font-size:11px" onclick="navigator.clipboard.writeText('${n.chave}')">📋</span>` : '';
    const xmlBadge = `<span title="Clique para ver DANFE" style="background:#16a34a;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;cursor:pointer" onclick="fiscalAbrirDanfe('${n.chave}')">XML</span>`;
    const cpBadge  = `<span title="Contas a Pagar lançado" style="background:#1d4ed8;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600;margin-left:3px">CP✓</span>`;
    const cpBtn    = `<button onclick="fiscalLancarCP('${n.chave}', this)" style="background:none;border:1px solid #16a34a;color:#16a34a;border-radius:4px;padding:1px 5px;font-size:10px;cursor:pointer;margin-left:3px" title="Lançar Contas a Pagar">💰</button>`;
    const dlBtn    = n.chave ? `<button onclick="fiscalBaixarXml('${n.chave}', this)" style="background:none;border:1px solid #475569;color:#94a3b8;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer" title="Baixar XML da SEFAZ">📥</button>` : '';
    // Ciência da Operação: só manual, nota a nota (libera o XML completo na SEFAZ)
    const cienciaErro = n.ciencia && !n.ciencia.ok ? `Última tentativa recusada: ${n.ciencia.cStat} ${n.ciencia.xMotivo || ''}`.replace(/"/g, "'") : '';
    const cienciaCol = n.temXml || n.cancelada || !n.chave || (n.dtemi || '') < fiscalDataCorte(3) ? ''
      : n.ciencia?.ok
        ? `<span title="Ciência dada em ${fiscalHora(n.ciencia.ts)} — o XML chega numa das próximas consultas" style="background:#475569;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600;margin-left:3px">Ciência ✓</span>`
        : `<button onclick="fiscalDarCiencia('${n.chave}', this)" style="background:none;border:1px solid ${cienciaErro ? '#dc2626' : '#d97706'};color:${cienciaErro ? '#dc2626' : '#d97706'};border-radius:4px;padding:1px 5px;font-size:10px;cursor:pointer;margin-left:3px" title="${cienciaErro || 'Dar Ciência da Operação na SEFAZ (libera o XML completo)'}">✋ Ciência</button>`;
    const xmlCol   = (n.temXml
      ? xmlBadge + (n.cpLancado ? cpBadge : cpBtn)
      : n.cpLancado
        ? dlBtn + cpBadge
        : dlBtn) + cienciaCol;
    return `<tr>
      <td>${data}</td>
      <td>${n.num || '—'}-${n.serie || ''}</td>
      <td>${n.emitnome || '—'}${n.cancelada ? ' <span style="background:#dc2626;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600">CANCELADA</span>' : ''}</td>
      <td style="font-size:11px;color:#888">${(n.emitid || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')}</td>
      <td style="text-align:right;font-weight:600">${vFmt}</td>
      <td style="font-size:11px;color:#888;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${n.natoper || ''}">${n.natoper || '—'}</td>
      <td style="text-align:center;white-space:nowrap">${xmlCol}</td>
      <td>${chave}</td>
    </tr>`;
  }).join('');

  return `
    <div style="margin-bottom:28px">
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:16px">${g.nome || g.cnpj}</h2>
        <span style="font-size:12px;color:#888">${cnpjFmt}</span>
        <span style="font-size:12px;color:#888">${g.notas.length} nota(s)</span>
        <span style="font-size:12px;font-weight:600;margin-left:auto">${totalFmt}</span>
      </div>
      <div class="tabela-container">
        <table class="tabela">
          <thead><tr>
            <th>Data</th><th>NF / Série</th><th>Fornecedor</th><th>CNPJ Forn.</th>
            <th style="text-align:right">Valor</th><th>Natureza</th><th style="text-align:center">XML</th><th></th>
          </tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>`;
}

async function fiscalBaixarXml(chave, btn) {
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const r = await fetch('/api/fiscal/baixar-xml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave }),
    }).then(r => r.json());
    if (r.ok) {
      btn.outerHTML = `<span title="Clique para ver DANFE" style="background:#16a34a;color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;cursor:pointer" onclick="fiscalAbrirDanfe('${chave}')">XML</span><button onclick="fiscalLancarCP('${chave}', this)" style="background:none;border:1px solid #16a34a;color:#16a34a;border-radius:4px;padding:1px 5px;font-size:10px;cursor:pointer;margin-left:3px" title="Lançar Contas a Pagar">💰</button>`;
    } else {
      btn.disabled = false;
      btn.textContent = '📥';
      alert('Erro ao baixar XML: ' + (r.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '📥';
    alert('Erro: ' + err.message);
  }
}

async function fiscalDarCiencia(chave, btn) {
  const nf = String(parseInt(chave.slice(25, 34), 10));
  if (!confirm(`Dar Ciência da Operação na SEFAZ para a NF ${nf}?\n\nIsso registra na SEFAZ que a empresa tomou conhecimento da nota e libera o XML completo.`)) return;
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const r = await fetch('/api/sefaz-dfe/ciencia', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chaves: [chave] }),
    }).then(r => r.json());
    const res = r.resultado?.[chave];
    if (!r.ok) alert('Erro: ' + (r.erro || 'Erro desconhecido'));
    else if (!['135', '136', '573'].includes(res?.cStat)) alert(`SEFAZ recusou: ${res?.cStat} — ${res?.xMotivo || ''}`);
  } catch (err) {
    alert('Erro: ' + err.message);
  }
  await fiscalCarregar();
}

function fiscalAbrirDanfe(chave) {
  window.open(`/api/fiscal/danfe/${chave}`, '_blank');
}

async function fiscalLancarCP(chave, btn) {
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const r = await fetch('/api/fiscal/lancar-cp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chave }),
    }).then(r => r.json());
    if (r.ok) {
      if (r.importados > 0) {
        btn.outerHTML = `<span title="${r.importados} parcela(s) lançada(s)" style="background:#1d4ed8;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600">CP✓</span>`;
      } else {
        btn.disabled = false;
        btn.textContent = '💰';
        alert(r.aviso || `${r.dup ?? 0} parcela(s) já existem em Contas a Pagar.`);
      }
    } else {
      btn.disabled = false;
      btn.textContent = '💰';
      alert('Erro: ' + (r.erro || 'Erro desconhecido'));
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '💰';
    alert('Erro: ' + err.message);
  }
}

async function fiscalCarregarCerts() {
  for (const num of ['1', '2']) {
    const s = await fetch(`/api/notas/config?conta=${num}`).then(r => r.json()).catch(() => null);
    const box = document.getElementById(`fiscal-cert-info-${num}`);
    if (box && s?.cnpj) {
      const cnpjFmt = s.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
      box.textContent = `✅ ${s.titular || ''} — CNPJ ${cnpjFmt}`;
      box.style.display = 'block';
    }
  }
}

async function fiscalSalvarCert(conta) {
  const fileInput = document.getElementById(`fiscal-cert-file-${conta}`);
  const senha     = document.getElementById(`fiscal-cert-senha-${conta}`).value;
  const msg       = document.getElementById('fiscal-cert-msg');
  msg.style.display = 'none';
  if (!fileInput.files[0]) { msg.textContent = 'Selecione o arquivo .pfx'; msg.style.color = '#f87171'; msg.style.display = 'block'; return; }
  if (!senha)              { msg.textContent = 'Informe a senha'; msg.style.color = '#f87171'; msg.style.display = 'block'; return; }
  msg.textContent = 'Processando...'; msg.style.color = '#94a3b8'; msg.style.display = 'block';
  const cnpj    = (document.getElementById(`fiscal-cert-cnpj-${conta}`)?.value    || '').replace(/\D/g, '');
  const titular = document.getElementById(`fiscal-cert-titular-${conta}`)?.value || '';
  const form = new FormData();
  form.append('cert', fileInput.files[0]);
  form.append('senha', senha);
  form.append('conta', conta);
  if (cnpj)    form.append('cnpj', cnpj);
  if (titular) form.append('titular', titular);
  try {
    const d = await fetch('/api/notas/certificado', { method: 'POST', body: form }).then(r => r.json());
    if (d.error) { msg.textContent = d.error; msg.style.color = '#f87171'; return; }
    msg.textContent = `✅ Certificado C${conta} salvo — CNPJ: ${d.cnpj}`;
    msg.style.color = '#4ade80';
    const box = document.getElementById(`fiscal-cert-info-${conta}`);
    if (box) { box.textContent = `✅ ${d.titular || d.cnpj} — ${d.cnpj}`; box.style.display = 'block'; }
    fileInput.value = '';
    document.getElementById(`fiscal-cert-senha-${conta}`).value = '';
  } catch { msg.textContent = 'Erro ao salvar certificado.'; msg.style.color = '#f87171'; }
}

