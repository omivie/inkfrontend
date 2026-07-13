/**
 * Newsletter Subscribe — inline confirmation feedback (Jun 2026)
 * =============================================================
 *
 * Backend handoff (newsletter-subscribe-frontend-jun2026.md): the footer
 * Subscribe route no longer requires a Cloudflare Turnstile token — the plain
 * footer form's { email, source } submit now succeeds. The one FE gap was that
 * the form gave no clear confirmation: its only feedback was the global corner
 * showToast(), which is easy to miss, is inconsistent with every other form in
 * the app (contact / track-order / review / cart all use an inline aria-live
 * message), and silently no-ops on the pages that don't load main.js
 * (forgot/reset/verify — where showToast is undefined).
 *
 * These tests pin the FRONTEND contract for the inline-feedback rollout (ERR-052):
 *   - footer template ships a .newsletter-feedback aria-live region,
 *   - the shared binder renders feedback inline (no showToast), wired to the
 *     documented API contract: 200 → data.message; 400 → invalid-email copy;
 *     429 RATE_LIMITED → backend message,
 *   - the form stays Turnstile-free / tokenless,
 *   - the changed JS/CSS carry the new cache-bust rollout token.
 *
 * Run with:
 *   node --test tests/newsletter-subscribe-feedback-jun2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ICR = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ICR, rel), 'utf8');

// Strip JS/CSS comments so a banned literal mentioned in a comment (e.g. a
// reference to "showToast" in the rationale) doesn't trip a regex on live code.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const FOOTER = read('js/footer.js');
const FOOTER_CODE = stripComments(FOOTER);
const LAYOUT_CSS = read('css/layout.css');
const API_JS = read('js/api.js');

// ─── Template: inline aria-live feedback region ──────────────────────────────
test('footer template ships a .newsletter-feedback aria-live region', () => {
  // Lives inside the footer's injected markup, right after the form.
  assert.match(FOOTER, /class="newsletter-feedback"/, '.newsletter-feedback node missing from footer template');
  const tag = FOOTER.match(/<div class="newsletter-feedback"[^>]*>/);
  assert.ok(tag, '.newsletter-feedback must be a div with attributes');
  assert.match(tag[0], /role="status"/, 'feedback region needs role="status"');
  assert.match(tag[0], /aria-live="polite"/, 'feedback region needs aria-live="polite"');
  assert.match(tag[0], /\bhidden\b/, 'feedback region starts hidden');
});

test('feedback node sits immediately after the newsletter form', () => {
  const idxForm = FOOTER.indexOf('</form>');
  const idxFeedback = FOOTER.indexOf('class="newsletter-feedback"');
  assert.ok(idxForm !== -1 && idxFeedback !== -1, 'form and feedback both present');
  assert.ok(idxFeedback > idxForm, 'feedback node must come after </form>');
});

// ─── Binder: inline feedback, no toast ───────────────────────────────────────
test('binder defines inline-feedback helpers', () => {
  assert.match(FOOTER_CODE, /function setNewsletterFeedback\(/, 'setNewsletterFeedback() missing');
  assert.match(FOOTER_CODE, /function ensureFeedbackEl\(/, 'ensureFeedbackEl() missing');
  assert.match(FOOTER_CODE, /function newsletterErrorMessage\(/, 'newsletterErrorMessage() missing');
});

test('newsletter feedback no longer uses the global toast', () => {
  // The whole point of ERR-052: feedback is inline, not a corner toast that can
  // be missed or be undefined on pages without main.js.
  assert.doesNotMatch(FOOTER_CODE, /showToast\s*\(/, 'newsletter binder must not call showToast');
});

test('ensureFeedbackEl self-installs a feedback node for dynamically bound forms', () => {
  const fn = FOOTER_CODE.slice(FOOTER_CODE.indexOf('function ensureFeedbackEl('));
  const body = fn.slice(0, 700);
  assert.match(body, /newsletter-feedback/, 'must look for / create a .newsletter-feedback node');
  assert.match(body, /role['"]?\s*,\s*['"]status/, 'created node needs role=status');
  assert.match(body, /aria-live['"]?\s*,\s*['"]polite/, 'created node needs aria-live=polite');
  assert.match(body, /insertAdjacentElement\(['"]afterend/, 'created node inserted right after the form');
});

// ─── Success path: prefer backend data.message ───────────────────────────────
test('success renders inline and prefers res.data.message with a fallback', () => {
  // Contract success body: { ok:true, data:{ message:"Thank you for subscribing!" } }
  assert.match(FOOTER_CODE, /res\.data\.message/, 'success must read res.data.message');
  // newsletter-copy-fix-jun2026: the false "welcome code" promise was removed —
  // there is no newsletter coupon. The fallback is now byte-identical to the
  // backend's live data.message ("Thank you for subscribing!" ⇄ "Thanks for subscribing!").
  assert.match(FOOTER_CODE, /Thanks for subscribing!/, 'success fallback copy missing');
  assert.doesNotMatch(FOOTER_CODE, /welcome code/i, 'must not promise a welcome code (no coupon is issued)');
  // success uses the inline pill with the success kind
  assert.match(FOOTER_CODE, /setNewsletterFeedback\([^)]*['"]success['"]/, 'success must use setNewsletterFeedback(..., "success", ...)');
  // and clears the input on success
  assert.match(FOOTER_CODE, /emailInput\.value\s*=\s*['"]['"]/, 'success must clear the email input');
});

// ─── Error mapping: aligned to the documented contract codes ─────────────────
test('error mapping covers RATE_LIMITED, validation, and 5xx', () => {
  const fn = FOOTER_CODE.slice(FOOTER_CODE.indexOf('function newsletterErrorMessage('));
  const body = fn.slice(0, 1200);
  assert.match(body, /RATE_LIMITED/, '429 RATE_LIMITED must be handled');
  assert.match(body, /VALIDATION_ERROR|VALIDATION_FAILED/, '400 validation codes must be handled');
  assert.match(body, /Please enter a valid email address/, 'invalid-email copy missing');
  assert.match(body, /INTERNAL_ERROR|>=\s*500/, '5xx must be handled');
});

test('invalid email is caught client-side with inline error', () => {
  assert.match(FOOTER_CODE, /\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$/, 'email regex guard missing');
  assert.match(FOOTER_CODE, /setNewsletterFeedback\([^)]*['"]error['"][^)]*Please enter a valid email address/,
    'client-side invalid email must show inline error copy');
});

// ─── Payload + Turnstile: unchanged, tokenless ───────────────────────────────
test('payload stays { email, source }; turnstile_token only when present', () => {
  assert.match(FOOTER_CODE, /source:\s*source\s*\|\|\s*['"]footer['"]/, 'payload must carry source (default footer)');
  assert.match(FOOTER_CODE, /if\s*\(turnstileToken\)\s*payload\.turnstile_token/, 'turnstile_token only added when a token exists');
});

test('footer form is Turnstile-free (no widget host in markup)', () => {
  // The footer must keep submitting tokenlessly — the backend made Turnstile
  // optional, and the handoff says NOT to add a widget. Scope to the injected
  // markup block (the binder legitimately *queries* the selector for forms that
  // opt in elsewhere — that's support code, not a host on the footer form).
  const start = FOOTER.indexOf('class="footer-newsletter"');
  const end = FOOTER.indexOf('class="newsletter-feedback"');
  assert.ok(start !== -1 && end !== -1 && end > start, 'footer newsletter markup block not found');
  const block = FOOTER.slice(start, end + 120);
  assert.doesNotMatch(block, /data-newsletter-turnstile/, 'footer template must not embed a Turnstile host');
});

// ─── API surface unchanged ───────────────────────────────────────────────────
test('api.js still exposes subscribe() → POST /api/newsletter/subscribe', () => {
  assert.match(API_JS, /async subscribe\(/, 'API.subscribe() missing');
  assert.match(API_JS, /\/api\/newsletter\/subscribe/, 'must POST to /api/newsletter/subscribe');
  const fn = API_JS.slice(API_JS.indexOf('async subscribe('));
  assert.match(fn.slice(0, 200), /this\.post\(/, 'subscribe must use POST');
});

// ─── CSS: inline feedback pill ───────────────────────────────────────────────
test('layout.css defines the .newsletter-feedback pill (success + error)', () => {
  assert.match(LAYOUT_CSS, /\.newsletter-feedback\s*\{/, '.newsletter-feedback base rule missing');
  assert.match(LAYOUT_CSS, /\.newsletter-feedback--success\s*\{/, 'success variant missing');
  assert.match(LAYOUT_CSS, /\.newsletter-feedback--error\s*\{/, 'error variant missing');
  assert.match(LAYOUT_CSS, /\.newsletter-feedback\[hidden\]\s*\{[^}]*display:\s*none/, 'hidden state must collapse the node');
});

// ─── Cache-bust rollout token ────────────────────────────────────────────────
test('all footer.js/layout.css refs carry the new rollout token', () => {
  const pages = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (name.endsWith('.html')) pages.push(full);
    }
  };
  walk(path.join(ICR, 'html'));
  pages.push(path.join(ICR, 'index.html'));

  let footerRefs = 0;
  let layoutRefs = 0;
  for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    // Assert the refs EXIST and are cache-busted. Pinning the era literal
    // (newsletter-copy-fix-jun2026) meant this test failed the moment anyone else
    // touched footer.js — which is guaranteed, since the token is a content hash.
    // "Same token on every page" is now enforced for every asset, not just these two,
    // by tests/asset-cache-tokens.test.js §1.
    if (/footer\.js\?v=/.test(html)) {
      footerRefs++;
      assert.match(html, /footer\.js\?v=[^"]+/,
        `${path.relative(ICR, p)} must cache-bust footer.js`);
    }
    if (/layout\.css\?v=/.test(html)) {
      layoutRefs++;
      assert.match(html, /layout\.css\?v=[^"]+/,
        `${path.relative(ICR, p)} must cache-bust layout.css`);
    }
  }
  assert.ok(footerRefs >= 30, `expected footer.js on most pages, saw ${footerRefs}`);
  assert.ok(layoutRefs >= 30, `expected layout.css on most pages, saw ${layoutRefs}`);
});
