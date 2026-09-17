/**
 * Image Audit — the card must describe the image it actually has (ERR-265)
 * ========================================================================
 *
 * GBP71GA3 ("Brother Genuine BP71GA3 Glossy Paper") showed a grey "No image"
 * tile under a red WRONG PRODUCT badge, while the detail drawer's LEGACY pane
 * held a perfectly correct picture of the product. Three faults stacked:
 *
 *   1. renderCard read ONE field, `image_url_resolved`. The archived original in
 *      `legacy_image_url_resolved` is read by nothing else in the repo and is
 *      invisible to customers (the storefront renders `products.image_url`), so
 *      a quarantined row looked empty even though a good image was on file.
 *
 *   2. renderVerdictBadge() sat OUTSIDE the `missing ? placeholder : img`
 *      ternary, so a verdict kept accusing a card of an image that had already
 *      been cleared. Nothing resets `image_vision_verdict` on quarantine, so the
 *      badge outlives its subject indefinitely — here by ~4.5 months.
 *
 *   3. The thumbnail's only action was `open-drawer`; clicking a picture
 *      navigated instead of showing you the picture.
 *
 * The lesson worth pinning: A VERDICT IS ABOUT A FILE. When the file goes, the
 * verdict is not "still true" — it is unanchored, and rendering it as though it
 * described the current state is a lie the UI tells confidently.
 *
 * These are behaviour tests: the shipped module body is evaluated in a vm and
 * the real renderCard/openProductDrawer output is asserted against. A source
 * grep would pin the text that happens to be there, not the behaviour meant.
 *
 * Red-proofing: point GIA_SRC at a pre-change copy and re-run.
 *   git show HEAD:inkcartridges/js/admin/pages/genuine-image-audit.js > /tmp/old.js
 *   GIA_SRC=/tmp/old.js node --test tests/image-audit-card-surface-sep2026.test.js
 *
 * Measured against the pre-change file (2026-09-17): 11 of 15 fail, which is the
 * proof that they are load-bearing. The other FOUR pass on both sides ON PURPOSE
 * and are marked [CONTROL] below — they pin behaviour this change must NOT break
 * (the bare placeholder, a live row's real verdict, no warning on a healthy row,
 * the unmapped-token fallback). A control that goes red is a regression; a
 * control that is deleted because "it can't fail" removes the only evidence that
 * the new conditionals are actually conditional.
 *
 * Run with: node --test tests/image-audit-card-surface-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = process.env.GIA_SRC
  || path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'genuine-image-audit.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/**
 * Evaluate the page module as a classic script.
 *
 * The file is an ES module whose only imports are the admin shell helpers, so
 * stripping the import statement and supplying those names as globals runs the
 * real rendering code unchanged. Top-level `function` declarations land in the
 * context's global lexical scope rather than on the sandbox object, so the
 * ones under test are bridged out explicitly.
 */
function loadModule({ drawerSink } = {}) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const sandbox = {
    // ---- stubs for the '../app.js' imports ----
    AdminAuth: {},
    FilterState: { get: () => ({}), set() {} },
    AdminAPI: {},
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    esc,
    Toast: { success() {}, error() {}, info() {} },
    Modal: { confirm() {} },
    Drawer: {
      open(opts) {
        if (drawerSink) Object.assign(drawerSink, opts);
        const mk = () => ({ addEventListener() {} });
        return { body: mk(), footer: mk(), close() {} };
      },
    },
    // ---- ambient browser/global surface the module touches at call time ----
    document: {
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, set innerHTML(_v) {} }),
      addEventListener() {},
      body: { appendChild() {} },
    },
    window: {},
    CSS: { escape: (s) => String(s) },
    console: { warn() {}, error() {}, log() {} },
    setTimeout: (fn) => fn,
    Date, Number, Math, Object, Array, String, JSON, Boolean, Error, Promise,
    Set, Map, URLSearchParams, encodeURIComponent, isNaN, parseInt, parseFloat,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // `export default { … }` must become an assignment, not a bare block, or the
  // object literal parses as a statement block and the file will not compile.
  const body = SRC
    .replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s*\{[\s\S]*?\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/m, 'globalThis.__default = ')
    .replace(/^\s*export\s+/gm, '');

  const bridge = `
    globalThis.__renderCard = typeof renderCard === 'function' ? renderCard : null;
    globalThis.__humanReason = typeof humanReason === 'function' ? humanReason : null;
    globalThis.__imageState = typeof imageState === 'function' ? imageState : null;
    globalThis.__openProductDrawer = typeof openProductDrawer === 'function' ? openProductDrawer : null;
  `;
  vm.runInContext(body + bridge, sandbox);

  return {
    renderCard: sandbox.__renderCard,
    humanReason: sandbox.__humanReason,
    imageState: sandbox.__imageState,
    openProductDrawer: sandbox.__openProductDrawer,
  };
}

