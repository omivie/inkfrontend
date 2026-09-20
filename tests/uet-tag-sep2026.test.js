/**
 * MICROSOFT ADVERTISING UET TAG — install, CSP, and the purchase conversion
 * =========================================================================
 *
 * The Microsoft Ads account held a UET tag named INKCART in state `Unverified`,
 * which does not mean broken — it means NEVER INSTALLED. There was no `uetq`,
 * no `bat.bing.com`, no `msclkid` anywhere in this repo, so every dollar of
 * Microsoft ad spend was being judged on clicks with no idea which ones paid
 * for themselves.
 *
 * WHAT THIS FILE IS DEFENDING AGAINST, AND WHY EACH SECTION EXISTS
 * ----------------------------------------------------------------
 * §1 CSP. This is the third tracking tag to meet this policy and the previous
 *    two both failed SILENTLY (ERR-225 PayPal, ERR-260 the Ads conversion
 *    beacon). `bat.bing.com` must be in BOTH script-src and connect-src, and
 *    the two fail differently: script-src blocks bat.js outright and is
 *    obvious, connect-src blocks only the fetch/sendBeacon transport while
 *    `img-src 'self' https: data:` keeps the PIXEL transport alive — so the tag
 *    looks healthy while conversions vanish. That was one of ERR-260's three
 *    alibis. §1 also pins the addition as an ADDITION: a swap reads exactly
 *    like an addition in a diff of one very long line.
 *
 * §2 The tag id. An empty id is a tag that does nothing, and a tag that does
 *    nothing is indistinguishable from a tag that works — no console error, no
 *    failed request. A SKIP IS NOT A PASS, so this section goes RED while the
 *    id is unset. It cannot ship disabled by accident.
 *
 * §3 Placement. tests/ga4-ecommerce-events-sep2026.test.js slices gtag.js from
 *    `indexOf('const Ga4Ecommerce')` TO END OF FILE and asserts exactly one
 *    `gtag('event'` in that window. New code appended to the bottom of the file
 *    lands inside an assertion window built for something else, where it would
 *    pass or fail for reasons nobody intended (the ERR-256 lesson: a window
 *    anchored on one function tests where the code lives, not the claim). So
 *    UetTag sits ABOVE Ga4Ecommerce, and §3 re-asserts THEIR invariant to prove
 *    this change did not quietly alter it.
 *
 * §4 Consent. ERR-227: gtag.js declares only `analytics_storage`, an undeclared
 *    type is GRANTED under Consent Mode, and that is a deliberate revenue
 *    decision. The reflexive "complete the list" move — declaring a UET consent
 *    default — would restrict Microsoft for 100% of visitors and, if ever
 *    miswired, stay denied FOREVER WITH NO SYMPTOM. §4 pins the absence.
 *
 * §5 Behaviour, executed rather than grepped. The VALUE is the bug: a revenue
 *    figure of 0 where the server reported nothing is the absence-as-zero shape
 *    (ERR-063/068/073/219) pointed at an ad account. `assert.match(/revenue/)`
 *    cannot see a value, so §5 runs gtag.js in a VM and reads back what was
 *    actually pushed. Carries a POSITIVE CONTROL so it cannot pass vacuously.
 *
 * §6 The call site, which is where the money actually is.
 *
 * Run with: node --test tests/uet-tag-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
/* UET_TEST_ROOT points the whole suite at a COPY of the tree. It exists so the
 * red-proof (scripts/redproof-uet.sh) can mutate sources and confirm each
 * assertion actually fails, WITHOUT editing live files — several Claude
 * sessions work in this repo at once and a peer's sweeping commit can deploy
 * somebody else's half-edited file. A guard nobody has watched fail is a guess
 * (ERR-258). Unset in normal runs. */
const INK = process.env.UET_TEST_ROOT
    ? path.resolve(process.env.UET_TEST_ROOT)
    : path.join(ROOT, 'inkcartridges');

