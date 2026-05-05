// ============================================================
// calculadora.js — Calculadora de lucro
// ============================================================

function calcContaAtual() {
  return document.querySelector('.conta-btn.active')?.dataset?.conta || '1';
}

async function calcCarregarDados() {
  const mlb = document.getElementById('calc-mlb').value.trim();
  if (!mlb) {
    alert('Digite o MLB do produto.');
    return;
  }

  const conta = calcContaAtual();
  const btn = document.getElementById('btn-calc-carregar');
  const statusEl = document.getElementById('calc-status');
  btn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.textContent = '🔄 Buscando preço atual do anúncio...';

  try {
    // Buscar o preço atual do anúncio (para comparação)
    const itemResp = await fetch(`/api/ml/item/${mlb}?conta=${conta}`);
    const itemData = await itemResp.json();
    if (itemData.error) {
      alert('Erro ao buscar anúncio: ' + itemData.error);
      return;
    }

    const precoAnuncio = itemData.item?.price || 0;

    statusEl.textContent = '🔄 Carregando vendas recentes...';

    // Buscar vendas recentes para usar a última venda do MLB
    const resp = await fetch(`/api/lucro/vendas?conta=${conta}&date_from=${new Date(Date.now() - 90*24*60*60*1000).toISOString().split('T')[0]}&date_to=${new Date().toISOString().split('T')[0]}`);
    const data = await resp.json();
    if (data.error) {
      alert('Erro: ' + data.error);
      return;
    }

    statusEl.textContent = '🔄 Processando dados da última venda...';

    // Filtrar vendas pelo MLB e ordenar pela data mais recente
    const vendasProduto = data.vendas
      .filter(v => v.itens.some(i => i.mlb === mlb))
      .sort((a, b) => new Date(b.data) - new Date(a.data));

    if (!vendasProduto.length) {
      alert('Nenhuma venda encontrada para este MLB.');
      return;
    }

    const ultimaVenda = vendasProduto[0];
    const itemUltimaVenda = ultimaVenda.itens.find(i => i.mlb === mlb);
    const receitaPedido = ultimaVenda.itens.reduce((sum, item) => sum + item.precoUnit * item.quantidade, 0);
    const itemReceita = itemUltimaVenda.precoUnit * itemUltimaVenda.quantidade;
    const freteUltimaVenda = receitaPedido ? (ultimaVenda.freteReal * itemReceita / receitaPedido) : 0;
    const taxaMLUltimaVenda = itemUltimaVenda.taxaML;

    statusEl.textContent = '🔄 Calculando custos e impostos...';

    // Custo do produto (do config de lucro, usando SKU ou MLB)
    const configResp = await fetch(`/api/lucro/config?conta=${conta}`);
    const config = await configResp.json();
    const chaveCusto = itemUltimaVenda.sku || mlb;
    const custoProduto = config.custos[chaveCusto] || 0;

    // Imposto sobre o preço da última venda
    const precoUltimaVenda = itemUltimaVenda.precoUnit;
    const impostoValor = precoUltimaVenda * (config.taxa_imposto || 0) / 100;
    const lucro = precoUltimaVenda - custoProduto - taxaMLUltimaVenda - freteUltimaVenda - impostoValor;
    const margem = precoUltimaVenda > 0 ? (lucro / precoUltimaVenda) * 100 : 0;

    statusEl.textContent = '✅ Calculadora pronta!';

    // Pequena pausa para mostrar o sucesso
    setTimeout(() => {
      document.getElementById('calc-preco-venda').textContent = 'R$ ' + precoUltimaVenda.toFixed(2);
      document.getElementById('calc-custo-produto').textContent = 'R$ ' + custoProduto.toFixed(2);
      document.getElementById('calc-taxa-ml').textContent = 'R$ ' + taxaMLUltimaVenda.toFixed(2);
      document.getElementById('calc-frete').textContent = 'R$ ' + freteUltimaVenda.toFixed(2);
      document.getElementById('calc-imposto').textContent = 'R$ ' + impostoValor.toFixed(2);
      document.getElementById('calc-lucro').textContent = 'R$ ' + lucro.toFixed(2);
      document.getElementById('calc-margem').textContent = margem.toFixed(1) + '%';

      document.getElementById('calc-dados').style.display = 'block';

      // Preencher simulação
      document.getElementById('sim-custo-produto').value = custoProduto;
      document.getElementById('sim-preco-venda').value = precoUltimaVenda.toFixed(2);
      document.getElementById('sim-taxa-ml').value = precoUltimaVenda ? ((taxaMLUltimaVenda / precoUltimaVenda) * 100).toFixed(2) : '0.00';
      document.getElementById('sim-frete').value = freteUltimaVenda.toFixed(2);
      document.getElementById('sim-imposto').value = (config.taxa_imposto || 0);

      console.log('Preço anúncio atual:', precoAnuncio, 'Preço última venda:', precoUltimaVenda);

      btn.disabled = false;
      statusEl.style.display = 'none';
    }, 500);

  } catch (e) {
    alert('Erro ao carregar dados: ' + e.message);
    btn.disabled = false;
    statusEl.style.display = 'none';
  }
}

function calcSimular() {
  const custo_produto = parseFloat(document.getElementById('sim-custo-produto').value) || 0;
  const preco_venda = parseFloat(document.getElementById('sim-preco-venda').value) || 0;
  const taxa_ml_pct = parseFloat(document.getElementById('sim-taxa-ml').value) || 0;
  const frete = parseFloat(document.getElementById('sim-frete').value) || 0;
  const imposto_pct = parseFloat(document.getElementById('sim-imposto').value) || 0;

  const taxa_ml = preco_venda * taxa_ml_pct / 100;
  const imposto = preco_venda * imposto_pct / 100;
  const lucro = preco_venda - custo_produto - taxa_ml - frete - imposto;
  const margem = preco_venda > 0 ? (lucro / preco_venda * 100) : 0;

  document.getElementById('sim-lucro').textContent = 'R$ ' + lucro.toFixed(2);
  document.getElementById('sim-margem').textContent = margem.toFixed(2) + '%';

  document.getElementById('calc-simulacao-resultado').style.display = 'block';
}