/** The real GBP71GA3 shape: verdict recorded, live image gone, archive intact. */
const QUARANTINED = {
  id: 'p-gbp71ga3',
  sku: 'GBP71GA3',
  name: 'Brother Genuine BP71GA3 Glossy Paper (20 pages)',
  brand: 'Brother',
  image_url_resolved: null,
  legacy_image_url_resolved: 'https://cdn.example/legacy/bp71ga3.jpg',
  image_vision_verdict: 'wrong_product',
  image_vision_reasons: ['vision_wrong_product'],
  image_vision_score: 0.9,
  image_vision_checked_at: '2026-05-02T00:00:00Z',
  image_audit_status: 'pending',
  units_sold: 0,
  pack_type: 'single',
};

const HEALTHY = {
  ...QUARANTINED,
  id: 'p-gbp71ga4',
  sku: 'GBP71GA4',
  image_url_resolved: 'https://cdn.example/live/bp71ga4.jpg',
  legacy_image_url_resolved: null,
  image_vision_verdict: 'verified_product',
  image_vision_reasons: ['vision_retail_box'],
  image_audit_status: 'checked_clean',
};

const BARE = {
  ...QUARANTINED,
  id: 'p-bare',
  sku: 'GBU800CL',
  image_url_resolved: null,
  legacy_image_url_resolved: null,
  image_vision_verdict: 'unverifiable',
  image_vision_reasons: ['no_image_url'],
};

/* ── The archived image is shown, and shown AS archived ─────────────────── */

test('a quarantined row renders its archived image instead of an empty tile', () => {
  const { renderCard } = loadModule();
  const html = renderCard(QUARANTINED);

  assert.match(html, /<img[^>]+src="https:\/\/cdn\.example\/legacy\/bp71ga3\.jpg"/,
    'the archived image should be rendered — it is the only copy that exists');
  assert.doesNotMatch(html, />No image</,
    'the bare "No image" placeholder must not be used when an archive exists');
});

test('the archived image is tagged LEGACY and the card still reads as missing', () => {
  const { renderCard } = loadModule();
  const html = renderCard(QUARANTINED);

  assert.match(html, /gia-card__legacy-tag[^>]*>LEGACY</,
    'showing the archive without labelling it would imply the product has an image');
  assert.match(html, /class="gia-card[^"]*gia-card--missing/,
    'gia-card--missing must survive: the product still has NO live image, and the '
    + '"Missing image only" filter and the operator both depend on that signal');
  assert.match(html, /gia-card__img--legacy/,
    'the archived image should be visually distinguished from a live one');
});

test('[CONTROL] a product with no image at all keeps the placeholder', () => {
  const { renderCard } = loadModule();
  const html = renderCard(BARE);

  assert.match(html, />No image</);
  assert.doesNotMatch(html, /gia-card__legacy-tag/);
});

/* ── A verdict must not outlive the file it judged ──────────────────────── */

test('the stale verdict is NOT rendered on a card whose image is gone', () => {
  const { renderCard } = loadModule();
  const html = renderCard(QUARANTINED);

  assert.doesNotMatch(html, /Wrong product/i,
    'the wrong_product verdict describes a file that was cleared months ago; '
    + 'rendering it accuses the row of an image it no longer has');
  assert.match(html, /gia-verdict--neutral[^>]*>Image removed</,
    'say what is actually true about the tile instead');
});

test('[CONTROL] a live image still gets its real verdict', () => {
  const { renderCard } = loadModule();
  const html = renderCard(HEALTHY);

  assert.match(html, /Verified product/,
    'suppression must be scoped to imageless rows — this is not a blanket removal');
  assert.doesNotMatch(html, /Image removed/);
  assert.match(html, /gia-status--clean[^>]*>CLEAN</,
    'the human-signoff axis is independent of the verdict and must be unaffected');
});

/* ── Clicking a picture shows the picture ───────────────────────────────── */

