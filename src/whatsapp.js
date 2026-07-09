// Cliente da WhatsApp Cloud API (Graph API da Meta).
// Envia texto, botoes e marca mensagens como lidas.
import { log } from './logger.js';

export function createWhatsAppClient(cfg) {
  const base = `${cfg.whatsapp.graphBase}/${cfg.whatsapp.graphVersion}/${cfg.whatsapp.phoneNumberId}`;
  const headers = {
    Authorization: `Bearer ${cfg.whatsapp.token}`,
    'Content-Type': 'application/json',
  };

  async function post(payload) {
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.error('whatsapp.send_failed', { status: res.status, error: body?.error?.message });
      throw new Error(`WhatsApp send failed (${res.status}): ${body?.error?.message || 'unknown'}`);
    }
    return body;
  }

  return {
    async sendText(to, text) {
      // O WhatsApp limita o texto a ~4096 chars; partimos em pedacos por seguranca.
      const chunks = splitText(text, 3800);
      let last;
      for (const chunk of chunks) {
        last = await post({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { preview_url: true, body: chunk },
        });
      }
      log.info('whatsapp.sent', { to, kind: 'text' });
      return last;
    },

    // Botoes de resposta rapida (max 3). buttons = [{id, title}]
    async sendButtons(to, bodyText, buttons) {
      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText.slice(0, 1024) },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      };
      log.info('whatsapp.sent', { to, kind: 'buttons' });
      return post(payload);
    },

    // Envia um template APROVADO (para clientes fora da janela de 24h, ex.: reservas vindas do formulario web).
    // bodyParams = array de strings para as variaveis {{1}},{{2}},{{3}}...
    async sendTemplate(to, name, bodyParams = [], lang = 'pt_PT') {
      const components = bodyParams.length
        ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }]
        : [];
      log.info('whatsapp.sent', { to, kind: 'template', name });
      return post({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name, language: { code: lang }, components },
      });
    },

    async markRead(messageId) {
      try {
        await post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId });
      } catch (_) {
        /* nao critico */
      }
    },
  };
}

function splitText(text, size) {
  if (!text) return [''];
  const out = [];
  let s = String(text);
  while (s.length > size) {
    let cut = s.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  out.push(s);
  return out;
}
