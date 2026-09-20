/**
 * Duplicate value packs retired — FE follow-through (ERR-277, Sep 2026)
 * =====================================================================
 *
 * The backend retired 17 duplicate value-pack SKUs and sent
 * `duplicate-pack-retirement-FE-handoff-sep2026.md`. Its headline is "no code
 * changes, and no cache purge either" — and verified against the live API and a
 * real browser on 2026-09-20, every claim it makes is accurate:
 *
 *   · all 17 retired SKUs 301 to the documented survivor
 *   · a browser FOLLOWS those 301s, even though the catalogue GET is
 *     preflighted (api.js sends `Content-Type: application/json` on a bodyless
 *     GET, which is not a CORS-safelisted value) — curl could not have settled
 *     that, so it was measured in the page with positive and negative controls
 *   · /p/CT081KCMY lands on the survivor PDP with a self-referencing canonical
 *   · no retired SKU is hardcoded anywhere in shipped JS
 *
 * What the hand-off could not know is what those now-dead SKUs were holding up
 * on OUR side. This suite pins the three things that came out of that.
 *
 * §1 THE SKU VETO — the one that changes behaviour
 * ------------------------------------------------
 * §4 of the hand-off asks us to remove any client-side dedup that hides these
 * cards, and warns that a name-based dedup is "actively risky" because HP
 * DesignJet sells one series in several volumes (G728130MLCMY $583.49 vs
 * G728300MLCMY $1158.49 — both live, both in the `728` drilldown, verified
 * 2026-09-20) which a loose comparison reads as duplicates.
 *
 * The card surfaces were already clean: `ProductIdentity.markLookalikes`
 * (utils.js, ERR-195) MARKS look-alikes with their SKU and never filters, and
 * six tests pin that it never removes or reorders a row. Its header says why:
 * deciding two database rows are "the same product" is an assertion of identity
 * the frontend cannot make, and the row we hid would be the one the customer
 * wanted.
 *
 * But the /search union path did exactly that. `productIdentityKeys` emitted a
 * normalized-name key, and `mergeLiteralResults` treated ANY shared key as
 * "same product" — so two rows with DIFFERENT, KNOWN SKUs collapsed to one card
 * whenever their titles normalized equal, and the survivor was whichever came
 * first. A live scan of all 4,066 active products found zero name collisions on
 * 2026-09-20, so this was latent rather than firing — but the generator has
 * re-minted duplicate twins FOUR times (05-11, 05-29, 06-16, 08-31) and the
 * first sweep on 09-19 reverted within the day. Latent is not safe when the
 * data that trips it is regenerated nightly.
 *
 * The fix keeps the name key — it is load-bearing, because /api/search/suggest
 * rows can arrive with no sku at all (`adaptSuggestProduct` defaults it to '')
 * and without a name match the same product renders twice — and vetoes it with
 * a SKU conflict. All three dedup sites now share `identityIndex()`.
 *
 * §2 THE STALE COMMENT — api.js's compat sidecar
 * ----------------------------------------------
 * getShopData fires a SECOND request per brand+category drilldown and merged it
 * on the strength of a comment recording a live measurement. That measurement's
 * two recovered cards were `CT081KCMY` and `CT073CMY` — both now retired. The
 * comment had become false, in a block whose own text warns "a stale comment is
 * how ERR-216 happened". The sidecar STAYS (removing a fallback is a behaviour
 * change, not cleanup — ERR-158); what changed is that the claim is now
 * re-derived by `npm run probe:lookalike` instead of asserted in prose.
 *
 * §3 WHERE A RETIREMENT WOULD ACTUALLY HURT US
 * --------------------------------------------
 * None of the 17 appear in shipped rendering code. But `business-demo.js` holds
 * eight real SKUs AND their full product URLs frozen in source, because fake
 * ones would 404 the moment "Add to cart" is clicked. That is the single
 * frontend surface a future retirement can silently break, so its shape is
 * pinned here and its SKUs are checked live by the probe.
 *
 * Run: node --test tests/duplicate-pack-retirement-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHOP_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js');
const UTILS_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'utils.js');
const API_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'api.js');
const DEMO_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'business-demo.js');
const PROBE_PATH = path.join(ROOT, 'scripts', 'probe-lookalike-rows.mjs');

const stripComments = require('./helpers/strip-comments');

const SHOP_SRC = fs.readFileSync(SHOP_JS_PATH, 'utf8');
const UTILS_SRC = fs.readFileSync(UTILS_JS_PATH, 'utf8');
const API_SRC = fs.readFileSync(API_JS_PATH, 'utf8');
const DEMO_SRC = fs.readFileSync(DEMO_JS_PATH, 'utf8');
const PROBE_SRC = fs.readFileSync(PROBE_PATH, 'utf8');

const PROBE_CODE = stripComments(PROBE_SRC);
const SHOP_CODE = stripComments(SHOP_SRC);
const API_CODE = stripComments(API_SRC);
const DEMO_CODE = stripComments(DEMO_SRC);

/**
 * POSITIVE CONTROL for every source assertion below (ERR-253).
 * The comment stripper once ate 22,251 characters of live code across 35
 * suites, and an assertion cannot fail over code that is not in the string —
 * so a stripped source that came back empty would make every `assert.match`
 * below pass by vacuum. Each stripped source must still contain a sentinel that
 * only real code carries.
 */