test('the thumbnail zooms; it no longer opens the drawer', () => {
  const { renderCard } = loadModule();
  const html = renderCard(QUARANTINED);
  const thumb = html.match(/<div class="gia-card__thumb[^>]*>/)[0];

  assert.match(thumb, /data-action="zoom"/,
    'clicking an image should expand it in place');
  assert.doesNotMatch(thumb, /data-action="open-drawer"/,
    'navigating away was the old behaviour being replaced');
});

test('opening the detail is a separate, explicit button', () => {
  const { renderCard } = loadModule();
  const actions = renderCard(QUARANTINED).match(/<div class="gia-card__actions">[\s\S]*?<\/div>/)[0];

  assert.match(actions, /data-action="open-drawer"[^>]*title="Open details"/,
    'the drawer needs its own control now that the thumbnail is a zoom target');
});

test('an empty tile offers no zoom affordance', () => {
  const { renderCard } = loadModule();
  const thumb = renderCard(BARE).match(/<div class="gia-card__thumb[^>]*>/)[0];

  assert.doesNotMatch(thumb, /data-action="zoom"/,
    'a dead click target on a placeholder is a lie about what is clickable');
  assert.match(thumb, /gia-card__thumb--empty/);
});

/* ── Restore is offered exactly where it applies ────────────────────────── */

test('restore is offered only when an archive exists and no live image does', () => {
  const { renderCard } = loadModule();

  assert.match(renderCard(QUARANTINED), /data-action="restore-legacy"/,
    'this row is precisely the recoverable case');
  assert.doesNotMatch(renderCard(HEALTHY), /data-action="restore-legacy"/,
    'nothing to restore over a live image');
  assert.doesNotMatch(renderCard(BARE), /data-action="restore-legacy"/,
    'nothing to restore from');
});

/* ── absent / null / empty are three different answers ──────────────────── */

test('the drawer reports absent, null and empty image fields distinctly', () => {
  const sink = {};
  const { openProductDrawer } = loadModule({ drawerSink: sink });

  // image_url is ABSENT from the payload; image_url_resolved is null;
  // legacy_image_url is an empty string. Three different facts.
  openProductDrawer({
    ...QUARANTINED,
    image_url_resolved: null,
    legacy_image_url: '',
  });

  assert.match(sink.body, /Image fields/,
    'a blank pane has two causes and the operator cannot currently tell them apart');
  assert.match(sink.body, /gia-field--absent[^>]*>\(absent from payload\)</,
    'a key the backend never sent is not the same as one it sent as null');
  assert.match(sink.body, /gia-field--null[^>]*>null</);
  assert.match(sink.body, /gia-field--null[^>]*>\(empty string\)</);
});

test('the drawer says plainly that the verdict no longer describes anything', () => {
  const sink = {};
  const { openProductDrawer } = loadModule({ drawerSink: sink });
  openProductDrawer(QUARANTINED);

  assert.match(sink.body, /no longer on the product/,
    'the verdict is still worth showing in context — but not as current fact');
  assert.match(sink.body, /not<\/strong> on the storefront/,
    'the operator must know customers are seeing a placeholder right now');
});

test('[CONTROL] a healthy row gets no staleness warning', () => {
  const sink = {};
  const { openProductDrawer } = loadModule({ drawerSink: sink });
  openProductDrawer(HEALTHY);

  assert.doesNotMatch(sink.body, /no longer on the product/,
    'the notice must be conditional, or it is noise that trains people to ignore it');
});

/* ── Reason tokens ──────────────────────────────────────────────────────── */

test('the two tokens that reached the UI title-cased now read as prose', () => {
  const { humanReason } = loadModule();

  assert.equal(humanReason('filename_no_model_tokens'), 'Filename does not mention the model');
  assert.equal(humanReason('no_image_url'), 'No image on the product');
});

test('[CONTROL] unmapped tokens still fall through rather than disappearing', () => {
  const { humanReason } = loadModule();
  assert.equal(humanReason('some_future_token'), 'Some Future Token',
    'the fallback is what let the two tokens above surface at all — keep it');
});

/* ── The shared helper ──────────────────────────────────────────────────── */

test('imageState never reports a live image on the strength of an archive', () => {
  const { imageState } = loadModule();

  const q = imageState(QUARANTINED);
  assert.equal(q.hasLive, false, 'the storefront reads image_url only');
  assert.equal(q.isLegacy, true);
  assert.equal(q.url, 'https://cdn.example/legacy/bp71ga3.jpg');

  const h = imageState(HEALTHY);
  assert.equal(h.hasLive, true);
  assert.equal(h.isLegacy, false);

  const b = imageState(BARE);
  assert.equal(b.hasAny, false);
  assert.equal(b.url, '');
});
