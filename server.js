// ============================================================
// server.js — Servidor Express principal
// Serve os arquivos estáticos + rotas da API do Mercado Livre
// ============================================================

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// Arquivo onde as credenciais ficam salvas entre reinicializações
const DATA_FILE = path.join(__dirname, 'data.json');

// ── Middleware ────────────────────────────────────────────────
// Necessário para ler o protocolo correto (https) atrás do proxy do Railway
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers de persistência ───────────────────────────────────

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '{}');
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  // Persiste no Railway como variáveis de ambiente (não bloqueia)
  syncRailwayEnvVars(data).catch(() => {});
}

// ── Persistência via Railway Environment Variables ────────────
// Railway apaga o data.json a cada deploy. Usamos env vars como
// armazenamento permanente. Requer a variável RAILWAY_TOKEN configurada.

async function syncRailwayEnvVars(data) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) return; // sem token, ignora silenciosamente

  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  if (!projectId || !environmentId || !serviceId) return;

  const variables = {};
  if (data.client_id)     variables.ML_CLIENT_ID     = data.client_id;
  if (data.client_secret) variables.ML_CLIENT_SECRET = data.client_secret;
  if (data.access_token)  variables.ML_ACCESS_TOKEN  = data.access_token;
  if (data.refresh_token) variables.ML_REFRESH_TOKEN = data.refresh_token;
  if (data.user_id)       variables.ML_USER_ID       = String(data.user_id);

  await axios.post(
    'https://backboard.railway.app/graphql/v2',
    {
      query: `
        mutation Upsert($input: VariableCollectionUpsertInput!) {
          variableCollectionUpsert(input: $input)
        }
      `,
      variables: {
        input: { projectId, environmentId, serviceId, variables },
      },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// Ao iniciar, restaura dados das env vars se data.json estiver vazio
function initFromEnvVars() {
  const data = loadData();
  let changed = false;
  const map = {
    client_id:     'ML_CLIENT_ID',
    client_secret: 'ML_CLIENT_SECRET',
    access_token:  'ML_ACCESS_TOKEN',
    refresh_token: 'ML_REFRESH_TOKEN',
    user_id:       'ML_USER_ID',
  };
  for (const [key, envKey] of Object.entries(map)) {
    if (!data[key] && process.env[envKey]) {
      data[key] = process.env[envKey];
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

initFromEnvVars();

// ── Rotas de configuração ─────────────────────────────────────

// GET /api/config — retorna config salva (sem o client_secret por segurança)
app.get('/api/config', (req, res) => {
  const data = loadData();
  const { client_secret, ...safe } = data;
  res.json(safe);
});

// POST /api/config — salva credenciais no data.json
app.post('/api/config', (req, res) => {
  const { client_id, client_secret, access_token, refresh_token } = req.body;
  const data = loadData();
  if (client_id     !== undefined) data.client_id     = client_id;
  if (client_secret !== undefined) data.client_secret = client_secret;
  if (access_token  !== undefined) data.access_token  = access_token;
  if (refresh_token !== undefined) data.refresh_token = refresh_token;
  saveData(data);
  res.json({ ok: true });
});

// ── Rotas OAuth Mercado Livre ─────────────────────────────────

// GET /api/ml/debug — mostra a URL de callback gerada (remover após resolver)
app.get('/api/ml/debug', (req, res) => {
  const callback = `${req.protocol}://${req.get('host')}/api/ml/callback`;
  res.json({ callback_url: callback, protocol: req.protocol, host: req.get('host') });
});

// GET /api/ml/auth — redireciona o usuário para a tela de autorização do ML
app.get('/api/ml/auth', (req, res) => {
  const data = loadData();
  if (!data.client_id) {
    return res.redirect('/app.html?tab=config&error=sem_client_id');
  }
  const callback = `${req.protocol}://${req.get('host')}/api/ml/callback`;
  const url = `https://auth.mercadolivre.com.br/authorization`
    + `?response_type=code`
    + `&client_id=${data.client_id}`
    + `&redirect_uri=${encodeURIComponent(callback)}`;
  res.redirect(url);
});

// GET /api/ml/callback — ML redireciona aqui após o usuário autorizar
app.get('/api/ml/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect('/app.html?tab=config&error=auth_cancelado');
  }

  const data     = loadData();
  const callback = `${req.protocol}://${req.get('host')}/api/ml/callback`;

  try {
    // Troca o "code" por tokens de acesso
    const resp = await axios.post(
      'https://api.mercadolibre.com/oauth/token',
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     data.client_id,
        client_secret: data.client_secret,
        code,
        redirect_uri:  callback,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    data.access_token  = resp.data.access_token;
    data.refresh_token = resp.data.refresh_token;
    data.user_id       = resp.data.user_id;
    saveData(data);

    res.redirect('/app.html?tab=config&connected=true');
  } catch (err) {
    const detalhe = JSON.stringify(err.response?.data || err.message);
    console.error('Erro no callback OAuth:', detalhe);
    res.redirect(`/app.html?tab=config&error=auth_falhou&detalhe=${encodeURIComponent(detalhe)}`);
  }
});

// ── Rotas de dados do Mercado Livre ───────────────────────────

// Tenta renovar o token com o refresh_token salvo
async function refreshToken(data) {
  const resp = await axios.post(
    'https://api.mercadolibre.com/oauth/token',
    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     data.client_id,
      client_secret: data.client_secret,
      refresh_token: data.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  data.access_token  = resp.data.access_token;
  data.refresh_token = resp.data.refresh_token;
  saveData(data);
  return data;
}

// GET /api/ml/status — verifica se a conexão está ativa
app.get('/api/ml/status', async (req, res) => {
  const data = loadData();
  if (!data.access_token) return res.json({ connected: false });

  try {
    const resp = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    res.json({ connected: true, nickname: resp.data.nickname });
  } catch {
    res.json({ connected: false });
  }
});

// GET /api/ml/store — dados da loja (com refresh automático se necessário)
app.get('/api/ml/store', async (req, res) => {
  let data = loadData();
  if (!data.access_token) return res.json({ error: 'Não conectado' });

  const fetchStore = async (token) => {
    const resp = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.data;
  };

  try {
    const user = await fetchStore(data.access_token);
    res.json({ name: user.nickname, id: user.id, country: user.country_id });
  } catch (err) {
    // Token expirado — tenta renovar automaticamente
    if (data.refresh_token) {
      try {
        data = await refreshToken(data);
        const user = await fetchStore(data.access_token);
        res.json({ name: user.nickname, id: user.id, country: user.country_id });
      } catch {
        res.json({ error: 'Sessão expirada. Reconecte na aba Configurações.' });
      }
    } else {
      res.json({ error: 'Erro ao buscar loja. Verifique a conexão.' });
    }
  }
});

// GET /api/ml/estoque — lista anúncios com SKU, título, MLB e estoque
app.get('/api/ml/estoque', async (req, res) => {
  let data = loadData();
  if (!data.access_token) return res.json({ error: 'Não conectado' });

  // Busca o user_id se não estiver salvo
  if (!data.user_id) {
    try {
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      data.user_id = me.data.id;
      saveData(data);
    } catch {
      return res.json({ error: 'Não foi possível identificar o usuário.' });
    }
  }

  const limit = 50;

  // Extrai SKU em todas as fontes possíveis da API ML
  function extrairSku(body) {
    if (body.seller_custom_field) return body.seller_custom_field;
    // Atributos no nível do item
    const attrItem = (body.attributes || []).find(a => a.id === 'SELLER_SKU');
    if (attrItem && attrItem.value_name) return attrItem.value_name;
    // Variações
    if (body.variations && body.variations.length > 0) {
      for (const v of body.variations) {
        if (v.seller_custom_field) return v.seller_custom_field;
        const attrVar = (v.attributes || []).find(a => a.id === 'SELLER_SKU');
        if (attrVar && attrVar.value_name) return attrVar.value_name;
      }
    }
    return '—';
  }

  const DEPOSITO_LABEL = {
    fulfillment:   'Full',
    self_service:  'Próprio',
    cross_docking: 'Flex',
    xd_drop_off:   'Próprio',   // drop-off usa estoque do vendedor
  };

  try {
    // 1. Coleta todos os IDs de todos os status e páginas
    const todosIds = [];
    for (const status of ['active', 'paused', 'closed']) {
      let offset = 0;
      while (true) {
        const searchResp = await axios.get(
          `https://api.mercadolibre.com/users/${data.user_id}/items/search`,
          {
            params: { status, offset, limit },
            headers: { Authorization: `Bearer ${data.access_token}` },
          }
        );
        const ids = searchResp.data.results || [];
        todosIds.push(...ids);
        if (ids.length < limit) break;  // última página
        offset += limit;
        if (offset >= 1000) break;      // limite da API ML
      }
    }

    if (!todosIds.length) return res.json({ items: [], total: 0 });

    // 2. Busca detalhes em lote de 20 (limite da API ML)
    const detalhes = [];
    for (let i = 0; i < todosIds.length; i += 20) {
      const chunk = todosIds.slice(i, i + 20);
      const resp  = await axios.get('https://api.mercadolibre.com/items', {
        params: {
          ids:        chunk.join(','),
          attributes: 'id,title,seller_custom_field,available_quantity,variations,shipping,attributes,status,last_updated',
        },
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      detalhes.push(...resp.data);
    }

    // Carrega datas de pausa detectadas anteriormente
    const pauseDates = data.pause_dates || {};
    const agora      = new Date().toISOString();
    let pauseChanged = false;

    const items = detalhes
      .filter(r => r.code === 200)
      .map(r => {
        const logisticType = r.body.shipping?.logistic_type || 'self_service';
        const mlb          = r.body.id;
        const status       = r.body.status;

        // Rastreia quando cada anúncio entrou em pausa
        if (status === 'paused') {
          if (!pauseDates[mlb]) {
            pauseDates[mlb] = agora;  // primeira vez que detectamos como pausado
            pauseChanged = true;
          }
        } else {
          if (pauseDates[mlb]) {
            delete pauseDates[mlb];   // voltou a ativo/encerrado — remove
            pauseChanged = true;
          }
        }

        return {
          mlb,
          titulo:        r.body.title,
          sku:           extrairSku(r.body),
          estoque:       r.body.available_quantity ?? 0,
          status,
          pausadoDesde:  status === 'paused' ? (pauseDates[mlb] || agora) : null,
          deposito:      logisticType,
          depositoLabel: DEPOSITO_LABEL[logisticType] || logisticType,
        };
      });

    // Persiste as datas de pausa se algo mudou
    if (pauseChanged) {
      data.pause_dates = pauseDates;
      saveData(data);
    }

    res.json({ items, total: items.length });
  } catch (err) {
    console.error('Erro ao buscar estoque:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar anúncios. Tente novamente.' });
  }
});

// GET /api/ml/vendas30dias — unidades vendidas por item nos últimos 30 dias
// Retorna objeto { "MLB123": 10, "MLB456": 3, ... }
app.get('/api/ml/vendas30dias', async (req, res) => {
  let data = loadData();
  if (!data.access_token) return res.json({ error: 'Não conectado' });
  if (!data.user_id)      return res.json({ error: 'user_id não encontrado' });

  // Data de 30 dias atrás em ISO 8601
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const vendasPorItem = {};
  let offset = 0;
  const limit = 50;

  try {
    // Pagina todas as ordens pagas dos últimos 30 dias
    while (true) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:                    data.user_id,
          'order.status':            'paid',
          'order.date_created.from': from,
          sort:                      'date_desc',
          offset,
          limit,
        },
        headers: { Authorization: `Bearer ${data.access_token}` },
        timeout: 10000, // 10s por chamada
      });

      const orders = resp.data.results || [];
      const total  = resp.data.paging?.total || 0;

      for (const order of orders) {
        for (const oi of (order.order_items || [])) {
          const id  = oi.item.id;
          const qty = oi.quantity || 1;
          vendasPorItem[id] = (vendasPorItem[id] || 0) + qty;
        }
      }

      if (orders.length < limit) break;
      offset += limit;
      if (offset >= total || offset >= 2000) break;
    }

    res.json(vendasPorItem);
  } catch (err) {
    console.error('Erro ao buscar vendas:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar vendas.' });
  }
});

// GET /api/ml/vendas-etiquetas — vendas pagas com etiqueta disponível para baixar
app.get('/api/ml/vendas-etiquetas', async (req, res) => {
  let data = loadData();
  if (!data.access_token) return res.json({ error: 'Não conectado' });
  if (!data.user_id)      return res.json({ error: 'user_id não encontrado' });

  // Statuses onde a etiqueta existe e pode ser baixada/rebaixada
  const LABEL_STATUSES = new Set(['handling', 'ready_to_ship', 'shipped']);

  try {
    // Busca ordens pagas recentes (até 200)
    const todasOrdens = [];
    let offset = 0;
    const limit = 50;
    while (true) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:         data.user_id,
          'order.status': 'paid',
          sort:           'date_desc',
          offset,
          limit,
        },
        headers: { Authorization: `Bearer ${data.access_token}` },
        timeout: 15000,
      });
      const orders = resp.data.results || [];
      todasOrdens.push(...orders);
      if (orders.length < limit || todasOrdens.length >= 200) break;
      offset += limit;
    }

    // Filtra ordens que têm shipment e não são Full (Full não precisa de etiqueta)
    const comShipment = todasOrdens.filter(o =>
      o.shipping && o.shipping.id && o.shipping.logistic_type !== 'fulfillment'
    );

    // Busca detalhes dos shipments em paralelo (lotes de 10)
    const resultado = [];
    for (let i = 0; i < comShipment.length; i += 10) {
      const lote = comShipment.slice(i, i + 10);
      const detalhes = await Promise.all(
        lote.map(async (order) => {
          try {
            const r = await axios.get(
              `https://api.mercadolibre.com/shipments/${order.shipping.id}`,
              { headers: { Authorization: `Bearer ${data.access_token}` }, timeout: 8000 }
            );
            return { order, shipment: r.data };
          } catch {
            return { order, shipment: null };
          }
        })
      );
      resultado.push(...detalhes);
    }

    const SUBSTATUS_LABEL = {
      ready_to_print: 'Baixar',
      printed:        'Baixar novamente',
    };

    const STATUS_PT = {
      handling:      'Preparando',
      ready_to_ship: 'Aguardando coleta',
      shipped:       'Enviado',
    };

    const vendas = resultado
      .filter(({ shipment }) => shipment && LABEL_STATUSES.has(shipment.status))
      .map(({ order, shipment }) => ({
        orderId:    order.id,
        data:       order.date_created,
        comprador:  order.buyer?.nickname || '—',
        itens:      (order.order_items || []).map(i => `${i.quantity}x ${i.item.title}`).join(' | '),
        total:      order.total_amount,
        shipmentId: shipment.id,
        status:     shipment.status,
        statusLabel: STATUS_PT[shipment.status] || shipment.status,
        acaoLabel:  SUBSTATUS_LABEL[shipment.substatus] || (shipment.status === 'shipped' ? 'Baixar novamente' : 'Baixar'),
      }));

    res.json({ vendas });
  } catch (err) {
    console.error('Erro ao buscar vendas com etiqueta:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar vendas.' });
  }
});

// GET /api/ml/etiqueta/:shipment_id — proxy para download do PDF da etiqueta
app.get('/api/ml/etiqueta/:shipment_id', async (req, res) => {
  const data = loadData();
  if (!data.access_token) return res.status(401).json({ error: 'Não conectado' });

  try {
    const resp = await axios.get(
      `https://api.mercadolibre.com/shipments/${req.params.shipment_id}/labels`,
      {
        params:       { response_type: 'pdf' },
        headers:      { Authorization: `Bearer ${data.access_token}` },
        responseType: 'stream',
        timeout:      15000,
      }
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="etiqueta-${req.params.shipment_id}.pdf"`);
    resp.data.pipe(res);
  } catch (err) {
    console.error('Erro ao baixar etiqueta:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao baixar etiqueta.' });
  }
});

// ── Inicia o servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
