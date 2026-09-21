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


/* ════════════════════════════════════════════════════════════════════════════
 * §7 THE FUNNEL MIRRORS — executed, because the VALUE is the bug
 *
 * Microsoft received a pageview and a purchase and nothing else, so bidding on
 * a low-volume account had one signal. view_item, add_to_cart, begin_checkout
 * and the two lead events are the rungs it can act on before a sale happens.
 *
 * THE CLAIM THIS SECTION DEFENDS is that the mirrors do NO arithmetic and hold
 * NO state. Every figure is the GA4 twin's, verbatim; every "have we sent this
 * already?" answer is the twin's too. If either stops being true the two ad
 * accounts can report different numbers for one event, with nothing spanning
 * them to notice — the failure this design is arranged to make impossible
 * rather than merely unlikely.
 *
 * AND ONE THING THAT IS NOT SYMMETRY: view_item deliberately carries no
 * revenue. See the test that says so.
 * ════════════════════════════════════════════════════════════════════════════ */

const UET_SECTION = GTAG.slice(GTAG.indexOf('const UetTag'), GTAG.indexOf('const Ga4Ecommerce'));

/** A GA4 twin's return value, shaped the way Ga4Ecommerce actually shapes it. */
const ga4Sent = (value) => (value === undefined ? { sent: true, reason: 'no-price' } : { sent: true, value });

test('§7 the UET module sends an ALLOWLISTED set of actions, and no other', () => {
    // The direct mirror of ga4-ecommerce-events-sep2026's _emit allowlist,
    // which exists because a mutation adding purchase() sailed past a blocklist
    // grep: blocklisting the one name you thought of leaves every other
    // spelling open. Here the names live as literals at the _mirror() call
    // sites and in purchase()'s own push.
    const actions = new Set([
        ...UET_SECTION.matchAll(/_mirror\('([a-z_]+)'/g),
        ...UET_SECTION.matchAll(/uetq\.push\('event', '([a-z_]+)'/g),
    ].map((m) => m[1]));

    assert.deepStrictEqual([...actions].sort(),
        ['add_to_cart', 'begin_checkout', 'purchase', 'view_item'],
        'a UET action was added or renamed. Renaming one silently retires whatever ' +
        'Microsoft goal the owner built on it: the events keep arriving, under a ' +
        'name no goal matches, counting toward nothing.');
});

test('§7 lead() cannot be talked into an arbitrary action', () => {
    // lead() takes its action from the CALLER, which is the one place this
    // module is weaker than the GA4 twin — over there every name is a literal a
    // grep can enumerate. So the set is pinned here AND enforced at runtime.
    const m = UET_SECTION.match(/LEAD_ACTIONS: \[([^\]]*)\]/);
    assert.ok(m, 'LEAD_ACTIONS is gone — lead() will accept any action a caller names');
    assert.deepStrictEqual(
        m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean),
        ['contact_form_submit', 'quote_started']);
});

test('§7 no ecomm_ remarketing variable is pushed', () => {
    // An omission recorded as a DECISION, so that "completing the set" fails
    // loudly. Microsoft documents ecomm_prodid / ecomm_pagetype /
    // ecomm_totalvalue on a standalone object push, not as event params —
    // pushing them here would be a no-op that looks like a feature.
    assert.ok(!/ecomm_/.test(UET_SECTION),
        'ecomm_* belongs on an object push and has not been verified here');
});

test('§7 ONE owner for the currency', () => {
    const literals = UET_SECTION.match(/'NZD'/g) || [];
    assert.equal(literals.length, 1, `${literals.length} 'NZD' literals — one of them will drift`);
    assert.ok(/CURRENCY: 'NZD'/.test(UET_SECTION));
});

test('§7 POSITIVE CONTROL for §4 — the consent check reads real source', () => {
    // §4 asserts an ABSENCE over comment-stripped source. A stripper that ate
    // the module would satisfy it vacuously and say nothing — six guards that
    // could not fail sat inside a 6088/0 green run (ERR-258), and this file's
    // own stripper is the naive two-regex kind that ERR-253 replaced. So: prove
    // there is still source to be absent FROM.
    assert.ok(/const UET_TAG_ID/.test(GTAG) && /const Ga4Ecommerce/.test(GTAG),
        'the comment stripper deleted live code — every absence assertion is now vacuous');
    assert.ok(UET_SECTION.length > 1000, 'the UET slice collapsed');
});

