/**
 * Tracking Requests — request-based tracking model (May 2026)
 * ===========================================================
 *
 * We stopped revealing order tracking automatically. The contract:
 *
 *   1. /track-order is a PUBLIC page (footer + account nav) where a customer
 *      enters their order number + email and REQUESTS tracking. It never
 *      renders a tracking number, carrier, timeline, or live events.
 *   2. The request notifies admins who opted into `notify_tracking_requests`
 *      on the admin Settings page.
 *   3. An admin fulfils the request (carrier + tracking number) from the admin
 *      "Tracking Requests" page, which emails the customer their tracking.
 *
 * These tests pin the FRONTEND half of that contract (the backend half lives in
 * tracking-request-backend-spec.md). Run with:
 *   node --test tests/tracking-request-may2026.test.js
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

// ─── Customer controller ───────────────────────────────────────────────────
test('track-order-page.js is a REQUEST controller, not an auto-display one', () => {
  const ctrl = read('js/track-order-page.js');
  assert.match(ctrl, /requestOrderTracking/, 'controller must call requestOrderTracking');
  assert.match(ctrl, /submitRequest/, 'controller must have submitRequest flow');
  // The old auto-display path is gone: no tracking number / timeline rendering.
  assert.ok(!ctrl.includes('getOrderTracking'), 'must NOT auto-fetch tracking via getOrderTracking');
  assert.ok(!/renderTracking\b/.test(ctrl), 'must NOT render a tracking detail panel');
  assert.ok(!/buildTimelineHtml/.test(ctrl), 'must NOT render a tracking timeline');
  assert.ok(!/tracking_number/.test(ctrl), 'controller must not surface tracking_number');
});

test('track-order controller is auth-aware: only the account mount redirects', () => {
  const ctrl = read('js/track-order-page.js');
  // It detects the account-embedded mount and gates ONLY that one.
  assert.match(ctrl, /account-sidebar/, 'must detect the account mount via .account-sidebar');
  assert.match(ctrl, /isAccountMount\s*&&\s*!authed/, 'redirect must be gated on account-mount AND unauthenticated');
  assert.match(ctrl, /\/account\/login\?redirect=/, 'account mount redirects unauthenticated visitors to login');
});

test('track-order controller renders a confirmation, prefills email when signed in', () => {
  const ctrl = read('js/track-order-page.js');
  assert.match(ctrl, /Request received/i, 'success state must confirm the request was received');
  assert.match(ctrl, /track-result/, 'uses the shared #track-result surface');
  assert.match(ctrl, /Auth\.user\?\.email/, 'prefills the signed-in customer email');
  assert.match(ctrl, /RATE_LIMITED/, 'handles the rate-limit response code');
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
test('footer.js links to /track-order in both the column and the bottom nav', () => {
  const footer = read('js/footer.js');
  const hits = (footer.match(/href="\/track-order"/g) || []).length;
  assert.ok(hits >= 2, `expected /track-order in the Information column AND the bottom nav, found ${hits}`);
});

// ─── Admin API ───────────────────────────────────────────────────────────────
test('admin/api.js exposes the tracking-request methods + endpoints', () => {
  const api = read('js/admin/api.js');
  assert.match(api, /async getTrackingRequests\(/, 'getTrackingRequests missing');
  assert.match(api, /async getPendingTrackingRequestCount\(/, 'getPendingTrackingRequestCount missing');
  assert.match(api, /async fulfillTrackingRequest\(/, 'fulfillTrackingRequest missing');
  assert.match(api, /async dismissTrackingRequest\(/, 'dismissTrackingRequest missing');
  assert.match(api, /\/api\/admin\/tracking-requests/, 'list endpoint missing');
  assert.match(api, /\/tracking-requests\/\$\{encodeURIComponent\(requestId\)\}\/fulfill/, 'fulfill endpoint missing');
  // fulfil must carry a tracking number and POST it.
  const fn = api.slice(api.indexOf('async fulfillTrackingRequest('));
  assert.match(fn.slice(0, 600), /tracking_number/, 'fulfil payload must carry tracking_number');
});

// ─── Admin page + nav ────────────────────────────────────────────────────────
test('admin Tracking Requests page module is well-formed', () => {
  const page = read('js/admin/pages/tracking-requests.js');
  assert.match(page, /export default/, 'must have a default export');
  assert.match(page, /async init\(/, 'page module needs init()');
  assert.match(page, /destroy\(\)/, 'page module needs destroy()');
  assert.match(page, /title:\s*'Tracking Requests'/, 'page title');
  assert.match(page, /import \{ Modal \}/, 'must import Modal for the fulfil dialog');
  assert.match(page, /fulfillTrackingRequest/, 'must call fulfillTrackingRequest');
  assert.match(page, /refreshTrackingRequestsBadge/, 'must refresh the nav badge after actions');
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
test('SQL migration defines the queue table + admin opt-in column', () => {
  const sql = read('sql/tracking_requests.sql');
  assert.match(sql, /create table if not exists public\.tracking_requests/, 'table create missing');
  assert.match(sql, /status[\s\S]*check \(status in \('pending', 'fulfilled', 'dismissed'\)\)/, 'status check constraint missing');
  assert.match(sql, /enable row level security/, 'RLS must be enabled');
  assert.match(sql, /add column if not exists notify_tracking_requests boolean/, 'opt-in column add missing');
});

test('backend spec doc exists for the backend Claude', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'tracking-request-backend-spec.md')),
    'tracking-request-backend-spec.md must exist at repo root');
});