const GTAG_SRC = fs.readFileSync(path.join(INK, 'js', 'gtag.js'), 'utf8');
const CONF_SRC = fs.readFileSync(path.join(INK, 'js', 'order-confirmation-page.js'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(INK, 'vercel.json'), 'utf8'));

/** Source with comments stripped. An assertion must never be satisfied by the
 *  prose explaining the thing it is checking for — a comment that NAMES a thing
 *  is not that thing (ERR-224, and four times over in ERR-276). */
function codeOnly(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const GTAG = codeOnly(GTAG_SRC);
const CONF = codeOnly(CONF_SRC);

const UET_HOST = 'https://bat.bing.com';

function cspValue() {
    const found = [];
    for (const rule of VERCEL.headers || []) {
        for (const h of rule.headers || []) {
            if (h.key.toLowerCase() === 'content-security-policy') found.push(h.value);
        }
    }
    assert.equal(found.length, 1, `expected exactly 1 CSP header, found ${found.length}`);
    return found[0];
}

function directives(csp) {
    const out = {};
    for (const part of csp.split(';')) {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length) out[tokens[0]] = tokens.slice(1);
    }
    return out;
}

const CSP = cspValue();
const D = directives(CSP);


/* ── §1 CSP ──────────────────────────────────────────────────────────────── */

test('§1 bat.bing.com is in script-src — without it bat.js never loads', () => {
    assert.ok(D['script-src'].includes(UET_HOST),
        'script-src is missing https://bat.bing.com — the UET tag cannot load at all');
});

test('§1 bat.bing.com is in connect-src — THIS is the half that hides', () => {
    // img-src is 'self' https: data:, so UET's pixel transport works whether or
    // not this entry exists. Only the fetch/sendBeacon transport is governed by
    // connect-src. Drop this and the tag still looks alive in every casual
    // check while conversions go missing — ERR-260, exactly.
    assert.ok(D['connect-src'].includes(UET_HOST),
        'connect-src is missing https://bat.bing.com — the pixel will still fire, ' +
        'so this will NOT look broken; conversions will just quietly not arrive');
});

test('§1 it is an exact host, not a wildcard', () => {
    // ERR-260 cuts both ways: `*.google.com` did not match `www.google.co.nz`,
    // so a wildcard is narrower than it looks — and a host nobody measured is
    // not a host worth granting. Microsoft serves UET from one origin.
    const wild = [...D['script-src'], ...D['connect-src']].filter((t) => /bing|microsoft|msn/i.test(t));
    assert.deepStrictEqual([...new Set(wild)], [UET_HOST],
        'only https://bat.bing.com should be granted; a wildcard grants hosts nobody measured');
});

test('§1 the UET host was ADDED, not swapped in for something else', () => {
    // Every token in the policy immediately BEFORE this change, enumerated
    // literally. ERR-260 shipped as a swap that read like an addition, because
    // the whole policy is one very long line in a diff.
    //
    // This lives here rather than in tests/stripe-wallet-csp-sep2026.test.js.
    // That file's PRE_EXISTING map is documented as the state before THAT
    // change; appending later additions to it would make its own comment untrue
    // and leave two files owning one fact. One owner (ERR-253).
    const PRE_EXISTING = {
        'script-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://js.stripe.com',
            'https://www.googletagmanager.com', 'https://www.googleadservices.com',
            'https://googleads.g.doubleclick.net', 'https://static.cloudflareinsights.com',
            'https://challenges.cloudflare.com', 'https://www.paypal.com', 'https://*.paypal.com',
            'https://*.paypalobjects.com', 'https://apis.google.com', 'https://*.js.stripe.com',
            "'sha256-n8SeBQJ44hfg74TlDOKj4U2ORkgMfIj5ms8CC25yEBk='"],
        'connect-src': ["'self'", 'https://*.google.co.nz', 'https://api.inkcartridges.co.nz',
            'https://ink-backend-zaeq.onrender.com', 'https://*.supabase.co', 'https://*.stripe.com',
            'https://*.google-analytics.com', 'https://www.googletagmanager.com',
            'https://*.google.com', 'https://*.doubleclick.net', 'https://www.googleadservices.com',
            'https://cdn.jsdelivr.net', 'https://challenges.cloudflare.com',
            'https://static.cloudflareinsights.com', 'https://*.paypal.com',
            'https://*.paypalobjects.com', 'https://fonts.googleapis.com', 'https://link.com',
            'https://*.link.com'],
    };
    const gone = [];
    for (const [dir, tokens] of Object.entries(PRE_EXISTING)) {
        for (const tok of tokens) {
            if (!(D[dir] || []).includes(tok)) gone.push(`${dir} LOST ${tok}`);
        }
    }
    assert.deepStrictEqual(gone, [], 'adding the UET host must not remove anything');
});

