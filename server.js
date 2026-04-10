// ============================================================
// server.js — Servidor Express principal
// Serve os arquivos estáticos + rotas da API do Mercado Livre
// Suporta duas contas ML com alternância em tempo real
// ============================================================

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');

// ── Middleware ────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers de persistência ───────────────────────────────────

function loadData() {
  let raw = {};
  if (fs.existsSync(DATA_FILE)) {
    try { raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  // Migração do formato antigo (flat) para novo (multi-conta)
  if (!raw.contas) {
    const c1 = {};
    for (const k of ['client_id','client_secret','access_token','refresh_token','user_id']) {
      if (raw[k]) c1[k] = raw[k];
    }
    if (raw.pause_dates) c1.pause_dates = raw.pause_dates;
    raw = { conta_ativa: '1', contas: { '1': c1, '2': {} } };
    fs.writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2));
  }
  raw.conta_ativa     = raw.conta_ativa || '1';
  raw.contas          = raw.contas      || {};
  raw.contas['1']     = raw.contas['1'] || {};
  raw.contas['2']     = raw.contas['2'] || {};
  return raw;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  syncRailwayEnvVars(data).catch(() => {});
}

// Retorna as credenciais da conta atualmente ativa
function contaAtiva(data) {
  return data.contas[data.conta_ativa] || {};
}

// ── Persistência via Railway Environment Variables ────────────

