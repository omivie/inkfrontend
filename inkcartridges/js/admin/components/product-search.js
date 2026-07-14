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

/**
 * Look up the ex-GST cost of many SKUs at once → Map<sku, cost|null>.
 *
 * Why this exists: the backend does NOT echo supplier_cost_excl_gst back on a
 * saved invoice (it snapshots the cost into the shadow order but leaves the
 * invoice line null). So reopening an invoice shows an empty "Our Cost" box even
 * for a product we know the cost of, and the invoice's Profit column can never
 * read anything but "—". Back-filling from the catalogue on open closes that loop:
 * the operator just hits Save and the cost persists.
 *
 * A SKU with no catalogue row, or a row with no cost_price, maps to null — that is
 * UNKNOWN, and it stays unknown. Never 0.
 */
export async function fetchProductCosts(skus) {
  const want = [...new Set((skus || []).map(s => String(s || '').trim()).filter(Boolean))];
  const out = new Map();
  if (!want.length) return out;
  const sb = (typeof Auth !== 'undefined' && Auth?.supabase) ? Auth.supabase : null;
  if (!sb) return out;                       // no Supabase → no back-fill; costs stay unknown
  try {
    const { data, error } = await sb.from('products').select('sku, cost_price').in('sku', want);
    if (error || !Array.isArray(data)) return out;
    for (const row of data) out.set(row.sku, productCostExGst(row));
  } catch (err) {
    window.DebugLog?.warn?.('[ProductSearch] cost back-fill failed', err?.message || err);
  }
  return out;
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

export function attachProductAutocomplete(input, { onPick } = {}) {
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
  });
}
