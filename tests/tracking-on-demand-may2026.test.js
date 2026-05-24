/**
 * Tracking-on-demand — order-detail + order-confirmation contract (May 2026)
 * ==========================================================================
 *
 * Companion to tests/tracking-request-may2026.test.js, which already pins the
 * /track-order request form + admin fulfilment + footer wiring. THIS suite
 * pins the rest of the surface: that the OTHER customer order pages stop
 * leaking shipment progress / delivery predictions inline, and instead point
 * customers at the /track-order request form.
 *
 * The owner's brief: "all tracking information is only shown after the user
 * requests tracking information." So:
 *
 *   1. /account/order-detail no longer auto-paints the shipment timeline
 *      (Order Placed → Processing → Shipped → Delivered with dates).
 *   2. /order-confirmation no longer auto-paints an Estimated Delivery date
 *      to the customer (the date is still computed for the Google Customer
 *      Reviews data feed — that's not customer-facing UI).
 *   3. Both pages carry an explicit "Request tracking" CTA pointing at the
 *      track-order request form:
 *        - order-detail.html  → /account/track-order  (authed mount)
 *        - order-confirmation → /track-order          (public mount; works
 *                                                       for guests post-checkout)
 *   4. order-confirmation-page.js drops `trackingNumber` from
 *      transformAPIOrder's return value (it was vestigial and a leak risk).
 *
 * Run with:
 *   node --test tests/tracking-on-demand-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ICR, rel), 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const DETAIL_JS_SRC   = read('js/order-detail-page.js');
const DETAIL_HTML_SRC = read('html/account/order-detail.html');
const CONF_JS_SRC     = read('js/order-confirmation-page.js');
const CONF_HTML_SRC   = read('html/order-confirmation.html');

const DETAIL_JS   = stripComments(DETAIL_JS_SRC);
const DETAIL_HTML = stripComments(DETAIL_HTML_SRC);
const CONF_JS     = stripComments(CONF_JS_SRC);
const CONF_HTML   = stripComments(CONF_HTML_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — order-detail no longer paints a shipment timeline
// ─────────────────────────────────────────────────────────────────────────────

test('§1.1 order-detail-page.js does not call renderTimeline', () => {
  // The renderTimeline() call from renderOrder() is gone.
  assert.ok(
    !/this\.renderTimeline\s*\(/.test(DETAIL_JS),
    'order-detail-page.js must NOT invoke renderTimeline() — tracking is on-demand'
  );
});

test('§1.2 order-detail-page.js does not define a renderTimeline method', () => {
  // The function itself was removed so nobody quietly re-wires it later.
  assert.ok(
    !/\brenderTimeline\s*\(\s*order\s*\)\s*\{/.test(DETAIL_JS),
    'renderTimeline() method must be removed from order-detail-page.js'
  );
});

test('§1.3 order-detail-page.js renders no timeline-step / order-timeline markup', () => {
  // Even as a string. Defensive: no future maintainer can splice it back in
  // without breaking this test.
  assert.ok(
    !/timeline-step/.test(DETAIL_JS),
    'order-detail-page.js must not emit timeline-step markup'
  );
  assert.ok(
    !/order-detail-timeline/.test(DETAIL_JS),
    'order-detail-page.js must not emit the order-detail-timeline wrapper'
  );
});

test('§1.4 order-detail-page.js never surfaces tracking_number / tracking_url / carrier / tracking_events', () => {
  for (const token of ['tracking_number', 'tracking_url', 'tracking_events', /\bcarrier\b/]) {
    const re = token instanceof RegExp ? token : new RegExp(token);
    assert.ok(
      !re.test(DETAIL_JS),
      `order-detail-page.js must not read ${token} — tracking is on-demand`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — order-detail HTML carries a Request-tracking CTA
// ─────────────────────────────────────────────────────────────────────────────

test('§2.1 order-detail.html links to /account/track-order in the order-actions block', () => {
  assert.ok(
    /href="\/account\/track-order"/.test(DETAIL_HTML),
    'order-detail.html must link to /account/track-order so customers can request tracking'
  );
});

test('§2.2 the CTA is tagged for the contract (data-track-cta)', () => {
  // The tag stays stable so future audits + analytics can find it.
  assert.ok(
    /data-track-cta\b/.test(DETAIL_HTML),
    'order-detail.html tracking CTA must carry data-track-cta'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — order-confirmation no longer auto-paints estimated delivery
// ─────────────────────────────────────────────────────────────────────────────

test('§3.1 order-confirmation.html drops the visible #estimated-delivery span', () => {
  assert.ok(
    !/id="estimated-delivery"/.test(CONF_HTML),
    'order-confirmation.html must not ship the #estimated-delivery span — removed for tracking-on-demand'
  );
  // The literal "Estimated Delivery:" copy goes with it.
  assert.ok(
    !/Estimated Delivery:/.test(CONF_HTML),
    'order-confirmation.html must not display "Estimated Delivery:" inline'
  );
});

test('§3.2 order-confirmation-page.js does not write to #estimated-delivery', () => {
  assert.ok(
    !/getElementById\(['"]estimated-delivery['"]\)/.test(CONF_JS),
    'order-confirmation-page.js must not query #estimated-delivery — that DOM node is gone'
  );
});

test('§3.3 transformAPIOrder no longer carries trackingNumber on the returned shape', () => {
  // The vestigial trackingNumber field is gone so the confirmation surface can
  // never accidentally render it.
  assert.ok(
    !/trackingNumber\s*:\s*apiOrder\.tracking_number/.test(CONF_JS),
    'transformAPIOrder must not project apiOrder.tracking_number into trackingNumber'
  );
});

test('§3.4 GCR opt-in still computes estimated_delivery_date for the Google data feed', () => {
  // This is NOT customer-facing UI — it's the Google Customer Reviews data
  // feed, which requires the date. Keep it.
  assert.ok(
    /getEstimatedDeliveryDate\s*\(/.test(CONF_JS),
    'getEstimatedDeliveryDate() must still exist for the Google Customer Reviews data feed'
  );
  assert.ok(
    /estimated_delivery_date/.test(CONF_JS),
    'GCR payload must still carry estimated_delivery_date'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — order-confirmation HTML CTA points at the PUBLIC /track-order form
// ─────────────────────────────────────────────────────────────────────────────

test('§4.1 order-confirmation.html primary CTA links to /track-order (not /account)', () => {
  // The post-purchase Track-CTA must hit the public form so guests can use it
  // without logging in. The old href="/account" was a wrong destination.
  assert.ok(
    /href="\/track-order"/.test(CONF_HTML),
    'order-confirmation.html must link to the public /track-order form'
  );
  // Sanity: the CTA copy describes a REQUEST, not a reveal.
  assert.ok(
    /Request tracking/i.test(CONF_HTML),
    'order-confirmation.html CTA copy must read "Request tracking" — never "Track now" or similar'
  );
});

test('§4.2 the confirmation-actions Track CTA is tagged for analytics', () => {
  const re = /data-track-cta="Track Order"[\s\S]{0,400}href="\/track-order"|href="\/track-order"[\s\S]{0,400}data-track-cta="Track Order"/;
  assert.ok(re.test(CONF_HTML), 'Track CTA must remain analytics-tagged AND point at /track-order');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Belt-and-braces: no other order surface auto-emits a tracking number
// ─────────────────────────────────────────────────────────────────────────────

test('§5.1 order-confirmation.html does not embed a literal tracking_number / tracking_url', () => {
  for (const token of ['tracking_number', 'tracking_url', 'tracking_events']) {
    assert.ok(
      !new RegExp(token).test(CONF_HTML),
      `order-confirmation.html must not ship ${token} markup`
    );
  }
});

test('§5.2 order-detail.html does not embed an inline timeline / tracking widget', () => {
  for (const token of ['order-detail-timeline', 'timeline-step', 'tracking-detail']) {
    assert.ok(
      !new RegExp(token).test(DETAIL_HTML),
      `order-detail.html must not ship the ${token} block`
    );
  }
});
