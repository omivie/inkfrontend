/**
 * Apple Pay / Google Pay never rendered — CSP, eligibility, and a diagnosis
 * that works on the host that has the bug (ERR-268)
 * =========================================================================
 *
 * The wallet row on /payment produced **zero** payments in 173 live charges
 * between 2026-03-10 and 2026-09-17. Not one Apple Pay. Not one Google Pay.
 * Three independent defects were found, and each one alone was enough:
 *
 *  1. FOUR CSP ENTRIES STRIPE DOCUMENTS AS REQUIRED WERE MISSING, including
 *     `hooks.stripe.com` — where 3-D Secure challenges render. A card that
 *     triggered a 3DS step had nowhere to draw it. That is CARD revenue, on
 *     the main path, and it had nothing to do with wallets.
 *
 *  2. THE ECE PASSED NO `paymentMethods` OPTION. Stripe renders Apple Pay on
 *     non-Safari desktop, and Google Pay on Safari and every iOS browser,
 *     ONLY when those are 'always'. At the default 'auto' Stripe excludes
 *     those platforms by design.
 *
 *  3. AND THE INSTRUMENT WAS SWITCHED OFF ON THE ONLY HOST THAT MATTERED.
 *     Every wallet log in payment-page.js goes through DebugLog, which is
 *     gated on localhost. The handoff that reported this told us to open
 *     Safari and read those lines. There was nothing to read.
 *
 * > ***A log that is silent on production is not an instrument, and a green
 * > local run says nothing about a header localhost never serves.***
 *
 * WHY THE ASSERTIONS BELOW LOOK PARANOID
 * --------------------------------------
 * This is the third CSP defect in this repo in a month, and the previous two
 * were invisible from green:
 *
 *   ERR-225  an allowed ORIGIN is not an allowed SCRIPT
 *   ERR-260  `*.google.com` does not match `www.google.co.nz`
 *
 * Both were a wildcard that looked wider than it was. So §3 does not check
 * that a string is present — it runs a real CSP host-source matcher and
 * proves each wildcard covers what we need it to and NOT what its neighbour
 * covers, which is the only way a future "tidy-up" that deletes one as
 * redundant goes red instead of shipping.
 *
 * §2 exists because ERR-260 shipped as a swap that looked like an addition.
 * Every token that was in the policy before this change is enumerated
 * literally and must survive.
 *
 * EVERY GUARD IS RED-PROOFED (ERR-258: six guards that could not fail hid
 * behind a 6088/0 suite). Each check is a pure function over a string, so
 * the red-proof mutates THE STRING, never the file — peers hold these files
 * and a test that rewrites them to check itself is how a fixture gets eaten.
 *
 * Run with: node --test tests/stripe-wallet-csp-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Every enforced Content-Security-Policy header value in vercel.json. */
function cspHeaders(vercelJson) {
  const out = [];
  for (const rule of JSON.parse(vercelJson).headers || []) {
    for (const h of rule.headers || []) {
      if (/^content-security-policy$/i.test(h.key)) out.push(h.value);
    }
  }
  return out;
}

/** `{ 'frame-src': ['https://js.stripe.com', ...], ... }` */
function directives(csp) {
  return Object.fromEntries(
    csp.trim().split(';').map(d => d.trim()).filter(Boolean)
      .map(d => { const p = d.split(/\s+/); return [p[0], p.slice(1)]; })
  );
}

const VERCEL_RAW = read('inkcartridges/vercel.json');
const CSP = cspHeaders(VERCEL_RAW)[0];

const PAY_RAW = read('inkcartridges/js/payment-page.js');
const PAY = stripComments(PAY_RAW);
const PAY_HTML = read('inkcartridges/html/payment.html');

// ─────────────────────────────────────────────────────────────────────────────
// A real CSP host-source matcher.
//
// This is the piece ERR-260 did not have. `https://*.google.com` was read as
// "Google is allowed" when it means "one registrable domain, subdomains only",
// and the Ads beacon fires at `www.google.co.nz`. The same misreading one
// domain over would have us delete `https://link.com` as covered by
// `https://*.link.com`, which it is not.
//
// Deliberately NOT a full CSP implementation — it handles the one form this
// policy uses (scheme + optional `*.` + host) and REFUSES anything else rather
// than quietly returning false, because a matcher that silently answers "no"
// to a form it cannot parse is how a guard stops guarding.
// ─────────────────────────────────────────────────────────────────────────────
function hostSourceMatches(source, url) {
  const src = /^(https?):\/\/(\*\.)?([A-Za-z0-9.-]+)$/.exec(source);
  if (!src) throw new Error(`matcher cannot parse source: ${source}`);
  const [, scheme, wildcard, host] = src;

  const target = new URL(url);
  if (target.protocol !== `${scheme}:`) return false;

  const h = target.hostname.toLowerCase();
  const want = host.toLowerCase();
  // `*.example.com` matches any subdomain (one label or many) but NOT the
  // bare domain. A bare `example.com` matches only itself.
  return wildcard ? h.endsWith(`.${want}`) : h === want;
}

