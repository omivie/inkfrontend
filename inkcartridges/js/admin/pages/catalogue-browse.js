/**
 * Catalogue Browse — the admin's brand → category → code → product walk.
 * ======================================================================
 *
 * This is the customer's own drill-down, rendered inside the admin, and it is
 * where every new product now starts. You walk to where the product belongs,
 * see what is already there, and add it from that spot — so brand, category and
 * code are chosen by navigation instead of typed into three blank dropdowns.
 *
 * WHY IT IS A NAVIGATOR AND NOT A CREATE HIERARCHY
 * -----------------------------------------------
 * The obvious design — add a brand, then add a type under it, then add a code
 * under that, then add products into the code — cannot be built, because three
 * of those four levels are not records:
 *
 *   category  a fixed map over `product_type`, a backend Postgres enum
 *   code      DERIVED from sku/name by API._enrichSeriesCodes at query time
 *
 * A code with zero products has nothing to store, so "create a code, then fill
 * it" would render a chip that appears nowhere on /shop. That is this repo's
 * most-logged failure — a surface that ships invisible (ERR-075/125/163). So
 * the walk pre-fills the create form and the chip materialises when the first
 * product saves into it. See utils/catalogue-pathway.js for the full statement.
 *
 * ONE VOCABULARY
 * --------------
 * Every level reads `window.API.getShopData()` — the exact function /shop
 * calls. It never computes its own chip list, its own counts or its own
 * category membership. The admin already carries six product-type vocabularies
 * and three category vocabularies; a seventh, computed here, would drift from
 * the storefront silently and this page's whole value is that it shows what the
 * customer sees.
 *
 * WHAT THE COUNTS MEAN
 * --------------------
 * `/api/shop` does not return inactive products, so every count on this page is
 * "live on /shop" — not "in the catalogue". That is said in the header rather
 * than left for someone to discover, because an unlabelled count that quietly
 * excludes rows is the absence-read-as-zero mistake (ERR-063/068/150). The
 * catalogue-wide view is the All Products tab; the reachability gap is measured
 * by `npm run probe:catalogue-pathway` and, per brand+category, by the
 * "Check for unreachable products" button on the code level.
 *
 * Loaded lazily by pages/products.js as the `browse` sub-tab, the same way
 * printers.js is. It is NOT in NAV_ITEMS and has no route of its own.
 */

import { AdminAPI, icon, esc } from '../app.js';
import { Toast } from '../components/toast.js';
import { Modal } from '../components/modal.js';
import { paginate, pagerHtml, categoryLabel, isValidProductCode } from '../utils/product-codes.js';
import { productTypeLabel } from '../utils/product-types.js';
import {
  SHOP_CATEGORIES, brandVisibleOnShop, typesForCategory, isManualCodeType,
} from '../utils/catalogue-pathway.js';

const PER_PAGE = 60;

// ---- Module state ----
// Reset in BOTH init() and destroy(). Module-level state that is only cleared
// on the way out means last visit's narrowing silently carries over into the
// next one, and a slice reads as the whole catalogue — the bug the Product
// Codes page had to fix (its brand/category selects now reset in both).
let _container = null;
let _hooks = {};
let _level = 'brands';            // brands | categories | codes | products | ribbon-products
let _brand = null;                // { slug, name, id, kind: 'cartridge'|'ribbon' }
let _category = '';               // a SHOP_CATEGORIES value
let _codeEntry = null;            // { code, count, aliases[] }
let _page = 0;
let _filter = '';
let _loadToken = 0;               // guards a slow load from painting over a newer one

function resetState() {
  _level = 'brands';
  _brand = null;
  _category = '';
  _codeEntry = null;
  _page = 0;
  _filter = '';
}

// ---------------------------------------------------------------------------
// Small shared render helpers
// ---------------------------------------------------------------------------

const spinner = () => `<div style="display:flex;align-items:center;justify-content:center;min-height:24vh">
  <div class="admin-loading__spinner"></div></div>`;

function emptyState(title, text) {
  return `<div class="admin-empty">
    <div class="admin-empty__title">${esc(title)}</div>
    <div class="admin-empty__text">${esc(text)}</div>
  </div>`;
}

/**
 * An error pane that says which step failed and offers a retry.
 *
 * "Could not load" and "there is nothing here" are different sentences and this
 * page must never collapse them — an unreachable API rendering as an empty
 * brand grid would read as "the catalogue is empty".
 */
function errorState(what, err) {
  return `<div class="admin-empty">
    <div class="admin-empty__title">Couldn’t load ${esc(what)}</div>
    <div class="admin-empty__text">${esc(err?.message || String(err || 'Unknown error'))}</div>
    <button class="admin-btn admin-btn--sm" data-cb-retry style="margin-top:12px">Retry</button>
  </div>`;
}