test('§0 control — the stripped sources still contain live code', () => {
    assert.match(SHOP_CODE, /function mergeLiteralResults\(/, 'shop-page.js survived stripping');
    assert.match(API_CODE, /async getShopData\(/, 'api.js survived stripping');
    assert.match(DEMO_CODE, /const CATALOGUE\b/, 'business-demo.js survived stripping');
    assert.ok(SHOP_CODE.length > 50000, `shop-page.js stripped to ${SHOP_CODE.length} chars — too short to be real`);
    assert.ok(API_CODE.length > 50000, `api.js stripped to ${API_CODE.length} chars — too short to be real`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Load the shipped search helpers out of shop-page.js (utils.js first — the
// identity rule calls SearchMatch.normalizeForMatch at call time).
// ─────────────────────────────────────────────────────────────────────────────
function loadShopHelpers() {
    const doc = {
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }; },
        body: { appendChild() {} },
        documentElement: { style: {} },
        cookie: '',
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat,
        setTimeout, clearTimeout,
        document: doc,
        location: { search: '', pathname: '/search', href: 'http://localhost/search', hostname: 'localhost' },
        history: { replaceState() {}, pushState() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    sandbox.navigator = { userAgent: 'node' };
    sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
    const ctx = vm.createContext(sandbox);
    vm.runInContext(UTILS_SRC, ctx, { filename: 'utils.js' });
    vm.runInContext(SHOP_SRC, ctx, { filename: 'shop-page.js' });
    const helpers = sandbox.window._searchParityHelpers;
    assert.ok(helpers, 'shop-page.js must expose window._searchParityHelpers');
    return helpers;
}

// The 17 SKUs retired on 2026-09-19, with the survivor each one 301s to.
// Verified live 2026-09-20: 17/17, correct targets, followed by a real browser.
const RETIRED = Object.freeze({
    CT081KCMY: 'C81NKCMY',
    CT081CMY: 'C81NCMY',
    CT073CMY: 'C73NCMY',
    G410CMY: 'G410HYCMY',
    G312CMY: 'G312HYCMY',
    CIS365KCMY: 'CCLT406SKCMY',
    CIS365CMY: 'CCLT406SCMY',
    GW213KCMY: 'G213AKCMY',
    GW212KCMY: 'G212AKCMY',
    GW212CMY: 'G212ACMY',
    GW218CMY: 'G218ACMY',
    GW204KCMY: 'G416AKCMY',
    GW204CMY: 'G416ACMY',
    GCF50KCMY: 'G202AKCMY',
    GCF50CMY: 'G202ACMY',
    GCF21KCMY: 'G131AKCMY',
    GCART055HCMY: 'GCART055HYCMY',
});

// ═════════════════════════════════════════════════════════════════════════════
// §1 The SKU veto — identity on the search path
// ═════════════════════════════════════════════════════════════════════════════

test('§1 identityIndex is exported as the shared vocabulary', () => {
    const { identityIndex } = loadShopHelpers();
    assert.equal(typeof identityIndex, 'function', 'identityIndex must be exposed for these tests');
});

test('§1 two rows with DIFFERENT known skus are two products, whatever the name', () => {
    const { identityIndex } = loadShopHelpers();
    const ix = identityIndex();
    ix.add({ id: 'x1', sku: 'AAA', name: 'Same Name' });
    assert.equal(ix.has({ id: 'x2', sku: 'BBB', name: 'same   name' }), false,
        'a name collision must not outrank a sku conflict');
});

test('§1 the HP DesignJet case the hand-off names stays two cards', () => {
    // Both live, both on the `728` chip, 2x the price apart. Their names differ
    // today so the name key never fires — this pins that even if a future
    // rename collapsed the titles, the SKUs still keep them apart.
    const { mergeLiteralResults } = loadShopHelpers();
    const a = [{ id: 'd1', sku: 'G728130MLCMY', name: 'HP Genuine 728 CMY Ink Cartridge 3-Pack', price: 583.49 }];
    const b = [{ id: 'd2', sku: 'G728300MLCMY', name: 'HP Genuine 728 CMY Ink Cartridge 3-Pack', retail_price: 1158.49 }];
    const merged = mergeLiteralResults(a, b);
    assert.equal(merged.length, 2, 'a $583 pack and a $1158 pack are not one card');
    // Array.from brings the vm-realm array back into this realm — deepEqual
    // compares prototypes, and a sandbox array is not this realm's Array. Same
    // idiom as tests/search-results-parity-may2026.test.js's skuList.
    assert.deepEqual(Array.from(merged, (p) => p.sku).sort(), ['G728130MLCMY', 'G728300MLCMY']);
});

test('§1 the name key still merges when one side has no sku at all', () => {
    // The reason the key is vetoed rather than deleted: /suggest rows reach the
    // merge with sku '' (adaptSuggestProduct), so name is all there is.
    const { identityIndex } = loadShopHelpers();
    const ix = identityIndex();
    ix.add({ id: 'x1', sku: 'AAA', name: 'Same Name' });
    assert.equal(ix.has({ name: 'same   name' }), true, 'a sku-less row still matches on name');
    assert.equal(ix.has({ sku: '', name: 'Same Name' }), true, 'an empty-string sku is "unknown", not a conflict');
});

test('§1 id and sku matching are unchanged by the veto', () => {
    const { identityIndex } = loadShopHelpers();
    const ix = identityIndex();
    ix.add({ id: 'x1', sku: 'AAA', name: 'One' });
    assert.equal(ix.has({ id: 'x1', name: 'Totally Different' }), true, 'id still matches');
    assert.equal(ix.has({ sku: 'aaa', name: 'Totally Different' }), true, 'sku still matches, case-insensitively');
    assert.equal(ix.has({ id: 'zzz', sku: 'ZZZ', name: 'Unrelated' }), false, 'an unrelated row is not a match');
});

test('§1 rowsNotAlreadyIn honours the veto too', () => {
    const { rowsNotAlreadyIn } = loadShopHelpers();
    const kept = rowsNotAlreadyIn(
        [{ id: 'c1', sku: 'BBB', name: 'Shared Title' }],
        [{ id: 'c2', sku: 'AAA', name: 'Shared Title' }]
    );
    assert.equal(kept.length, 1, 'a different sku is a different product and must be carried across');
    const dropped = rowsNotAlreadyIn(
        [{ id: 'c1', sku: 'AAA', name: 'Shared Title' }],
        [{ id: 'c2', sku: 'AAA', name: 'Shared Title' }]
    );
    assert.equal(dropped.length, 0, 'the same sku is still deduped');
});

test('§1 reattachCompatProvenance never stamps one sku onto another', () => {
    const { reattachCompatProvenance } = loadShopHelpers();
    const compat = [{ sku: 'AAA', name: 'Shared Title', match_reason: 'compatibility', matched_token: 'VP6000' }];
    const out = reattachCompatProvenance([{ sku: 'BBB', name: 'Shared Title' }], compat);
    assert.equal(out[0].match_reason, undefined,
        'a title collision must not transfer provenance between two different SKUs');
    const same = reattachCompatProvenance([{ sku: 'aaa', name: 'Shared Title' }], compat);
    assert.equal(same[0].match_reason, 'compatibility', 'the genuine sku match still gets tagged');
});

test('§1 all three dedup sites read the SAME vocabulary — no private copy', () => {
    // ERR-133/ERR-150's lesson: a second copy is a second vocabulary, and a
    // second vocabulary drifts.
    for (const fn of ['mergeLiteralResults', 'rowsNotAlreadyIn', 'reattachCompatProvenance']) {
        const at = SHOP_CODE.indexOf(`function ${fn}(`);
        assert.ok(at > -1, `${fn} must exist`);
        const body = SHOP_CODE.slice(at, at + 1600);
        assert.match(body, /identityIndex\(\)/, `${fn} must build identity through identityIndex()`);
    }
});

test('§1 the veto itself is present and is about skus, not names', () => {
    const at = SHOP_CODE.indexOf('function identityIndex(');
    assert.ok(at > -1, 'identityIndex must exist');
    const body = SHOP_CODE.slice(at, at + 2200);
    assert.match(body, /claim\.sku && sku !== claim\.sku/,
        'the veto must compare the claiming sku against this row\'s sku');
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 The stale sidecar justification
// ═════════════════════════════════════════════════════════════════════════════

test('§2 api.js no longer claims the retired SKUs as live sidecar recoveries', () => {
    // The old comment read "-> getShopData 9  (+CT081KCMY)". Both rows are gone.
    // A comment is not executable, so nothing else in this repo can catch it
    // going stale — which is exactly how it stayed wrong.
    const RAW = API_SRC;
    assert.ok(RAW.includes('CT081KCMY'), 'the history is still recorded (it explains the change)');
    assert.match(RAW, /THAT MEASUREMENT IS NOW DEAD/,
        'api.js must say plainly that the old sidecar measurement no longer holds');
    assert.match(RAW, /probe:lookalike/,
        'and must point at the probe that re-derives the number instead of asserting it');
});

test('§2 the sidecar itself is still wired up — a dead comment is not a dead fallback', () => {
    // ERR-158: removing a fallback is a behaviour change, not cleanup. The
    // measurement going to zero is evidence, not an instruction.
    assert.match(API_CODE, /source:\s*'compatible'/, 'the compat sidecar request must still be built');
    assert.match(API_CODE, /sidecarPromise\s*=/, 'the sidecar must still be fired');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 No retired SKU may re-enter shipped code
// ═════════════════════════════════════════════════════════════════════════════

test('§3 no retired SKU is referenced by any shipped frontend JS', () => {
    const jsDir = path.join(ROOT, 'inkcartridges', 'js');
    const files = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.js')) files.push(p);
        }
    })(jsDir);
    assert.ok(files.length > 50, `expected the shipped js tree, found ${files.length} files`);

    const offenders = [];
    for (const f of files) {
        const code = stripComments(fs.readFileSync(f, 'utf8'));
        for (const sku of Object.keys(RETIRED)) {
            // Word-bounded so a longer SKU that merely contains a retired one
            // is not reported (GW212CMY vs GW212CMYXL).
            if (new RegExp(`\\b${sku}\\b`).test(code)) {
                offenders.push(`${path.relative(ROOT, f)} → ${sku}`);
            }
        }
    }
    assert.deepEqual(offenders, [],
        'a retired SKU in shipped code is a card that 301s or 404s for every shopper:\n  '
        + offenders.join('\n  '));
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 business-demo.js — the one FE surface a retirement can break
// ═════════════════════════════════════════════════════════════════════════════

test('§4 the demo catalogue still pairs every SKU with a product URL that carries it', () => {
    // Its own comment: "Fake SKUs would 404 the moment 'Add to cart' is
    // clicked." Both halves are frozen in source, so a SKU retirement OR a slug
    // change breaks it silently. This pins the shape; the probe checks them live.
    const skus = [...DEMO_CODE.matchAll(/sku:\s*'([A-Z0-9-]+)'/g)].map((m) => m[1]);
    const urls = [...DEMO_CODE.matchAll(/product_url:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(skus.length >= 8, `expected the frozen demo catalogue, found ${skus.length} skus`);
    assert.equal(skus.length, urls.length, 'every demo row must carry both a sku and a product_url');
    for (let i = 0; i < skus.length; i++) {
        assert.ok(urls[i].endsWith('/' + skus[i]),
            `demo row ${skus[i]} has product_url ${urls[i]} — the URL must end in its own SKU`);
    }
});

test('§4 no demo SKU is one of the retired seventeen', () => {
    const skus = [...DEMO_CODE.matchAll(/sku:\s*'([A-Z0-9-]+)'/g)].map((m) => m[1]);
    const hit = skus.filter((s) => Object.prototype.hasOwnProperty.call(RETIRED, s));
    assert.deepEqual(hit, [], `the demo dashboard would 404 on: ${hit.join(', ')}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 The probe is the standing guard — it must cover all seventeen
// ═════════════════════════════════════════════════════════════════════════════

test('§5 probe-lookalike-rows covers every retired SKU and its survivor', () => {
    assert.ok(PROBE_SRC.length > 10000, 'probe source did not load');
    const missing = [];
    for (const [from, to] of Object.entries(RETIRED)) {
        const re = new RegExp(`from:\\s*'${from}'[^\\n]*to:\\s*'${to}'`);
        if (!re.test(PROBE_SRC)) missing.push(`${from} → ${to}`);
    }
    assert.deepEqual(missing, [],
        'the retirement manifest must pin every pair, or a revert goes unnoticed:\n  '
        + missing.join('\n  '));
});

test('§5 the manifest keeps negative controls — it cannot only expect redirects', () => {
    // A manifest of nothing but expect:'redirect' passes just as happily
    // against a backend that 301s EVERYTHING. CBCI3BK and CLC40KCMY are live
    // rows that must not redirect; they are what make a green run mean
    // something. (ERR-258: red-proof every guard.)
    const live = [...PROBE_SRC.matchAll(/expect:\s*'live'/g)];
    assert.ok(live.length >= 2, `expected at least 2 must-stay-live controls, found ${live.length}`);
    assert.match(PROBE_SRC, /from:\s*'CBCI3BK'/, 'the BCI-3e black control must stay');
    assert.match(PROBE_SRC, /from:\s*'CLC40KCMY'/, 'the supplier-keyed control must stay');
});

test('§5 the probe still has no write path', () => {
    // A probe that can record is a probe that can pass because it overwrote
    // what it was comparing against (sweep:b2b ate a committed fixture that
    // way on 2026-08-12).
    //
    // Read the STRIPPED source: the probe's own header documents the flags it
    // deliberately does not have ("There is no --record, no
    // --update-baseline…"), and a sentence promising the absence of a write
    // path must not be mistaken for one. Control below proves the strip left
    // real code behind.
    assert.match(PROBE_CODE, /async function get\(/, 'probe source survived stripping');

    // Test for the CAPABILITY, not for the words. The probe PRINTS its mode on
    // every run — "this script has no write verb, no --record" — and that
    // banner is a string literal, so a text search for the flag name matches
    // the promise rather than a breach of it. What would actually make this a
    // recorder is a write call or a flag that switches one on.
    assert.doesNotMatch(PROBE_CODE, /writeFileSync|appendFileSync|createWriteStream|fs\.promises\.write|\.write\(/,
        'probe-lookalike-rows must have no filesystem write call');
    assert.doesNotMatch(PROBE_CODE, /HAS\(\s*'--(record|update-baseline|write|fix)'/,
        'probe-lookalike-rows must not parse a record/write flag');
    assert.doesNotMatch(PROBE_CODE, /method:\s*'(POST|PUT|PATCH|DELETE)'/i,
        'probe-lookalike-rows must issue no mutating request');

    // And the mode must still be announced, because a read-only probe that does
    // not say so cannot be told from one that quietly changed.
    assert.match(PROBE_SRC, /READ-ONLY/, 'the run must print its mode');
});

test('§5 the slug-resolver scan carries its negative control', () => {
    // Measured 2026-09-20 the endpoint 500'd for EVERY slug, good and bogus
    // alike — so "the good slug failed" alone cannot tell an outage from a
    // miss. Both probes, or the scan proves nothing.
    assert.match(PROBE_SRC, /by-slug\/zzz-no-such-slug-probe-control-zzz/,
        'the scan must ask for a slug that cannot exist');
    assert.match(PROBE_SRC, /slug resolver is DOWN for every slug/,
        'and must name the both-fail case as an outage');
});
