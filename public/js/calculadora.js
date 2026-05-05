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

  try {
    // Buscar vendas recentes para calcular médias
    const resp = await fetch(`/api/lucro/vendas?conta=${conta}&date_from=${new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0]}&date_to=${new Date().toISOString().split('T')[0]}`);
    const data = await resp.json();
    if (data.error) {
      alert('Erro: ' + data.error);
      return;
    }

    // Filtrar vendas pelo MLB
    const vendasProduto = data.vendas.filter(v => v.itens.some(i => i.mlb === mlb));
    if (vendasProduto.length === 0) {
      alert('Nenhuma venda encontrada para este MLB.');
      return;
    }

    // Calcular médias
    let totalReceita = 0;
    let totalTaxaML = 0;
    let totalFrete = 0;
    let totalQuantidade = 0;

    vendasProduto.forEach(venda => {
      venda.itens.forEach(item => {
        if (item.mlb === mlb) {
          totalReceita += item.precoUnit * item.quantidade;
          totalTaxaML += item.taxaML; // taxa por item
          totalFrete += venda.freteReal;
          totalQuantidade += item.quantidade;
        }
      });
    });

    const precoMedio = totalReceita / totalQuantidade;
    const taxaMLMedio = totalTaxaML / vendasProduto.length; // média por venda
    const freteMedio = totalFrete / vendasProduto.length;

    // Custo do produto (do config de lucro)
    const configResp = await fetch(`/api/lucro/config?conta=${conta}`);
    const config = await configResp.json();
    const custoProduto = config.custos[mlb] || 0;

    // Imposto
    const impostoValor = precoMedio * (config.taxa_imposto || 0) / 100;

    const lucro = precoMedio - custoProduto - taxaMLMedio - freteMedio - impostoValor;

    document.getElementById('calc-preco-venda').textContent = 'R$ ' + precoMedio.toFixed(2);
    document.getElementById('calc-custo-produto').textContent = 'R$ ' + custoProduto.toFixed(2);
    document.getElementById('calc-taxa-ml').textContent = 'R$ ' + taxaMLMedio.toFixed(2);
    document.getElementById('calc-frete').textContent = 'R$ ' + freteMedio.toFixed(2);
    document.getElementById('calc-imposto').textContent = 'R$ ' + impostoValor.toFixed(2);
    document.getElementById('calc-lucro').textContent = 'R$ ' + lucro.toFixed(2);

    document.getElementById('calc-dados').style.display = 'block';

    // Preencher simulação
    document.getElementById('sim-custo-produto').value = custoProduto;
    document.getElementById('sim-preco-venda').value = precoMedio.toFixed(2);
    document.getElementById('sim-taxa-ml').value = (totalTaxaML / totalReceita * 100).toFixed(2);
    document.getElementById('sim-frete').value = freteMedio.toFixed(2);
    document.getElementById('sim-imposto').value = (config.taxa_imposto || 0);

  } catch (e) {
    alert('Erro ao carregar dados: ' + e.message);
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