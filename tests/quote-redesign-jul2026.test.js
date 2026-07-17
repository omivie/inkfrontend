/**
 * /quote two-stage redesign (Jul 2026)
 * ====================================
 *
 * Pins the redesign-specific wiring on top of tests/quote-page-jul2026.test.js:
 *   - sessionStorage draft ('quote_draft', 30-min TTL, cleared on success),
 *   - human-readable reference (Q-XXXXXX, alphabet without 0/O/1/I),
 *   - campaign source allowlist (raw ?utm_source is never echoed),
 *   - the private write-only Supabase Storage bucket contract — bucket name in
 *     BOTH js and sql, server-enforced size + MIME limits, INSERT-only for
 *     anon, and deliberately NO select policy,
 *   - /card 302 redirect in BOTH vercel.json and serve.json with identical
 *     destinations (ERR-092: the two configs drift silently),
 *   - Turnstile hardening: deferred stage-2 render, visible error + Retry,
 *   - prefill via Auth.readyPromise + API.getProfile (fill-empty-only),
 *   - a11y: role="alert" error summaries, fieldset/legend in the row template,
 *     prefers-reduced-motion + sticky aside in the quote CSS section,
 *   - new asset refs ship ?v= placeholders (stamped by npm run build).
 *
 * Static source checks (repo has no jsdom). Run with:
 *   node --test tests/quote-redesign-jul2026.test.js
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
const QUOTE_SQL = read('sql/quote_uploads.sql');
// Policy assertions must ignore the header commentary (which *discusses*
// select policies while forbidding them) — strip `--` comment lines.
const QUOTE_SQL_CODE = QUOTE_SQL.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');
const PAGES_CSS = read('css/pages.css');
const VERCEL = JSON.parse(read('vercel.json'));
const SERVE = JSON.parse(read('serve.json'));

// ─── Draft persistence ───────────────────────────────────────────────────────
test('draft persists in sessionStorage under quote_draft with a 30-min TTL', () => {
  assert.match(QUOTE_JS, /'quote_draft'/, 'draft key missing');
  assert.match(QUOTE_JS, /30\s*\*\s*60\s*\*\s*1000/, '30-min TTL missing');
  assert.match(QUOTE_JS, /savedAt/, 'draft must stamp savedAt for the TTL check');
  // Success must clear the draft; the Turnstile token must never be persisted.
  assert.match(QUOTE_JS, /clearDraft\(\)/, 'clearDraft missing');
  assert.doesNotMatch(QUOTE_JS, /turnstile_token[^,}]*sessionStorage|sessionStorage[^;]*turnstile_token/,
    'never persist the turnstile token');
});

// ─── Reference ───────────────────────────────────────────────────────────────
test('reference is Q- + phone-friendly alphabet (no 0/O/1/I)', () => {
  assert.match(QUOTE_JS, /'Q-'/, 'Q- prefix missing');
  const alphabet = QUOTE_JS.match(/REF_ALPHABET\s*=\s*'([^']+)'/);
  assert.ok(alphabet, 'REF_ALPHABET missing');
  for (const banned of ['0', 'O', '1', 'I']) {
    assert.ok(!alphabet[1].includes(banned), `alphabet must not contain ${banned}`);
  }
  assert.match(QUOTE_JS, /crypto\.getRandomValues/, 'reference must be crypto-random');
});

// ─── Campaign source allowlist ───────────────────────────────────────────────
test('campaign source is allowlisted — raw utm_source is never echoed', () => {
  assert.match(QUOTE_JS, /SOURCE_ALLOWLIST/, 'allowlist missing');
  assert.match(QUOTE_JS, /'business-card'/, 'business-card source missing');
  assert.match(QUOTE_JS, /SOURCE_ALLOWLIST\[raw\]\s*\|\|\s*null/, 'source must resolve through the allowlist (or null)');
});

// ─── Upload bucket contract (js ⇄ sql) ───────────────────────────────────────
test('upload bucket name matches between quote-page.js and quote_uploads.sql', () => {
  assert.match(QUOTE_JS, /'quote-uploads'/, 'bucket constant missing from js');
  assert.match(QUOTE_SQL, /'quote-uploads'/, 'bucket missing from sql');
});

test('quote_uploads.sql: private bucket, 10 MB cap, exact MIME allowlist', () => {
  assert.match(QUOTE_SQL, /public,?\s*file_size_limit/, 'bucket columns missing');
  assert.match(QUOTE_SQL, /\bfalse\b/, 'bucket must be private (public = false)');
  assert.match(QUOTE_SQL, /10485760/, '10 MB file_size_limit missing');
  for (const mime of [
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]) {
    assert.ok(QUOTE_SQL.includes(`'${mime}'`), `MIME ${mime} missing from bucket allowlist`);
  }
  // The 10 MB client constant must agree with the bucket.
  assert.match(QUOTE_JS, /10485760/, 'client MAX_FILE_BYTES must match the bucket limit');
});

test('quote_uploads.sql is a write-only dropbox: INSERT for anon, NO select', () => {
  assert.match(QUOTE_SQL_CODE, /for insert/i, 'insert policy missing');
  assert.match(QUOTE_SQL_CODE, /to anon/i, 'anon must be able to insert');
  assert.doesNotMatch(QUOTE_SQL_CODE, /for select/i,
    'NO select policy — admin role is backend-verified, any authenticated SELECT would expose files to every signed-in customer');
  assert.doesNotMatch(QUOTE_SQL_CODE, /for update/i, 'no update policy');
  assert.doesNotMatch(QUOTE_SQL_CODE, /for delete/i, 'no delete policy');
});

test('client validates MIME + size BEFORE uploading', () => {
  assert.match(QUOTE_JS, /ALLOWED_MIME/, 'client MIME allowlist missing');
  assert.match(QUOTE_JS, /fileAllowed\(/, 'pre-upload validation missing');
  assert.match(QUOTE_JS, /sanitizeName\(/, 'filenames must be sanitised');
});

// ─── /card redirect in BOTH configs (ERR-092) ────────────────────────────────
test('/card 302 redirect exists in vercel.json and serve.json with the same destination', () => {
  const DEST = '/quote?utm_source=business-card&utm_medium=qr';
  const v = (VERCEL.redirects || []).find((r) => r.source === '/card');
  assert.ok(v, '/card redirect missing from vercel.json');
  assert.equal(v.destination, DEST, 'vercel destination mismatch');
  assert.equal(v.permanent, false, 'must stay temporary (302) so the card target can change');
  const s = (SERVE.redirects || []).find((r) => r.source === 'card');
  assert.ok(s, 'card redirect missing from serve.json (local dev drifts — ERR-092)');
  assert.equal(s.destination, DEST, 'serve destination mismatch');
  assert.equal(s.type, 302, 'serve redirect must be 302');
});

// ─── Turnstile hardening ─────────────────────────────────────────────────────
test('Turnstile renders lazily on stage 2 and failure is visible with Retry', () => {
  assert.match(QUOTE_JS, /ensureTurnstile\(\)/, 'deferred render missing');
  assert.match(QUOTE_HTML, /id="quote-turnstile-error"/, 'visible error element missing');
  assert.match(QUOTE_HTML, /id="quote-turnstile-retry"/, 'retry button missing');
  assert.match(QUOTE_JS, /'expired-callback'/, 'expired-callback re-arm missing');
  assert.match(QUOTE_JS, /'error-callback'/, 'error-callback missing');
});

// ─── Prefill ─────────────────────────────────────────────────────────────────
test('signed-in prefill uses Auth.readyPromise + API.getProfile and fills only empty fields', () => {
  assert.match(QUOTE_JS, /Auth\.readyPromise/, 'must await Auth.readyPromise (not a setTimeout race)');
  assert.match(QUOTE_JS, /API\.getProfile/, 'profile gap-fill missing');
  assert.match(QUOTE_JS, /fillIfEmpty/, 'prefill must never overwrite user/draft values');
});

// ─── Accessibility ───────────────────────────────────────────────────────────
test('error summaries are role="alert" and the row template uses fieldset/legend', () => {
  assert.match(QUOTE_HTML, /id="quote-error-summary-1"[^>]*role="alert"/, 'stage-1 error summary');
  assert.match(QUOTE_HTML, /id="quote-error-summary-2"[^>]*role="alert"/, 'stage-2 error summary');
  const tpl = QUOTE_HTML.match(/<template id="quote-row-template">[\s\S]*?<\/template>/);
  assert.ok(tpl, 'row template missing');
  assert.match(tpl[0], /<fieldset/, 'row template must use fieldset');
  assert.match(tpl[0], /<legend/, 'row template must use legend');
  // Preference radios are a nested labelled group.
  assert.match(tpl[0], /Genuine or compatible\?/, 'preference legend missing');
});

test('quote CSS section: sticky aside + prefers-reduced-motion', () => {
  const section = PAGES_CSS.slice(PAGES_CSS.indexOf('Quote page (/quote)'));
  assert.ok(section.length > 100, 'quote CSS section missing from pages.css');
  assert.match(section, /position:\s*sticky/, 'sticky support aside missing');
  assert.match(section, /prefers-reduced-motion/, 'reduced-motion guard missing');
  assert.match(section, /--tap-min/, 'touch-target token missing');
});

// ─── Analytics stays on existing rails ───────────────────────────────────────
test('funnel events are gtag-based and key buttons carry data-track', () => {
  for (const ev of ['quote_started', 'quote_method_selected', 'quote_stage_completed', 'quote_submitted', 'quote_submission_failed']) {
    assert.match(QUOTE_JS, new RegExp(`'${ev}'`), `gtag event ${ev} missing`);
  }
  assert.match(QUOTE_HTML, /data-track="quote:method-upload"/, 'method buttons must carry data-track');
  assert.match(QUOTE_HTML, /data-track="quote:stage1-next"/, 'stage-1 continue must carry data-track');
  // No personal data or filenames ride analytics events.
  assert.doesNotMatch(QUOTE_JS, /track\([^)]*email/, 'never send email to analytics');
});

// ─── Cache tokens ────────────────────────────────────────────────────────────
test('newly-added asset refs use a ?v= token (stamped by npm run build)', () => {
  assert.match(QUOTE_HTML, /\/js\/printer-data\.js\?v=[0-9a-f]{8}/, 'printer-data.js must ship a versioned ref');
});