async function syncRailwayEnvVars(data) {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) return;
  const projectId     = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;
  const serviceId     = process.env.RAILWAY_SERVICE_ID;
  if (!projectId || !environmentId || !serviceId) return;

  const variables = { ML_CONTA_ATIVA: data.conta_ativa || '1' };
  for (const num of ['1', '2']) {
    const c = data.contas[num] || {};
    if (c.client_id)     variables[`ML_CLIENT_ID_${num}`]     = c.client_id;
    if (c.client_secret) variables[`ML_CLIENT_SECRET_${num}`] = c.client_secret;
    if (c.access_token)  variables[`ML_ACCESS_TOKEN_${num}`]  = c.access_token;
    if (c.refresh_token) variables[`ML_REFRESH_TOKEN_${num}`] = c.refresh_token;
    if (c.user_id)       variables[`ML_USER_ID_${num}`]       = String(c.user_id);
  }

  await axios.post(
    'https://backboard.railway.app/graphql/v2',
    {
      query: `mutation Upsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }`,
      variables: { input: { projectId, environmentId, serviceId, variables } },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

function initFromEnvVars() {
  const data = loadData();
  let changed = false;

  if (!data.conta_ativa && process.env.ML_CONTA_ATIVA) {
    data.conta_ativa = process.env.ML_CONTA_ATIVA;
    changed = true;
  }

  // Formato novo: ML_CLIENT_ID_1, ML_CLIENT_ID_2, etc.
  for (const num of ['1', '2']) {
    const c = data.contas[num] || {};
    const map = {
      client_id:     `ML_CLIENT_ID_${num}`,
      client_secret: `ML_CLIENT_SECRET_${num}`,
      access_token:  `ML_ACCESS_TOKEN_${num}`,
      refresh_token: `ML_REFRESH_TOKEN_${num}`,
      user_id:       `ML_USER_ID_${num}`,
    };
    for (const [key, envKey] of Object.entries(map)) {
      if (!c[key] && process.env[envKey]) {
        c[key] = process.env[envKey];
        changed = true;
      }
    }
    data.contas[num] = c;
  }

  // Formato antigo (pré-multi-conta): ML_CLIENT_ID, ML_ACCESS_TOKEN, etc. → conta 1
  const oldMap = {
    client_id:     'ML_CLIENT_ID',
    client_secret: 'ML_CLIENT_SECRET',
    access_token:  'ML_ACCESS_TOKEN',
    refresh_token: 'ML_REFRESH_TOKEN',
    user_id:       'ML_USER_ID',
  };
  const c1 = data.contas['1'];
  for (const [key, envKey] of Object.entries(oldMap)) {
    if (!c1[key] && process.env[envKey]) {
      c1[key] = process.env[envKey];
      changed = true;
    }
  }

  if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

initFromEnvVars();

// Busca nickname das contas conectadas que ainda não têm o campo salvo
async function fetchMissingNicknames() {
  const data = loadData();
  let changed = false;
  for (const num of ['1', '2']) {
    const c = data.contas[num];
    if (c && c.access_token && !c.nickname) {
      try {
        const resp = await axios.get('https://api.mercadolibre.com/users/me', {
          headers: { Authorization: `Bearer ${c.access_token}` },
          timeout: 8000,
        });
        c.nickname = resp.data.nickname;
        changed = true;
      } catch {}
    }
  }
  if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

fetchMissingNicknames();

// ── Rotas: conta ativa ────────────────────────────────────────

app.get('/api/conta/ativa', (req, res) => {
  const data = loadData();
  res.json({
    conta_ativa: data.conta_ativa,
    contas: {
      '1': { nickname: data.contas['1']?.nickname || null },
      '2': { nickname: data.contas['2']?.nickname || null },
    },
  });
});

app.post('/api/conta/ativa', (req, res) => {
  const { conta } = req.body;
  if (!['1', '2'].includes(conta)) return res.status(400).json({ error: 'Conta inválida' });
  const data = loadData();
  data.conta_ativa = conta;
  saveData(data);
  res.json({ ok: true });
});

// ── Rotas de configuração ─────────────────────────────────────

app.get('/api/config', (req, res) => {
  const data  = loadData();
  const num   = req.query.conta || data.conta_ativa;
  const c     = data.contas[num] || {};
  const { client_secret, ...safe } = c;
  res.json({ ...safe, conta_ativa: data.conta_ativa });
});

app.post('/api/config', (req, res) => {
  const { client_id, client_secret, access_token, refresh_token, conta } = req.body;
  const data = loadData();
  const num  = conta || data.conta_ativa;
  if (!data.contas[num]) data.contas[num] = {};
  const c = data.contas[num];
  if (client_id     !== undefined) c.client_id     = client_id;
  if (client_secret !== undefined) c.client_secret = client_secret;
  if (access_token  !== undefined) c.access_token  = access_token;
  if (refresh_token !== undefined) c.refresh_token = refresh_token;
  saveData(data);
  res.json({ ok: true });
});

// ── Rotas OAuth ───────────────────────────────────────────────

app.get('/api/ml/auth', (req, res) => {
  const data  = loadData();
  const num   = req.query.conta || data.conta_ativa;
  const c     = data.contas[num] || {};
  if (!c.client_id) return res.redirect('/app.html?tab=config&error=sem_client_id');
  const callback = `${req.protocol}://${req.get('host')}/api/ml/callback`;
  const url = `https://auth.mercadolivre.com.br/authorization`
    + `?response_type=code`
    + `&client_id=${c.client_id}`
    + `&redirect_uri=${encodeURIComponent(callback)}`
    + `&state=${num}`
    + `&scope=offline_access+read_listings+write_listings+read_orders+write_orders+read_shipping+write_shipping+read_product_ads`;
  res.redirect(url);
});

app.get('/api/ml/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) return res.redirect('/app.html?tab=config&error=auth_cancelado');

  const data     = loadData();
  const num      = state || data.conta_ativa;
  const c        = data.contas[num] || {};
  const callback = `${req.protocol}://${req.get('host')}/api/ml/callback`;

  if (!c.client_secret) {
    return res.redirect('/app.html?tab=config&error=auth_falhou&detalhe=' +
      encodeURIComponent('Client Secret não encontrado. Salve as credenciais antes de conectar.'));
  }

  try {
    const resp = await axios.post(
      'https://api.mercadolibre.com/oauth/token',
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     c.client_id,
        client_secret: c.client_secret,
        code,
        redirect_uri:  callback,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    c.access_token  = resp.data.access_token;
    c.refresh_token = resp.data.refresh_token;
    c.user_id       = resp.data.user_id;
    // Busca o nickname para exibir no seletor de conta
    try {
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${c.access_token}` },
      });
      c.nickname = me.data.nickname;
    } catch {}
    data.contas[num] = c;
    saveData(data);
    res.redirect(`/app.html?tab=config&connected=true&conta=${num}`);
  } catch (err) {
    const detalhe = JSON.stringify(err.response?.data || err.message);
    console.error('Erro no callback OAuth:', detalhe);
    res.redirect(`/app.html?tab=config&error=auth_falhou&detalhe=${encodeURIComponent(detalhe)}`);
  }
});

// ── Rotas de dados ML ─────────────────────────────────────────

async function refreshToken(data, num) {
  const c = data.contas[num];
  const resp = await axios.post(
    'https://api.mercadolibre.com/oauth/token',
    new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  c.access_token  = resp.data.access_token;
  c.refresh_token = resp.data.refresh_token;
  saveData(data);
  return c;
}

app.get('/api/ml/status', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ connected: false });
  try {
    const resp = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${c.access_token}` },
    });
    res.json({ connected: true, nickname: resp.data.nickname });
  } catch {
    res.json({ connected: false });
  }
});

app.get('/api/ml/store', async (req, res) => {
  const data = loadData();
  let c      = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  const fetchStore = async (token) => {
    const r = await axios.get('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return r.data;
  };

  try {
    const user = await fetchStore(c.access_token);
    res.json({ name: user.nickname, id: user.id, country: user.country_id });
  } catch {
    if (c.refresh_token) {
      try {
        c = await refreshToken(data, data.conta_ativa);
        const user = await fetchStore(c.access_token);
        res.json({ name: user.nickname, id: user.id, country: user.country_id });
      } catch {
        res.json({ error: 'Sessão expirada. Reconecte na aba Configurações.' });
      }
    } else {
      res.json({ error: 'Erro ao buscar loja. Verifique a conexão.' });
    }
  }
});

app.get('/api/ml/estoque', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  let c      = data.contas[num];
  if (!c.access_token) return res.json({ error: 'Não conectado' });

  if (!c.user_id) {
    try {
      const me = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${c.access_token}` },
      });
      c.user_id = me.data.id;
      saveData(data);
    } catch {
      return res.json({ error: 'Não foi possível identificar o usuário.' });
    }
  }

  const limit = 50;

  function extrairSku(body) {
    if (body.seller_custom_field) return body.seller_custom_field;
    const attrItem = (body.attributes || []).find(a => a.id === 'SELLER_SKU');
    if (attrItem && attrItem.value_name) return attrItem.value_name;
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
    xd_drop_off:   'Próprio',
  };

  try {
    const todosIds = [];
    for (const status of ['active', 'paused', 'closed']) {
      let offset = 0;
      while (true) {
        const searchResp = await axios.get(
          `https://api.mercadolibre.com/users/${c.user_id}/items/search`,
          {
            params: { status, offset, limit },
            headers: { Authorization: `Bearer ${c.access_token}` },
          }
        );
        const ids = searchResp.data.results || [];
        todosIds.push(...ids);
        if (ids.length < limit) break;
        offset += limit;
        if (offset >= 1000) break;
      }
    }

    if (!todosIds.length) return res.json({ items: [], total: 0 });

    const detalhes = [];
    for (let i = 0; i < todosIds.length; i += 20) {
      const chunk = todosIds.slice(i, i + 20);
      const resp  = await axios.get('https://api.mercadolibre.com/items', {
        params: {
          ids:        chunk.join(','),
          attributes: 'id,title,seller_custom_field,available_quantity,variations,shipping,attributes,status,last_updated',
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
      });
      detalhes.push(...resp.data);
    }

    const pauseDates = c.pause_dates || {};
    const agora      = new Date().toISOString();
    let pauseChanged = false;

    const items = detalhes
      .filter(r => r.code === 200)
      .map(r => {
        const logisticType = r.body.shipping?.logistic_type || 'self_service';
        const mlb          = r.body.id;
        const status       = r.body.status;

        if (status === 'paused') {
          if (!pauseDates[mlb]) { pauseDates[mlb] = agora; pauseChanged = true; }
        } else {
          if (pauseDates[mlb]) { delete pauseDates[mlb]; pauseChanged = true; }
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
          variacoes:     (r.body.variations || []).map(v => ({
            id:     v.id,
            nome:   (v.attribute_combinations || []).map(a => a.value_name).join(' / ') || `Var. ${v.id}`,
            estoque: v.available_quantity ?? 0,
          })),
        };
      });

    if (pauseChanged) {
      c.pause_dates = pauseDates;
      saveData(data);
    }

    res.json({ items, total: items.length });
  } catch (err) {
    console.error('Erro ao buscar estoque:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar anúncios. Tente novamente.' });
  }
});

