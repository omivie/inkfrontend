/**
 * Genuine-no-color-tile invariant
 * ================================
 *
 * Pins the rule that genuine products without an `image_url` must fall
 * through to the neutral placeholder — never a colored / striped tile.
 *
 * Why this matters (May 2026 catalog overhaul):
 *
 *   The backend imported 167 new genuine packs (HP, Lexmark, OKI, Canon)
 *   that ship with `image_url=NULL` until the composite-image generator
 *   catches up to all four constituent singles. A KCMY genuine pack with
 *   `color="KCMY"` and no image — if rendered through ProductColors blindly
 *   — would paint a black/cyan/magenta/yellow striped gradient tile, which
 *   is the visual language of compatibles. Customers would think they were
 *   looking at a third-party item.
 *
 *   The fix: every product-image render path gates the color tile on
 *   "is this product compatible?". For genuine: skip the tile, show the
 *   placeholder SVG.
 *
 * Surfaces covered:
 *
 *   - products.js                  (product card: shop, search dropdown grid, related)
 *   - product-detail-page.js       (PDP main image)
 *   - cart.js                      (cart line item)
 *   - favourites.js                (wishlist row)
 *   - checkout-page.js             (compact checkout summary)
 *   - order-confirmation-page.js   (post-order receipt)
 *   - order-detail-page.js         (account order history detail)
 *
 * Each surface is asserted twice:
 *
 *   1. STATIC — the source code reads `source === 'compatible'`,
 *      `_isCompatible(...)`, or `info.isCompatible` before the color tile
 *      branch, and the tile is conditional on that.
 *
 *   2. RUNTIME — products.js Products.renderCard is loaded into a vm and
 *      called with a genuine pack having image_url=null, color="KCMY". The
 *      output must contain the placeholder SVG and NOT a
 *      `product-card__color-block` element. The complementary case (a
 *      compatible pack, same shape) MUST contain the color block — to
 *      catch a future "delete the gate" overcorrection.
 *
 * Run with: node --test tests/genuine-no-color-tile.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (rel) => fs.readFileSync(JS(rel), 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const PRODUCTS_SRC      = stripComments(READ('products.js'));
const CART_SRC          = stripComments(READ('cart.js'));
const FAVOURITES_SRC    = stripComments(READ('favourites.js'));
const CHECKOUT_SRC      = stripComments(READ('checkout-page.js'));
const PDP_SRC           = stripComments(READ('product-detail-page.js'));
const CONFIRMATION_SRC  = stripComments(READ('order-confirmation-page.js'));
const ORDER_DETAIL_SRC  = stripComments(READ('order-detail-page.js'));

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: each surface reads brand-source before any color-tile branch
// ─────────────────────────────────────────────────────────────────────────────

test('products.js — genuine card with no image renders placeholder, not color tile', () => {
    // The card-image branch must gate the color-block fallback on
    // `source === 'compatible'`. Two specific patterns we want to keep:
    //   (a) `colorStyle && product.source === 'compatible'`
    //       — compatible-with-color path. The presence of the
    //         `=== 'compatible'` clause is the gate.
    //   (b) `product.source === 'compatible'` (no-color compatible default).
    // And finally a `<img src="/assets/images/placeholder-product.svg"`
    // for the genuine fallback.
    const m = PRODUCTS_SRC.match(/getProductImageHTML\s*\(product[^)]*\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(m, 'products.js must define getProductImageHTML');
    const body = m[1];
    assert.match(body, /colorStyle\s*&&\s*product\.source\s*===\s*['"]compatible['"]/,
        'compatible-with-color tile must be gated on product.source === "compatible"');
    assert.match(body, /product\.source\s*===\s*['"]compatible['"]/,
        'compatible-no-color fallback must be gated on product.source === "compatible"');
    assert.match(body, /placeholder-product\.svg/,
        'genuine fallback must render the placeholder SVG');
});

test('product-detail-page.js — genuine PDP with no image renders placeholder, not color tile', () => {
    // Locate the no-image branch (the `else { ... }` after `if (info.image_url)`).
    // We anchor on the productImageEl id since that's stable across edits.
    const m = PDP_SRC.match(/const\s+productImageEl\s*=\s*document\.getElementById\(\s*['"]product-image['"]\s*\);[\s\S]*?renderCompatiblePrinters/);
    assert.ok(m, 'PDP image-render block (productImageEl … renderCompatiblePrinters) must exist');
    const body = m[0];
    // Both color-block branches in the no-image case must reference info.isCompatible.
    const colorBlockBranches = body.match(/product-gallery__color-block/g) || [];
    assert.ok(colorBlockBranches.length >= 2,
        `expected at least 2 color-block render sites (with/without colorStyle); got ${colorBlockBranches.length}`);
    // The colored-tile branch must require info.isCompatible AND a color style.
    assert.match(body, /info\.isCompatible\s*&&\s*colorStyle/,
        'PDP no-image colored-tile branch must require info.isCompatible AND colorStyle');
    assert.match(body, /placeholder-product\.svg/,
        'PDP genuine fallback must render the placeholder SVG');
});

test('cart.js — getItemImageHTML gates color tile on Cart._isCompatible', () => {
    const m = CART_SRC.match(/getItemImageHTML:\s*function\s*\(item\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(m, 'cart.js must define getItemImageHTML');
    const body = m[1];
    assert.match(body, /this\._isCompatible\s*\(\s*item\s*\)/,
        'cart getItemImageHTML must call this._isCompatible(item)');
    // The colorStyle local must be falsy when the item is genuine.
    assert.match(body, /isCompatibleItem\s*\?\s*rawColorStyle\s*:\s*null/,
        'cart getItemImageHTML must null out colorStyle when item is genuine');
    assert.match(body, /placeholder-product\.svg/,
        'cart genuine fallback must render the placeholder SVG');
});

test('cart.js — _parseServerCart preserves product_source (so server-loaded carts still gate correctly)', () => {
    const m = CART_SRC.match(/_parseServerCart:\s*function\s*\(responseData\)\s*\{([\s\S]*?)return\s*\{\s*items/);
    assert.ok(m, 'cart.js must define _parseServerCart');
    const body = m[1];
    assert.match(body, /product_source:\s*item\.product\.source/,
        '_parseServerCart must copy item.product.source onto the parsed row as product_source');
});

test('favourites.js — _isCompatible exists and getItemImageHTML gates the color tile through it', () => {
    // Helper exists.
    const helperMatch = FAVOURITES_SRC.match(/_isCompatible\s*\(item\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(helperMatch, 'favourites.js must define _isCompatible');
    const helperBody = helperMatch[1];
    assert.match(helperBody, /product_source\s*===\s*['"]compatible['"]/,
        'favourites._isCompatible must check product_source first');
    assert.match(helperBody, /\/\^compatible\\b\/i/,
        'favourites._isCompatible legacy fallback must be anchored to leading-word /^compatible\\b/i');

    // Image render uses the helper.
    const renderMatch = FAVOURITES_SRC.match(/getItemImageHTML\(item\)\s*\{([\s\S]*?)\n\s{4}\},/);
    assert.ok(renderMatch, 'favourites.js must define getItemImageHTML');
    const renderBody = renderMatch[1];
    assert.match(renderBody, /this\._isCompatible\s*\(\s*item\s*\)/,
        'favourites.getItemImageHTML must call this._isCompatible(item)');
    assert.match(renderBody, /isCompatibleItem\s*\?\s*rawColorStyle\s*:\s*null/,
        'favourites.getItemImageHTML must null out colorStyle when item is genuine');
});

test('favourites.js — loadFromServer preserves product_source from server response', () => {
    // The mapping must populate product_source from fav.product.source so
    // _isCompatible can read it back on the next render pass.
    const m = FAVOURITES_SRC.match(/this\.items\s*=\s*favourites\.map\s*\(fav\s*=>\s*\(\{([\s\S]*?)\}\)\);/);
    assert.ok(m, 'favourites.loadFromServer must populate this.items via favourites.map');
    const body = m[1];
    assert.match(body, /product_source:\s*fav\.product\?\.source/,
        'loadFromServer must copy fav.product.source onto each parsed row as product_source');
});

test('checkout-page.js — getItemImageHTML gates color tile via Cart._isCompatible', () => {
    const m = CHECKOUT_SRC.match(/getItemImageHTML\(item\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'checkout-page.js must define getItemImageHTML');
    const body = m[1];
    assert.match(body, /Cart\._isCompatible/,
        'checkout getItemImageHTML must consult Cart._isCompatible');
    assert.match(body, /isCompatibleItem\s*\?\s*rawColorStyle\s*:\s*null/,
        'checkout getItemImageHTML must null out colorStyle when item is genuine');
});

test('order-confirmation-page.js — getItemImageHtml gates color tile on item.source', () => {
    const m = CONFIRMATION_SRC.match(/getItemImageHtml\(item\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'order-confirmation-page.js must define getItemImageHtml');
    const body = m[1];
    assert.match(body, /item\.source\s*===\s*['"]compatible['"]/,
        'confirmation getItemImageHtml must read item.source === "compatible"');
    assert.match(body, /isCompatibleItem\s*\?\s*rawColorStyle\s*:\s*null/,
        'confirmation getItemImageHtml must null out colorStyle when item is genuine');
});

test('order-detail-page.js — getColorPlaceholder takes source and short-circuits to neutral SVG for genuine', () => {
    // Aug 2026 (ERR-141): gained a third `color` arg when the private 7-word
    // name-scan map was replaced by ProductColors.getProductStyle. The
    // short-circuit below is what the invariant actually rests on, and it still
    // runs FIRST — the colour argument is only ever consulted for compatibles.
    const m = ORDER_DETAIL_SRC.match(/getColorPlaceholder\(productName,\s*source,\s*color\)\s*\{([\s\S]*?)\n\s{8}\},/);
    assert.ok(m, 'order-detail-page.js must define getColorPlaceholder(productName, source, color)');
    const body = m[1];
    // For non-compatible (i.e. genuine) the function must short-circuit to the
    // neutral cartridge SVG before any color-derivation branches run.
    assert.match(body, /source\s*&&\s*source\s*!==\s*['"]compatible['"]/,
        'getColorPlaceholder must short-circuit to neutral SVG when source is set and not "compatible"');
    // The genuine gate must precede every colour-derivation branch.
    assert.ok(body.indexOf('!== \'compatible\'') < body.indexOf('getProductStyle'),
        'the genuine short-circuit must run BEFORE any ProductColors lookup');
    // The caller must pass item.source through.
    assert.match(ORDER_DETAIL_SRC, /this\.getColorPlaceholder\(item\.product_name,\s*item\.source,/,
        'order-item render must pass item.source to getColorPlaceholder');
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME: load products.js, exercise renderCard with genuine + compatible
// packs that both have image_url=null and color="KCMY". Genuine must show
// the placeholder, compatible must show the color block.
// ─────────────────────────────────────────────────────────────────────────────

function loadProducts() {
    // Stub the bare minimum that products.js touches at module load time and
    // during renderCard. We don't need a real DOM — renderCard returns an
    // HTML string.
    const sandbox = {
        console,
        URL, URLSearchParams, encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array, String, Number, Boolean, Symbol, RegExp,
        // Module deps used by renderCard:
        Security: {
            escapeHtml: (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
            escapeAttr: (s) => String(s == null ? '' : s)
                .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
                .replace(/</g, '&lt;').replace(/>/g, '&gt;'),
            sanitizeUrl: (u) => u,
        },
        ProductColors: {
            // Use the real map shape so getProductStyle returns a non-null
            // gradient for KCMY.
            getStyle(name) {
                const map = {
                    black: 'background-color: #1a1a1a;',
                    kcmy: 'background: linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%);',
                    // Aug 2026 (ERR-143): the stub MUST be able to paint
                    // tri-colour, or the G804CLR test below would pass because
                    // the stub had no entry rather than because the genuine
                    // gate fired — a green test proving nothing.
                    'tri-colour': 'background: linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%);',
                };
                return map[(name || '').toLowerCase()] || null;
            },
            getProductStyle(obj) {
                const c = (obj && obj.color || '').toLowerCase();
                return this.getStyle(c);
            },
            detectFromName(name) {
                const n = (name || '').toLowerCase();
                if (n.includes('kcmy')) return 'kcmy';
                if (n.includes('black')) return 'black';
                return null;
            },
            isPlaceholderSwatchImage(url) {
                return !!url && /\/color-swatch(?:-v\d+)?\.png$/i.test(url);
            },
        },
        getStockStatus: () => ({ class: 'in-stock', text: 'In stock' }),
        getSourceBadge: (s) => s === 'compatible'
            ? { class: 'compatible', text: 'COMPATIBLE' }
            : { class: 'genuine', text: 'GENUINE' },
        qualifiesForFreeShipping: () => false,
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        calculateGST: (n) => Number(n || 0) * 0.15 / 1.15,
        storageUrl: (u) => u,
        imageSrcset: () => '',
        DebugLog: { log() {}, warn() {}, error() {} },
        // products.js calls window.Products = Products at the end.
        window: {},
        document: { addEventListener() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(JS('products.js'), 'utf8'), ctx, { filename: 'products.js' });
    return sandbox.Products;
}

const GENUINE_PACK = {
    id: 'gen-1',
    sku: 'G-HP-CF410X-TNR-KCMY-4PK',
    name: 'HP Genuine 410X Toner Cartridge KCMY 4-Pack',
    brand: { name: 'HP' },
    color: 'KCMY',
    color_hex: null,
    image_url: null,                 // ← the case under test
    retail_price: 899.99,
    in_stock: true,
    stock_quantity: 5,
    source: 'genuine',
    pack_type: 'value_pack',
    canonical_url: 'https://www.inkcartridges.co.nz/products/hp-genuine-410x-toner-cartridge-kcmy-4-pack/G-HP-CF410X-TNR-KCMY-4PK',
};

const COMPATIBLE_PACK = {
    id: 'comp-1',
    sku: 'C-HP-CF410X-TNR-KCMY-4PK',
    name: 'Compatible Toner Cartridge Replacement for HP 410X KCMY 4-Pack',
    brand: { name: 'HP' },
    color: 'KCMY',
    color_hex: null,
    image_url: null,                 // also null — but should still get the tile
    retail_price: 199.99,
    in_stock: true,
    stock_quantity: 50,
    source: 'compatible',
    pack_type: 'value_pack',
    canonical_url: 'https://www.inkcartridges.co.nz/products/compatible-toner-cartridge-replacement-for-hp-410x-kcmy-4-pack/C-HP-CF410X-TNR-KCMY-4PK',
};

test('runtime: genuine pack with image_url=NULL renders placeholder, NOT a color block', () => {
    const Products = loadProducts();
    const html = Products.renderCard(GENUINE_PACK, 0);
    // Genuine should show the placeholder image …
    assert.match(html, /\/assets\/images\/placeholder-product\.svg/,
        'genuine pack with image_url=null must render the placeholder SVG');
    // … and must NOT render a colored tile div.
    assert.doesNotMatch(html, /class="product-card__color-block"/,
        'genuine pack with image_url=null must NOT render a product-card__color-block');
    // Per source-chip-removal-may2026.md the per-card source chip is
    // retired — section heading + product name already declare source.
    assert.doesNotMatch(html, /product-card__badge--genuine/,
        'per-card GENUINE chip must NOT render (retired May 2026)');
});

test('runtime: compatible pack with image_url=NULL renders the color block (regression guard)', () => {
    const Products = loadProducts();
    const html = Products.renderCard(COMPATIBLE_PACK, 0);
    assert.match(html, /class="product-card__color-block"/,
        'compatible pack with image_url=null MUST render the color block — the gate must not over-correct');
    // It must NOT also render the placeholder (one tile per card).
    assert.doesNotMatch(html, /placeholder-product\.svg/,
        'compatible color-block path must not also render the placeholder');
    assert.doesNotMatch(html, /product-card__badge--compatible/,
        'per-card COMPATIBLE chip must NOT render (retired May 2026)');
});

test('runtime: genuine single (color="Black", image_url=null) also gets placeholder, not black tile', () => {
    const Products = loadProducts();
    const genuineSingle = {
        ...GENUINE_PACK,
        sku: 'G-HP-CF410X-TNR-BK',
        name: 'HP Genuine 410X Toner Cartridge Black',
        color: 'Black',
        pack_type: 'single',
    };
    const html = Products.renderCard(genuineSingle, 0);
    assert.match(html, /placeholder-product\.svg/,
        'genuine single with no image must render the placeholder, not a Black-color tile');
    assert.doesNotMatch(html, /class="product-card__color-block"/,
        'genuine single must NOT render a Black-color tile when image_url is null');
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPATIBLE NAME FORMAT (May 2026) — title + slug shape
// ─────────────────────────────────────────────────────────────────────────────

test('runtime: genuine Tri-Colour single with image_url=NULL (G804CLR) gets the placeholder, NOT a CMY tile', () => {
    // ERR-143 — the citable answer to the Aug 2026 tri-colour handoff, which
    // asked us to "verify the tri-colour swatch renders for all 6 SKUs …
    // driven off color === 'Tri-Colour'". All six are GENUINE, and a genuine
    // row must never paint a colour tile: a CMY 3-stripe is the visual
    // language of a COMPATIBLE cartridge, so painting one on a genuine
    // product misrepresents the brand the customer is buying.
    //
    // G804CLR is the live case — a genuine HP 804 Tri-Colour single shipped
    // with image_url = NULL. The correct render is the neutral placeholder.
    // If this test ever fails because someone "fixed" the swatch, they have
    // reintroduced the bug this invariant exists to prevent.
    const Products = loadProducts();
    const g804clr = {
        ...GENUINE_PACK,
        sku: 'G804CLR',
        name: 'HP Genuine 804CLR Ink Cartridge 804 Tri-Colour (165 pages)',
        color: 'Tri-Colour',
        pack_type: 'single',
        image_url: null,
    };
    const html = Products.renderCard(g804clr, 0);

    // Prove the stub COULD have painted it — so the assertion below is
    // evidence of the gate firing, not of a missing map entry.
    const compatibleTwin = Products.renderCard({ ...g804clr, source: 'compatible' }, 0);
    assert.match(compatibleTwin, /class="product-card__color-block"/,
        'a COMPATIBLE tri-colour single with no image must still get the tile — the gate must not over-correct');

    assert.match(html, /placeholder-product\.svg/,
        'genuine Tri-Colour single with no image must render the neutral placeholder');
    assert.doesNotMatch(html, /class="product-card__color-block"/,
        'genuine Tri-Colour single must NOT render a CMY 3-stripe tile');
});

test('runtime: new compatible pack name lands intact in the card title attr (no truncation in HTML)', () => {
    const Products = loadProducts();
    const longName = 'Compatible Ink Cartridge Replacement for Brother LC37/LC57 KCMY 4-Pack';
    const card = Products.renderCard({ ...COMPATIBLE_PACK, name: longName }, 0);
    // The full name must appear in both the title attr (tooltip) and the
    // visible <h3> text. CSS line-clamp is a *visual* truncation; the DOM
    // still carries the whole string for screen readers and copy/paste.
    assert.match(card, /title="Compatible Ink Cartridge Replacement for Brother LC37\/LC57 KCMY 4-Pack"/,
        'card title attr must contain the full new-format compatible name');
    assert.match(card, /<h3[^>]*>Compatible Ink Cartridge Replacement for Brother LC37\/LC57 KCMY 4-Pack<\/h3>/,
        'card <h3> text must contain the full new-format compatible name');
});

test('runtime: card href prefers product.canonical_url path (so old-slug bookmarks land on the new slug)', () => {
    const Products = loadProducts();
    // Same SKU, but the URL we'd serve points to the May-2026 slug.
    const html = Products.renderCard(COMPATIBLE_PACK, 0);
    assert.match(html, /href="\/products\/compatible-toner-cartridge-replacement-for-hp-410x-kcmy-4-pack\/C-HP-CF410X-TNR-KCMY-4PK"/,
        'card href must use the canonical_url path (new slug + sku) so card clicks always land on the canonical URL');
});

// ─────────────────────────────────────────────────────────────────────────────
// Aug 2026 (ERR-143) — THE IMAGE-ERROR PATH
//
// Every test above covers `image_url: null`. None covered "the product HAS an
// image and the image fails to load" — and that was where the invariant
// leaked. All three card renderers emitted
//
//     <img data-fallback="color-block"><div class="product-card__color-block"
//          style="<gradient>; display: none;">
//
// gated on `colorStyle` alone, never on source. bindImageFallbacks() reveals
// that hidden div on the img's error event, so any GENUINE product whose image
// 404'd swapped itself for a striped tile — the visual language of a
// COMPATIBLE cartridge. The optimizer proxy (api.inkcartridges.co.nz/api/
// images/optimize) 429s under load, so this is a live path, not a theoretical
// one. Genuine rows must fall back to the neutral placeholder instead.
// ─────────────────────────────────────────────────────────────────────────────

test('runtime: GENUINE product WITH an image must not carry a hidden colour-block fallback', () => {
    const Products = loadProducts();
    const withImage = {
        ...GENUINE_PACK,
        color: 'Tri-Colour',
        pack_type: 'single',
        image_url: 'https://example.test/images/g804clr/product.webp',
    };
    const html = Products.renderCard(withImage, 0);
    assert.match(html, /data-fallback="placeholder"/,
        'a genuine image must fall back to the neutral placeholder');
    assert.doesNotMatch(html, /data-fallback="color-block"/,
        'a genuine image must NEVER fall back to a colour block');
    assert.doesNotMatch(html, /class="product-card__color-block"/,
        'no hidden striped tile may be emitted for a genuine product, even display:none');
});

test('runtime: COMPATIBLE product WITH an image keeps its colour-block fallback', () => {
    const Products = loadProducts();
    const withImage = {
        ...COMPATIBLE_PACK,
        image_url: 'https://example.test/images/c804xlclr/product.webp',
    };
    const html = Products.renderCard(withImage, 0);
    assert.match(html, /data-fallback="color-block"/,
        'compatibles keep the colour fallback — the gate must not over-correct');
    assert.match(html, /class="product-card__color-block"[^>]*display: none/,
        'and the hidden block must still be emitted for them');
});

test('all three card renderers gate the colour-block fallback on source', () => {
    // products.js, shop-page.js and product-detail-page.js each build their own
    // image markup. A fix applied to one and not the others leaves the hole open.
    const PRODUCTS = PRODUCTS_SRC;
    const SHOP = stripComments(READ('shop-page.js'));
    const PDP = PDP_SRC;
    assert.match(PRODUCTS, /if \(colorStyle && product\.source === 'compatible'\)/,
        'products.js must gate the colour-block fallback on source');
    assert.match(SHOP, /if \(colorStyle && isCompatible\)/,
        'shop-page.js must gate the colour-block fallback on source');
    assert.match(PDP, /if \(colorStyle && info\.isCompatible\)/,
        'product-detail-page.js must gate the colour-block fallback on source');
});
