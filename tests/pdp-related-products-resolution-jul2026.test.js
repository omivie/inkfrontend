/**
 * PDP Related Products — multi-code family resolution + loud transient failure
 * ============================================================================
 *
 * Context (ERR-134)
 * -----------------
 * A backend handoff (`related-products-series-codes-fe-notes-jul2026.md`) shipped
 * `series_codes` + `yield_tier` on `GET /api/products/:sku` and said "No frontend
 * change required — just verify." The headline claim held: the reported Epson
 * 786XL Cyan PDP renders its full 786 family again, and a 138-SKU stratified
 * sample showed detail⇄list parity at 100%.
 *
 * Verifying it surfaced three defects the note did not cover.
 *
 * 1. TRANSIENT FAILURE SILENTLY DELETED THE SECTION.
 *    `renderRelatedProducts` treated an unhealthy response as an empty one:
 *    `if (res.ok && res.data?.products)` … then `if (related.length === 0) return;`.
 *    A rate-limited or cold backend produced a page with no Related Products at
 *    all — pixel-identical to "this product genuinely has no siblings". Proven
 *    live: 16× HTTP 429 on the 786XL PDP deleted the whole section. A bare
 *    `catch (e) {}` swallowed every throw with no log on top of that.
 *    The distinction matters because the silent case is COMMON and correct:
 *    767 of 3,801 non-ribbon PDPs are genuine singletons.
 *
 * 2. ONLY `series_codes[0]` WAS EVER TRIED.
 *    `series_codes` is a list, and for a product spanning models the first entry
 *    is not always the one carrying the family. Measured live:
 *      CB412DNBK-2  ['B412','B432','B512','3K']  ?code=B412  = 1 (itself)
 *                                                ?code=B432  = 3
 *      CB401BK                                   ?code=B401  = 1
 *                                                ?code=MB451 = 3
 *      C45ABK                                    ?code=45    = 1
 *                                                ?code=42    = 2
 *    Three PDPs lost their entire Related Products section to a dead first code.
 *
 * 3. CATEGORY VOCABULARY GAPS.
 *    `normalizeProductType` had no case for `fax_film`/`fax_film_refill` (7
 *    products, all filed under `/api/shop?category=drums`), and
 *    `normalizeCategory` did not recognise `CON-LASER` — the code every toner
 *    arrives with. The detail endpoint only ever returns CON-INK / CON-LASER /
 *    CON-RIBBON.
 *
 * Run: node --test tests/pdp-related-products-resolution-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const PDP_PATH = path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js');
const PDP_SRC = fs.readFileSync(PDP_PATH, 'utf8');

/**
 * Balanced-brace extraction of a method body, by name.
 *
 * Deliberately NOT a fixed-width `slice(i, i + 700)`: those go vacuous the
 * moment the method grows a doc comment, and an assertion against "" passes
 * (ERR-124). Deliberately NOT comment-stripped either — a line comment holding
 * a literal `/*` opens a fake block comment that eats the rest of the file.
 */
function methodBody(src, name) {
    const re = new RegExp('(?:^|\\n)\\s*(?:async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{');
    const m = re.exec(src);
    assert.ok(m, `could not locate method ${name}() in product-detail-page.js`);
    const start = m.index + m[0].length;
    let depth = 1;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i);
        }
    }
    assert.fail(`unbalanced braces while extracting ${name}()`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Load the pure helpers out of product-detail-page.js. Only top-level
// declarations run at load, so a permissive document/window stub is enough.
// ─────────────────────────────────────────────────────────────────────────────
function loadPdpHelpers() {
    const noop = () => {};
    const docStub = {
        addEventListener: noop, removeEventListener: noop,
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add: noop, remove: noop }, setAttribute: noop, appendChild: noop }),
        body: { appendChild: noop }, documentElement: { style: {} }, cookie: '',
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat,
        setTimeout, clearTimeout,
        addEventListener: noop, removeEventListener: noop,
        document: docStub,
        location: { search: '', pathname: '/products/x/G786XLC', href: 'http://localhost/products/x/G786XLC' },
        history: { replaceState: noop, pushState: noop },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        IntersectionObserver: function () { return { observe: noop, disconnect: noop }; },
        MutationObserver: function () { return { observe: noop, disconnect: noop }; },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(PDP_SRC, ctx, { filename: 'product-detail-page.js' });
    const helpers = sandbox.window._pdpRelatedHelpers;
    assert.ok(helpers, 'product-detail-page.js must expose window._pdpRelatedHelpers');
    return helpers;
}