test('§1 no inline script was introduced anywhere (ERR-230)', () => {
    // Microsoft hands you an inline <script>. The rule here is EXTERNALISE,
    // never add a hash: a hash pins a blob no tool in this repo can read.
    const offenders = [];
    for (const file of htmlFiles()) {
        const src = fs.readFileSync(file, 'utf8');
        const re = /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/gi;
        if (re.test(src) && /bat\.bing|uetq|UET\(/i.test(src)) {
            offenders.push(path.relative(ROOT, file));
        }
    }
    assert.deepStrictEqual(offenders, [],
        'the UET snippet must never be pasted inline — script-src has no unsafe-inline');
});


/* ── §2 THE TAG ID — RED UNTIL IT IS REAL ────────────────────────────────── */

test('§2 UET_TAG_ID is a real Microsoft tag id, not an empty placeholder', () => {
    const m = GTAG.match(/const UET_TAG_ID\s*=\s*'([^']*)'/);
    assert.ok(m, 'UET_TAG_ID is not declared in gtag.js');
    assert.match(m[1], /^\d{7,9}$/,
        'UET_TAG_ID is empty or not a Microsoft tag id.\n' +
        '  Microsoft Advertising -> Conversion tracking -> UET tag (INKCART).\n' +
        '  The snippet shows it as ti:"########".\n' +
        '  This assertion is deliberately RED while unset: an empty id ships a tag\n' +
        '  that silently does nothing, which looks exactly like one that works.');
});


/* ── §3 PLACEMENT — do not disturb the GA4 assertion window ──────────────── */

test('§3 UetTag is defined ABOVE Ga4Ecommerce', () => {
    const uet = GTAG_SRC.indexOf('const UetTag');
    const ga4 = GTAG_SRC.indexOf('const Ga4Ecommerce');
    assert.ok(uet !== -1, 'UetTag is not defined');
    assert.ok(ga4 !== -1, 'Ga4Ecommerce is not defined');
    assert.ok(uet < ga4,
        'UetTag must sit above Ga4Ecommerce. The GA4 suite slices this file from ' +
        'Ga4Ecommerce to EOF and asserts on what it finds; code below that point is ' +
        'judged by assertions written for something else.');
});