app.get('/api/ml/vendas30dias', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)      return res.json({ error: 'user_id não encontrado' });

  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const vendasPorItem = {};
  let offset = 0;
  const limit = 50;

  try {
    while (true) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:                    c.user_id,
          'order.status':            'paid',
          'order.date_created.from': from,
          sort:                      'date_desc',
          offset,
          limit,
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 10000,
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

app.get('/api/ml/vendas-etiquetas', async (req, res) => {
  const data = loadData();
  const c    = contaAtiva(data);
  if (!c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)      return res.json({ error: 'user_id não encontrado' });

  const LABEL_STATUSES   = new Set(['handling', 'ready_to_ship']);
  // Substatuses onde a etiqueta está de fato gerada e disponível para baixar
  const LABEL_SUBSTATUSES = new Set(['ready_to_print', 'printed']);

  try {
    const todasOrdens = [];
    let offset = 0;
    const limit = 50;
    while (true) {
      const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
        params: {
          seller:         c.user_id,
          'order.status': 'paid',
          sort:           'date_desc',
          offset,
          limit,
        },
        headers: { Authorization: `Bearer ${c.access_token}` },
        timeout: 15000,
      });
      const orders = resp.data.results || [];
      todasOrdens.push(...orders);
      if (orders.length < limit || todasOrdens.length >= 200) break;
      offset += limit;
    }

    // Filtra ordens com shipment, excluindo Full já no nível da ordem quando possível
    const comShipment = todasOrdens.filter(o =>
      o.shipping && o.shipping.id &&
      o.shipping.logistic_type !== 'fulfillment' &&
      o.shipping.mode !== 'fulfillment'
    );

    const resultado = [];
    for (let i = 0; i < comShipment.length; i += 10) {
      const lote = comShipment.slice(i, i + 10);
      const detalhes = await Promise.all(
        lote.map(async (order) => {
          try {
            const r = await axios.get(
              `https://api.mercadolibre.com/shipments/${order.shipping.id}`,
              { headers: { Authorization: `Bearer ${c.access_token}` }, timeout: 8000 }
            );
            return { order, shipment: r.data };
          } catch {
            return { order, shipment: null };
          }
        })
      );
      resultado.push(...detalhes);
    }

    const SUBSTATUS_LABEL = { ready_to_print: 'Baixar', printed: 'Baixar novamente' };
    const STATUS_PT = { handling: 'Preparando', ready_to_ship: 'Aguardando coleta' };

    const isFull = (s) => s && (
      s.logistic_type === 'fulfillment' ||
      s.logistic_type === 'fulfillment_reverse' ||
      (s.logistic_type || '').includes('fulfillment')
    );

    const vendas = resultado
      .filter(({ shipment }) =>
        shipment &&
        LABEL_STATUSES.has(shipment.status) &&
        LABEL_SUBSTATUSES.has(shipment.substatus) &&
        !isFull(shipment)
      )
      .map(({ order, shipment }) => {
        const itens = (order.order_items || []).map(i => ({
          titulo:    `${i.quantity}x ${i.item.title}`,
          sku:       i.item.seller_custom_field || '—',
          thumbnail: i.item.thumbnail || null,
        }));
        return {
          orderId:     order.id,
          data:        order.date_created,
          comprador:   order.buyer?.nickname || '—',
          itens:       itens.map(i => i.titulo).join(' | '),
          skus:        itens.map(i => i.sku).join(' | '),
          thumbnail:   itens[0]?.thumbnail || null,
          shipmentId:  shipment.id,
          conta:       data.conta_ativa,
          status:      shipment.status,
          statusLabel: STATUS_PT[shipment.status] || shipment.status,
          acaoLabel:   SUBSTATUS_LABEL[shipment.substatus] || 'Baixar',
        };
      });

    res.json({ vendas });
  } catch (err) {
    console.error('Erro ao buscar vendas com etiqueta:', err.response?.data || err.message);
    res.json({ error: 'Erro ao buscar vendas.' });
  }
});


