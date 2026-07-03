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

export function attachProductAutocomplete(input, { onPick } = {}) {
  return attachAutocomplete(input, {
    minChars: 2,
    menuClass: 'admin-ac__menu--product',
    fetch: async (q) => {
      const data = await AdminAPI.getProducts({ search: q }, 1, 12);
      return data?.products || data?.items || [];
    },
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