/**
 * A CSP string with one source removed from every directive it appears in.
 *
 * NOT `csp.split(' ').filter(...)`. The last source in a directive is glued to
 * its `;` separator, so a naive split leaves `https://*.link.com;` in place and
 * the "mutant" is identical to the original — which made a red-proof pass while
 * proving nothing. Parse, filter, re-serialise.
 */
function withoutSource(csp, source) {
  return Object.entries(directives(csp))
    .map(([dir, srcs]) => [dir, srcs.filter(s => s !== source)])
    .map(([dir, srcs]) => [dir, ...srcs].join(' '))
    .join('; ');
}

/** Does ANY source in this directive permit `url`? */
function directivePermits(csp, directive, url) {
  const sources = directives(csp)[directive] || [];
  return sources.some(s => /^https?:\/\//.test(s) && hostSourceMatches(s, url));
}

// ─────────────────────────────────────────────────────────────────────────────
// Checks — pure functions over a string, so each can be run against a mutant.
// ─────────────────────────────────────────────────────────────────────────────

/** §1 — the seven entries this release adds, and what breaks without each. */
const REQUIRED_ADDITIONS = [
  ['frame-src',   'https://*.js.stripe.com', 'Stripe.js starts Element frames on separate origins where permitted'],
  ['frame-src',   'https://hooks.stripe.com', '3-D SECURE CHALLENGES RENDER HERE — a card needing a 3DS step has nowhere to draw it'],
  ['frame-src',   'https://link.com',        "Link's auth UI — Link was 46 of our last 173 charges"],
  ['frame-src',   'https://*.link.com',      "Link's assets (checkout.link.com, statics.link.com)"],
  ['script-src',  'https://*.js.stripe.com', 'Stripe.js on its split origins'],
  ['connect-src', 'https://link.com',        "Link's XHR"],
  ['connect-src', 'https://*.link.com',      "Link's XHR on subdomains"],
];

function missingAdditions(csp) {
  const d = directives(csp);
  return REQUIRED_ADDITIONS
    .filter(([dir, src]) => !(d[dir] || []).includes(src))
    .map(([dir, src, why]) => `${dir} is missing ${src} — ${why}`);
}

/**
 * §2 — every token that was in the policy BEFORE this change, enumerated
 * literally. ERR-260 shipped as a swap that read like an addition; this is the
 * assertion that would have caught it.
 */
const PRE_EXISTING = {
  'script-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://js.stripe.com',
    'https://www.googletagmanager.com', 'https://www.googleadservices.com',
    'https://googleads.g.doubleclick.net', 'https://static.cloudflareinsights.com',
    'https://challenges.cloudflare.com', 'https://www.paypal.com', 'https://*.paypal.com',
    'https://*.paypalobjects.com', 'https://apis.google.com',
    "'sha256-n8SeBQJ44hfg74TlDOKj4U2ORkgMfIj5ms8CC25yEBk='"],
  'connect-src': ["'self'", 'https://*.google.co.nz', 'https://api.inkcartridges.co.nz',
    'https://ink-backend-zaeq.onrender.com', 'https://*.supabase.co', 'https://*.stripe.com',
    'https://*.google-analytics.com', 'https://www.googletagmanager.com', 'https://*.google.com',
    'https://*.doubleclick.net', 'https://www.googleadservices.com', 'https://cdn.jsdelivr.net',
    'https://challenges.cloudflare.com', 'https://static.cloudflareinsights.com',
    'https://*.paypal.com', 'https://*.paypalobjects.com', 'https://fonts.googleapis.com'],
  'frame-src': ['https://js.stripe.com', 'https://pay.google.com',
    'https://challenges.cloudflare.com', 'https://*.paypal.com', 'https://*.paypalobjects.com',
    'https://www.google.com'],
};