// A faithful mirror of the non-ribbon fetch loop, so the candidate list is
// proven to drive REAL resolution rather than merely existing. `families` maps
// code → sibling skus (excluding self), exactly like /api/shop?code= would.
function resolveFamily(seriesCodes, extractedCode, families, familyCodeCandidates) {
    const calls = [];
    let related = [];
    for (const candidate of familyCodeCandidates(seriesCodes, extractedCode)) {
        calls.push(candidate);
        related = related.concat(families[candidate] || []);
        if (related.length) break;
    }
    return { calls, related };
}

// ═════════════════════════════════════════════════════════════════════════════
// §1  familyCodeCandidates — the candidate generator
// ═════════════════════════════════════════════════════════════════════════════

test('§1 familyCodeCandidates — series_codes order is preserved, first stays first', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    assert.deepEqual(
        Array.from(familyCodeCandidates(['B412', 'B432', 'B512', '3K'], 'B412')),
        ['B412', 'B432', 'B512', '3K'],
        'series_codes[0] must remain the first request so the hot edge-cache URL is unchanged'
    );
});

test('§1 familyCodeCandidates — normalises case and strips dashes', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    assert.deepEqual(Array.from(familyCodeCandidates(['lc-133', 'Tn2250'], null)), ['LC133', 'TN2250']);
});

test('§1 familyCodeCandidates — dedupes, including against the extracted code', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    assert.deepEqual(Array.from(familyCodeCandidates(['786', '786', 'B-412'], 'B412')), ['786', 'B412']);
});

test('§1 familyCodeCandidates — the extracted code is APPENDED, never prepended', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    assert.deepEqual(Array.from(familyCodeCandidates(['B412', 'B432'], 'ZZZ')), ['B412', 'B432', 'ZZZ']);
});

test('§1 familyCodeCandidates — brand-regex code alone when series_codes is absent', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    assert.deepEqual(Array.from(familyCodeCandidates(null, 'LC133')), ['LC133']);
    assert.deepEqual(Array.from(familyCodeCandidates([], 'LC133')), ['LC133']);
});

test('§1 familyCodeCandidates — empty/blank/nullish entries are dropped, never sent as ?code=', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    assert.deepEqual(Array.from(familyCodeCandidates(['', null, undefined, '   ', '786'], null)), ['786']);
    assert.deepEqual(Array.from(familyCodeCandidates([], null)), []);
    assert.deepEqual(Array.from(familyCodeCandidates(undefined, undefined)), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// §2  The three real products that lost their section to a dead first code
// ═════════════════════════════════════════════════════════════════════════════

test('§2 OKI CB412DNBK-2 — B412 is a dead end, B432 carries the family', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    const { calls, related } = resolveFamily(
        ['B412', 'B432', 'B512', '3K'], 'B412',
        { B412: [], B432: ['GB432BK', 'GB432HYBK'] },
        familyCodeCandidates
    );
    assert.deepEqual(calls, ['B412', 'B432'], 'must fall through B412 and stop at B432');
    assert.deepEqual(related, ['GB432BK', 'GB432HYBK']);
});

test('§2 OKI CB401BK — B401 is a dead end, MB451 carries the family', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    const { related } = resolveFamily(
        ['B401', 'MB451'], 'B401',
        { B401: [], MB451: ['GMB451BK-2', 'GMB451HYBK'] },
        familyCodeCandidates
    );
    assert.deepEqual(related, ['GMB451BK-2', 'GMB451HYBK']);
});

test('§2 HP C45ABK — 45 is a dead end, 42 carries the family', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    const { related } = resolveFamily(
        ['45', '42', '38', '39'], '45',
        { 45: [], 42: ['G42XBK'] },
        familyCodeCandidates
    );
    assert.deepEqual(related, ['G42XBK']);
});

test('§2 the common case still makes exactly ONE request (edge cache preserved)', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    const { calls } = resolveFamily(
        ['786'], '786',
        { 786: ['G786XLBK', 'G786XLM', 'G786XLY'] },
        familyCodeCandidates
    );
    assert.deepEqual(calls, ['786'], '2,931 of 3,801 PDPs resolve on the first candidate — do not spend extra requests there');
});