/** The breadcrumb trail — every crumb before the last is clickable. */
function breadcrumbHtml() {
  const crumbs = [{ label: 'All brands', level: 'brands' }];
  if (_brand) {
    crumbs.push({
      label: _brand.name,
      level: _brand.kind === 'ribbon' ? 'ribbon-products' : 'categories',
    });
  }
  if (_category) crumbs.push({ label: categoryLabel(_category), level: 'codes' });
  if (_codeEntry) crumbs.push({ label: _codeEntry.code, level: 'products' });

  return `<nav class="admin-cb-crumbs" aria-label="Catalogue path">${
    crumbs.map((c, i) => {
      const last = i === crumbs.length - 1;
      const sep = i === 0 ? '' : `<span class="admin-cb-crumbs__sep" aria-hidden="true">›</span>`;
      return sep + (last
        ? `<span class="admin-cb-crumbs__here" aria-current="page">${esc(c.label)}</span>`
        : `<button type="button" class="admin-cb-crumbs__link" data-cb-crumb="${esc(c.level)}">${esc(c.label)}</button>`);
    }).join('')
  }</nav>`;
}

/**
 * The standing note that every count on this page is the customer's view.
 * Shown on every level that renders a count, not just once on entry — a caveat
 * you have to remember from two screens ago is a caveat nobody applies.
 */
