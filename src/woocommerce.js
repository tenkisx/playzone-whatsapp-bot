// Integracao WooCommerce (REST API v3) — FONTE DE VERDADE para precos e stock.
// Regra critica: o bot NUNCA inventa precos. Se um produto nao for encontrado
// ou o preco for desconhecido, devolvemos "desconhecido" e o bot diz que vai confirmar.
import { log } from './logger.js';

export function createWooClient(cfg) {
  const base = `${cfg.woo.baseUrl}/wp-json/wc/v3`;
  const auth = 'Basic ' + Buffer.from(`${cfg.woo.key}:${cfg.woo.secret}`).toString('base64');
  const headers = { Authorization: auth, 'Content-Type': 'application/json' };

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.error('woo.error', { path, method, status: res.status, message: data?.message });
      throw new Error(`WooCommerce ${method} ${path} falhou (${res.status}): ${data?.message || 'erro'}`);
    }
    return data;
  }

  function fmtKz(v) {
    const n = Number(v);
    if (!isFinite(n) || v === '' || v == null) return 'desconhecido';
    return n.toLocaleString('pt-PT', { maximumFractionDigits: 0 }) + ' AKZ';
  }

  return {
    // Procura ate `limit` produtos publicados que correspondem ao termo.
    async searchProducts(term, limit = 5) {
      const q = encodeURIComponent(term);
      const items = await call(`/products?search=${q}&per_page=${limit}&status=publish`);
      const mapped = (Array.isArray(items) ? items : []).map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price === '' ? null : p.price,      // string ou null
        price_label: fmtKz(p.price),                 // "277 990 AKZ" ou "desconhecido"
        in_stock: p.stock_status === 'instock',
        permalink: p.permalink,
        sku: p.sku || null,
      }));
      log.info('woo.search', { term, results: mapped.length });
      return mapped;
    },

    async getProduct(id) {
      const p = await call(`/products/${id}`);
      return {
        id: p.id,
        name: p.name,
        price: p.price === '' ? null : p.price,
        price_label: fmtKz(p.price),
        in_stock: p.stock_status === 'instock',
        permalink: p.permalink,
      };
    },

    // Cria uma encomenda. line_items = [{ product_id, quantity }].
    // Devolve numero e link de pagamento. Estado inicial vem da config (on-hold por defeito).
    async createOrder({ customer, lineItems, note }) {
      const payload = {
        status: cfg.ops.orderStatus,
        set_paid: false,
        billing: {
          first_name: customer.name || 'Cliente WhatsApp',
          phone: customer.phone || '',
          address_1: customer.address || '',
          city: customer.city || '',
          email: customer.email || '',
        },
        line_items: lineItems.map((li) => ({ product_id: li.product_id, quantity: li.quantity })),
        customer_note: note || 'Encomenda recebida via WhatsApp (assistente IA).',
      };
      const order = await call('/orders', { method: 'POST', body: payload });
      log.info('woo.order_created', { orderId: order.id, total: order.total });
      return {
        id: order.id,
        number: order.number,
        total_label: fmtKz(order.total),
        status: order.status,
        pay_url: order.payment_url || `${cfg.woo.baseUrl}/finalizar-compra/order-pay/${order.id}/?pay_for_order=true&key=${order.order_key}`,
      };
    },
  };
}
