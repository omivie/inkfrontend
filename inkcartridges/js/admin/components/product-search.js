/**
 * Product autocomplete — storefront-grade product picker for admin line items.
 *
 * Wraps attachAutocomplete with a much larger dropdown that renders each result
 * as a product row with a thumbnail, code, name and price — mirroring the
 * landing-page SmartSearch dropdown rather than the old plain text list.
 * Shared by the Invoices editor and the Quick Order editor so both behave the
 * same and stay in sync.
 *
 *   const ac = attachProductAutocomplete(inputEl, { onPick: (product) => {...} });
 *   ac.destroy();   // on line re-render / drawer teardown
 */
import { attachAutocomplete } from './autocomplete.js';
import { AdminAPI } from '../app.js';
import { costOrNull } from '../utils/invoice-math.js';

const PLACEHOLDER_IMG = '/assets/images/placeholder-product.svg';
const escH = (s) => (window.Security?.escapeHtml ? Security.escapeHtml(String(s ?? '')) : String(s ?? ''));
const escA = (s) => (window.Security?.escapeAttr ? Security.escapeAttr(String(s ?? '')) : String(s ?? '').replace(/"/g, '&quot;'));
const money = (n) => (typeof window.formatPrice === 'function' ? window.formatPrice(Number(n) || 0) : '$' + (Number(n) || 0).toFixed(2));

// Resolve a usable image URL from the many shapes /api/admin/products can return
// (mirrors the admin Products table thumbnail logic). Bare Supabase paths are run
// through storageUrl(); full/rooted URLs pass through untouched.
function resolveImg(p) {
  const img = (Array.isArray(p.images) && p.images[0]) || p.primary_image || p.image_url;
  if (!img) return '';
  const raw = typeof img === 'string' ? img : (img.image_url || img.url || img.thumbnail_url || img.path || '');
  if (!raw) return '';
  if (/^https?:\/\//.test(raw) || raw.startsWith('/')) return raw;
  return (typeof window.storageUrl === 'function') ? window.storageUrl(raw) : raw;
}

/**
 * Our ex-GST supplier cost for a product, or null when we don't know it.
 *
 * products.cost_price is ex-GST (same column utils/profitability.js deducts
 * as-is). Shared by the Invoices and Quick Order pickers so both resolve the
 * field identically and neither has to guess the backend's spelling.
 *
 * null means UNKNOWN, never $0 — see costOrNull in utils/invoice-math.js.
 */
export function productCostExGst(p) {
  return costOrNull(p?.cost_price ?? p?.supplier_cost ?? p?.cost ?? null);
}

// PostgREST's .or() filter is comma/paren-delimited, so those characters in a
// raw search term would corrupt the expression. The picker takes free text, so
// strip them rather than trust the input.
const sbSafe = (s) => String(s ?? '').replace(/[,()]/g, ' ').trim();

// NOTE (ERR-071, Jul 2026): there used to be a `fetchProductCosts` here that
// back-filled the "Our Cost" box on open, because the invoice API was believed not
// to echo supplier_cost_excl_gst. The backend response (verified live: GET
// /api/admin/invoices/:id returns supplier_cost_excl_gst on each line, e.g. 139.8
// on #3263) confirmed that premise was wrong — the empty box was the *stored* value
// being null on the truncated-code rows, now canonicalised + repaired. The
// workaround was pure dead weight, so it (and its caller backfillCostsFromCatalogue
// in pages/invoices.js) is gone. Cost now comes straight from the echoed value.

/**
 * Verify line codes against the catalogue → Map<lowercased code, canonical sku>.
 *
 * The gate that keeps a non-SKU out of an invoice's product_code (ERR-071). A code
 * that matches no product is simply ABSENT from the returned map — absent means
 * "not a SKU", and utils/line-codes.js turns that into a blocking error rather
 * than guessing which product was meant.
 *
 * Returns null — NOT an empty map — when the catalogue itself is unreachable.
 * The distinction is the whole point: an empty map says "nothing matched, block
 * the save"; null says "we couldn't ask", and a save must never be blocked by our
 * own outage. Same UNKNOWN-≠-zero discipline as costOrNull, applied to lookups.
 *
 * Matching is exact but case-insensitive. We do that by ALSO querying the
 * uppercased form (canonical SKUs are uppercase) rather than with ilike, so a `%`
 * or `_` in a typed code can never be read as a wildcard and silently match some
 * other product.
 */
export async function resolveSkus(codes) {
  const want = [...new Set((codes || []).map((c) => sbSafe(c)).filter(Boolean))];
  const out = new Map();
  if (!want.length) return out;
  const sb = (typeof Auth !== 'undefined' && Auth?.supabase) ? Auth.supabase : null;
  if (!sb) return null;                        // can't ask → caller must not block
  try {
    const probes = [...new Set([...want, ...want.map((c) => c.toUpperCase())])];
    const { data, error } = await sb.from('products').select('sku').in('sku', probes);
    if (error || !Array.isArray(data)) return null;
    for (const row of data) {
      const sku = String(row.sku ?? '');
      if (sku) out.set(sku.toLowerCase(), sku);
    }
    return out;
  } catch (err) {
    window.DebugLog?.warn?.('[ProductSearch] SKU verification failed', err?.message || err);
    return null;
  }
}

/**
 * Search products for the picker.
 *
 * Supabase first — not just because it's faster (it skips the Render hop, same
 * reasoning as pages/products.js:722), but because cost_price is the whole point
 * of this picker now and there is NO evidence /api/admin/products returns it:
 * the Products page reads cost_price from a direct Supabase select, and only
 * falls back to HTTP for margin/image/stock filters. Selecting the column
 * explicitly here is what guarantees it reaches onPick.
 *
 * The HTTP path remains as a fallback so the picker still works (minus the cost
 * auto-fill) when Supabase is unavailable. And even then COGS stays correct: the
 * backend snapshots products.cost_price at save time when the client sends none.
 */
async function searchProducts(q) {
  const sb = (typeof Auth !== 'undefined' && Auth?.supabase) ? Auth.supabase : null;
  const term = sbSafe(q);
  if (sb && term) {
    try {
      const { data, error } = await sb
        .from('products')
        .select('id, sku, name, retail_price, cost_price, image_url, product_images(path, is_primary, sort_order)')
        .or(`name.ilike.%${term}%,sku.ilike.%${term}%`)
        .limit(12);
      if (!error && Array.isArray(data) && data.length) return data;
    } catch (err) {
      window.DebugLog?.warn?.('[ProductSearch] Supabase lookup failed, falling back to HTTP', err?.message || err);
    }
  }
  const data = await AdminAPI.getProducts({ search: q }, 1, 12);
  return data?.products || data?.items || [];
}

// Extra options (e.g. scrollIntoViewOnFocus) pass straight through to
// attachAutocomplete — spread LAST so a caller can override a default here.
export function attachProductAutocomplete(input, { onPick, ...rest } = {}) {
  return attachAutocomplete(input, {
    minChars: 2,
    menuClass: 'admin-ac__menu--product',
    // NB: the picked row is handed to onPick whole, cost_price included. The cost
    // is never RENDERED in the dropdown — it's an internal figure, and the
    // dropdown is the one part of this surface an operator might show a customer.
    fetch: searchProducts,
    render: (p) => {
      const src = resolveImg(p);
      const code = p.sku || '';
      const name = p.name || p.product_name || '';
      const price = p.retail_price != null ? money(p.retail_price) : '';
      const thumb = src
        ? `<img class="admin-ac__thumb" src="${escA(src)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">`
        : `<span class="admin-ac__thumb admin-ac__thumb--empty"></span>`;
      return `<span class="admin-ac__product">
        ${thumb}
        <span class="admin-ac__pinfo">
          <span class="admin-ac__pcode">${escH(code)}</span>
          <span class="admin-ac__pname">${escH(name)}</span>
        </span>
        ${price ? `<span class="admin-ac__pprice">${escH(price)}</span>` : ''}
      </span>`;
    },
    onPick,
    ...rest,
  });
}
