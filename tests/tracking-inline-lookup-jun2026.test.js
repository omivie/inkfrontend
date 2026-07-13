/**
 * Inline order tracking on /track-order (Jun 2026)
 * ================================================
 *
 * Supersedes the customer-facing half of the May-2026 request-only model. The
 * /track-order page (public + account mounts, one controller) now LOOKS THE
 * ORDER UP via POST /api/orders/track-lookup and renders the result inline:
 * status badge, progress timeline, tracking number / carrier / ETA, a
 * "Track with {carrier}" link, and the live courier scan history.
 *
 * The admin / notify-me half (POST /api/orders/track-request, the admin
 * Tracking Requests queue, the opt-in, the SQL schema) is UNCHANGED and stays
 * pinned by tests/tracking-request-may2026.test.js. The order-detail /
 * order-confirmation "tracking-on-demand" contract is also unchanged and stays
 * pinned by tests/tracking-on-demand-may2026.test.js.
 *
 * Backend contract (verified live, Jun 2026):
 *   POST /api/orders/track-lookup {order_number, email} →
 *     200 {ok:true,data:{order_number,status,status_label,tracking_number|null,
 *          tracking_url|null,carrier,estimated_delivery|null,shipped_at|null,
 *          timeline:[{step,label,completed,date|null}],tracking_events:[…]|null}}
 *     400 {ok:false,error:{code:'VALIDATION_FAILED',details:[{field,message}]}}
 *     404 {ok:false,error:{code:'NOT_FOUND',message:<generic, anti-enumeration>}}
 *     429 {ok:false,error:{code:'RATE_LIMITED'}}
 *
 * Run with:
 *   node --test tests/tracking-inline-lookup-jun2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ICR, rel), 'utf8');

const API_SRC  = read('js/api.js');
const CTRL_SRC = read('js/track-order-page.js');
const CSS_SRC  = read('css/pages.css');
const PUB_HTML = read('html/track-order.html');
const ACC_HTML = read('html/account/track-order.html');

// ─── API layer ─────────────────────────────────────────────────────────────
test('api.js: trackLookup POSTs to /api/orders/track-lookup with order_number + email', () => {
  assert.match(API_SRC, /async trackLookup\(/, 'trackLookup() must exist');
  const fn = API_SRC.slice(API_SRC.indexOf('async trackLookup(')).slice(0, 500);
  assert.match(fn, /this\.post\(\s*['"]\/api\/orders\/track-lookup['"]/, 'must POST to /api/orders/track-lookup');
  assert.match(fn, /order_number:\s*payload\.order_number/, 'must forward order_number');
  assert.match(fn, /email:\s*payload\.email/, 'must forward email');
});

test('api.js: the notify-me endpoint (requestOrderTracking) is retained', () => {
  // The inline model still uses track-request as a "notify me when it ships"
  // fallback for not-yet-shipped orders.
  assert.match(API_SRC, /async requestOrderTracking\(/, 'requestOrderTracking() must remain');
  assert.match(API_SRC, /\/api\/orders\/track-request/, 'track-request endpoint must remain');
});

// ─── Controller: lookup + render ─────────────────────────────────────────────
test('controller calls trackLookup and renders the tracking card', () => {
  assert.match(CTRL_SRC, /API\.trackLookup\(/, 'must call API.trackLookup');
  assert.match(CTRL_SRC, /submitLookup/, 'must have submitLookup flow');
  assert.match(CTRL_SRC, /renderTracking\s*\(/, 'must have renderTracking');
  assert.match(CTRL_SRC, /class="tracking-detail"/, 'must render the .tracking-detail card');
});

test('controller maps over the timeline (no hardcoded step count)', () => {
  // Net-30 returns 4 steps, cancelled returns [placed, cancelled], normal 5 —
  // the renderer must iterate, not assume a fixed shape.
  assert.match(CTRL_SRC, /buildTimeline\s*\(/, 'buildTimeline must exist');
  const fn = CTRL_SRC.slice(CTRL_SRC.indexOf('buildTimeline(timeline)')).slice(0, 900);
  assert.match(fn, /timeline\.map\(/, 'must map over data.timeline');
  assert.match(fn, /timeline-step--cancelled/, 'must handle the cancelled step');
  assert.match(fn, /timeline-step--completed/, 'must mark completed steps');
  // No literal 5-step assumption.
  assert.ok(!/timeline\[4\]|length\s*===\s*5/.test(fn), 'must not hardcode a 5-step timeline');
});

test('controller renders tracking number, carrier, ETA, and the Track-with button', () => {
  assert.match(CTRL_SRC, /tracking_number/, 'must read tracking_number');
  assert.match(CTRL_SRC, /\bcarrier\b/, 'must read carrier');
  assert.match(CTRL_SRC, /estimated_delivery/, 'must read estimated_delivery');
  assert.match(CTRL_SRC, /buildTrackButton\s*\(/, 'must have buildTrackButton');
  assert.match(CTRL_SRC, /Track with /, 'must label the carrier link "Track with …"');
  // The carrier link must be sanitised and open safely.
  assert.match(CTRL_SRC, /Security\.sanitizeUrl\(/, 'tracking_url must pass through Security.sanitizeUrl');
  assert.match(CTRL_SRC, /rel="noopener noreferrer"/, 'external tracking link must be rel=noopener noreferrer');
});

test('controller renders the live courier events newest-first as given', () => {
  assert.match(CTRL_SRC, /buildEvents\s*\(/, 'must have buildEvents');
  assert.match(CTRL_SRC, /tracking_events/, 'must read tracking_events');
  const fn = CTRL_SRC.slice(CTRL_SRC.indexOf('buildEvents(events)')).slice(0, 900);
  assert.match(fn, /\.map\(/, 'must map over the events array');
  // Defensive: skip entirely when null/empty (no orphan heading).
  assert.match(fn, /!Array\.isArray\(events\)\s*\|\|\s*!events\.length/, 'must no-op on null/empty events');
});

// ─── Controller: error handling per response.code ────────────────────────────
test('controller handles NOT_FOUND with the generic, anti-enumeration message', () => {
  assert.match(CTRL_SRC, /response\.code === 'NOT_FOUND'/, 'must branch on NOT_FOUND');
  // It must surface the backend message verbatim, never disclose which field
  // was wrong.
  const idx = CTRL_SRC.indexOf("response.code === 'NOT_FOUND'");
  const branch = CTRL_SRC.slice(idx, idx + 600);
  assert.match(branch, /response\.error/, 'NOT_FOUND must show response.error verbatim');
  assert.ok(!/wrong email|email.*not match|no such order|doesn't exist/i.test(branch),
    'NOT_FOUND branch must NOT reveal which field failed (anti-enumeration)');
});

test('controller handles VALIDATION_FAILED and RATE_LIMITED inline', () => {
  assert.match(CTRL_SRC, /response\.code === 'VALIDATION_FAILED'/, 'must branch on VALIDATION_FAILED');
  assert.match(CTRL_SRC, /response\.code === 'RATE_LIMITED'/, 'must branch on RATE_LIMITED');
  // Network / 5xx falls into the catch.
  assert.match(CTRL_SRC, /catch\s*\(\s*err\s*\)/, 'must catch thrown network/5xx errors');
});

// ─── Controller: notify-me fallback when not yet shipped ─────────────────────
test('controller fires the notify-me fallback when tracking_number is null', () => {
  // On a successful lookup of a not-yet-shipped order it registers a notify-me
  // (track-request) so the customer is emailed on dispatch.
  assert.match(CTRL_SRC, /tracking_number == null/, 'must detect the not-shipped state');
  assert.match(CTRL_SRC, /API\.requestOrderTracking\(/, 'must fire requestOrderTracking for not-shipped orders');
  assert.match(CTRL_SRC, /buildNotShippedNote/, 'must show a not-shipped note');
});

// ─── Controller: debounced refresh ───────────────────────────────────────────
test('controller exposes a debounced "Check again" refresh', () => {
  assert.match(CTRL_SRC, /id="track-refresh"/, 'must render a #track-refresh button');
  assert.match(CTRL_SRC, /bindRefresh\s*\(/, 'must have bindRefresh');
  assert.match(CTRL_SRC, /REFRESH_MIN_GAP_MS/, 'refresh must be debounced against the rate limit');
  assert.match(CTRL_SRC, /_lastQuery/, 'refresh must re-run the last query');
});

// ─── Controller: XSS-safety + email fallback preserved ───────────────────────
test('controller escapes dynamic content and keeps the session-email fallback', () => {
  assert.match(CTRL_SRC, /Security\.escapeHtml/, 'must escape dynamic HTML');
  assert.match(CTRL_SRC, /Security\.escapeAttr/, 'must escape attribute values (href)');
  assert.match(CTRL_SRC, /effectiveEmail\s*=\s*email\s*\|\|\s*\(authed\s*&&\s*Auth\.user\?\.email\)/,
    'must keep the session-email fallback for signed-in customers');
});

// ─── CSS ─────────────────────────────────────────────────────────────────────
test('pages.css ships the inline-tracking helper rules', () => {
  for (const cls of ['.track-result--tracking', '.tracking-note', '.tracking-info-value--eta', '.tracking-refresh']) {
    assert.ok(CSS_SRC.includes(cls), `pages.css must define ${cls}`);
  }
  // The reused tracking classes from the original design must still exist.
  for (const cls of ['.tracking-detail', '.order-timeline', '.timeline-step', '.tracking-events']) {
    assert.ok(CSS_SRC.includes(cls), `pages.css must keep ${cls}`);
  }
});

// ─── HTML mounts: copy + cache-bust ──────────────────────────────────────────
test('both mounts drop the "we\'ll email you" copy and use the inline button label', () => {
  for (const [name, html] of [['public', PUB_HTML], ['account', ACC_HTML]]) {
    assert.ok(!/within\s+one business day/i.test(html), `${name} mount must drop the "one business day" promise`);
    assert.ok(html.includes('Track my order'), `${name} mount button must read "Track my order"`);
  }
});

// Was pinned to `v=track-lookup-inline-jun2026`. Cache tokens are content hashes that
// move with every edit, so an era literal guarantees this test breaks on the next
// unrelated CSS release. The real invariants — one token per asset sitewide, every
// asset versioned, staged changes bumped — are in tests/asset-cache-tokens.test.js.
// What this feature needs is simply that BOTH mounts load the controller, cache-busted.
test('both mounts load the controller + pages.css, cache-busted', () => {
  for (const [name, html] of [['public', PUB_HTML], ['account', ACC_HTML]]) {
    assert.match(html, /track-order-page\.js\?v=[^"]+/, `${name}: controller must be cache-busted`);
    assert.match(html, /pages\.css\?v=[^"]+/, `${name}: pages.css must be cache-busted`);
  }
});

test('the static HTML never pre-renders a tracking card (it is JS-rendered)', () => {
  for (const [name, html] of [['public', PUB_HTML], ['account', ACC_HTML]]) {
    assert.ok(!html.includes('class="tracking-detail"'), `${name}: must not pre-render a tracking-detail card`);
    assert.ok(!/tracking_number/.test(html), `${name}: must not embed a literal tracking_number`);
  }
});