function liveCountNote() {
  return `<p class="admin-cb-note">Counts are what a customer sees on /shop —
    inactive products are not included. The full catalogue is the
    <strong>All Products</strong> tab.</p>`;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function goTo(level, patch = {}) {
  if ('brand' in patch) _brand = patch.brand;
  if ('category' in patch) _category = patch.category;
  if ('codeEntry' in patch) _codeEntry = patch.codeEntry;

  // Clear everything below the level being entered, so a crumb click can never
  // leave a stale code sitting under a freshly-picked category.
  if (level === 'brands') { _brand = null; _category = ''; _codeEntry = null; }
  if (level === 'categories' || level === 'ribbon-products') { _category = ''; _codeEntry = null; }
  if (level === 'codes') { _codeEntry = null; }

  _level = level;
  _page = 0;
  _filter = '';
  render();
}

function render() {
  if (!_container) return;
  const token = ++_loadToken;
  _container.innerHTML = breadcrumbHtml() + `<div id="cb-level">${spinner()}</div>`;

  _container.querySelectorAll('[data-cb-crumb]').forEach(btn => {
    btn.addEventListener('click', () => goTo(btn.dataset.cbCrumb));
  });

  const host = _container.querySelector('#cb-level');
  const paint = (fn) => fn(host, token).catch((e) => {
    if (token !== _loadToken) return;
    host.innerHTML = errorState(_level, e);
    host.querySelector('[data-cb-retry]')?.addEventListener('click', render);
  });

  if (_level === 'brands') paint(renderBrands);
  else if (_level === 'ribbon-products') paint(renderRibbonProducts);
  else if (_level === 'categories') paint(renderCategories);
  else if (_level === 'codes') paint(renderCodes);
  else paint(renderProducts);
}

// ---------------------------------------------------------------------------
// Level 1 — brands
// ---------------------------------------------------------------------------

/**
 * Two sections, mirroring /shop: cartridge & toner brands (the `brands` table)
 * and typewriter & ribbon brands (`ribbon_brands`). They are genuinely separate
 * universes with separate storage, and on the storefront they lead to different
 * pages — collapsing them into one grid here would misrepresent both.
 */
async function renderBrands(host, token) {
  const [brands, ribbonBrands] = await Promise.all([
    AdminAPI.getBrands(),
    AdminAPI.getAdminRibbonBrands().catch(() => null),
  ]);
  if (token !== _loadToken) return;

  if (!Array.isArray(brands)) throw new Error('The brand list could not be read from /api/brands.');

  // A brand /api/brands returns but /shop refuses to render is invisible with
  // no error anywhere. Surface it here rather than leaving it to be noticed.
  const visible = brands.filter(b => brandVisibleOnShop(b.slug));
  const hidden  = brands.filter(b => !brandVisibleOnShop(b.slug));

  const tile = (b, shown) => `
    <button type="button" class="admin-cb-tile${shown ? '' : ' admin-cb-tile--muted'}"
            data-cb-brand="${esc(b.slug || '')}" data-cb-brand-name="${esc(b.name || b.slug || '')}"
            data-cb-brand-id="${esc(String(b.id ?? ''))}">
      <span class="admin-cb-tile__name">${esc(b.name || b.slug || '')}</span>
      ${shown ? '' : `<span class="admin-cb-tile__warn">not shown on /shop</span>`}
    </button>`;

  const ribbonTile = (b) => `
    <button type="button" class="admin-cb-tile admin-cb-tile--ribbon${b.is_active === false ? ' admin-cb-tile--muted' : ''}"
            data-cb-ribbon="${esc(b.slug || '')}" data-cb-brand-name="${esc(b.name || b.slug || '')}">
      <span class="admin-cb-tile__name">${esc(b.name || b.slug || '')}</span>
      ${b.is_active === false ? `<span class="admin-cb-tile__warn">inactive</span>` : ''}
    </button>`;

  host.innerHTML = `
    <h3 class="admin-cb-h">Cartridge &amp; toner brands</h3>
    <div class="admin-cb-grid">${visible.map(b => tile(b, true)).join('') || emptyState('No brands', 'The brand list came back empty.')}</div>

    ${hidden.length ? `
      <h3 class="admin-cb-h admin-cb-h--warn">${hidden.length} brand${hidden.length === 1 ? '' : 's'} not on /shop</h3>
      <p class="admin-cb-note">These exist in the catalogue and appear in search and on their
        product pages, but <strong>render no tile on /shop</strong>: the shop filters the brand
        list against a hardcoded allowlist (<code>preferredOrder</code> in
        <code>js/shop-page.js</code>). Adding one there also needs a logo entry in
        <code>brandInfo</code>. You can still add products to them here.</p>
      <div class="admin-cb-grid">${hidden.map(b => tile(b, false)).join('')}</div>
    ` : ''}

    <h3 class="admin-cb-h">Typewriter &amp; ribbon brands</h3>
    <p class="admin-cb-note">Ribbon products carry <strong>only the codes you assign</strong> —
      nothing about a ribbon is derived from its SKU.
      <a href="#ribbon-brands" class="admin-cb-link">Add or edit ribbon brands →</a></p>
    <div class="admin-cb-grid">${
      Array.isArray(ribbonBrands) && ribbonBrands.length
        ? ribbonBrands.map(ribbonTile).join('')
        : emptyState('No ribbon brands', 'Nothing came back from the ribbon_brands table.')
    }</div>
  `;

  host.querySelectorAll('[data-cb-brand]').forEach(btn => {
    btn.addEventListener('click', () => goTo('categories', {
      brand: {
        slug: btn.dataset.cbBrand,
        name: btn.dataset.cbBrandName,
        id: btn.dataset.cbBrandId || null,
        kind: 'cartridge',
      },
    }));
  });
  host.querySelectorAll('[data-cb-ribbon]').forEach(btn => {
    // Ribbon brands do NOT enter the /shop drilldown, and this is not a
    // shortcut — it is the only thing that works. A ribbon brand is the
    // PRINTER brand (Adler, Olympia, IBM), linked through the
    // product_ribbon_brands junction; it is not `products.brand_id`. Measured
    // 2026-08-30: /api/shop?brand=adler returns ok:false — there is no `adler`
    // row in `brands` at all — while /api/ribbons?printer_brand=adler answers
    // cleanly. /shop makes the same split: its ribbon tiles are plain links out
    // to /ribbons?printer_brand=X rather than drilldown steps.
    btn.addEventListener('click', () => goTo('ribbon-products', {
      brand: { slug: btn.dataset.cbRibbon, name: btn.dataset.cbBrandName, id: null, kind: 'ribbon' },
    }));
  });
}

// ---------------------------------------------------------------------------
// Ribbon brands — a second universe, two levels deep, not four
// ---------------------------------------------------------------------------

/**
 * Ribbons do not have a category or a code level, and inventing one for them
 * would be a lie in both directions.
 *
 * A ribbon brand is the PRINTER brand (Adler, Olympia, IBM) reached through the
 * `product_ribbon_brands` junction — not `products.brand_id` — so the /shop
 * drilldown cannot address it. /shop agrees: its typewriter tiles are plain
 * links out to `/ribbons?printer_brand=X`, not drilldown steps.
 *
 * And ribbons carry no derived codes at all. `/api/shop` returns an EMPTY series
 * array for the ribbon category (measured 2026-08-30: brother/ribbon → total 2,
 * series 0), because a ribbon's `series_codes` are cleared unless the owner has
 * assigned an override. That is deliberate — ribbons are owner-manual in every
 * aspect except page design (ERR-085/086). So there is no chip level to render;
 * a code grid here would be permanently, misleadingly empty.
 */
async function renderRibbonProducts(host, token) {
  const resp = await window.API.getRibbons({ printer_brand: _brand.slug, limit: 200 });
  if (token !== _loadToken) return;

  if (!resp || resp.ok === false) {
    throw new Error(`No ribbons could be read for ${_brand.name}.`);
  }
  const ribbons = resp.data?.ribbons || resp.data?.products || [];

  host.innerHTML = `
    <p class="admin-cb-note">Ribbons are <strong>owner-entered in every respect except page
      design</strong>. Nothing here is derived from a SKU — a ribbon carries only the product
      codes you assign it, in the product editor's <strong>Product Codes</strong> tab. This list
      is what <code>/ribbons?printer_brand=${esc(_brand.slug)}</code> shows a customer.</p>
    <div class="admin-cb-actions" style="margin-top:0;padding-top:0;border-top:none">
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="cb-add-here">
        ${icon('products', 14, 14)} Add ribbon for ${esc(_brand.name)}
      </button>
      <span class="admin-cb-actions__hint">Pick the ribbon product type in the form; assign its
        codes after it is created.</span>
    </div>
    ${ribbons.length
      ? `<div class="admin-cb-products">${ribbons.map(r => `
          <button type="button" class="admin-cb-product" data-cb-ribbon-sku="${esc(r.sku || '')}">
            <span class="admin-cb-product__sku">${esc(r.sku || '\u2014')}</span>
            <span class="admin-cb-product__name">${esc(r.name || '')}</span>
            <span class="admin-cb-product__meta">
              ${r.brand ? `<span class="admin-cb-chip">${esc(r.brand)}</span>` : ''}
              ${r.is_active === false ? `<span class="admin-cb-chip">inactive</span>` : ''}
            </span>
          </button>`).join('')}</div>`
      : emptyState('No ribbons for this brand yet',
          `Nothing is filed under ${_brand.name}. Add the first one below, then link it to this `
          + 'brand in the editor\u2019s Ribbon Brands section.')}
  `;

  host.querySelector('#cb-add-here')?.addEventListener('click', () => addProductHere(null));

  // A ribbon row opens by SKU: /api/ribbons returns the ribbon projection, not
  // a products row, so there is no id to hand the drawer directly.
  host.querySelectorAll('[data-cb-ribbon-sku]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sku = btn.dataset.cbRibbonSku;
      if (!sku) return;
      try {
        const data = await AdminAPI.getProducts({ search: sku }, 1, 5);
        const list = data?.products ?? data?.items ?? (Array.isArray(data) ? data : []);
        const hit = list.find(p => String(p.sku).toUpperCase() === sku.toUpperCase());
        if (hit) _hooks.onOpenProduct?.(hit);
        else Toast.error(`No product row found for SKU ${sku}.`);
      } catch (e) {
        Toast.error(e?.message || 'That ribbon could not be loaded.');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Level 2 — categories
// ---------------------------------------------------------------------------

/**
 * Counts come from `getShopData({brand}).data.counts`, remapped exactly as
 * shop-page.js does (`drums`, and `label_tape || label` — the storefront
 * tolerates both spellings, so we must too).
 *
 * Two deliberate divergences from /shop, both because the admin's job is the
 * inverse of the storefront's:
 *   - a ZERO-count category is still shown. /shop hides it; an empty category
 *     is exactly where you add the first product, so hiding it here would make
 *     that impossible.
 *   - RIBBONS is shown. /shop filters it out of this grid (reachable only via
 *     the nav dropdown), but ribbon products are real and live in the catalogue.
 */
async function renderCategories(host, token) {
  const resp = await window.API.getShopData({ brand: _brand.slug });
  if (token !== _loadToken) return;

  const counts = (resp && resp.ok && resp.data && resp.data.counts) || {};
  // The live payload spells these `label` and `ribbon` (measured 2026-08-30:
  // {"ink":330,"toner":268,"drums":61,"label":155,"paper":5,"ribbon":2}), while
  // shop-page.js also tolerates `label_tape`. Accept both spellings on both —
  // reading one key and getting undefined would render a real category as "no
  // products yet", which is the absence-as-zero mistake with a friendly face.
  const countFor = (value) => {
    if (value === 'drums') return counts.drums || 0;
    if (value === 'label') return counts.label_tape || counts.label || 0;
    if (value === 'ribbons') return counts.ribbons || counts.ribbon || 0;
    return counts[value] || 0;
  };

  host.innerHTML = liveCountNote() + `<div class="admin-cb-grid">${
    SHOP_CATEGORIES.map(cat => {
      const n = countFor(cat.value);
      return `<button type="button" class="admin-cb-tile${n ? '' : ' admin-cb-tile--muted'}"
                data-cb-cat="${esc(cat.value)}">
        <span class="admin-cb-tile__name">${esc(cat.label)}</span>
        <span class="admin-cb-tile__count">${n ? `${n} product${n === 1 ? '' : 's'}` : 'no products yet'}</span>
      </button>`;
    }).join('')
  }</div>`;

  host.querySelectorAll('[data-cb-cat]').forEach(btn => {
    btn.addEventListener('click', () => goTo('codes', { category: btn.dataset.cbCat }));
  });
}

// ---------------------------------------------------------------------------
// Level 3 — codes
// ---------------------------------------------------------------------------

async function renderCodes(host, token) {
  const resp = await window.API.getShopData({ brand: _brand.slug, category: _category });
  if (token !== _loadToken) return;

  const series = (resp && resp.ok && resp.data && Array.isArray(resp.data.series)) ? resp.data.series : [];
  // Collapse 604/604XL into one chip exactly as the storefront does, keeping
  // the aliases — /api/shop?code= matches series_codes EXACTLY, so a collapsed
  // chip must fan out to every raw code it swallowed or the grid comes back short.
  const collapsed = (typeof window !== 'undefined' && window.SeriesCodes?.collapseChipList)
    ? window.SeriesCodes.collapseChipList(series)
    : series.map(s => ({ ...s, aliases: [String(s.code || '').toUpperCase()] }));

  const q = _filter.trim().toUpperCase();
  const visible = q ? collapsed.filter(c => String(c.code).toUpperCase().includes(q)) : collapsed;
  const model = paginate(visible, _page, PER_PAGE);

  host.innerHTML = `
    ${liveCountNote()}
    <div class="admin-cb-toolbar">
      <input class="admin-pc-filter" id="cb-code-filter" placeholder="Filter codes…"
             value="${esc(_filter)}" style="padding-left:12px;max-width:260px">
      <span class="admin-cb-toolbar__count">${visible.length} code${visible.length === 1 ? '' : 's'}</span>
      <span style="flex:1 1 auto"></span>
      <button class="admin-btn admin-btn--sm" id="cb-new-code">+ New code</button>
      <button class="admin-btn admin-btn--ghost admin-btn--sm" id="cb-check-reach">Check for unreachable products</button>
    </div>
    <div id="cb-reach"></div>
    ${model.total
      ? `<div class="admin-pc-grid" style="max-height:none">${
          model.items.map(c => `
            <span class="admin-pc-code" data-cb-code="${esc(c.code)}"
                  data-cb-aliases="${esc((c.aliases || [c.code]).join(','))}" role="button" tabindex="0">
              <button type="button" class="admin-pc-code__toggle">
                ${esc(c.code)}<span class="admin-pc-code__count">${Number(c.count) || 0}</span>
              </button>
            </span>`).join('')
        }</div>${pagerHtml(model)}`
      : emptyState('No codes here yet',
          `Nothing is live on /shop under ${_brand.name} · ${categoryLabel(_category)}. `
          + 'Add the first product below and its code will appear.')}
    <div class="admin-cb-actions">
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="cb-add-here">
        ${icon('products', 14, 14)} Add product to ${esc(_brand.name)} · ${esc(categoryLabel(_category))}
      </button>
      <span class="admin-cb-actions__hint">Its code will come from the SKU you type${
        _category === 'ribbons' ? ', unless you assign one — ribbon codes are never derived' : ''}.</span>
    </div>
  `;

  const filterEl = host.querySelector('#cb-code-filter');
  filterEl?.addEventListener('input', (e) => {
    _filter = e.target.value; _page = 0;
    // Re-render only the list; keep focus in the box the operator is typing in.
    renderCodes(host, ++_loadToken).then(() => {
      const el = host.querySelector('#cb-code-filter');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
  });

  host.querySelectorAll('[data-cb-code]').forEach(el => {
    const open = () => goTo('products', {
      codeEntry: {
        code: el.dataset.cbCode,
        aliases: (el.dataset.cbAliases || el.dataset.cbCode).split(',').filter(Boolean),
      },
    });
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  host.querySelectorAll('[data-pcpage]').forEach(btn => {
    btn.addEventListener('click', () => {
      _page += btn.dataset.pcpage === 'next' ? 1 : -1;
      renderCodes(host, ++_loadToken);
    });
  });

  host.querySelector('#cb-add-here')?.addEventListener('click', () => addProductHere(null));
  host.querySelector('#cb-new-code')?.addEventListener('click', () => promptNewCode(collapsed));
  host.querySelector('#cb-check-reach')?.addEventListener('click', (e) => runReachabilityCheck(host, e.currentTarget));
}

/**
 * "+ New code" — name a chip that does not exist yet.
 *
 * THE HONEST PART: a code is not a record, so this button cannot create one.
 * Nothing is stored when you name it. `series_codes` is derived from a
 * product's sku/name at query time, and `product_codes` only overrides that for
 * a product that already exists — so a code with no products has nothing to
 * write and would render on no page. Naming one and walking away must therefore
 * leave nothing behind, and this modal says so rather than implying a save.
 *
 * What it does instead is offer the two things that DO make a code exist, and
 * they are genuinely different jobs:
 *
 *   1. Add its first product      — the common case. The code is carried into
 *                                   the create form, and the chip appears the
 *                                   moment that product saves.
 *   2. Tag products that exist    — the Product Codes page's membership drawer,
 *                                   which writes `product_codes` rows against
 *                                   products already in the catalogue.
 *
 * Brand and category are NOT asked for. The Product Codes page has to ask,
 * because it lists every code in the catalogue and a chip has to be born
 * somewhere — but here the operator is already standing in one, which is the
 * whole point of walking to it.
 */
function promptNewCode(existingCodes) {
  const scopeLabel = `${_brand.name} \u00b7 ${categoryLabel(_category)}`;
  const modal = Modal.open({
    title: `New code in ${scopeLabel}`,
    body: `<div class="admin-form-group">
        <label for="cb-code-input">Code</label>
        <input type="text" id="cb-code-input" class="admin-input" maxlength="24"
               placeholder="e.g. LC3341" autocomplete="off">
        <div class="admin-form-help">Letters, numbers and \u201c/\u201d, 2\u201324 characters. Use \u201c/\u201d
          only for a merged pair code, written the way the catalogue writes it (PG40/CL41).</div>
        <div class="admin-form-error" id="cb-code-err"></div>
      </div>
      <p class="admin-cb-note" style="margin-bottom:0">
        A code isn\u2019t stored on its own \u2014 it comes from the products underneath it.
        Naming one here saves nothing by itself; pick how it should get its first product.
      </p>`,
    footer: `<button class="admin-btn admin-btn--ghost" data-act="cancel">Cancel</button>
             <button class="admin-btn" data-act="tag">Tag existing products</button>
             <button class="admin-btn admin-btn--primary" data-act="create">Add its first product</button>`,
  });
  if (!modal) return;

  const input = modal.body.querySelector('#cb-code-input');
  const err = modal.body.querySelector('#cb-code-err');
  input.focus();

  /** Validate and normalise, or null with the reason already shown. */
  const readCode = () => {
    const code = AdminAPI.normalizeProductCode(input.value);
    if (!isValidProductCode(code)) {
      err.textContent = 'That code isn\u2019t valid \u2014 2\u201324 letters, numbers or \u201c/\u201d.';
      return null;
    }
    // Already on this page? Then it is not new, and the operator wants the tile
    // they are looking at rather than a second way in.
    const hit = (existingCodes || []).find(c => String(c.code).toUpperCase() === code);
    if (hit) {
      err.textContent = `${code} already exists in ${scopeLabel} \u2014 click its tile to see its `
        + `${hit.count} product${hit.count === 1 ? '' : 's'}.`;
      return null;
    }
    err.textContent = '';
    return code;
  };

  modal.footer.querySelector('[data-act="cancel"]').addEventListener('click', () => Modal.close());

  modal.footer.querySelector('[data-act="create"]').addEventListener('click', () => {
    const code = readCode();
    if (!code) return;
    Modal.close();
    addProductHere(code);
  });

  // The other job: a code that should collect products already in the
  // catalogue. That is membership editing, and the Product Codes page owns it —
  // rebuilding its drawer here would be a second surface writing the same
  // override table, which is how two normalisers drifted apart before (ERR-061).
  modal.footer.querySelector('[data-act="tag"]').addEventListener('click', () => {
    const code = readCode();
    if (!code) return;
    Modal.close();
    Toast.info(`Find or add ${code} on the Product Codes page to tick the products it covers.`);
    window.location.hash = '#product-codes';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = readCode();
      if (code) { Modal.close(); addProductHere(code); }
    }
  });
}

/**
 * The gap between "in the catalogue" and "live on /shop", for one brand+category.
 *
 * MEASURED, NOT SIMULATED. The first version of this ran `reachabilityFacets`
 * over the admin list and reported 195 of Brother's 200 ink products as
 * unreachable. Every one of them was fine: `/api/admin/products` does not
 * project `series_codes`, and a GENUINE product's code cannot be derived from
 * its SKU either (the extractor's SKU rule keys on the compatible `C` prefix,
 * so `GLC131BK` yields nothing). The check was reading missing data as missing
 * codes — absence-as-failure, the same mistake as absence-as-zero.
 *
 * So it no longer asks "should this be reachable". It asks the storefront what
 * it actually serves and diffs. A product in the admin list and not in the
 * /shop list is unreachable, whatever the reason, and the reason is only
 * offered where the admin row can honestly answer it.
 */
async function runReachabilityCheck(host, btn) {
  const out = host.querySelector('#cb-reach');
  if (!out) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Checking\u2026';
  out.innerHTML = spinner();

  try {
    const types = typesForCategory(_category);
    if (!types.length) throw new Error(`No product types are mapped to the "${_category}" category.`);

    // 1. What the customer can actually reach, walked to exhaustion. A partial
    //    walk here would invent unreachable products out of page 2.
    const live = new Set();
    for (let page = 1; page <= 20; page++) {
      const r = await window.API.getShopData({ brand: _brand.slug, category: _category, page, limit: 200 });
      if (!r || r.ok === false) throw new Error(`/api/shop stopped answering at page ${page}.`);
      const list = r.data?.products || [];
      for (const p of list) if (p.sku) live.add(String(p.sku).toUpperCase());
      if (!list.length || r.meta?.has_next === false) break;
    }
    if (!live.size) throw new Error('the storefront returned no products for this brand+category.');

    // 2. What the catalogue holds, including inactive. One call per type:
    //    /api/admin/products takes a single product_type and cannot express a
    //    type GROUP (BF-044), so a category of seven types is seven requests.
    const rows = [];
    for (const t of types) {
      const data = await AdminAPI.getProducts({ brand: _brand.slug, product_type: t }, 1, 200);
      const list = data?.products ?? data?.items ?? (Array.isArray(data) ? data : []);
      rows.push(...list);
    }
    if (!rows.length) throw new Error('the admin list returned no products for this brand+category.');

    // 3. Diff, and explain only what the admin row can honestly answer.
    // Only claim what the row positively answers. The admin list's projection is
    // not the storefront's — it spells the brand `brand`, `brands` or
    // `brand_id` depending on the path, and a KEY THAT IS ABSENT is not a value
    // that is null. Saying "no brand assigned" about a row whose brand simply
    // was not projected is how the first version of this reported 195 healthy
    // products as broken. Where the row cannot answer, say the measured fact
    // instead: the storefront does not serve it.
    const has = (p, k) => Object.prototype.hasOwnProperty.call(p, k);
    const why = (p) => {
      if (has(p, 'is_active') && p.is_active === false) return 'deactivated';
      const brandKnown = p.brand_id || p.brand?.slug || p.brands?.slug;
      if (!brandKnown && (has(p, 'brand_id') || has(p, 'brand') || has(p, 'brands'))) {
        return 'no brand assigned';
      }
      if (!brandVisibleOnShop(_brand.slug)) return `brand "${_brand.slug}" renders no tile on /shop`;
      if (has(p, 'product_type') && !p.product_type) return 'no product_type set';
      return 'in the catalogue but no /shop chip serves it \u2014 check its SKU against the codes above';
    };
    const broken = rows
      .filter(p => p.sku && !live.has(String(p.sku).toUpperCase()))
      .map(p => ({ p, reason: why(p) }));

    const scope = `${esc(_brand.name)} \u00b7 ${esc(categoryLabel(_category))}`;
    if (!broken.length) {
      out.innerHTML = `<div class="admin-cb-reach admin-cb-reach--ok">
        <strong>All ${rows.length} reachable.</strong> Every product the admin lists for
        ${scope} is served by /shop.
      </div>`;
    } else {
      out.innerHTML = `<div class="admin-cb-reach admin-cb-reach--bad">
        <strong>${broken.length} of ${rows.length} not reachable on /shop.</strong>
        In the catalogue, not served to customers under ${scope}.
        <ul class="admin-cb-reach__list">${
          broken.slice(0, 40).map(({ p, reason }) => `<li>
            <code>${esc(p.sku || '\u2014')}</code> ${esc(p.name || '')}
            <span class="admin-cb-reach__why">${esc(reason)}</span>
          </li>`).join('')
        }</ul>
        ${broken.length > 40 ? `<p class="admin-cb-note">\u2026and ${broken.length - 40} more. Run <code>npm run probe:catalogue-pathway</code> for the whole catalogue.</p>` : ''}
      </div>`;
    }
  } catch (e) {
    // "We could not look" must never render as "we looked and it was fine".
    out.innerHTML = `<div class="admin-cb-reach admin-cb-reach--warn">
      <strong>Could not check.</strong> ${esc(e?.message || String(e))} \u2014
      this is not a clean result, it is an unanswered question.
    </div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------------------------------------------------------------------------
// Level 4 — the products under one code
// ---------------------------------------------------------------------------

async function renderProducts(host, token) {
  // A collapsed chip stands for several raw codes and /api/shop?code= matches
  // exactly, so request every alias and merge — the same fan-out shop-page.js
  // does for its product grid.
  const aliases = _codeEntry.aliases?.length ? _codeEntry.aliases : [_codeEntry.code];
  const responses = await Promise.all(aliases.map(code =>
    window.API.getShopData({ brand: _brand.slug, category: _category, code, limit: 200 })
      .catch(() => null)));
  if (token !== _loadToken) return;

  const seen = new Set();
  const products = [];
  for (const r of responses) {
    const list = (r && r.ok && r.data && (r.data.products || r.data.items)) || [];
    for (const p of list) {
      const key = p.id || p.sku;
      if (key == null || seen.has(key)) continue;
      seen.add(key);
      products.push(p);
    }
  }

  host.innerHTML = `
    ${liveCountNote()}
    <div class="admin-cb-actions">
      <button class="admin-btn admin-btn--primary admin-btn--sm" id="cb-add-here">
        ${icon('products', 14, 14)} Add product to ${esc(_codeEntry.code)}
      </button>
      <span class="admin-cb-actions__hint">${
        isManualCodeType(products[0]?.product_type) || _category === 'ribbons'
          ? `${esc(_codeEntry.code)} will be assigned to it — ribbon codes are never derived.`
          : `Brand, category and code are filled in from here.`
      }</span>
    </div>
    ${products.length
      ? `<div class="admin-cb-products">${products.map(p => `
          <button type="button" class="admin-cb-product" data-cb-product="${esc(String(p.id || ''))}">
            <span class="admin-cb-product__sku">${esc(p.sku || '—')}</span>
            <span class="admin-cb-product__name">${esc(p.name || '')}</span>
            <span class="admin-cb-product__meta">
              ${p.source ? `<span class="admin-cb-chip">${esc(p.source)}</span>` : ''}
              ${p.color ? `<span class="admin-cb-chip">${esc(p.color)}</span>` : ''}
              ${p.product_type ? `<span class="admin-cb-chip">${esc(productTypeLabel(p.product_type))}</span>` : ''}
            </span>
          </button>`).join('')}</div>`
      : emptyState('Nothing live under this code',
          `${_codeEntry.code} has no products visible on /shop right now.`)}
  `;

  host.querySelector('#cb-add-here')?.addEventListener('click', () => addProductHere(_codeEntry.code));

  host.querySelectorAll('[data-cb-product]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.cbProduct;
      if (!id) return;
      try {
        const full = await AdminAPI.getProduct(id);
        if (full) _hooks.onOpenProduct?.(full);
        else Toast.error('That product could not be loaded.');
      } catch (e) {
        Toast.error(e?.message || 'That product could not be loaded.');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The hand-off into the create form
// ---------------------------------------------------------------------------

/**
 * Open the create modal pre-filled with where the operator is standing.
 *
 * `code` is null when adding from the code LIST rather than from inside one
 * code — the product still gets its brand and category, and its code comes from
 * whatever SKU is typed. That is the honest shape: we know two of the three.
 */
function addProductHere(code) {
  if (!_hooks.onAddProduct) {
    Toast.error('The product editor is not available from here.');
    return;
  }
  _hooks.onAddProduct({
    brandId: _brand?.id || null,
    brandSlug: _brand?.slug || '',
    brandName: _brand?.name || '',
    category: _category,
    code: code || '',
    isRibbonBrand: _brand?.kind === 'ribbon',
  });
}

// ---------------------------------------------------------------------------

export default {
  title: 'Browse',

  /**
   * @param {HTMLElement} container
   * @param {{onAddProduct?:Function, onOpenProduct?:Function}} hooks
   *   Passed in by pages/products.js rather than imported, so this module never
   *   imports back into the module that loads it. A cycle between the two would
   *   resolve one of them to a half-initialised namespace, which fails at call
   *   time and only for whichever side happened to load second.
   */
  async init(container, hooks = {}) {
    _container = container;
    _hooks = hooks || {};
    resetState();
    render();
  },

  destroy() {
    _container = null;
    _hooks = {};
    _loadToken++;
    resetState();
  },
};
