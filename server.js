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
}

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
      'https://api.mercadolivre.com/oauth/token',
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
    'https://api.mercadolivre.com/oauth/token',
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
    const resp = await axios.get('https://api.mercadolivre.com/users/me', {
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
    const resp = await axios.get('https://api.mercadolivre.com/users/me', {
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

// ── Inicia o servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