test('§7 view_item carries the SKU and, DELIBERATELY, no revenue', () => {
    // The twin's `value` at this rung is item.price — the list price of ONE
    // unit, not the value of anything that happened. Forwarding it as
    // Microsoft revenue_value would put a sticker price into a column the
    // platform may count: make view_item a conversion goal and the account's
    // Conversion Value fills with prices of things nobody bought, and ROAS is
    // computed against them. A number that is correct and means something else
    // is the dangerous kind. The rung still reports — it is the early signal
    // the whole change exists for — just without a figure nobody can defend.
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    const r = ctx.UetTag.viewItem({ sku: 'TN2330' }, ga4Sent(96.99));

    assert.equal(r.sent, true);
    assert.equal(r.reason, 'no-revenue-rung');
    assert.deepStrictEqual(plain(ctx.uetq.calls[0]), ['event', 'view_item', {
        event_category: 'ecommerce', event_label: 'TN2330',
    }]);
    // Read RAW, not through plain(): a JSON round-trip drops undefined keys, so
    // `revenue_value: undefined` — the actual bug shape — would pass silently.
    assert.equal('revenue_value' in ctx.uetq.calls[0][2], false);
    assert.equal('currency' in ctx.uetq.calls[0][2], false,
        'a currency with no figure beside it is noise');
});

test('§7 add_to_cart reads ONLY the sku from the server payload', () => {
    // The mirror gets the same `confirmed` object the twin did, carrying
    // price_snapshot and quantity. It must ignore both: the twin has already
    // run resolveAddedQuantity() over them, and `confirmed.quantity` is the
    // resulting LINE TOTAL — reading it a second time here is how a one-unit
    // add came to report $290.97 (ERR-223/BF-060).
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    const confirmed = { product: { sku: 'CF217A' }, quantity: 3, price_snapshot: 96.99 };
    const r = ctx.UetTag.addToCart(confirmed, ga4Sent(96.99));

    assert.equal(r.value, 96.99, 'the mirror multiplied something — it must do no arithmetic');
    assert.deepStrictEqual(plain(ctx.uetq.calls[0]), ['event', 'add_to_cart', {
        event_category: 'ecommerce', event_label: 'CF217A', currency: 'NZD', revenue_value: 96.99,
    }]);
});

test('§7 begin_checkout carries no event_label, and says where its figure came from', () => {
    // valueSource travels with the number because 'local' is a display-only
    // estimate and 'server' is the backend's confirmed subtotal. Both are
    // legitimate to send, but they must not be indistinguishable in the return
    // value — partialness belongs in the RETURN VALUE, not only in a comment.
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    const r = ctx.UetTag.beginCheckout({ sent: true, value: 241.5, items: 3, valueSource: 'local' });

    assert.equal(r.valueSource, 'local');
    assert.deepStrictEqual(plain(ctx.uetq.calls[0]), ['event', 'begin_checkout', {
        event_category: 'ecommerce', currency: 'NZD', revenue_value: 241.5,
    }]);
});

test('§7 POSITIVE CONTROL — a GST-divided figure would be caught', () => {
    // Without this the section could pass while reporting 13% less revenue than
    // the twin does, in an account the owner bids real money from. 115 in, 115
    // out: anything dividing by 1.15 lands on 100 and this goes red.
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    ctx.UetTag.addToCart({ product: { sku: 'X' } }, ga4Sent(115));
    assert.equal(ctx.uetq.calls[0][2].revenue_value, 115,
        '100 here means a /1.15 crept into the mirror path');
});