test('§2 a genuine singleton exhausts its codes and yields nothing (correctly hidden)', () => {
    const { familyCodeCandidates } = loadPdpHelpers();
    const { calls, related } = resolveFamily(['TN2130'], 'TN2130', { TN2130: [] }, familyCodeCandidates);
    assert.deepEqual(calls, ['TN2130']);
    assert.equal(related.length, 0, 'no siblings is a real answer — 767 PDPs are in this state');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3  Source wiring — the loop, and failure kept distinct from emptiness
// ═════════════════════════════════════════════════════════════════════════════

test('§3 renderRelatedProducts drives the fetch from familyCodeCandidates', () => {
    const body = methodBody(PDP_SRC, 'renderRelatedProducts');
    assert.match(body, /familyCodeCandidates\s*\(\s*info\.series_codes\s*,\s*code\s*\)/,
        'the family fetch must iterate every code the product carries, not just series_codes[0]');
    assert.match(body, /for\s*\(\s*const\s+candidate\s+of\s+codeCandidates\s*\)/);
    assert.match(body, /code:\s*candidate/, 'the loop variable must be what is sent as ?code=');
});

test('§3 an unhealthy response sets fetchFailed and STOPS — never counted as empty', () => {
    const body = methodBody(PDP_SRC, 'renderRelatedProducts');
    assert.match(body, /if\s*\(\s*!res\.ok\s*\|\|\s*!res\.data\?\.products\s*\)\s*\{[\s\S]{0,600}?fetchFailed\s*=\s*true;[\s\S]{0,120}?break;/,
        'a failed read must be recorded as a failure and end the loop');
});

test('§3 an empty result caused by a FAILURE renders the error state, in EVERY category', () => {
    // Rewritten Aug 2026 (ERR-170). This used to require the fetchFailed branch to
    // live INSIDE `if (related.length === 0 && info.category !== 'ribbon')` — which
    // pinned the shape of the guard rather than the rule, and baked in the very bug
    // that guard had: ribbons were excluded, so a curated rail whose query errored
    // rendered its empty state and read as "the owner curated nothing".
    //
    // The rule is category-independent: an empty result that came from a failure is
    // not an empty result. The guard is now checked BEFORE the category test.
    const body = methodBody(PDP_SRC, 'renderRelatedProducts');
    const m = /if\s*\(related\.length === 0 && fetchFailed\)\s*\{([\s\S]{0,300}?)\}/.exec(body);
    assert.ok(m, 'a failure-caused empty result must have its own guard, ahead of any category test');
    assert.match(m[1], /this\._renderRelatedError\(/,
        'a failed fetch must render the error state instead of silently hiding the section');
    assert.match(m[1], /return;/);

    // …and it must come first, or ribbons fall through to the silent path again.
    const iFail = body.indexOf('related.length === 0 && fetchFailed');
    const iCat = body.indexOf("related.length === 0 && info.category !== 'ribbon'");
    assert.ok(iFail > -1 && iCat > -1, 'both guards must exist');
    assert.ok(iFail < iCat,
        'the failure guard must precede the category guard, or a failed ribbon lookup is swallowed');
});

test('§3 a SUCCESSFUL empty family still hides silently (no error box on a singleton)', () => {
    const body = methodBody(PDP_SRC, 'renderRelatedProducts');
    // The silent path — a genuine empty result — must contain no error render at
    // all, or all 767 legitimate singletons grow an error box.
    const m = /if\s*\(related\.length === 0 && info\.category !== 'ribbon'\)\s*\{([\s\S]{0,300}?)\}/.exec(body);
    assert.ok(m, 'the non-ribbon empty guard must still exist');
    assert.doesNotMatch(m[1], /_renderRelatedError/,
        'the silent hide path must never render the error state — that branch is for failures only');

    // Every error render must be reachable only from a FAILURE — either the
    // fetchFailed flag or the method's outer catch (a throw is a failure too).
    // Anything else would put an error box on a legitimately empty result.
    const renders = (body.match(/this\._renderRelatedError\(/g) || []).length;
    const fromFlag = (body.match(/fetchFailed[\s\S]{0,200}?this\._renderRelatedError\(/g) || []).length;
    const fromCatch = (body.match(/\}\s*catch\s*\([\s\S]{0,900}?this\._renderRelatedError\(/g) || []).length;
    assert.equal(renders, fromFlag + fromCatch,
        `all ${renders} _renderRelatedError call(s) must be reachable only from a failure `
        + `(${fromFlag} via fetchFailed, ${fromCatch} via catch)`);
});

test('§3 _renderRelatedError reuses the shop page pane and wires a working Retry', () => {
    const body = methodBody(PDP_SRC, '_renderRelatedError');
    assert.match(body, /drilldown-error/, 'reuse the existing shop-page failure pane, do not invent new CSS');
    assert.match(body, /data-related-retry/);
    assert.match(body, /addEventListener\(\s*'click'/);
    assert.match(body, /this\.renderRelatedProducts\(info\)/, 'Retry must actually re-run the load');
    assert.match(body, /section\.hidden\s*=\s*false/, 'the section must be revealed to show the error');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4  No silent swallowing
// ═════════════════════════════════════════════════════════════════════════════

test('§4 the renderRelatedProducts catch logs and surfaces — it is not empty', () => {
    const body = methodBody(PDP_SRC, 'renderRelatedProducts');
    // The OUTER catch — `lastIndexOf('} catch')` would find the inner
    // `catch (_)` that guards the error renderer against throwing.
    const tail = body.slice(body.lastIndexOf('} catch (e)'));
    assert.match(tail, /DebugLog\.warn\(/, 'a throw here used to leave no trace at all');
    assert.match(tail, /_renderRelatedError\(/);
    assert.doesNotMatch(tail, /catch\s*\(\s*e\s*\)\s*\{\s*\}/, 'no bare empty catch');
});

test('§4 no raw console.* introduced (ERR-035)', () => {
    const body = methodBody(PDP_SRC, 'renderRelatedProducts')
        + methodBody(PDP_SRC, '_renderRelatedError');
    assert.doesNotMatch(body, /(?<!\/\/[^\n]*)\bconsole\.(log|warn|error|info)\s*\(/,
        'storefront logging goes through DebugLog');
});

// ═════════════════════════════════════════════════════════════════════════════
// §5  Category vocabulary
// ═════════════════════════════════════════════════════════════════════════════

test('§5 normalizeProductType maps fax films to drum (their real /api/shop category)', () => {
    const body = methodBody(PDP_SRC, 'normalizeProductType');
    assert.match(body, /case 'fax_film':/);
    assert.match(body, /case 'fax_film_refill':\s*return 'drum';/,
        "all 7 fax films live under ?category=drums — verified live");
});

test('§5 normalizeCategory recognises CON-LASER, the code every toner arrives with', () => {
    const body = methodBody(PDP_SRC, 'normalizeCategory');
    assert.match(body, /lower\.includes\('laser'\)\s*\)\s*return 'toner'/);
});

test('§5 normalizeCategory still maps the other two live category codes', () => {
    const body = methodBody(PDP_SRC, 'normalizeCategory');
    // CON-INK / CON-RIBBON are the only other values the detail endpoint returns.
    assert.match(body, /lower\.includes\('ink'\)\s*\)\s*return 'ink'/);
    assert.match(body, /lower\.includes\('ribbon'\)\s*\)\s*return 'ribbon'/);
});

// ═════════════════════════════════════════════════════════════════════════════
// §6  The ribbon branch is untouched (guards ERR-085: ribbons stay owner-curated)
// ═════════════════════════════════════════════════════════════════════════════

test('§6 ribbon related products make NO backend code-family fetch', () => {
    const body = methodBody(PDP_SRC, 'renderRelatedProducts');
    const start = body.indexOf("if (info.category === 'ribbon') {");
    assert.ok(start >= 0, 'the ribbon branch must still exist');
    const ribbonBranch = body.slice(start, body.indexOf('} else {', start));
    assert.doesNotMatch(ribbonBranch, /getShopData/, 'ERR-085: ribbons are owner-curated only');
    assert.doesNotMatch(ribbonBranch, /familyCodeCandidates/, 'the new multi-code loop must not leak into ribbons');
    assert.doesNotMatch(ribbonBranch, /extractProductCode/);
});
