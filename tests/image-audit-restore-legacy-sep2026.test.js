/**
 * Image Audit — restoring an archived image, now that the endpoint is live (ERR-286)
 * ================================================================================
 *
 * The backend shipped `POST /api/admin/image-audit/:id/restore-legacy` on
 * 2026-09-21 — our contract, to the letter — plus `bulk-restore-legacy`,
 * `?recoverable_only=true` and a split on `/stats`. With it came a warning that
 * decides how the page may use it:
 *
 *   `legacy_image_url` holds TWO populations that look identical in SQL: old
 *   quarantine casualties worth restoring, and a deliberate 730-row WATERMARK
 *   hold (2026-09-21 01:57Z) awaiting review by eye. Do NOT blanket-restore.
 *   And 42 of the older rows carry `image_object_missing` / `http_status=400`
 *   — the archived URL is itself dead.
 *
 * Measured 2026-09-25 (`npm run probe:bundle-response`):
 *   - hold rows carry `image_audit_status: 'watermark_hold'`;
 *   - `/list?status=watermark_hold` is a 400 (enum: pending|checked_clean|replaced);
 *   - `recoverable_only=true` = 834 = 104 pending + 730 hold, so "recoverable"
 *     alone INCLUDES the hold; with `status=pending` it is the true 104;
 *   - `/stats.missing_image_breakdown` = { recoverable, never_had_one, watermark_hold }.
 *
 * The owner chose per-row restore only (2026-09-25). So these tests pin:
 *   1. ONE eligibility answer (restoreEligibility) for card, drawer and confirm;
 *   2. a dead archive is never offered; a hold needs an explicit "I checked it";
 *      a live+archived row sends `overwrite_live` and says it replaces;
 *   3. a 409 is "nothing archived any more", not a generic failure;
 *   4. "Recoverable only" excludes the hold;
 *   5. the split is shown, ABSENT is not zero, and there is no bulk restore.
 *
 * Behaviour tests: the shipped module is evaluated in a vm, as in
 * image-audit-card-surface-sep2026.test.js.
 *
 * Red-proofing: GIA_SRC=<pre-change copy> node --test tests/image-audit-restore-legacy-sep2026.test.js
 *
 * Run with: node --test tests/image-audit-restore-legacy-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = process.env.GIA_SRC
  || path.join(ROOT, 'inkcartridges', 'js', 'admin', 'pages', 'genuine-image-audit.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const ADMIN_API = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'admin', 'api.js'), 'utf8');

function loadModule({ restoreImpl } = {}) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const log = { toasts: [], confirms: [], restoreCalls: [] };
  const toast = (kind) => (msg) => log.toasts.push({ kind, msg });
  const sandbox = {
    AdminAuth: {},
    FilterState: { get: () => ({}), set() {} },
    AdminAPI: {
      async restoreLegacyImage(id, opts) {
        log.restoreCalls.push({ id, opts });
        if (restoreImpl) return restoreImpl(id, opts);
        return { image_url_resolved: 'https://x/live.png', legacy_image_url_resolved: '' };
      },
      async getImageAuditStats() { return null; },
      async getImageAuditList() { return null; },
    },
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    esc,
    Toast: { success: toast('success'), error: toast('error'), info: toast('info'), warning: toast('warning') },
    Modal: { confirm(opts) { log.confirms.push(opts); } },
    Drawer: { open() { const mk = () => ({ addEventListener() {} }); return { body: mk(), footer: mk(), close() {} }; } },
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
  const body = SRC
    .replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s*\{[\s\S]*?\};?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/m, 'globalThis.__default = ')
    .replace(/^\s*export\s+/gm, '');
  const bridge = `
    globalThis.__fns = {
      restoreEligibility: typeof restoreEligibility === 'function' ? restoreEligibility : null,
      renderCard: typeof renderCard === 'function' ? renderCard : null,
      humanReason: typeof humanReason === 'function' ? humanReason : null,
      restoreLegacy: typeof restoreLegacy === 'function' ? restoreLegacy : null,
      buildKpis: typeof buildKpis === 'function' ? buildKpis : null,
      buildFilters: typeof buildFilters === 'function' ? buildFilters : null,
      buildToolbar: typeof buildToolbar === 'function' ? buildToolbar : null,
      setStats: (s) => { _stats = s; },
      setState: (o) => { Object.assign(_state, o); },
    };
  `;
  vm.runInContext(body + bridge, sandbox);
  return { ...sandbox.__fns, log };
}

const ARCHIVE = 'https://store/legacy.png';
const RECOVERABLE = { id: 'r1', sku: 'GBP71GP20', legacy_image_url_resolved: ARCHIVE, image_url_resolved: null, image_audit_status: 'pending', image_vision_reasons: null };
const HOLD = { ...RECOVERABLE, id: 'h1', sku: 'GDR2315BK', image_audit_status: 'watermark_hold', image_vision_reasons: ['filename_sku_in_filename', 'vision_error: vision_circuit_open: insufficient_credit'] };
const DEAD = { ...RECOVERABLE, id: 'd1', sku: 'GDEAD', image_vision_reasons: ['image_object_missing', 'http_status=400'] };
const BOTH = { ...RECOVERABLE, id: 'b1', sku: 'GBOTH', image_url_resolved: 'https://store/live.png' };
const LIVE_ONLY = { ...RECOVERABLE, id: 'l1', sku: 'GLIVE', image_url_resolved: 'https://store/live.png', legacy_image_url_resolved: null };

const cardEl = () => ({ classList: { add() {}, remove() {} }, outerHTML: '' });

/* ── 1. One eligibility answer ──────────────────────────────────────────── */

