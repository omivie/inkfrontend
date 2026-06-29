/**
 * Tracking Requests — request-based tracking model
 * ================================================
 *
 * We stopped revealing order tracking automatically. The contract:
 *
 *   1. /track-order is a PUBLIC page (footer + account nav) where a customer
 *      enters their order number + email and REQUESTS tracking. It never
 *      renders a tracking number, carrier, timeline, or live events.
 *   2. The request notifies admins who opted into `notify_tracking_requests`
 *      on the admin Settings page.
 *   3. An admin opens the admin "Tracking Requests" page and clicks through to
 *      the ORDER to add a tracking number. Fulfilment is AUTOMATIC — adding
 *      tracking on the order (PUT /api/admin/orders/:id) flips the request to
 *      `fulfilled` and emails the customer. There is no fulfil/dismiss endpoint.
 *
 * These tests pin the FRONTEND half of that contract against the verified live
 * backend (June 2026). Run with:
 *   node --test tests/tracking-request-may2026.test.js
 *
 * Backend contract (verified live, June 2026):
 *   POST /api/orders/track-request → 200 {ok:true,data:{message}} ALWAYS
 *     (anti-enumeration); 400 {ok:false,error:{code:'VALIDATION_FAILED',...}}
 *     for malformed input; 429 {ok:false,error:{code:'RATE_LIMITED'}}.
 *   GET /api/admin/tracking-requests?status=pending|fulfilled|all →
 *     {ok:true,data:{requests:[{id,order_number,email,status,fulfilled_at,
 *       created_at,order:{status,tracking_number,carrier}}],total}}  (flat total).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ICR, rel), 'utf8');

// ─── Customer API ────────────────────────────────────────────────────────────
test('api.js exposes requestOrderTracking → POST /api/orders/track-request', () => {
  const api = read('js/api.js');
  assert.match(api, /async requestOrderTracking\(/, 'requestOrderTracking() missing');
  assert.match(api, /\/api\/orders\/track-request/, 'must POST to /api/orders/track-request');
  // It must POST (a mutation), never GET.
  const fn = api.slice(api.indexOf('async requestOrderTracking('));
  assert.match(fn.slice(0, 400), /this\.post\(/, 'requestOrderTracking must use POST');
  assert.match(fn.slice(0, 400), /order_number/, 'payload must carry order_number');
});

test('api.js exposes trackLookup → POST /api/orders/track-lookup (Jun 2026 inline model)', () => {
  const api = read('js/api.js');
  assert.match(api, /async trackLookup\(/, 'trackLookup() missing');
  assert.match(api, /\/api\/orders\/track-lookup/, 'must POST to /api/orders/track-lookup');
  const fn = api.slice(api.indexOf('async trackLookup('));
  assert.match(fn.slice(0, 400), /this\.post\(/, 'trackLookup must use POST');
  assert.match(fn.slice(0, 400), /order_number/, 'payload must carry order_number');
});

// ─── Customer controller ───────────────────────────────────────────────────
// NOTE: the customer /track-order page moved to an INLINE-display model in
// Jun 2026 (POST /api/orders/track-lookup → render timeline + tracking inline).
// The deep behavioural contract for that lives in
// tests/tracking-inline-lookup-jun2026.test.js. This block now only pins that
// the controller IS the inline-display one and still keeps the notify-me
// fallback (requestOrderTracking) that feeds the admin queue.
test('track-order-page.js is the INLINE-display controller (Jun 2026)', () => {
  const ctrl = read('js/track-order-page.js');
  assert.match(ctrl, /trackLookup/, 'controller must call API.trackLookup');
  assert.match(ctrl, /submitLookup/, 'controller must have a submitLookup flow');
  assert.match(ctrl, /renderTracking\b/, 'controller must render a tracking detail panel');
  assert.match(ctrl, /buildTimeline\b/, 'controller must build the progress timeline');
  assert.match(ctrl, /tracking-detail/, 'controller must render the .tracking-detail card');
  // Notify-me fallback for not-yet-shipped orders is retained.
  assert.match(ctrl, /requestOrderTracking/, 'controller must keep the notify-me fallback (requestOrderTracking)');
  // It uses the live lookup, not the legacy per-order GET tracking endpoint.
  assert.ok(!ctrl.includes('getOrderTracking'), 'must NOT use the legacy getOrderTracking endpoint');
});

test('track-order controller is auth-aware: only the account mount redirects', () => {
  const ctrl = read('js/track-order-page.js');
  // It detects the account-embedded mount and gates ONLY that one.
  assert.match(ctrl, /account-sidebar/, 'must detect the account mount via .account-sidebar');
  assert.match(ctrl, /isAccountMount\s*&&\s*!authed/, 'redirect must be gated on account-mount AND unauthenticated');
  assert.match(ctrl, /\/account\/login\?redirect=/, 'account mount redirects unauthenticated visitors to login');
});

test('track-order controller renders inline tracking, prefills email when signed in', () => {
  const ctrl = read('js/track-order-page.js');
  assert.match(ctrl, /order-timeline/, 'success state must render the inline tracking timeline');
  assert.match(ctrl, /track-result/, 'uses the shared #track-result surface');
  assert.match(ctrl, /Auth\.user\?\.email/, 'prefills the signed-in customer email');
  assert.match(ctrl, /RATE_LIMITED/, 'handles the rate-limit response code');
});

test('track-order controller handles the live backend error codes', () => {
  const ctrl = read('js/track-order-page.js');
  // The live backend returns VALIDATION_FAILED (not VALIDATION_ERROR) for
  // malformed order numbers / emails. api.js surfaces it as response.code.
  assert.match(ctrl, /VALIDATION_FAILED/, 'must handle the VALIDATION_FAILED code specifically');
  // Signed-in customers must always send a valid email (backend requires one):
  // the controller falls back to the session email when the field is empty.
  assert.match(ctrl, /effectiveEmail/, 'must compute an effective email with a session fallback');
  assert.match(ctrl, /effectiveEmail\s*=\s*email\s*\|\|\s*\(authed\s*&&\s*Auth\.user\?\.email\)/,
    'effective email must fall back to Auth.user.email when authed');
});

// ─── Public page ─────────────────────────────────────────────────────────────
test('public /track-order page exists with the request form contract', () => {
  const html = read('html/track-order.html');
  for (const id of ['track-order-form', 'track-order-number', 'track-email', 'track-submit', 'track-result']) {
    assert.ok(html.includes(`id="${id}"`), `public track page missing #${id}`);
  }
  assert.match(html, /track-order-page\.js/, 'public page must load the controller');
  assert.match(html, /name="email"/, 'email field present');
  assert.match(html, /name="order_number"/, 'order number field present');
  // Confirm it does NOT ship a pre-rendered tracking number / timeline.
  assert.ok(!html.includes('tracking-detail'), 'public page must not pre-render a tracking detail block');
});

test('public /track-order ships the canonical site-header + footer + main.js', () => {
  const html = read('html/track-order.html');
  assert.ok(html.includes('<header class="site-header">'), 'must ship the canonical header');
  assert.ok(html.includes('<footer class="site-footer">'), 'must ship the site footer');
  assert.match(html, /<script[^>]+src=["']\/js\/main\.js/, 'must load main.js for active-nav + chrome');
  assert.match(html, /<script[^>]+src=["']\/js\/footer\.js/, 'must load footer.js');
});

test('vercel.json routes /track-order to /html/track-order', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const r = vercel.rewrites.find(x => x.source === '/track-order');
  assert.ok(r, '/track-order rewrite missing');
  assert.equal(r.destination, '/html/track-order');
});

// ─── Account page ────────────────────────────────────────────────────────────
test('account /track-order page uses the new request-form field IDs', () => {
  const html = read('html/account/track-order.html');
  for (const id of ['track-order-form', 'track-order-number', 'track-email', 'track-submit', 'track-result']) {
    assert.ok(html.includes(`id="${id}"`), `account track page missing #${id}`);
  }
  // The legacy auto-display IDs are gone.
  assert.ok(!html.includes('id="tracking-result"'), 'legacy #tracking-result must be removed');
  assert.ok(!html.includes('id="order-number"'), 'legacy #order-number must be removed (renamed to #track-order-number)');
  assert.ok(html.includes('id="recent-orders-section"'), 'recent-orders section present (hidden until orders load)');
});

// ─── Footer entry points ─────────────────────────────────────────────────────
// The footer was redesigned (commits 80f71c4 / 6dc79dd): the bottom link nav was
// replaced by the payment-card strip, so /track-order now lives only in the
// Information column. (Previously this asserted hits >= 2; updated to match the
// redesign — see errors.md "footer bottom-nav track-order link removed".)
test('footer.js links to /track-order in the Information column', () => {
  const footer = read('js/footer.js');
  const hits = (footer.match(/href="\/track-order"/g) || []).length;
  assert.ok(hits >= 1, `expected a /track-order link in the footer Information column, found ${hits}`);
});

// ─── Admin API ───────────────────────────────────────────────────────────────
test('admin/api.js exposes the read-only tracking-request methods', () => {
  const api = read('js/admin/api.js');
  assert.match(api, /async getTrackingRequests\(/, 'getTrackingRequests missing');
  assert.match(api, /async getPendingTrackingRequestCount\(/, 'getPendingTrackingRequestCount missing');
  assert.match(api, /\/api\/admin\/tracking-requests/, 'list endpoint missing');
});

test('admin/api.js drops the non-existent fulfil/dismiss endpoints', () => {
  const api = read('js/admin/api.js');
  // The backend has NO fulfil/dismiss endpoint — fulfilment is automatic when
  // a tracking number is set on the order. Calling them would 404.
  assert.ok(!/fulfillTrackingRequest/.test(api), 'fulfillTrackingRequest must be removed (no /fulfill endpoint)');
  assert.ok(!/dismissTrackingRequest/.test(api), 'dismissTrackingRequest must be removed (no dismiss endpoint)');
  assert.ok(!/tracking-requests\/[^'"`]*\/fulfill/.test(api), 'must not reference a /fulfill route');
});

test('admin/api.js reads the flat data.total (no pagination object)', () => {
  const api = read('js/admin/api.js');
  const fn = api.slice(api.indexOf('async getPendingTrackingRequestCount('));
  const body = fn.slice(0, 500);
  assert.match(body, /data\.total/, 'badge count must read flat data.total');
  assert.ok(!/pagination/.test(body), 'must NOT read data.pagination.total (the backend returns no pagination)');
});

// ─── Admin page + nav ────────────────────────────────────────────────────────
test('admin Tracking Requests page is a read-and-route surface', () => {
  const page = read('js/admin/pages/tracking-requests.js');
  assert.match(page, /export default/, 'must have a default export');
  assert.match(page, /async init\(/, 'page module needs init()');
  assert.match(page, /destroy\(\)/, 'page module needs destroy()');
  assert.match(page, /title:\s*'Tracking Requests'/, 'page title');
  assert.match(page, /getTrackingRequests/, 'must list requests');
  assert.match(page, /refreshTrackingRequestsBadge/, 'must refresh the nav badge after loads');
  // Routes to the order; fulfilment happens there (auto), not via a modal here.
  assert.match(page, /orders\?focus=/, 'pending requests must deep-link to the order via #orders?focus=');
  assert.match(page, /data-open-order/, 'must render an "open order" action');
  assert.match(page, /r\.order\b|\.order\s*\|\|/, 'must read the nested order object from each request');
});

test('admin Tracking Requests page has no fulfil/dismiss UI', () => {
  const page = read('js/admin/pages/tracking-requests.js');
  assert.ok(!/fulfillTrackingRequest/.test(page), 'must not call the removed fulfil endpoint');
  assert.ok(!/dismissTrackingRequest/.test(page), 'must not call the removed dismiss endpoint');
  assert.ok(!/showFulfillModal|import \{ Modal \}/.test(page), 'inline fulfil modal must be gone');
  assert.ok(!/data-dismiss=/.test(page), 'dismiss button must be gone');
  // 'dismissed' is not a backend status anymore.
  assert.ok(!/dismissed/.test(page), 'must not reference a dismissed status');
});

test('admin orders page supports the #orders?focus= deep-link', () => {
  const orders = read('js/admin/pages/orders.js');
  assert.match(orders, /function getHashParam\(/, 'getHashParam helper must exist');
  assert.match(orders, /async function focusOnOrder\(/, 'focusOnOrder helper must exist');
  assert.match(orders, /getHashParam\(['"]focus['"]\)/, 'init must read the focus param');
  assert.match(orders, /openOrderModal/, 'focus must open the order drawer');
});

test('admin app.js registers the tracking-requests nav item + badge wiring', () => {
  const app = read('js/admin/app.js');
  assert.match(app, /key:\s*'tracking-requests'.*badge:\s*true/, 'nav item must exist with badge:true');
  assert.match(app, /function refreshTrackingRequestsBadge\(/, 'badge refresher must be defined');
  assert.match(app, /export \{[^}]*refreshTrackingRequestsBadge[^}]*\}/, 'badge refresher must be exported');
  assert.match(app, /refreshTrackingRequestsBadge\(\);/, 'badge refresher must be invoked on boot');
  // Tracking Requests is for all admins, not owner-only.
  assert.ok(!/key:\s*'tracking-requests'[^}]*ownerOnly/.test(app), 'tracking-requests must NOT be owner-only');
});

// ─── Admin opt-in ────────────────────────────────────────────────────────────
test('admin Settings exposes the notify_tracking_requests opt-in', () => {
  const settings = read('js/admin/pages/contact-emails.js');
  assert.match(settings, /notify_tracking_requests/, 'notification type missing');
  assert.match(settings, /Tracking Requests/, 'human label missing');
});

// ─── Schema ──────────────────────────────────────────────────────────────────
test('SQL doc mirrors the deployed order_tracking_requests schema', () => {
  const sql = read('sql/order_tracking_requests.sql');
  assert.match(sql, /create table if not exists public\.order_tracking_requests/, 'table create missing');
  // Status is pending|fulfilled only — no dismissed.
  assert.match(sql, /status[\s\S]*check \(status in \('pending', 'fulfilled'\)\)/, 'status check constraint missing/wrong');
  assert.ok(!/dismissed/.test(sql), 'dismissed status must be gone from the schema doc');
  // One pending request per order (partial unique index).
  assert.match(sql, /unique index[\s\S]*where status = 'pending'/, 'one-pending-per-order partial unique index missing');
  // order_id cascades on delete.
  assert.match(sql, /order_id[\s\S]*references public\.orders[\s\S]*on delete cascade/, 'order_id FK cascade missing');
  assert.match(sql, /enable row level security/, 'RLS must be enabled');
  assert.match(sql, /add column if not exists notify_tracking_requests boolean/, 'opt-in column add missing');
});

test('the obsolete backend handoff spec is gone (backend is built)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'tracking-request-backend-spec.md')),
    'tracking-request-backend-spec.md must be removed — the backend is built and the spec is obsolete');
});