test("§3 the GA4 slice window still holds exactly one gtag('event') call", () => {
    // Their invariant, re-asserted here, so this change is proven not to have
    // moved it rather than assumed not to have.
    const ga4Section = GTAG.slice(GTAG.indexOf('const Ga4Ecommerce'));
    const doors = (ga4Section.match(/gtag\('event'/g) || []).length;
    assert.equal(doors, 1, `${doors} gtag('event') calls below Ga4Ecommerce — must be exactly 1`);
});

test('§3 UET does not route through gtag() at all', () => {
    // Different platform, different transport. A gtag() call here would reach
    // the configured Google destinations, not Microsoft.
    const uetSection = GTAG.slice(GTAG.indexOf('const UetTag'), GTAG.indexOf('const Ga4Ecommerce'));
    assert.ok(!/gtag\(/.test(uetSection), 'the UET module must not call gtag()');
    assert.ok(/uetq\.push/.test(uetSection), 'the UET module must push to uetq');
});


/* ── §4 CONSENT — pinning an ABSENCE (ERR-227) ───────────────────────────── */

test('§4 no UET consent default is declared', () => {
    assert.ok(!/uetq\.push\(\s*'consent'/.test(GTAG),
        'Declaring a UET consent default is the reflexive "complete the list" move. ' +
        'ad_storage is GRANTED today by deliberate omission (ERR-227); restricting ' +
        'Microsoft alone would diverge from the Ads posture with nothing reconciling them.');
});

test('§4 the gtag consent default still declares ONLY analytics_storage', () => {
    const block = GTAG.match(/gtag\('consent',\s*'default',\s*\{([\s\S]*?)\}\)/);
    assert.ok(block, 'the consent default block is gone');
    assert.ok(/analytics_storage/.test(block[1]));
    assert.ok(!/ad_storage|ad_user_data|ad_personalization/.test(block[1]),
        'adding an ad_* type here silently switches off ad measurement (ERR-227)');
});

test('§4 no auto SPA tracking — it would duplicate pageviews, not add them', () => {
    assert.ok(!/enableAutoSpaTracking/.test(GTAG),
        'this site is 34 real HTML pages; SPA tracking would double-count views');
});


/* ── §5 BEHAVIOUR, EXECUTED — the value is the bug ───────────────────────── */

/** Runs gtag.js against a fake DOM and returns what it did. */
function runGtag() {
    const scripts = [];
    const store = new Map();
    const ctx = {
        console,
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
        },
        document: {
            createElement: () => ({ set src(v) { this._src = v; }, get src() { return this._src; } }),
            head: { appendChild: (el) => scripts.push(el) },
            documentElement: { appendChild: (el) => scripts.push(el) },
        },
    };
    // window IS the global here, so `window.x = y` creates a global exactly as
    // it does in a browser — which is how gtag.js's own `window.dataLayer` and
    // `window.uetq` assignments are meant to behave.
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(GTAG_SRC, ctx, { filename: 'gtag.js' });
    return { ctx, scripts };
}

test('§5 init() requests bat.js over explicit https', () => {
    const { scripts } = runGtag();
    const bat = scripts.filter((s) => /bat\.bing\.com/.test(s.src || ''));
    // With an empty tag id the loader correctly declines, so this asserts the
    // URL only when a tag is configured — §2 is what makes the id real.
    if (bat.length) {
        assert.equal(bat[0].src, 'https://bat.bing.com/bat.js',
            'protocol-relative // urls are not what the CSP entry spells');
    }
});

test('§5 an empty tag id is reported, never swallowed', () => {
    const { ctx } = runGtag();
    const m = GTAG.match(/const UET_TAG_ID\s*=\s*'([^']*)'/);
    if (m && !m[1]) {
        // Fail-soft must be LOUD: partialness belongs in the RETURN VALUE.
        const r = ctx.UetTag.init();
        assert.equal(r.loaded, false);
        assert.equal(r.reason, 'no-tag-id',
            'a disabled tag must say WHY in its return value, not just do nothing');
    }
});

/* A loaded bat.js replaces the array with a real UET object. Both states are
 * reachable on a receipt page — the purchase can fire before OR after the ad
 * script arrives — so both are tested. `calls` records whole argument lists. */
function loadedUet() {
    const calls = [];
    return { calls, push: (...args) => calls.push(args) };
}

/* Values that came out of the VM must be normalised before comparison.
 * A vm realm has its OWN Object/Array prototypes, so a deep-equal against a
 * literal declared here fails with "same structure but not reference-equal" on
 * a value that is entirely correct — a red test that looks like a real defect
 * and is not one. Note node:assert/strict makes deepEqual an alias for
 * deepStrictEqual, so "just use the loose one" is not available. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test('§5 purchase() reports the server total as revenue (loaded tag)', () => {
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    const r = ctx.UetTag.purchase({ total: 96.99, orderNumber: '2026092101' });

    assert.equal(r.sent, true);
    assert.equal(r.value, 96.99);
    assert.deepStrictEqual(plain(ctx.uetq.calls[0]), ['event', 'purchase',
        { currency: 'NZD', transaction_id: '2026092101', revenue_value: 96.99 }]);
});

test('§5 a purchase fired BEFORE bat.js lands is queued, not lost', () => {
    // The whole reason window.uetq is seeded as an array before the script is
    // requested. A confirmation page can easily beat an async ad script, and a
    // conversion dropped for that reason would be invisible: fewer sales in the
    // account than in the database, with nothing pointing at the cause.
    //
    // On a plain array, push('event','purchase',{...}) appends THREE elements.
    // That is Microsoft's documented queue form — bat.js reads the array back as
    // one call when it constructs UET with `q`. Asserted literally so that if
    // the shape is ever "tidied" into a nested array, this says so.
    const { ctx } = runGtag();
    ctx.uetq = [];
    const r = ctx.UetTag.purchase({ total: 5.99, orderNumber: 'Q1' });

    assert.equal(r.sent, true);
    assert.deepStrictEqual(plain(ctx.uetq), ['event', 'purchase',
        { currency: 'NZD', transaction_id: 'Q1', revenue_value: 5.99 }]);
});

test('§5 POSITIVE CONTROL — a GST-divided total would be caught', () => {
    // The guard against this section passing vacuously. Ad platforms want the
    // shopper-facing, GST-INCLUSIVE price; a /1.15 anywhere in this path would
    // under-report revenue by 13% in an account that bids real money.
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    ctx.UetTag.purchase({ total: 115, orderNumber: 'X1' });
    assert.equal(ctx.uetq.calls[0][2].revenue_value, 115,
        'revenue must be GST-inclusive — 100 here would mean a /1.15 crept in');
    assert.ok(!/\/\s*1\.15/.test(GTAG), 'no /1.15 anywhere in gtag.js');
});

test('§5 a missing total reports the conversion WITHOUT inventing a zero', () => {
    // Number(null) is 0 and so is Number(''). Coercing first and range-checking
    // after turns "the server reported no total" into a confident $0.00 sale —
    // the absence-as-zero shape, here pointed at an ad account.
    const { ctx } = runGtag();
    for (const total of [null, undefined, '', 'abc', NaN]) {
        ctx.uetq = loadedUet();
        const r = ctx.UetTag.purchase({ total, orderNumber: 'X2' });
        assert.equal(r.sent, true, 'the purchase really happened; still report it');
        assert.equal(r.reason, 'no-value');
        assert.ok(!('revenue_value' in ctx.uetq.calls[0][2]),
            `total=${String(total)} produced a revenue_value — absence became a number`);
    }
});

test('§5 a genuine zero still reports as zero', () => {
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    const r = ctx.UetTag.purchase({ total: 0, orderNumber: 'X3' });
    assert.equal(r.sent, true);
    assert.equal(ctx.uetq.calls[0][2].revenue_value, 0,
        'a genuine 0 is data; only ABSENCE may be omitted');
});

test('§5 no order number means no conversion', () => {
    const { ctx } = runGtag();
    ctx.uetq = [];
    const r = ctx.UetTag.purchase({ total: 10 });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-order-number');
    assert.equal(ctx.uetq.length, 0,
        'without a transaction_id Microsoft cannot dedupe — do not send it');
});

test('§5 nothing thrown reaches the caller', () => {
    // An analytics tag is never worth breaking a receipt page over.
    const { ctx } = runGtag();
    ctx.uetq = { push() { throw new Error('boom'); } };
    const r = ctx.UetTag.purchase({ total: 1, orderNumber: 'X4' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'threw');
});


/** The body of markConversion(), anchored on its DEFINITION.
 *  An earlier version of this file anchored on `markConversion()` and silently
 *  matched the CALL SITE `markConversion();` 30 characters earlier, so every
 *  §6 assertion was reading a slice of the wrong function. A slice anchor that
 *  can match two things is a test pointed somewhere nobody checked. */
function markConversionBody() {
    const start = CONF.indexOf('markConversion() {');
    assert.ok(start !== -1, 'markConversion() definition is gone');
    const end = CONF.indexOf('\n        },', start);
    assert.ok(end > start, 'could not find the end of markConversion()');
    const body = CONF.slice(start, end);
    // Prove the slice is the real thing before anything asserts against it.
    assert.ok(/_conversionFired/.test(body) && /ink_conversion_recorded/.test(body),
        'the markConversion() slice does not contain its own guards — anchor moved');
    return body;
}

/* ── §6 THE CALL SITE ────────────────────────────────────────────────────── */

test('§6 the purchase fires from inside markConversion(), below all three guards', () => {
    const body = markConversionBody();

    assert.ok(/UetTag\.purchase/.test(body),
        'the UET purchase must live inside markConversion(), which owns the dedupe');

    // Below the latch, not above it: the guards are the whole reason a refreshed
    // receipt does not report a second full-value sale.
    assert.ok(body.indexOf('_conversionFired = true') < body.indexOf('UetTag.purchase'),
        'the UET call sits above the per-pageload latch — a reload would double-count');
    assert.ok(/_paymentSucceeded/.test(body));
    assert.ok(/ink_conversion_recorded/.test(body));
});

test('§6 UET and Ads are fed the same two fields from the same object', () => {
    const body = markConversionBody();
    const ads = body.slice(body.indexOf("gtag('event', 'conversion'"));
    const uet = body.slice(body.indexOf('UetTag.purchase'));

    for (const field of ['order.total', 'order.orderNumber']) {
        assert.ok(ads.includes(field), `the Ads conversion no longer reads ${field}`);
        assert.ok(uet.includes(field), `the UET conversion does not read ${field}`);
    }
    // Structural parity: two ad accounts cannot be told different numbers for
    // the same order, because neither derives the number.
    assert.ok(!/\/\s*1\.15/.test(body), 'no GST division at the conversion call site');
});

test('§6 UetTag is only called where gtag.js is actually loaded', () => {
    // ERR-167/ERR-214: a global referenced on a page that never loads its
    // runtime is a no-op that looks like a feature.
    const conf = fs.readFileSync(path.join(INK, 'html', 'order-confirmation.html'), 'utf8');
    assert.match(conf, /src="\/js\/gtag\.js(\?v=[a-f0-9]+)?"/,
        'order-confirmation.html does not load gtag.js, so UetTag would be undefined there');
});

test('§6 enrolment is structurally identical to GA4 — no separate surface', () => {
    // ERR-214: markup hash-locked across 30 pages, the runtime enrolled BY HAND,
    // and 10 pages drifted for four months while looking fine. UET introduces no
    // new enrolment fact to maintain BECAUSE it rides inside gtag.js. This pins
    // that claim from both ends.
    const pages = htmlFiles().filter((f) =>
        /src="\/js\/gtag\.js(\?v=[a-f0-9]+)?"/.test(fs.readFileSync(f, 'utf8')));
    assert.ok(pages.length >= 35, `gtag.js on only ${pages.length} pages — the anchor moved`);

    // (a) no second runtime file to enrol
    const strays = fs.readdirSync(path.join(INK, 'js'))
        .filter((f) => /^(uet|bing|bat)[-.]/i.test(f));
    assert.deepStrictEqual(strays, [],
        'a separate UET runtime file means a second hand-maintained enrolment set');

    // (b) no page loads a UET script directly. If one ever did, UET's reach and
    //     gtag.js's reach would be two different sets that no assertion spans.
    const direct = htmlFiles()
        .filter((f) => /bat\.bing\.com|\/js\/uet/i.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(ROOT, f));
    assert.deepStrictEqual(direct, [],
        'UET must reach pages only via gtag.js, so its enrolment cannot drift from GA4\'s');
});


/** Every .html in the deployed tree. */
function htmlFiles(dir = INK, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) htmlFiles(full, out);
        else if (entry.name.endsWith('.html')) out.push(full);
    }
    return out;
}
