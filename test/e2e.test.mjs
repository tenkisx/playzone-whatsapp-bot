// Teste ponta-a-ponta com serviços SIMULADOS (sem credenciais reais).
// Prova: webhook -> IA (tool-use) -> WooCommerce (preço real) -> resposta WhatsApp,
// e um segundo turno que confirma e CRIA a encomenda.
//
// Correr:  node test/e2e.test.mjs   (exit 0 = passou, 1 = falhou)
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MOCK_PORT = 8791;
const BOT_PORT = 8792;
const APP_SECRET = 'test_app_secret';

const captured = { waText: [], orders: [], searches: [], smart: [], anthropicCalls: 0 };

// ---------- Mock dos serviços externos (Anthropic + WhatsApp + WooCommerce) ----------
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      res.setHeader('content-type', 'application/json');
      const url = req.url || '';

      // Anthropic Messages API
      if (url.startsWith('/v1/messages')) {
        captured.anthropicCalls++;
        const parsed = JSON.parse(body || '{}');
        const convo = JSON.stringify(parsed.messages || []);
        const askedToCreate = /\bconfirmo\b|criar.?encomenda|pode encomendar/i.test(convo);
        const hasSearchResult = convo.includes('Samsung S23 128GB');
        const hasOrderResult = convo.includes('5001'); // nº da encomenda só existe após criar
        const asksHair = /cabelo\s+seco/i.test(convo);
        const hasCatResult = convo.includes('Cuidados Capilares'); // tool_result de sugerir_categorias

        if (hasCatResult) {
          return res.end(mkMsg('msg_final_cats',
            [{ type: 'text', text: 'Para cabelo seco recomendo Cuidados Capilares: https://playzone.ao/categoria-produto/beleza-e-saude/cuidados-capilares/ 💇 Quer que veja produtos concretos com preço?' }], 'end_turn'));
        }
        if (asksHair) {
          return res.end(mkMsg('msg_cats',
            [{ type: 'tool_use', id: 'toolu_cats', name: 'sugerir_categorias',
               input: { descricao: 'shampoo para cabelo seco' } }], 'tool_use'));
        }

        if (hasOrderResult) {
          return res.end(mkMsg('msg_final_order',
            [{ type: 'text', text: 'Encomenda 5001 criada! Pague em: https://playzone.ao/pay. Obrigado 🙏' }], 'end_turn'));
        }
        if (askedToCreate && hasSearchResult) {
          return res.end(mkMsg('msg_create',
            [{ type: 'tool_use', id: 'toolu_order', name: 'criar_encomenda',
               input: { nome: 'Ana Cliente', telefone: '244900111222', cidade: 'Luanda',
                        itens: [{ product_id: 101, quantidade: 1 }] } }], 'tool_use'));
        }
        if (hasSearchResult) {
          return res.end(mkMsg('msg_after_search',
            [{ type: 'text', text: 'Temos o Samsung S23 128GB por 277 990 AKZ, em stock. Confirma a encomenda?' }], 'end_turn'));
        }
        // primeira chamada -> procurar produto
        return res.end(mkMsg('msg_search',
          [{ type: 'tool_use', id: 'toolu_search', name: 'procurar_produto', input: { termo: 'Samsung S23' } }], 'tool_use'));
      }

      // WhatsApp Cloud API (envio) — path /v21.0/<phoneid>/messages
      if (/\/v\d+\.\d+\/.+\/messages/.test(url)) {
        const p = JSON.parse(body || '{}');
        if (p.type === 'text') captured.waText.push({ to: p.to, body: p.text?.body });
        return res.end(JSON.stringify({ messages: [{ id: 'wamid.MOCK' }] }));
      }

      // Cérebro de pesquisa do site (admin-ajax.php, action=pz_ai_search)
      if (url.includes('admin-ajax.php')) {
        captured.smart.push(body);
        return res.end(JSON.stringify({
          ok: true, mode: 'ai', reply: 'Para cabelo seco temos ótimas opções!',
          suggestions: [
            { label: 'Cuidados Capilares', url: 'https://playzone.ao/categoria-produto/beleza-e-saude/cuidados-capilares/' },
            { label: 'Hidratação', url: 'https://playzone.ao/categoria-produto/beleza-e-saude/cuidados-capilares/hidratacao-capilar/' },
          ],
        }));
      }

      // WooCommerce
      if (url.includes('/wp-json/wc/v3/products')) {
        captured.searches.push(url);
        return res.end(JSON.stringify([{
          id: 101, name: 'Samsung S23 128GB', price: '277990', stock_status: 'instock',
          permalink: 'https://playzone.ao/produto/samsung-s23', sku: 'S23-128',
        }]));
      }
      if (url.includes('/wp-json/wc/v3/orders')) {
        const o = { id: 5001, number: '5001', total: '277990', status: 'on-hold', order_key: 'wc_key_abc' };
        captured.orders.push(o);
        return res.end(JSON.stringify(o));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    srv.listen(MOCK_PORT, () => resolve(srv));
  });
}

function mkMsg(id, content, stop) {
  return JSON.stringify({
    id, type: 'message', role: 'assistant', model: 'claude-mock',
    content, stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 15 },
  });
}