test("§7 POSITIVE CONTROL — the figure is the twin's, whatever it is", () => {
    // A mirror that re-derived anything could not reproduce an arbitrary
    // number. This one can, because it copies.
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    ctx.UetTag.beginCheckout({ sent: true, value: 1234.56 });
    assert.equal(ctx.uetq.calls[0][2].revenue_value, 1234.56);
});

test('§7 a twin that reported no value sends NO revenue_value, not a zero', () => {
    // Absence-as-zero pointed at an ad account: Number(undefined) is NaN, but
    // Number(null) and Number('') are both 0, and a confident $0.00 conversion
    // is worse than a missing one (ERR-063/068/073/219).
    for (const value of [undefined, null, '', 'abc', NaN]) {
        const { ctx } = runGtag();
        ctx.uetq = loadedUet();
        const r = ctx.UetTag.addToCart({ product: { sku: 'A' } }, { sent: true, value });

        assert.equal(r.sent, true, 'the rung happened — it must still be reported');
        assert.equal(r.reason, 'no-value');
        assert.equal('revenue_value' in ctx.uetq.calls[0][2], false,
            `revenue_value present for value=${String(value)} — must be ABSENT, not 0`);
        assert.equal('currency' in ctx.uetq.calls[0][2], false);
    }
});

test('§7 a genuine zero still reports as zero', () => {
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    const r = ctx.UetTag.addToCart({ product: { sku: 'A' } }, { sent: true, value: 0 });
    assert.equal(r.sent, true);
    assert.equal(ctx.uetq.calls[0][2].revenue_value, 0);
});

test('§7 THE ONE-OWNER INVARIANT — nothing is sent unless the twin sent', () => {
    // The assertion the whole design rests on. Ga4Ecommerce owns the one-shot
    // state (_sentViewItem by SKU, _sentBeginCheckout). If a mirror ever fires
    // on its own, the two ad accounts drift apart on a repeat and nothing
    // anywhere compares them.
    for (const twin of [
        undefined,
        null,
        {},
        { sent: false, reason: 'already-sent' },
        { sent: false, reason: 'no-sku' },
        { sent: 'true' },                       // truthy, but not the answer
    ]) {
        const { ctx } = runGtag();
        ctx.uetq = loadedUet();
        const r = ctx.UetTag.viewItem({ sku: 'A' }, twin);
        assert.equal(r.sent, false, `fired on twin=${JSON.stringify(twin)}`);
        assert.equal(r.reason, 'not-mirrored');
        assert.equal(ctx.uetq.calls.length, 0, `pushed on twin=${JSON.stringify(twin)}`);
    }
});

