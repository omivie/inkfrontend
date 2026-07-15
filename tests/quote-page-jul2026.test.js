/**
 * Trade-quote page + QR generator (Jul 2026)
 * ==========================================
 *
 * New QR-driven trade-quote funnel: a business scans a printed QR code, lands
 * on /quote, enters their details and needs, and submits. There is no dedicated
 * backend quote endpoint yet, so the form reuses the proven POST /api/contact
 * pipeline — it folds the business-specific fields into a structured `message`
 * body and posts with subject "Trade quote request", landing in the existing
 * support inbox with zero backend changes.
 *
 * The repo has no jsdom, so these are static source checks that pin the wiring:
 *   - /quote page ships the business form fields + honeypot + Turnstile host,
 *   - the controller composes the message, sets the fixed subject, and reuses
 *     API.submitContactForm (with the raw-fetch fallback to /api/contact),
 *   - the Turnstile gate + honeypot are enforced,
 *   - the QR tool vendors a self-hosted encoder (no CDN → CSP-clean) and both
 *     new routes are wired in vercel.json.
 *
 * Run with:
 *   node --test tests/quote-page-jul2026.test.js
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
    .replace(/\/\/[^\n]*/g, '');
}

const QUOTE_HTML = read('html/quote.html');
const QUOTE_JS_RAW = read('js/quote-page.js');
const QUOTE_JS = stripComments(QUOTE_JS_RAW);
const QR_HTML = read('html/admin/quote-qr.html');
const QR_JS_RAW = read('js/quote-qr-page.js');
const QR_JS = stripComments(QR_JS_RAW);
const VERCEL = JSON.parse(read('vercel.json'));

// ─── /quote page: form fields ────────────────────────────────────────────────
test('/quote form collects the business + contact + needs fields', () => {
  assert.match(QUOTE_HTML, /id="quote-form"/, 'quote-form missing');
  for (const name of ['business_name', 'name', 'email', 'phone', 'printers', 'items', 'delivery_address', 'notes']) {
    assert.match(QUOTE_HTML, new RegExp(`name="${name}"`), `field ${name} missing from /quote form`);
  }
});

test('/quote form keeps the honeypot + Turnstile host + result region', () => {
  assert.match(QUOTE_HTML, /name="website"/, 'honeypot field missing');
  assert.match(QUOTE_HTML, /id="quote-turnstile"/, 'Turnstile host missing');
  const result = QUOTE_HTML.match(/<div id="quote-result"[^>]*>/);
  assert.ok(result, 'result region missing');
  assert.match(result[0], /role="status"/, 'result needs role="status"');
  assert.match(result[0], /aria-live="polite"/, 'result needs aria-live="polite"');
});

test('/quote loads the quote controller (not contact-page.js)', () => {
  assert.match(QUOTE_HTML, /\/js\/quote-page\.js/, 'quote-page.js not loaded');
  assert.doesNotMatch(QUOTE_HTML, /\/js\/contact-page\.js/, 'must not load contact-page.js');
});

test('/quote has its own canonical + title', () => {
  assert.match(QUOTE_HTML, /<link rel="canonical" href="https:\/\/www\.inkcartridges\.co\.nz\/quote">/, 'canonical must point at /quote');
  assert.match(QUOTE_HTML, /<title>[^<]*Trade Quote[^<]*<\/title>/, 'title should mention Trade Quote');
});

// ─── Controller: submission contract ─────────────────────────────────────────
test('controller posts the fixed "Trade quote request" subject', () => {
  assert.match(QUOTE_JS, /subject:\s*'Trade quote request'/, 'subject must be the fixed quote subject');
});

test('controller reuses API.submitContactForm with a /api/contact fallback', () => {
  assert.match(QUOTE_JS, /API\.submitContactForm\(/, 'must reuse API.submitContactForm');
  assert.match(QUOTE_JS, /\/api\/contact/, 'raw-fetch fallback must target /api/contact');
  // No premature dependence on a not-yet-existent /api/quote endpoint.
  assert.doesNotMatch(QUOTE_JS, /\/api\/quote\b/, 'must not call a non-existent /api/quote endpoint yet');
});

test('controller composes a message body from the business fields', () => {
  assert.match(QUOTE_JS, /function composeMessage\(/, 'composeMessage() missing');
  // The composed body must carry the structured sections the inbox needs.
  assert.match(QUOTE_JS, /'Business: '/, 'message must include Business line');
  assert.match(QUOTE_JS, /'Products & quantities:'/, 'message must include Products & quantities');
  assert.match(QUOTE_JS, /'Delivery address:'/, 'message must include Delivery address');
});

test('controller enforces the Turnstile gate and honeypot', () => {
  assert.match(QUOTE_JS, /complete the CAPTCHA/i, 'Turnstile gate message missing');
  assert.match(QUOTE_JS, /getToken\(\)/, 'must read a Turnstile token before sending');
  assert.match(QUOTE_JS, /honeypot/i, 'honeypot handling missing');
});

test('controller requires business name, contact name, email, and items', () => {
  assert.match(QUOTE_JS, /business name/i, 'business-name validation missing');
  assert.match(QUOTE_JS, /valid email address/i, 'email validation missing');
  assert.match(QUOTE_JS, /products and quantities/i, 'items validation missing');
});

// ─── QR generator tool ───────────────────────────────────────────────────────
test('QR tool vendors a self-hosted encoder (no CDN, CSP-clean)', () => {
  const lib = read('js/vendor/qrcode.min.js');
  assert.match(lib, /qrcode\s*=\s*function/, 'vendored qrcode factory missing');
  assert.match(QR_HTML, /\/js\/vendor\/qrcode\.min\.js/, 'tool must load the vendored lib');
  // Must not pull the encoder from a CDN at runtime.
  assert.doesNotMatch(QR_HTML, /src="https?:\/\/[^"]*qrcode/i, 'QR lib must be self-hosted, not from a CDN');
});

test('QR tool is noindex and defaults to the /quote URL', () => {
  assert.match(QR_HTML, /<meta name="robots" content="noindex, nofollow">/, 'QR tool must be noindex');
  assert.match(QR_JS_RAW, /https:\/\/www\.inkcartridges\.co\.nz\/quote/, 'QR tool should default to the /quote URL');
});

test('QR tool can emit SVG and PNG', () => {
  assert.match(QR_JS, /createSvgTag/, 'SVG output missing');
  assert.match(QR_JS, /toDataURL\('image\/png'\)/, 'PNG output missing');
});

// ─── Routing ─────────────────────────────────────────────────────────────────
test('vercel.json rewrites /quote to its html page', () => {
  const has = (source, destination) =>
    VERCEL.rewrites.some((r) => r.source === source && r.destination === destination);
  assert.ok(has('/quote', '/html/quote'), '/quote rewrite missing');
});

test('QR tool lives under /admin (noindex, served by the existing /admin/:path* rewrite)', () => {
  // The internal QR generator is an owner tool: placing it in html/admin keeps it
  // noindex (the /admin/(.*) X-Robots header) and out of the storefront audits.
  const adminRewrite = VERCEL.rewrites.find((r) => r.source === '/admin/:path*');
  assert.ok(adminRewrite && adminRewrite.destination === '/html/admin/:path*',
    '/admin/:path* rewrite must exist so /admin/quote-qr serves html/admin/quote-qr');
  assert.ok(QR_HTML.length > 0, 'QR tool must live at html/admin/quote-qr.html');
});
