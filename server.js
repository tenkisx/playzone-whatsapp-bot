// =====================================================================
// Play Zone — Assistente WhatsApp (webhook server)
// Fluxo: Meta Cloud API -> este webhook -> IA (Claude) + WooCommerce -> resposta
// =====================================================================
import express from 'express';
import crypto from 'node:crypto';
import { loadConfig } from './src/config.js';
import { log } from './src/logger.js';
import { createWhatsAppClient } from './src/whatsapp.js';
import { createWooClient } from './src/woocommerce.js';
import { createSmartSearch } from './src/smartsearch.js';
import { createBrain } from './src/ai.js';
import { getSession, pushMessage, setHandoff } from './src/session.js';

const cfg = loadConfig(); // fail closed se faltar config
const app = express();

// Precisamos do corpo RAW para validar a assinatura da Meta.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const wa = createWhatsAppClient(cfg);
const woo = createWooClient(cfg);
const smartSearch = createSmartSearch(cfg);

// Alerta a equipa (numeros em TEAM_ALERT_NUMBERS)
async function alertTeam(text) {
  for (const num of cfg.ops.teamNumbers) {
    try {
      await wa.sendText(num, text);
    } catch (e) {
      log.error('team_alert_failed', { error: e.message });
    }
  }
}

const brain = createBrain(cfg, {
  woo,
  smartSearch,
  onHandoff: async (phone, motivo) => {
    setHandoff(phone, true);
    await alertTeam(`🔔 Handoff WhatsApp\nCliente: ${log.redactPhone(phone)}\nMotivo: ${motivo}`);
  },
  onOrderCreated: async (phone, order, input) => {
    await alertTeam(
      `🛒 Nova encomenda WhatsApp\nNº: ${order.number}\nTotal: ${order.total_label}\nCliente: ${input.nome} (${log.redactPhone(phone)})\nEstado: ${order.status}`
    );
  },
});

// ---- Verificacao do webhook (Meta faz um GET quando configuras o webhook) ----
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === cfg.whatsapp.verifyToken) {
    log.info('webhook.verified', {});
    return res.status(200).send(challenge);
  }
  log.warn('webhook.verify_failed', {});
  return res.sendStatus(403);
});

// ---- Validacao de assinatura (X-Hub-Signature-256) ----
function validSignature(req) {
  const sig = req.get('x-hub-signature-256');
  if (!sig || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', cfg.whatsapp.appSecret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---- Receber mensagens ----
app.post('/webhook', async (req, res) => {
  // Responde 200 imediatamente (a Meta reenvia se demorarmos).
  res.sendStatus(200);

  if (!validSignature(req)) {
    log.warn('webhook.bad_signature', {});
    return;
  }

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message) return; // pode ser status de entrega, ignorar

    const from = message.from; // numero do cliente (sem +)
    const type = message.type;

    // So tratamos texto e botoes por agora (imagem/audio -> escala para humano).
    let userText = null;
    if (type === 'text') userText = message.text?.body;
    else if (type === 'interactive') userText = message.interactive?.button_reply?.title;

    await wa.markRead(message.id);

    if (!userText) {
      await wa.sendText(
        from,
        'Recebi o seu conteúdo 🙏. De momento respondo melhor por texto — pode escrever-me o que procura? Se preferir, digo à equipa para o contactar.'
      );
      return;
    }

    const session = getSession(from);

    // Se ja esta em handoff humano, nao respondemos automaticamente (evita cruzar com o agente).
    if (session.handoff) {
      log.info('msg.during_handoff', { from });
      return;
    }

    pushMessage(from, 'user', userText);
    log.info('msg.received', { from, len: userText.length });

    const answer = await brain.reply(getSession(from).messages, { phone: from });
    pushMessage(from, 'assistant', answer);
    await wa.sendText(from, answer);
  } catch (e) {
    log.error('webhook.handler_error', { error: e.message });
  }
});

// ---- Health check ----
// ---- Reservas vindas do formulario web (jogos.playzone.ao/reservar-sessao) ----
// O formulario Elementor faz POST aqui (Webhook action). Alertamos o dono (TEAM_ALERT_NUMBERS = 487).
// A confirmacao ao cliente via template fica pronta (comentada) porque precisa do POSTO ({{3}}),
// que e atribuido por ti ao confirmar. Template: reserva_confirmada_lounge -> {{1}}=nome {{2}}=data+hora {{3}}=posto.
app.post('/reservation', async (req, res) => {
  try {
    const b = req.body || {};
    const f = b.fields || b.form_fields || b; // Elementor manda os campos pelo custom_id
    const pick = (k) => {
      const v = f[k];
      return (v && typeof v === 'object' ? v.value : v) || '';
    };
    const nome = pick('nome');
    const telefone = String(pick('telefone')).replace(/\D/g, '');
    const email = pick('email');
    const jogo = pick('jogo');
    const data = pick('data');
    const hora = pick('hora');

    await alertTeam(
      `\u{1F4C5} Nova reserva Game Lounge\nNome: ${nome}\nTel: ${telefone}\nEmail: ${email}\nJogo: ${jogo}\nData/hora: ${data} ${hora}`
    );
    log.info('reservation.received', { jogo, temTel: !!telefone });

    // Confirmacao imediata ao cliente (descomenta quando definires o POSTO):
    // if (telefone) {
    //   await wa.sendTemplate(telefone, 'reserva_confirmada_lounge',
    //     [nome, `${data} as ${hora}`, 'a confirmar'], 'pt_PT');
    // }

    res.json({ ok: true });
  } catch (e) {
    log.error('reservation.error', { error: e.message });
    res.status(500).json({ ok: false });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'playzone-whatsapp-bot' }));

app.listen(cfg.port, () => {
  log.info('server.started', { port: cfg.port, model: cfg.ai.model, woo: cfg.woo.baseUrl });
});