test("§7 the twin's own transport cannot strand the mirrors", () => {
    // Gating on the twin couples the mirrors to Ga4Ecommerce, so it is worth
    // being exact about what that costs. Ga4Ecommerce returns
    // { sent:false, reason:'no-gtag' } when `gtag` is not a function — which
    // would silently zero the whole Microsoft funnel while uetq was fine.
    //
    // It cannot happen HERE, and the reason is structural rather than lucky:
    // the gtag() shim is defined in THIS FILE, above both modules. Wherever
    // UetTag exists, gtag is a function, because one script delivered both.
    // An ad blocker takes googletagmanager.com, not our own shim. Pinned so
    // that moving the shim out of gtag.js has to answer this.
    assert.ok(/function gtag\(/.test(GTAG),
        'the gtag() shim left gtag.js — the mirrors can now be stranded by a GA4 transport failure');
    assert.ok(GTAG.indexOf('function gtag(') < GTAG.indexOf('const UetTag'));

    const { ctx } = runGtag();
    assert.equal(typeof ctx.gtag, 'function', 'gtag is not defined by loading gtag.js alone');
});

test('§7 a mirror fired before bat.js lands is queued, not lost', () => {
    const { ctx } = runGtag();
    ctx.uetq = [];
    ctx.UetTag.addToCart({ product: { sku: 'S' } }, ga4Sent(9.5));
    // Microsoft's documented queue form: three appended elements, not a nest.
    assert.deepStrictEqual(plain(ctx.uetq), ['event', 'add_to_cart', {
        event_category: 'ecommerce', event_label: 'S', currency: 'NZD', revenue_value: 9.5,
    }]);
});

test('§7 lead() reports an enquiry and invents no revenue for it', () => {
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    const r = ctx.UetTag.lead('contact_form_submit', { event_label: 'Bulk order' });

    assert.equal(r.sent, true);
    assert.deepStrictEqual(plain(ctx.uetq.calls[0]), ['event', 'contact_form_submit', {
        event_category: 'lead', event_label: 'Bulk order',
    }]);
});

test('§7 lead() REFUSES an action outside the allowlist', () => {
    // The executed half of the allowlist, and the reason it exists:
    // UetTag.lead('purchase', …) from any file in js/ would otherwise be a
    // second, unguarded revenue path into the account — bypassing every one of
    // markConversion()'s three dedupe guards.
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();

    for (const action of ['purchase', 'view_item', 'signup', 'Contact_Form_Submit']) {
        const r = ctx.UetTag.lead(action, { revenue_value: 999 });
        assert.equal(r.sent, false, `lead() sent '${action}'`);
        assert.equal(r.reason, 'unknown-action');
    }
    assert.equal(ctx.uetq.calls.length, 0);
});

test('§7 a lead cannot carry revenue even when handed some', () => {
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    ctx.UetTag.lead('quote_started', { revenue_value: 10, currency: 'USD' });
    assert.equal('revenue_value' in ctx.uetq.calls[0][2], false);
    assert.equal('currency' in ctx.uetq.calls[0][2], false);
});

test('§7 lead() drops a placeholder label rather than reporting it', () => {
    // A fabricated dimension is worse than a missing one: indistinguishable
    // from a real row in a report, and quietly one of the biggest (ERR-157).
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    ctx.UetTag.lead('quote_started', { event_label: 'Unknown' });
    assert.equal('event_label' in ctx.uetq.calls[0][2], false);
});

test('§7 lead() with no action sends nothing', () => {
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    assert.equal(ctx.UetTag.lead('   ').sent, false);
    assert.equal(ctx.uetq.calls.length, 0);
});

test('§7 nothing a mirror does reaches the caller as a throw', () => {
    const { ctx } = runGtag();
    ctx.uetq = { push() { throw new Error('bat.js exploded'); } };
    assert.equal(ctx.UetTag.viewItem({ sku: 'A' }, ga4Sent(1)).reason, 'threw');
    assert.equal(ctx.UetTag.lead('quote_started').reason, 'threw');
});

test('§7 every action a goal can be built on, in one place', () => {
    const { ctx } = runGtag();
    ctx.uetq = loadedUet();
    ctx.UetTag.viewItem({ sku: 'A' }, ga4Sent(1));
    ctx.UetTag.addToCart({ product: { sku: 'A' } }, ga4Sent(1));
    ctx.UetTag.beginCheckout(ga4Sent(1));
    ctx.UetTag.lead('contact_form_submit');
    ctx.UetTag.lead('quote_started');

    assert.deepStrictEqual(ctx.uetq.calls.map((c) => c[1]),
        ['view_item', 'add_to_cart', 'begin_checkout', 'contact_form_submit', 'quote_started']);
});


/* ════════════════════════════════════════════════════════════════════════════
 * §8 THE CALL SITES — where a mirror stops being a mirror
 *
 * A module nobody calls is the ERR-194/ERR-214 shape: cart-analytics.js sat on
 * three pages behind a `typeof` guard that was an off-switch at every real
 * entry point, and add_to_cart recorded 56 events in its entire history while
 * looking fine. §7 proves the mirrors behave; §8 proves they are wired, and
 * wired in the one position where they inherit the guards they depend on.
 *
 * EVERY SLICE SELF-VALIDATES. An earlier §6 anchored on `markConversion()` and
 * silently matched the CALL SITE thirty characters earlier, so the whole
 * section read the wrong function. quote-page.js makes that trap live again:
 * `markStarted()` has five call sites and one definition.
 * ════════════════════════════════════════════════════════════════════════════ */

const SITES = {
    pdp: codeOnly(fs.readFileSync(path.join(INK, 'js', 'product-detail-page.js'), 'utf8')),
    cart: codeOnly(fs.readFileSync(path.join(INK, 'js', 'cart.js'), 'utf8')),
    checkout: codeOnly(fs.readFileSync(path.join(INK, 'js', 'checkout-page.js'), 'utf8')),
    contact: codeOnly(fs.readFileSync(path.join(INK, 'js', 'contact-page.js'), 'utf8')),
    quote: codeOnly(fs.readFileSync(path.join(INK, 'js', 'quote-page.js'), 'utf8')),
};

/** A bounded slice whose START ANCHOR IS PROVEN UNIQUE before anything reads it. */
function region(src, start, end, proof, label) {
    const a = src.indexOf(start);
    assert.ok(a !== -1, `${label}: start anchor is gone — ${start}`);
    assert.equal(src.indexOf(start, a + 1), -1,
        `${label}: the start anchor matches more than once. A slice anchor that can ` +
        `match two things is a test pointed somewhere nobody checked.`);
    const b = src.indexOf(end, a);
    assert.ok(b > a, `${label}: end anchor is gone — ${end}`);
    const body = src.slice(a, b);
    for (const re of proof) {
        assert.ok(re.test(body), `${label}: the slice does not contain ${re} — the anchor moved`);
    }
    return body;
}

test('§8 view_item mirrors only what the twin reported, behind the test-product gate', () => {
    const body = region(SITES.pdp,
        "if (typeof Ga4Ecommerce !== 'undefined' && !this._isTestProduct",
        'this.loadReviews();',
        [/Ga4Ecommerce\.viewItem/], 'pdp view_item');

    assert.ok(/UetTag\.viewItem/.test(body), 'the UET twin is not wired on the PDP');
    assert.ok(body.indexOf('Ga4Ecommerce.viewItem') < body.indexOf('UetTag.viewItem'),
        'the mirror runs BEFORE the twin — it cannot be mirroring a result that does not exist yet');
    // The one-shot guard for this rung is _sentViewItem, inside Ga4Ecommerce.
    // The mirror must consume the twin's answer, not re-ask the question.
    assert.ok(/UetTag\.viewItem\(this\.product, \w+\)/.test(body),
        'the mirror is not passed the GA4 result — it now has an opinion of its own about repeats');
    // ERR-234/246: an operator on the control SKU is not a shopper. One gate, both datasets.
    assert.ok(body.indexOf('_isTestProduct') < body.indexOf('UetTag.viewItem'));
});

test('§8 add_to_cart mirrors inside the serverConfirmed gate, and derives nothing', () => {
    const body = region(SITES.cart,
        "if (serverConfirmed && typeof Ga4Ecommerce !== 'undefined')",
        '_showCrossSellModal(crossSellPayload)',
        [/Ga4Ecommerce\.addToCart/], 'cart add_to_cart');

    assert.ok(/UetTag\.addToCart/.test(body), 'the UET twin is not wired in cart.js');
    assert.ok(body.indexOf('Ga4Ecommerce.addToCart') < body.indexOf('UetTag.addToCart'));
    assert.ok(/UetTag\.addToCart\(serverConfirmed, \w+\)/.test(body),
        'the mirror is not passed the GA4 result');

    // An add the server refused is not an add. `serverConfirmed` is the whole
    // mechanism and there is deliberately no second condition to keep in sync.
    assert.ok(body.indexOf('UetTag.addToCart') > body.indexOf('serverConfirmed'));

    // NO ARITHMETIC AT THE CALL SITE. resolveAddedQuantity() ran once, in the
    // twin. `serverConfirmed.quantity` is the resulting LINE TOTAL, and a
    // second reader of it is how one $96.99 add reported $290.97 (ERR-223).
    const mirror = body.slice(body.indexOf('UetTag.addToCart'));
    assert.ok(!/quantity|price_snapshot|\*/.test(mirror),
        'the mirror touches a quantity or a price — it must copy the twin, not recompute');
});

test('§8 begin_checkout mirrors the twin, which still takes no argument', () => {
    const body = region(SITES.checkout,
        "if (typeof Ga4Ecommerce !== 'undefined') {",
        'checkGuestCheckoutFlag',
        [/Ga4Ecommerce\.beginCheckout/], 'checkout begin_checkout');

    assert.ok(/UetTag\.beginCheckout\(\w+\)/.test(body), 'the UET twin is not wired on checkout');
    assert.ok(/Ga4Ecommerce\.beginCheckout\(\)/.test(body),
        'beginCheckout() must keep its empty parens — the GA4 suite matches that literal');
    assert.ok(body.indexOf('Ga4Ecommerce.beginCheckout') < body.indexOf('UetTag.beginCheckout'));
});

test('§8 the contact lead fires on the SUCCESS branch only', () => {
    // A failed send is not an enquiry. A conversion that did not happen is one
    // the owner bids real money on.
    const body = region(SITES.contact,
        'send(payload).then(function () {',
        '}).catch(function (err) {',
        [/contact_form_submit/], 'contact lead');

    assert.ok(/UetTag\.lead\('contact_form_submit'/.test(body),
        'the contact lead is not wired, or sits outside the success handler');
    // And nowhere else in the file — the catch branch and the retry path must
    // not reach it.
    assert.equal((SITES.contact.match(/UetTag\.lead/g) || []).length, 1);
});

test('§8 the quote lead fires from markStarted(), NOT from track()', () => {
    // markStarted() owns `started`, the once-flag for this event. track() is
    // shared with quote events that are not conversions, so a mirror placed
    // there would fire on every one of them. markStarted() also has five call
    // sites and one definition, which is exactly the anchor trap §6 already
    // fell into once — hence the `function ` prefix.
    const body = region(SITES.quote,
        'function markStarted() {',
        'function reducedMotion()',
        [/started = true/, /track\('quote_started'\)/], 'quote lead');

    assert.ok(/UetTag\.lead\('quote_started'\)/.test(body), 'the quote lead is not in markStarted()');
    assert.ok(body.indexOf('started = true') < body.indexOf('UetTag.lead'),
        'the mirror sits above the once-flag — every keystroke would report a conversion');

    const track = region(SITES.quote, 'function track(eventName, params) {', '\n    }\n',
        [/gtag/], 'quote track()');
    assert.ok(!/UetTag/.test(track),
        'the mirror moved into track(), which is shared with non-conversion events');
    assert.equal((SITES.quote.match(/UetTag\.lead/g) || []).length, 1);
});

test('§8 every new call site guards on typeof UetTag', () => {
    // gtag.js is a blocking head script on all 38 storefront pages, so UetTag
    // is in fact always there. The guard is kept anyway because its absence is
    // the difference between a dead analytics line and a dead page.
    for (const [name, src] of Object.entries(SITES)) {
        const calls = (src.match(/UetTag\.\w+/g) || []).length;
        assert.ok(calls >= 1, `${name}: no UetTag call site`);
        assert.ok(/typeof UetTag !== 'undefined'/.test(src), `${name}: unguarded UetTag reference`);
    }
});

test('§8 every page with a call site actually loads gtag.js', () => {
    // The enrolment fact, asked of the HTML rather than assumed. This is the
    // claim that UET adds no new surface to maintain: its reach IS gtag.js's.
    const owners = {
        'product-detail-page.js': 1, 'cart.js': 33, 'checkout-page.js': 1,
        'contact-page.js': 1, 'quote-page.js': 1,
    };
    const pages = htmlFiles().map((f) => [f, fs.readFileSync(f, 'utf8')]);

    for (const [controller, expected] of Object.entries(owners)) {
        const hosts = pages.filter(([, html]) => html.includes(`/js/${controller}`));
        assert.equal(hosts.length, expected,
            `${controller} is loaded by ${hosts.length} pages, expected ${expected}`);
        for (const [file, html] of hosts) {
            assert.ok(/src="\/js\/gtag\.js(\?v=[a-f0-9]+)?"/.test(html),
                `${path.basename(file)} loads ${controller} but NOT gtag.js — UetTag is undefined there`);
        }
    }
});