test('restoreEligibility names every kind of row', () => {
  const { restoreEligibility } = loadModule();
  assert.ok(restoreEligibility, 'restoreEligibility() must exist');
  assert.equal(restoreEligibility(RECOVERABLE), 'recoverable');
  assert.equal(restoreEligibility(HOLD), 'watermark_hold');
  assert.equal(restoreEligibility(DEAD), 'dead_archive');
  assert.equal(restoreEligibility(BOTH), 'overwrite');
  assert.equal(restoreEligibility(LIVE_ONLY), 'none');
  // A dead archive wins over the hold: restoring a dead file is wrong either way.
  assert.equal(restoreEligibility({ ...HOLD, image_vision_reasons: ['http_status=404'] }), 'dead_archive');
});

/* ── 2. What the card offers ────────────────────────────────────────────── */

test('a dead archive is shown as dead, never offered as a restore', () => {
  const { renderCard } = loadModule();
  const html = renderCard(DEAD);
  assert.doesNotMatch(html, /data-action="restore-legacy"/,
    'restoring a missing file would put a broken image live on the storefront');
  assert.match(html, /gia-icon-btn--disabled/, 'the operator must see WHY there is no restore');
  // [CONTROL] the ordinary row still offers it.
  assert.match(renderCard(RECOVERABLE), /data-action="restore-legacy"/);
});

test('a watermark-hold row is labelled as such on the card', () => {
  const { renderCard } = loadModule();
  assert.match(renderCard(HOLD), /WATERMARK HOLD/);
  assert.doesNotMatch(renderCard(RECOVERABLE), /WATERMARK HOLD/, '[CONTROL] only the hold says hold');
});

test('the dead-archive tokens read as English, not title-cased snake_case', () => {
  const { humanReason } = loadModule();
  assert.match(humanReason('image_object_missing'), /missing from storage/);
  assert.equal(humanReason('http_status=400'), 'Image URL answered HTTP 400');
});

/* ── 3. The confirm, the body, and the 409 ──────────────────────────────── */

test('a hold row needs an explicit "I checked it" before it goes live', async () => {
  const m = loadModule();
  m.restoreLegacy({ ...HOLD }, cardEl());
  assert.equal(m.log.confirms.length, 1);
  assert.match(m.log.confirms[0].message, /watermark/i);
  assert.match(m.log.confirms[0].confirmLabel, /I checked it/);
  await m.log.confirms[0].onConfirm();
  assert.deepEqual({ ...m.log.restoreCalls[0].opts }, { overwriteLive: false });
});

test('a live+archived row sends overwrite_live and says it REPLACES', async () => {
  const m = loadModule();
  m.restoreLegacy({ ...BOTH }, cardEl());
  assert.match(m.log.confirms[0].title, /Replace the live image/);
  await m.log.confirms[0].onConfirm();
  assert.deepEqual({ ...m.log.restoreCalls[0].opts }, { overwriteLive: true },
    'the backend refuses this row without overwrite_live — and it must be asked for, never implied');
  // [CONTROL] an ordinary restore does NOT send it.
  const r = loadModule();
  r.restoreLegacy({ ...RECOVERABLE }, cardEl());
  await r.log.confirms[0].onConfirm();
  assert.deepEqual({ ...r.log.restoreCalls[0].opts }, { overwriteLive: false });
});

