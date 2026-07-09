// Carrega e valida a configuracao a partir do ambiente (.env).
// Fail closed: se faltar algo critico, o processo nao arranca (evita comportamento silencioso).

function req(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    throw new Error(`[config] Variavel de ambiente obrigatoria em falta: ${name}`);
  }
  return v.trim();
}

function opt(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() !== '' ? v.trim() : fallback;
}

// Aceita o primeiro nome de variavel que estiver definido (permite reutilizar o
// .env do ERP: WHATSAPP_META_TOKEN, WHATSAPP_META_PHONE_ID, WHATSAPP_API_VERSION).
function reqAny(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim() !== '') return v.trim();
  }
  throw new Error(`[config] Falta uma destas variaveis: ${names.join(' ou ')}`);
}
function optAny(names, fallback) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim() !== '') return v.trim();
  }
  return fallback;
}

export function loadConfig() {
  const cfg = {
    port: parseInt(opt('PORT', '8080'), 10),

    whatsapp: {
      // Reutiliza os nomes do ERP se existirem (WHATSAPP_META_TOKEN / _PHONE_ID / _API_VERSION)
      token: reqAny(['WHATSAPP_TOKEN', 'WHATSAPP_META_TOKEN']),
      phoneNumberId: reqAny(['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_META_PHONE_ID']),
      verifyToken: req('WHATSAPP_VERIFY_TOKEN'),
      appSecret: req('WHATSAPP_APP_SECRET'),
      graphVersion: optAny(['GRAPH_API_VERSION', 'WHATSAPP_API_VERSION'], 'v21.0'),
      // Base da Graph API (configuravel para testes/mocks). Producao = graph.facebook.com
      graphBase: opt('GRAPH_API_BASE', 'https://graph.facebook.com'),
    },

    ai: {
      apiKey: req('ANTHROPIC_API_KEY'),
      model: opt('AI_MODEL', 'claude-sonnet-5'),
      maxTokens: parseInt(opt('AI_MAX_TOKENS', '1024'), 10),
      // baseURL opcional (para testes/mocks ou gateway). Vazio => default do SDK
      baseURL: opt('ANTHROPIC_BASE_URL', ''),
    },

    woo: {
      baseUrl: opt('WOO_BASE_URL', 'https://playzone.ao').replace(/\/+$/, ''),
      key: req('WOO_CONSUMER_KEY'),
      secret: req('WOO_CONSUMER_SECRET'),
    },

    site: {
      // Base do site público (endpoint da Pesquisa IA: /wp-admin/admin-ajax.php).
      // Opcional: por omissão usa o mesmo domínio do WooCommerce.
      baseUrl: opt('SITE_BASE_URL', opt('WOO_BASE_URL', 'https://playzone.ao')).replace(/\/+$/, ''),
    },

    ops: {
      teamNumbers: opt('TEAM_ALERT_NUMBERS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      businessHours: opt('BUSINESS_HOURS', 'Seg-Sab 09:00-18:00'),
      orderStatus: opt('ORDER_STATUS', 'on-hold'),
    },
  };
  return cfg;
}