app.get('/api/ml/ads-roas', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ error: 'Não conectado' });
  if (!c.user_id)            return res.json({ error: 'user_id não encontrado. Reconecte a conta.' });

  const headers   = { Authorization: `Bearer ${c.access_token}`, 'Content-Type': 'application/json' };
  const today     = new Date();
  const dateBegin = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const dateEnd   = today.toISOString().split('T')[0];

  try {
    // 1. Busca o advertiser_id do usuário
    const advResp = await axios.get('https://api.mercadolibre.com/advertising/advertisers', {
      params:  { user_id: c.user_id },
      headers,
      timeout: 12000,
    });
    const advertiser = (advResp.data.results || advResp.data)?.[0] || advResp.data;
    const advertiserId = advertiser?.id || advertiser?.advertiser_id;
    if (!advertiserId) return res.json({ error: 'Advertiser ID não encontrado.', detalhe: JSON.stringify(advResp.data) });

    // 2. Lista campanhas do advertiser
    const campResp = await axios.get(
      `https://api.mercadolibre.com/advertising/advertisers/${advertiserId}/campaigns`,
      { params: { status: 'active', limit: 100 }, headers, timeout: 12000 }
    );
    const campaigns = campResp.data.results || campResp.data || [];

    // Mapa campanha id → target_roas
    const campMap = {};
    for (const camp of campaigns) {
      campMap[String(camp.id)] = {
        nome:       camp.name || camp.id,
        targetRoas: camp.bidding_strategy?.target_roas ?? null,
      };
    }

    // 3. Para cada campanha, busca os product ads e métricas
    const itens = [];

    for (const camp of campaigns) {
      const campInfo = campMap[String(camp.id)];

      // Busca ads da campanha com métricas do período
      let adsResp;
      try {
        adsResp = await axios.get(
          `https://api.mercadolibre.com/advertising/advertisers/${advertiserId}/campaigns/${camp.id}/product_ads`,
          {
            params:  { date_range_begin: dateBegin, date_range_end: dateEnd, limit: 200 },
            headers,
            timeout: 12000,
          }
        );
      } catch { continue; }

      const ads = adsResp.data.results || adsResp.data || [];
      for (const ad of ads) {
        const spend           = Number(ad.spend || ad.total_cost || 0);
        const revenue         = Number(ad.revenue || ad.total_revenue || 0);
        const units           = Number(ad.sold_quantity || ad.units_sold || 0);
        if (spend === 0) continue;
        const roasEntregando  = spend > 0 ? revenue / spend : null;
        const custoPorUnidade = units > 0 ? spend  / units  : null;
        itens.push({
          campanha:       campInfo.nome,
          mlb:            ad.item_id  || ad.product_id || '—',
          titulo:         ad.item_title || ad.title    || '—',
          sku:            ad.seller_custom_field || ad.sku || '—',
          targetRoas:     campInfo.targetRoas,
          roasEntregando,
          custoPorUnidade,
          spend,
          revenue,
          units,
          clicks:      Number(ad.clicks      || 0),
          impressions: Number(ad.impressions || 0),
        });
      }
    }

    if (!itens.length) return res.json({ itens: [], aviso: 'Nenhum dado de ads com gasto encontrado nos últimos 30 dias.' });

    res.json({ itens });
  } catch (err) {
    console.error('Erro ads-roas:', err.response?.data || err.message);
    const d = err.response?.data;
    res.json({ error: d?.message || d?.error || 'Erro ao buscar dados de ads.', detalhe: JSON.stringify(d) });
  }
});

