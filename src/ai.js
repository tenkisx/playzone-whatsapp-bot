// Cerebro IA: Claude + tool-use.
// Carrega o system prompt e a base de conhecimento, define as ferramentas
// (procurar_produto, criar_encomenda, escalar_para_humano) e corre o ciclo agentico.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { log } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SYSTEM_PROMPT = readFileSync(join(ROOT, 'prompt', 'system-prompt.md'), 'utf8');
const KNOWLEDGE = readFileSync(join(ROOT, 'knowledge', 'playzone-kb.md'), 'utf8');

const TOOLS = [
  {
    name: 'procurar_produto',
    description:
      'Procura produtos reais no catalogo WooCommerce da Play Zone. Devolve nome, preco real, se esta em stock e link. Usar sempre que o cliente mencionar um produto ou pedir preco. NUNCA inventar precos: usar sempre esta ferramenta.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Termo de pesquisa, ex: "Samsung S23", "iPhone 14", "portatil"' },
      },
      required: ['termo'],
    },
  },
  {
    name: 'criar_encomenda',
    description:
      'Cria uma encomenda no sistema DEPOIS de o cliente confirmar produto, quantidade, preco e dados de entrega. So chamar apos confirmacao explicita do cliente.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        telefone: { type: 'string' },
        cidade: { type: 'string' },
        morada: { type: 'string' },
        itens: {
          type: 'array',
          description: 'Lista de itens a encomendar.',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'integer', description: 'ID do produto obtido de procurar_produto' },
              quantidade: { type: 'integer', minimum: 1 },
            },
            required: ['product_id', 'quantidade'],
          },
        },
        nota: { type: 'string', description: 'Nota opcional (ex: preferencia de pagamento)' },
      },
      required: ['nome', 'telefone', 'itens'],
    },
  },
  {
    name: 'sugerir_categorias',
    description:
      'Sugere categorias reais da loja (nome + link) quando o cliente descreve uma NECESSIDADE ou problema em vez de um produto específico. Exemplos: "shampoo para cabelo seco", "quero ganhar massa muscular", "tenho acne", "prenda para menina de 8 anos". Devolve até 4 categorias com link para partilhar. Depois de sugerir, se o cliente mostrar interesse, usar procurar_produto para dar preços concretos. NUNCA inventar links: usar apenas os devolvidos por esta ferramenta.',
    input_schema: {
      type: 'object',
      properties: {
        descricao: {
          type: 'string',
          description: 'A necessidade do cliente pelas palavras dele, ex: "shampoo para cabelo seco"',
        },
      },
      required: ['descricao'],
    },
  },
  {
    name: 'escalar_para_humano',
    description:
      'Passa a conversa a um agente humano quando a situacao sai do ambito do assistente (reclamacoes, defeitos, garantia em curso, descontos, pagamentos falhados, grandes quantidades, ou a pedido do cliente).',
    input_schema: {
      type: 'object',
      properties: { motivo: { type: 'string' } },
      required: ['motivo'],
    },
  },
];

export function createBrain(cfg, deps) {
  const client = new Anthropic({
    apiKey: cfg.ai.apiKey,
    ...(cfg.ai.baseURL ? { baseURL: cfg.ai.baseURL } : {}),
  });
  const { woo, smartSearch, onHandoff, onOrderCreated } = deps;

  async function runTool(name, input, ctx) {
    if (name === 'procurar_produto') {
      const results = await woo.searchProducts(input.termo);
      return { results };
    }
    if (name === 'sugerir_categorias') {
      if (!smartSearch) return { suggestions: [] };
      return await smartSearch.suggest(input.descricao);
    }
    if (name === 'criar_encomenda') {
      const order = await woo.createOrder({
        customer: {
          name: input.nome,
          phone: input.telefone || ctx.phone,
          city: input.cidade,
          address: input.morada,
        },
        lineItems: (input.itens || []).map((i) => ({ product_id: i.product_id, quantity: i.quantidade })),
        note: input.nota,
      });
      onOrderCreated?.(ctx.phone, order, input);
      return { order };
    }
    if (name === 'escalar_para_humano') {
      onHandoff?.(ctx.phone, input.motivo);
      return { ok: true, message: 'Escalado para agente humano.' };
    }
    return { error: `Ferramenta desconhecida: ${name}` };
  }

  // Recebe o historico da sessao (array {role, content}) e devolve o texto final para o cliente.
  async function reply(sessionMessages, ctx) {
    const messages = sessionMessages.map((m) => ({ role: m.role, content: m.content }));
    const system = `${SYSTEM_PROMPT}\n\n---\n# BASE DE CONHECIMENTO\n${KNOWLEDGE}`;

    // Ciclo agentico: no maximo 5 saltos de ferramenta por resposta (fail closed).
    for (let hop = 0; hop < 5; hop++) {
      const resp = await client.messages.create({
        model: cfg.ai.model,
        max_tokens: cfg.ai.maxTokens,
        system,
        tools: TOOLS,
        messages,
      });

      if (resp.stop_reason === 'tool_use') {
        const toolUses = resp.content.filter((c) => c.type === 'tool_use');
        messages.push({ role: 'assistant', content: resp.content });
        const toolResults = [];
        for (const tu of toolUses) {
          let result;
          try {
            result = await runTool(tu.name, tu.input, ctx);
          } catch (e) {
            log.error('ai.tool_error', { tool: tu.name, error: e.message });
            result = { error: e.message, hint: 'Informar o cliente que houve um problema e que a equipa vai confirmar.' };
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(result),
          });
        }
        messages.push({ role: 'user', content: toolResults });
        continue; // volta a chamar o modelo com os resultados
      }

      // Resposta final de texto
      const text = resp.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim();
      return text || 'Desculpe, pode repetir o pedido?';
    }

    log.warn('ai.max_hops_reached', { phone: ctx.phone });
    return 'Deixe-me confirmar isto com a equipa e já lhe respondo.';
  }

  return { reply };
}
