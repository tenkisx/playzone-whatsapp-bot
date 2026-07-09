// Memoria de conversa por cliente (em memoria + limpeza automatica).
// Guarda o historico recente para a IA manter contexto. Para producao a serio,
// trocar por Redis/DB (a interface e propositadamente simples).
const SESSIONS = new Map();
const MAX_TURNS = 16;          // ultimas mensagens mantidas (user+assistant)
const TTL_MS = 1000 * 60 * 60 * 6; // 6h de inatividade -> esquece

export function getSession(phone) {
  let s = SESSIONS.get(phone);
  const now = Date.now();
  if (!s || now - s.updated > TTL_MS) {
    s = { phone, messages: [], handoff: false, created: now, updated: now };
    SESSIONS.set(phone, s);
  }
  return s;
}

export function pushMessage(phone, role, content) {
  const s = getSession(phone);
  s.messages.push({ role, content });
  if (s.messages.length > MAX_TURNS) {
    s.messages = s.messages.slice(-MAX_TURNS);
  }
  s.updated = Date.now();
  return s;
}

export function setHandoff(phone, value) {
  const s = getSession(phone);
  s.handoff = value;
  s.updated = Date.now();
}

// Limpeza periodica de sessoes expiradas.
setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of SESSIONS) {
    if (now - s.updated > TTL_MS) SESSIONS.delete(phone);
  }
}, 1000 * 60 * 30).unref?.();