function droppedPreExisting(csp) {
  const d = directives(csp);
  const gone = [];
  for (const [dir, tokens] of Object.entries(PRE_EXISTING)) {
    for (const tok of tokens) {
      if (!(d[dir] || []).includes(tok)) gone.push(`${dir} LOST ${tok}`);
    }
  }
  return gone;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the additions are present
// ─────────────────────────────────────────────────────────────────────────────

test('§1 the CSP carries all seven Stripe/Link entries', () => {
  assert.deepStrictEqual(missingAdditions(CSP), [],
    'Stripe documents these in its integration security guide. Each one fails ' +
    'silently in a real browser and passes every curl and every server-side ' +
    'test we own:\n  ' + missingAdditions(CSP).join('\n  '));
});

test('§1 RED-PROOF — dropping any one addition is caught', () => {
  for (const [, src] of REQUIRED_ADDITIONS) {
    // Remove just this source, everywhere it appears.
    const mutant = withoutSource(CSP, src);
    assert.notDeepStrictEqual(missingAdditions(mutant), [],
      `removing ${src} left the guard green — it is not actually checking for it`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — additions, not swaps
// ─────────────────────────────────────────────────────────────────────────────

test('§2 every pre-existing source survived — this was an addition, not a swap', () => {
  assert.deepStrictEqual(droppedPreExisting(CSP), [],
    'A source that was in the policy before this change has gone. ERR-260 shipped ' +
    'exactly this way: a swap reads like an addition in a diff of one very long ' +
    'line.\n  ' + droppedPreExisting(CSP).join('\n  '));
});

test('§2 RED-PROOF — removing a pre-existing source is caught', () => {
  const mutant = CSP.replace(' https://pay.google.com', '');
  assert.notDeepStrictEqual(droppedPreExisting(mutant), [],
    'dropping pay.google.com (Google Pay would die) left the guard green');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — the wildcards are not redundant, proved with a real matcher
// ─────────────────────────────────────────────────────────────────────────────

test('§3 the matcher itself is right about how CSP wildcards work', () => {
  // A positive control for the tool the rest of §3 depends on. Without this,
  // a matcher that always returned false would make every check below pass.
  assert.ok(hostSourceMatches('https://link.com', 'https://link.com/x'));
  assert.ok(hostSourceMatches('https://*.link.com', 'https://checkout.link.com/x'));
  assert.ok(hostSourceMatches('https://*.link.com', 'https://a.b.link.com/x'));
  assert.ok(!hostSourceMatches('https://*.link.com', 'https://link.com/x'),
    'a wildcard does NOT match the bare registrable domain');
  assert.ok(!hostSourceMatches('https://link.com', 'https://checkout.link.com/x'),
    'a bare domain does NOT match its subdomains');
  assert.ok(!hostSourceMatches('https://*.google.com', 'https://www.google.co.nz/x'),
    'ERR-260, kept here as a standing example: a wildcard on one registrable ' +
    'domain says nothing about another');
  assert.throws(() => hostSourceMatches('data:', 'https://link.com/'),
    /cannot parse source/, 'the matcher must refuse a form it cannot parse, not answer "no"');
});

test('§3 NEITHER Link entry is redundant — deleting either breaks a real URL', () => {
  // `link.com` and `*.link.com` are two different things and Stripe needs both.
  // Someone tidying one away as "covered by the other" is the realistic future
  // mistake, and it would be invisible until a customer could not pay with Link.
  const withoutBare = withoutSource(CSP, 'https://link.com');
  const withoutWild = withoutSource(CSP, 'https://*.link.com');

  for (const dir of ['frame-src', 'connect-src']) {
    assert.ok(directivePermits(CSP, dir, 'https://link.com/'),
      `${dir} must permit link.com itself`);
    assert.ok(directivePermits(CSP, dir, 'https://checkout.link.com/'),
      `${dir} must permit Link's auth subdomain`);
    assert.ok(directivePermits(CSP, dir, 'https://statics.link.com/'),
      `${dir} must permit Link's asset subdomain`);

    assert.ok(!directivePermits(withoutBare, dir, 'https://link.com/'),
      `${dir}: https://*.link.com does NOT cover https://link.com — the bare entry is required`);
    assert.ok(!directivePermits(withoutWild, dir, 'https://checkout.link.com/'),
      `${dir}: https://link.com does NOT cover checkout.link.com — the wildcard is required`);
  }
});

test('§3 NEITHER Stripe.js entry is redundant, and 3DS has a home', () => {
  const withoutWild = withoutSource(CSP, 'https://*.js.stripe.com');

  assert.ok(directivePermits(CSP, 'frame-src', 'https://js.stripe.com/'),
    'frame-src must permit js.stripe.com');
  assert.ok(directivePermits(CSP, 'frame-src', 'https://m.js.stripe.com/'),
    'frame-src must permit the split Element origins');
  assert.ok(!directivePermits(withoutWild, 'frame-src', 'https://m.js.stripe.com/'),
    'https://js.stripe.com does NOT cover m.js.stripe.com — the wildcard is required');
  assert.ok(directivePermits(CSP, 'script-src', 'https://m.js.stripe.com/'),
    'script-src must permit the split Element origins too');

  // The entry with the clearest money attached, called out by name so nobody
  // removes it while thinking about wallets.
  assert.ok(directivePermits(CSP, 'frame-src', 'https://hooks.stripe.com/'),
    'frame-src must permit hooks.stripe.com — 3-D SECURE CHALLENGES RENDER THERE. ' +
    'Without it a card that triggers a 3DS step cannot complete, and that is the ' +
    'main payment path, not the wallet row.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the policy is still a well-formed, single, strict policy
// ─────────────────────────────────────────────────────────────────────────────

test('§4 still exactly one enforced CSP header', () => {
  assert.strictEqual(cspHeaders(VERCEL_RAW).length, 1,
    'two CSP headers are an intersection nobody reads');
});

test('§4 the policy is still strict and complete', () => {
  const d = directives(CSP);
  for (const dir of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src',
    'connect-src', 'frame-src', 'frame-ancestors', 'base-uri', 'object-src', 'form-action']) {
    assert.ok(d[dir], `${dir} disappeared from the policy`);
  }
  assert.ok(!(d['script-src'] || []).includes("'unsafe-inline'"),
    "script-src must never carry 'unsafe-inline' — widening the policy is never the wallet fix");
  assert.ok(!(d['script-src'] || []).includes("'unsafe-eval'"), "no 'unsafe-eval'");
  assert.deepStrictEqual(d['frame-ancestors'], ["'none'"]);
  assert.deepStrictEqual(d['base-uri'], ["'none'"]);

  // img-src already covers *.link.com and *.stripe.com via the bare `https:`
  // scheme source, which is why this change adds nothing there. Pinned so a
  // future tightening of img-src knows it owes Link an explicit entry.
  assert.ok((d['img-src'] || []).includes('https:'),
    'img-src relies on the bare `https:` scheme source to cover Link and Stripe ' +
    'images. If you tighten img-src, add https://*.link.com and https://*.stripe.com ' +
    'explicitly — Stripe documents both.');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — wallet eligibility
// ─────────────────────────────────────────────────────────────────────────────

function missingPaymentMethods(src) {
  const problems = [];
  const m = /paymentMethods:\s*\{([^}]*)\}/.exec(src);
  if (!m) return ['the ECE passes no paymentMethods option at all'];
  if (!/applePay:\s*'always'/.test(m[1])) problems.push("applePay is not 'always'");
  if (!/googlePay:\s*'always'/.test(m[1])) problems.push("googlePay is not 'always'");
  return problems;
}

test("§5 the ECE asks for Apple Pay and Google Pay with 'always'", () => {
  assert.deepStrictEqual(missingPaymentMethods(PAY), [],
    "At the default 'auto', Stripe renders NO Apple Pay on non-Safari desktop and " +
    'NO Google Pay on Safari or any iOS browser. Those platforms are most of our ' +
    'traffic, and the wallet row took 0 of 173 charges while this option was absent.');
});

test("§5 RED-PROOF — 'auto', 'never' and a missing option are all caught", () => {
  assert.notDeepStrictEqual(missingPaymentMethods(PAY.replace(/applePay:\s*'always'/, "applePay: 'auto'")), []);
  assert.notDeepStrictEqual(missingPaymentMethods(PAY.replace(/googlePay:\s*'always'/, "googlePay: 'never'")), []);
  assert.notDeepStrictEqual(missingPaymentMethods(PAY.replace(/paymentMethods:\s*\{[^}]*\}/, 'x: 1')), []);
});

test('§5 the card Payment Element still suppresses its own wallet row', () => {
  // The whole reason 'always' above is safe: exactly one wallet surface. If this
  // ever flips to 'auto', a shopper sees Apple Pay twice.
  assert.match(PAY, /wallets:\s*\{\s*applePay:\s*'never',\s*googlePay:\s*'never'\s*\}/,
    'the card Payment Element must keep wallets:never, or the express row and the ' +
    'card tab both render a wallet button');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — the failure that could not report itself
// ─────────────────────────────────────────────────────────────────────────────

function timeoutProblems(src) {
  const problems = [];
  if (!/const ECE_READY_TIMEOUT_MS\s*=\s*\d+/.test(src)) problems.push('no ECE_READY_TIMEOUT_MS constant');
  if (!/const readyTimer = setTimeout\(/.test(src)) problems.push('no ready deadline is armed');
  if (!/clearTimeout\(readyTimer\)/.test(src)) problems.push('the deadline is never cancelled — it would fire after a real ready');
  if (!/eceStatus\s*=\s*'timeout'/.test(src)) problems.push('a timeout is not recorded as a distinct state');
  return problems;
}

test("§6 a 'ready' that never fires is caught, not waited on forever", () => {
  assert.deepStrictEqual(timeoutProblems(PAY), [],
    "When the CSP refuses the Element's frame, 'ready' NEVER fires: both branches " +
    'of the ready handler are skipped, the wrapper is never removed, an empty gap ' +
    'sits above the card form, and nothing is written anywhere. That is the state ' +
    'the wallet row was in for six months.\n  ' + timeoutProblems(PAY).join('\n  '));
});

test('§6 RED-PROOF — each half of the deadline is load-bearing', () => {
  assert.notDeepStrictEqual(timeoutProblems(PAY.replace('const readyTimer = setTimeout(', 'const readyTimer = (')), []);
  assert.notDeepStrictEqual(timeoutProblems(PAY.replace('clearTimeout(readyTimer)', 'void 0')), []);
  assert.notDeepStrictEqual(timeoutProblems(PAY.replace(/const ECE_READY_TIMEOUT_MS\s*=\s*\d+/, 'const X = 1')), []);
});

test('§6 the deadline is generous enough not to steal a slow wallet', () => {
  const ms = Number(/const ECE_READY_TIMEOUT_MS\s*=\s*(\d+)/.exec(PAY)[1]);
  assert.ok(ms >= 5000,
    `${ms}ms is too tight — a slow phone on rural mobile data would lose a wallet ` +
    'button it was going to get. The deadline is for a frame that is never coming.');
  assert.ok(ms <= 20000, `${ms}ms leaves an empty gap on screen too long`);
});

test('§6 [CONTROL] the pre-existing empty-wallet branch still removes the block', () => {
  // This predates ERR-268 and must survive it — it is the ordinary case
  // (a browser with no wallet set up), not a failure.
  assert.match(PAY, /Object\.values\(apm\)\.some\(Boolean\)/);
  assert.match(PAY, /DebugLog\.log\('Express Checkout: no eligible wallet/);
  assert.strictEqual(
    (PAY.match(/express-checkout-wrapper'\)\?\.remove\(\)/g) || []).length >= 2, true,
    'the wrapper must still be removed on both the no-wallet and timeout paths');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — the diagnosis channel: readable on production, silent by default,
//      and carrying nothing that belongs to a customer
// ─────────────────────────────────────────────────────────────────────────────

test('§7 the wallet channel is opt-in and survives the Stripe redirect', () => {
  assert.match(PAY, /wallet-debug/, 'there must be a URL flag to turn diagnosis on');
  assert.match(PAY, /const KEY = 'walletDiag'/, "the channel's storage key must be walletDiag");
  assert.match(PAY, /sessionStorage\.setItem\(KEY, '1'\)/,
    'the flag must persist in sessionStorage — Stripe redirects away and back, and a ' +
    'diagnosis you have to re-arm after every redirect is one you will lose mid-attempt');
  assert.match(PAY, /sessionStorage\.getItem\(KEY\) === '1'/,
    'the persisted flag must be what actually enables the channel');
  assert.match(PAY, /enabled:\s*on/, 'the channel must default to the flag, not to on');
  assert.match(PAY, /say\(\.\.\.parts\) \{ if \(this\.enabled\)/,
    'every print must go through the gate — a single ungated console call ships to ' +
    'every customer');
});

test('§7 CSP refusals are captured, which is what makes absence attributable', () => {
  assert.match(PAY, /addEventListener\('securitypolicyviolation'/);
  assert.match(PAY, /violatedDirective/);
  assert.match(PAY, /blockedURI/);
  // Registered in init(), before Stripe.js mounts anything.
  // Bound the slice on the NEXT METHOD DEFINITION, not on `loadCheckoutData()` —
  // that string also appears as a CALL inside init(), three lines in, which cut
  // the slice before the very ordering this test exists to check.
  const init = PAY.slice(PAY.indexOf('async init()'), PAY.indexOf('\n        loadCheckoutData() {'));
  assert.ok(init.includes('this.initStripe()'),
    'the init() slice must actually reach initStripe(), or the ordering assertion ' +
    'below is vacuous');
  assert.match(init, /this\.initWalletDiag\(\)/,
    'the listener must be registered in init() before initStripe(), or the ' +
    'refusals it exists to catch happen before it is listening');
  assert.ok(init.indexOf('this.initWalletDiag()') < init.indexOf('this.initStripe()'),
    'initWalletDiag() must run before initStripe()');
});

test('§7 the channel never prints anything that belongs to a customer', () => {
  // This file's sibling guard (console-debuglog-audit.test.js) exists because
  // payment-page.js once printed the full order payload — name, address, phone,
  // guest email — into production DevTools. The wallet channel DOES print on
  // production, so that boundary has to be re-proved here, not assumed.
  const PII = /checkoutData|orderPayload|cartItems|billingDetails|firstName|lastName|\bemail\b|\bphone\b|address1|postcode|client_secret|turnstileToken/;
  const calls = PAY.match(/\bdiag\.say\([\s\S]*?\);/g) || [];
  assert.ok(calls.length >= 5, `expected the channel to be used; found ${calls.length} calls`);
  const leaks = calls.filter(c => PII.test(c));
  assert.deepStrictEqual(leaks, [],
    'A wallet diagnosis line references customer data. This channel prints on ' +
    'PRODUCTION behind a URL flag, and URLs get shared and screenshotted:\n  ' +
    leaks.join('\n  '));
});

test('§7 RED-PROOF — the PII guard would actually fire', () => {
  const PII = /checkoutData|orderPayload|cartItems|billingDetails|firstName|lastName|\bemail\b|\bphone\b/;
  const mutant = PAY.replace(/\bdiag\.say\('ECE created/, "diag.say('leak', this.checkoutData.email");
  const calls = mutant.match(/\bdiag\.say\([\s\S]*?\);/g) || [];
  assert.ok(calls.some(c => PII.test(c)),
    'the PII pattern did not match an obvious leak — the guard above cannot fail');
});

test('§7 DebugLog is left exactly as it was', () => {
  // The tempting shortcut was to flip DebugLog._isDev on production. That would
  // have re-opened the PayPal payload exposure for anyone holding the debug URL,
  // and it would have restamped utils.js across ~34 HTML files for a one-page fix.
  const utils = read('inkcartridges/js/utils.js');
  assert.match(utils, /hostname === 'localhost'/);
  assert.doesNotMatch(PAY, /DebugLog\._isDev\s*=/,
    'payment-page.js must never write to DebugLog._isDev');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — the change actually reaches a browser
// ─────────────────────────────────────────────────────────────────────────────

test('§8 payment.html serves the payment-page.js we just edited', () => {
  const m = /payment-page\.js\?v=([0-9a-f]{8})"/.exec(PAY_HTML);
  assert.ok(m, 'payment.html must reference /js/payment-page.js with an 8-hex ?v= token');
  const expected = crypto.createHash('md5').update(fs.readFileSync(
    path.join(ROOT, 'inkcartridges/js/payment-page.js'))).digest('hex').slice(0, 8);
  assert.strictEqual(m[1], expected,
    `The cache token is stale: payment.html says ?v=${m[1]}, the file hashes to ` +
    `${expected}. Returning shoppers would keep the OLD payment-page.js out of cache ` +
    'and none of this would reach them. This is the same md5 that ' +
    'inkcartridges/scripts/stamp-versions.js computes at build time.');
});

test('§8 [CONTROL] the express checkout markup is still there to mount into', () => {
  assert.match(PAY_HTML, /id="express-checkout-wrapper"/);
  assert.match(PAY_HTML, /id="express-checkout-element"/);
  assert.ok(PAY_HTML.indexOf('express-checkout-wrapper') < PAY_HTML.indexOf('id="payment-element"'),
    'the wallet row must stay above the card form');
});
