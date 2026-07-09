// Structured JSON logger. Um evento por linha -> facil de auditar e enviar para ficheiro.
// Nunca escreve tokens, telefones completos, nem conteudo sensivel em claro.

function redactPhone(phone) {
  if (!phone) return phone;
  const s = String(phone);
  if (s.length <= 4) return '****';
  return s.slice(0, 3) + '****' + s.slice(-2);
}

function emit(level, event, data = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  if (line.from) line.from = redactPhone(line.from);
  if (line.to) line.to = redactPhone(line.to);
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  info: (event, data) => emit('info', event, data),
  warn: (event, data) => emit('warn', event, data),
  error: (event, data) => emit('error', event, data),
  redactPhone,
};