// DEBUG — explora API de Ads
app.get('/api/ml/debug-ads', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.json({ error: 'Não conectado' });

  const headers = { Authorization: `Bearer ${c.access_token}` };
  const result  = {};

  const tryGet = async (label, url, params = {}) => {
    try {
      const r = await axios.get(url, { headers, params, timeout: 10000 });
      result[label] = { status: r.status, data: r.data };
    } catch (e) {
      result[label] = { status: e.response?.status, error: e.response?.data || e.message };
    }
  };

  // O endpoint /advertising/advertisers exige product_id — busca o primeiro item do usuário
  let primeiroMlb = req.query.mlb;
  if (!primeiroMlb && c.user_id) {
    try {
      const itemsResp = await axios.get(`https://api.mercadolibre.com/users/${c.user_id}/items/search`, {
        params: { status: 'active', limit: 1 }, headers, timeout: 8000,
      });
      primeiroMlb = itemsResp.data.results?.[0];
    } catch {}
  }

  result['_mlb_usado'] = primeiroMlb || 'nenhum';

  if (primeiroMlb) {
    // Tenta sem prefixo MLB (só o número)
    const mlbNum = String(primeiroMlb).replace(/^MLB/i, '');
    result['_mlb_numero'] = mlbNum;

    await tryGet('advertisers_num',             'https://api.mercadolibre.com/advertising/advertisers',  { product_id: mlbNum });
    await tryGet('advertisers_num_user',        'https://api.mercadolibre.com/advertising/advertisers',  { product_id: mlbNum, user_id: c.user_id });
    await tryGet('product_ads_num',             'https://api.mercadolibre.com/advertising/product_ads',  { product_id: mlbNum });
    await tryGet('product_ads_num_user',        'https://api.mercadolibre.com/advertising/product_ads',  { product_id: mlbNum, user_id: c.user_id });
    await tryGet('product_ads_num_direto',      `https://api.mercadolibre.com/advertising/product_ads/${mlbNum}`);
    await tryGet('advertising_root',            'https://api.mercadolibre.com/advertising',              { product_id: mlbNum });

    // Busca o catalog_product_id interno do item
    try {
      const itemR = await axios.get(`https://api.mercadolibre.com/items/${primeiroMlb}`, {
        params: { attributes: 'id,catalog_product_id,parent_item_id' }, headers, timeout: 8000,
      });
      const catId = itemR.data.catalog_product_id || itemR.data.parent_item_id;
      result['_catalog_product_id'] = catId || 'nenhum';
      if (catId) {
        await tryGet('advertisers_catalog',     'https://api.mercadolibre.com/advertising/advertisers',  { product_id: catId });
        await tryGet('product_ads_catalog',     'https://api.mercadolibre.com/advertising/product_ads',  { product_id: catId });
      }
    } catch {}
  }

  res.json(result);
});