// ---------- Arranca o bot como subprocesso, apontando as bases ao mock ----------
function startBot() {
  const env = {
    ...process.env,
    PORT: String(BOT_PORT),
    WHATSAPP_TOKEN: 'test_token',
    WHATSAPP_PHONE_NUMBER_ID: '1174583372405366',
    WHATSAPP_VERIFY_TOKEN: 'verify_me',
    WHATSAPP_APP_SECRET: APP_SECRET,
    GRAPH_API_BASE: `http://localhost:${MOCK_PORT}`,
    GRAPH_API_VERSION: 'v21.0',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: `http://localhost:${MOCK_PORT}`,
    AI_MODEL: 'claude-mock',
    WOO_BASE_URL: `http://localhost:${MOCK_PORT}`,
    SITE_BASE_URL: `http://localhost:${MOCK_PORT}`,
    WOO_CONSUMER_KEY: 'ck_test',
    WOO_CONSUMER_SECRET: 'cs_test',
    TEAM_ALERT_NUMBERS: '',
  };
  const proc = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: 'inherit' });
  return proc;
}

async function waitHealth(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('bot nao ficou saudavel');
}

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
}

async function sendInbound(text, from = '244900111222') {
  const payload = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [{ from, id: 'wamid.' + Date.now(), type: 'text', text: { body: text } }] } }] }],
  });
  const res = await fetch(`http://localhost:${BOT_PORT}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) },
    body: payload,
  });
  return res.status;
}

async function waitFor(pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---------- Execução ----------
let mock, bot, failures = 0;
function assert(cond, msg) { if (cond) { console.log('  ✓ ' + msg); } else { console.log('  ✗ ' + msg); failures++; } }

try {
  mock = await startMock();
  bot = startBot();
  await waitHealth(`http://localhost:${BOT_PORT}/health`);
  console.log('E2E: bot + mocks a correr\n');

  // TURNO 1: cliente pergunta pelo produto
  console.log('Turno 1 — "quero um Samsung S23":');
  const s1 = await sendInbound('Ola, quero um Samsung S23');
  assert(s1 === 200, 'webhook aceite (200)');
  await waitFor(() => captured.waText.length >= 1);
  assert(captured.searches.length >= 1, 'consultou o WooCommerce (preco real)');
  const reply1 = captured.waText.map((m) => m.body).join(' | ');
  assert(/Samsung S23/i.test(reply1), 'resposta menciona o produto');
  assert(/277\s?990/.test(reply1), 'resposta traz o preco real do WooCommerce (277 990)');

  // TURNO 2: cliente confirma -> deve criar encomenda
  console.log('\nTurno 2 — "confirmo a encomenda, sou a Ana, Luanda":');
  const before = captured.waText.length;
  const s2 = await sendInbound('Confirmo a encomenda. Nome Ana Cliente, telefone 244900111222, Luanda.');
  assert(s2 === 200, 'webhook aceite (200)');
  await waitFor(() => captured.orders.length >= 1 && captured.waText.length > before);
  assert(captured.orders.length >= 1, 'encomenda criada no WooCommerce');
  const reply2 = captured.waText.slice(before).map((m) => m.body).join(' | ');
  assert(/5001/.test(reply2), 'resposta devolve o numero da encomenda (5001)');

  // TURNO 3: cliente descreve uma NECESSIDADE -> cérebro do site (sugerir_categorias)
  console.log('\nTurno 3 — "quero um shampoo para cabelo seco" (cérebro do site):');
  const beforeSmart = captured.waText.length;
  const s3 = await sendInbound('quero um shampoo para cabelo seco', '244933000111');
  assert(s3 === 200, 'webhook aceite (200)');
  await waitFor(() => captured.waText.length > beforeSmart);
  assert(captured.smart.length >= 1, 'consultou o cérebro do site (pz_ai_search)');
  const reply3 = captured.waText.slice(beforeSmart).map((m) => m.body).join(' | ');
  assert(/cuidados-capilares/i.test(reply3), 'resposta traz link real de categoria da loja');

  // Assinatura invalida deve ser rejeitada (nao processa)
  console.log('\nSeguranca — webhook com assinatura invalida:');
  const badBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: 'x', id: '1', type: 'text', text: { body: 'hack' } }] } }] }] });
  const searchesBefore = captured.searches.length;
  await fetch(`http://localhost:${BOT_PORT}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body: badBody });
  await new Promise((r) => setTimeout(r, 800));
  assert(captured.searches.length === searchesBefore, 'assinatura invalida NAO foi processada');

  console.log('\n=== RESULTADO ===');
  console.log(`Chamadas IA: ${captured.anthropicCalls} | Pesquisas Woo: ${captured.searches.length} | Encomendas: ${captured.orders.length} | Mensagens enviadas: ${captured.waText.length}`);
} catch (e) {
  console.error('ERRO no teste:', e.message);
  failures++;
} finally {
  try { bot && bot.kill('SIGKILL'); } catch (_) {}
  try { mock && mock.close(); } catch (_) {}
}

if (failures > 0) { console.log(`\n❌ ${failures} verificacao(oes) falharam`); process.exit(1); }
console.log('\n✅ Todos os testes ponta-a-ponta passaram');
process.exit(0);