test('a dead archive is refused before any request is made', () => {
  const m = loadModule();
  m.restoreLegacy({ ...DEAD }, cardEl());
  assert.equal(m.log.confirms.length, 0);
  assert.equal(m.log.restoreCalls.length, 0);
  assert.match(m.log.toasts[0].msg, /dead/);
});

test('a 409 says "nothing archived any more", not a generic failure', async () => {
  const m = loadModule({
    restoreImpl: async () => { const e = new Error('Nothing archived'); e.status = 409; throw e; },
  });
  m.restoreLegacy({ ...RECOVERABLE }, cardEl());
  await m.log.confirms[0].onConfirm();
  const t = m.log.toasts.find((x) => x.kind === 'warning');
  assert.ok(t, 'a 409 must be a warning naming what happened');
  assert.match(t.msg, /nothing archived to restore any more/);
  // [CONTROL] a 500 is still an error.
  const e = loadModule({ restoreImpl: async () => { const x = new Error('boom'); x.status = 500; throw x; } });
  e.restoreLegacy({ ...RECOVERABLE }, cardEl());
  await e.log.confirms[0].onConfirm();
  assert.ok(e.log.toasts.some((x) => x.kind === 'error' && /boom/.test(x.msg)));
});

test('the admin API attaches status/code to a refusal and sends overwrite_live only when asked', () => {
  const fetchFn = ADMIN_API.slice(ADMIN_API.indexOf('async _imageAuditFetch('), ADMIN_API.indexOf('async getImageAuditStats('));
  assert.match(fetchFn, /err\.status = resp\.status;/, 'a caller cannot branch on a message string');
  assert.match(fetchFn, /err\.code = json\?\.error\?\.code/);
  const restore = ADMIN_API.slice(ADMIN_API.indexOf('async restoreLegacyImage('), ADMIN_API.indexOf('imageAuditSearchUrl('));
  assert.match(restore, /overwriteLive \? \{ method: 'POST', body: \{ overwrite_live: true \} \} : \{ method: 'POST' \}/);
});

/* ── 4. "Recoverable only" excludes the hold ────────────────────────────── */

test('"Recoverable only" sends recoverable_only AND status=pending', () => {
  const m = loadModule();
  m.setState({ recoverableOnly: true, status: '' });
  const f = m.buildFilters();
  assert.equal(f.recoverable_only, true);
  assert.equal(f.status, 'pending',
    'recoverable_only alone returns 834 rows = 104 + the 730-row watermark hold');
  // An explicit status choice wins.
  m.setState({ status: 'checked_clean' });
  assert.equal(m.buildFilters().status, 'checked_clean');
  // [CONTROL] off means off.
  m.setState({ recoverableOnly: false, status: '' });
  assert.equal(m.buildFilters().status, '');
  assert.equal(m.buildFilters().recoverable_only, false);
  assert.match(m.buildToolbar(), /id="gia-recoverable"/);
  assert.match(ADMIN_API, /if \(filters\.recoverable_only\) params\.set\('recoverable_only', 'true'\);/);
});

/* ── 5. The split, and no sweep ─────────────────────────────────────────── */

test('the KPI row shows the three-way split and the no-sweep note', () => {
  const m = loadModule();
  m.setStats({
    total_with_image: 3217, total_missing_image: 1170, pending_review: 1372,
    missing_image_breakdown: { recoverable: 104, never_had_one: 336, watermark_hold: 730 },
    vision: {},
  });
  const html = m.buildKpis();
  assert.match(html, /104 recoverable · 730 watermark hold · 336 never had one/);
  assert.match(html, /gia-hold-note/);
  assert.match(html, /no bulk restore here on purpose/);
});

test('ABSENT split is not a zero split', () => {
  const m = loadModule();
  m.setStats({ total_with_image: 10, total_missing_image: 5, pending_review: 1, vision: {} });
  const html = m.buildKpis();
  assert.doesNotMatch(html, /recoverable/, 'an older backend must not be told it has 0 recoverable');
  assert.doesNotMatch(html, /gia-hold-note/);
});

test('there is no bulk restore anywhere on the admin surface', () => {
  assert.ok(!/bulk-restore-legacy/.test(stripComments(SRC)),
    'the page must not call the sweep the backend asked nobody to run');
  assert.ok(!/bulk-restore-legacy/.test(stripComments(ADMIN_API)), 'and the admin API must not wrap it');
  assert.ok(!/NOT YET DEPLOYED/.test(ADMIN_API), 'the endpoint is live — the stale caveat must go');
});
