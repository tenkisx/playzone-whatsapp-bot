// Cliente do "cérebro de pesquisa" do site playzone.ao.
// O site expõe (admin-ajax.php, action=pz_ai_search) o mesmo motor que alimenta a
// Pesquisa IA do site: Claude + lista real de categorias + fallback local + analytics.
// Chamar daqui garante UMA fonte de verdade e que as perguntas do WhatsApp também
// aparecem em wp-admin -> Opções -> Pesquisa IA -> "Pesquisas mais frequentes".
//
// Fail closed: qualquer erro/timeout devolve { suggestions: [] } — o bot continua
// a conversa sem links em vez de falhar ou inventar.
import { log } from './logger.js';

const TIMEOUT_MS = 9000;

export function createSmartSearch(cfg) {
  const base = (cfg.site?.baseUrl || cfg.woo.baseUrl).replace(/\/+$/, '');

  async function suggest(descricao) {
    const q = String(descricao || '').trim().slice(0, 140);
    if (!q) return { suggestions: [] };

    const body = new URLSearchParams();
    body.append('action', 'pz_ai_search');
    body.append('q', q);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/wp-admin/admin-ajax.php`, {
        method: 'POST',
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        log.warn('smartsearch.http_error', { status: res.status });
        return { suggestions: [] };
      }
      const j = await res.json();
      if (!j || !j.ok || !Array.isArray(j.suggestions)) return { suggestions: [] };
      const suggestions = j.suggestions
        .slice(0, 4)
        .filter((s) => s && s.label && s.url)
        .map((s) => ({ categoria: String(s.label), link: String(s.url) }));
      log.info('smartsearch.ok', { q_len: q.length, n: suggestions.length, mode: j.mode || '?' });
      return { resposta_sugerida: j.reply || '', suggestions };
    } catch (e) {
      log.warn('smartsearch.failed', { error: e.message });
      return { suggestions: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  return { suggest };
}