// DEBUG — testa POST e variações para gerar etiqueta
app.get('/api/ml/debug-label/:shipment_id', async (req, res) => {
  const data   = loadData();
  const num    = req.query.conta || data.conta_ativa;
  const c      = data.contas[num] || {};
  const sid    = req.params.shipment_id;
  const tok    = c.access_token;
  const auth   = { Authorization: `Bearer ${tok}` };
  const result = {};

  // Tenta POST em /shipments/{id}/labels
  for (const body of [
    { shipment_ids: [parseInt(sid)], response_type: 'pdf' },
    { response_type: 'pdf' },
    {},
  ]) {
    try {
      const r = await axios.post(
        `https://api.mercadolibre.com/shipments/${sid}/labels`,
        body, { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      result[`POST_${JSON.stringify(body)}`] = { status: r.status, data: typeof r.data === 'string' ? r.data.slice(0, 300) : r.data };
    } catch (e) {
      result[`POST_${JSON.stringify(body)}`] = { status: e.response?.status, error: JSON.stringify(e.response?.data || e.message).slice(0, 200) };
    }
  }

  // Tenta POST em /shipments/labels (batch)
  try {
    const r = await axios.post(
      `https://api.mercadolibre.com/shipments/labels`,
      { shipment_ids: [parseInt(sid)], response_type: 'pdf' },
      { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 8000 }
    );
    result['POST_batch'] = { status: r.status, data: typeof r.data === 'string' ? r.data.slice(0, 300) : r.data };
  } catch (e) {
    result['POST_batch'] = { status: e.response?.status, error: JSON.stringify(e.response?.data || e.message).slice(0, 200) };
  }

  // Tenta GET com x-caller-id no header
  try {
    const r = await axios.get(
      `https://api.mercadolibre.com/shipments/${sid}/labels?response_type=pdf`,
      { headers: { ...auth, 'x-caller-id': c.user_id }, responseType: 'arraybuffer', timeout: 8000 }
    );
    result['GET_xcallerid'] = { status: r.status, bytes: r.data.byteLength, contentType: r.headers['content-type'] };
  } catch (e) {
    result['GET_xcallerid'] = { status: e.response?.status, error: e.response?.data ? Buffer.from(e.response.data).toString('utf8').slice(0, 200) : e.message };
  }

  // Tenta GET via endpoint de orders
  if (req.query.order_id) {
    try {
      const r = await axios.get(
        `https://api.mercadolibre.com/orders/${req.query.order_id}/shipments/${sid}/labels?response_type=pdf`,
        { headers: auth, responseType: 'arraybuffer', timeout: 8000 }
      );
      result['GET_via_order'] = { status: r.status, bytes: r.data.byteLength, contentType: r.headers['content-type'] };
    } catch (e) {
      result['GET_via_order'] = { status: e.response?.status, error: e.response?.data ? Buffer.from(e.response.data).toString('utf8').slice(0, 200) : e.message };
    }
  }

  // Tenta GET no snapshot_id do packing
  if (req.query.snapshot_id) {
    for (const url of [
      `https://api.mercadolibre.com/shipments/labels/snapshot/${req.query.snapshot_id}?response_type=pdf`,
      `https://api.mercadolibre.com/packs/labels/snapshot/${req.query.snapshot_id}?response_type=pdf`,
    ]) {
      try {
        const r = await axios.get(url, { headers: auth, responseType: 'arraybuffer', timeout: 8000 });
        result[`GET_snapshot_${url.split('/')[5]}`] = { status: r.status, bytes: r.data.byteLength };
      } catch (e) {
        result[`GET_snapshot_${url.split('/')[5]}`] = { status: e.response?.status, error: e.response?.data ? Buffer.from(e.response.data).toString('utf8').slice(0, 200) : e.message };
      }
    }
  }

  res.json(result);
});

app.get('/api/ml/etiquetas', async (req, res) => {
  const data = loadData();
  const num  = req.query.conta || data.conta_ativa;
  const c    = data.contas[num] || {};
  if (!c.access_token) return res.status(401).json({ error: 'Não conectado' });

  const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Nenhum ID informado' });

  const idsParam = ids.join(',');
  try {
    const resp = await axios.get(
      `https://api.mercadolibre.com/shipment_labels?shipment_ids=${idsParam}&response_type=pdf`,
      { headers: { Authorization: `Bearer ${c.access_token}` }, responseType: 'arraybuffer', timeout: 20000 }
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="etiquetas.pdf"`);
    return res.send(Buffer.from(resp.data));
  } catch (e) {
    res.status(404).json({ error: 'Erro ao baixar etiquetas.', detalhe: JSON.stringify(e.response?.data || e.message) });
  }
});

app.get('/api/ml/etiqueta/:shipment_id', async (req, res) => {
  const data  = loadData();
  const num   = req.query.conta || data.conta_ativa;
  const c     = data.contas[num] || {};
  if (!c.access_token) return res.status(401).json({ error: 'Não conectado' });

  const sid  = req.params.shipment_id;
  const tok  = c.access_token;

  // Tenta o novo endpoint /shipment_labels
  const urls = [
    `https://api.mercadolibre.com/shipment_labels?shipment_ids=${sid}&response_type=pdf`,
    `https://api.mercadolibre.com/shipment_labels?shipment_ids=${sid}&response_type=zpl2`,
    `https://api.mercadolibre.com/shipments/${sid}/labels?response_type=pdf`,
  ];

  for (const url of urls) {
    try {
      const resp = await axios.get(url, {
        headers:      { Authorization: `Bearer ${tok}` },
        responseType: 'arraybuffer',
        timeout:      15000,
      });
      const ct = resp.headers['content-type'] || '';
      if (resp.status === 200 && resp.data.byteLength > 100) {
        res.setHeader('Content-Type', ct || 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="etiqueta-${sid}.pdf"`);
        return res.send(Buffer.from(resp.data));
      }
    } catch {}
  }

  // Nenhum funcionou — retorna debug
  const debug = {};
  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers: { Authorization: `Bearer ${tok}` }, timeout: 8000 });
      debug[url] = { status: r.status, ct: r.headers['content-type'], size: JSON.stringify(r.data).length };
    } catch (e) {
      debug[url] = { status: e.response?.status, error: JSON.stringify(e.response?.data || e.message).slice(0, 200) };
    }
  }
  res.status(404).json({ error: 'Não foi possível baixar a etiqueta.', debug });
});

app.put('/api/ml/estoque/:mlb', async (req, res) => {
  const data = loadData();
  const num  = data.conta_ativa;
  const c    = data.contas[num];
  if (!c || !c.access_token) return res.status(401).json({ error: 'Não conectado' });

  const { quantidade, variacao_id } = req.body;
  if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < 0) {
    return res.status(400).json({ error: 'Quantidade inválida' });
  }

  const mlb     = req.params.mlb;
  const headers = { Authorization: `Bearer ${c.access_token}`, 'Content-Type': 'application/json' };

  try {
    if (variacao_id) {
      // Atualiza apenas esta variação específica
      await axios.put(
        `https://api.mercadolibre.com/items/${mlb}`,
        { variations: [{ id: Number(variacao_id), available_quantity: quantidade }] },
        { headers, timeout: 10000 }
      );
    } else {
      // Busca o item para saber se tem variações
      const itemResp = await axios.get(`https://api.mercadolibre.com/items/${mlb}`, {
        params:  { attributes: 'id,variations' },
        headers,
        timeout: 10000,
      });
      const variations = itemResp.data.variations || [];
      if (variations.length > 0) {
        await axios.put(
          `https://api.mercadolibre.com/items/${mlb}`,
          { variations: variations.map(v => ({ id: v.id, available_quantity: quantidade })) },
          { headers, timeout: 10000 }
        );
      } else {
        await axios.put(
          `https://api.mercadolibre.com/items/${mlb}`,
          { available_quantity: quantidade },
          { headers, timeout: 10000 }
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    const mlErr = err.response?.data;
    console.error('Erro ao atualizar estoque:', mlErr || err.message);
    const msg = mlErr?.message || mlErr?.error || mlErr?.cause?.[0]?.message || 'Erro ao atualizar no Mercado Livre';
    res.status(400).json({ error: msg, detalhe: JSON.stringify(mlErr) });
  }
});

// ── Inicia o servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
