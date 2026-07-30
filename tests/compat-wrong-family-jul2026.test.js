/**
 * WRONG-FAMILY CARTRIDGES — THE FRONTEND NEVER ASSERTS COMPATIBILITY (ERR-135)
 * ===========================================================================
 *
 * Context: a customer bought a cartridge that didn't fit their printer. Three
 * Brother printers were listing cartridges from the wrong family, and the
 * backend removed the bad `product_compatibility` rows (commits 8fa43a0,
 * 7edb38e). Its handoff said "FE code change required: none — data-only fix"
 * and asked for a Cloudflare cache purge.
 *
 * Verifying that on 2026-07-30 found both halves of the note to be wrong:
 *
 *   • THE PURGE WAS A NO-OP. Cloudflare does front the document host
 *     (`server: cloudflare`), but the printer prerender responses come back
 *     `cf-cache-status: DYNAMIC` — uncached — and the HTML was already clean.
 *     This repo also has no purge capability at all: no token, no zone, no
 *     script. The static layer is deliberately `max-age=0, must-revalidate` +
 *     `CDN-Cache-Control: no-cache` so a deploy never needs one.
 *
 *   • "NO FE CHANGE" WAS FALSE. The frontend had its own wrong-family
 *     generator, live, fed by data that never touched `product_compatibility`.
 *     `/shop?printer_model=<free text>` — emitted by account saved-printer
 *     cards for any saved printer without a slug — ran a five-strategy ladder
 *     whose last two rungs invented compatibility:
 *
 *       Strategy 4  `getProducts({ search: <BRAND NAME> })`, merged up to 100
 *                   results. Measured live: `?search=Brother&limit=100` → 100
 *                   products across 71 distinct series families (label tapes,
 *                   drums, photo paper, ribbons), every one rendered under
 *                   "Compatible Products for <the customer's printer>".
 *       Strategy 5  a hardcoded printer→code table + `ilike('name','%code%')`.
 *                   Measured live: `%200%` → 141 products, because "(9,200
 *                   pages)" contains 200; `%85A%` → CB435A when the table meant
 *                   CE285A. The table had no entry for any incident printer.
 *
 *     The PDP had the same defect one surface over: with no compatibility rows
 *     of its own it picked a "sibling" by the same unbounded substring match
 *     and printed THAT product's printers as this one's "For Use In".
 *
 * The invariant this file exists to hold:
 *
 *     THE FRONTEND NEVER ASSERTS COMPATIBILITY. Only `product_compatibility`,
 *     reached through the backend, may put a product under a "fits your
 *     printer" heading. Everything else is a SEARCH RESULT and is labelled one.
 *
 * This mirrors the older load-bearing rule that the frontend never computes
 * prices. Both failures came from the same shape: the FE deriving an answer the
 * backend owns, then presenting the derivation as fact.
 *
 * Sections:
 *   §1  CompatSource is the ONE vocabulary, and it behaves
 *   §2  the deleted wrong-family generators stay deleted
 *   §3  ?printer_model= routes, and never renders an unproven grid
 *   §4  no surface borrows compatibility from a sibling
 *   §5  printer models are not cartridge codes
 *   §6  middleware printer-prerender gate (previously unpinned — its source
 *       comment cited a test file that never existed)
 *   §7  LIVE — the incident printers, and the un-linked SKUs still selling
 *
 * Run with: node --test tests/compat-wrong-family-jul2026.test.js
 *           LIVE_API=1 node --test tests/compat-wrong-family-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = (rel) => path.join(INK, 'js', rel);
const READ = (p) => fs.readFileSync(p, 'utf8');

const UTILS_SRC = READ(JS('utils.js'));
const SHOP_SRC = READ(JS('shop-page.js'));
const PDP_SRC = READ(JS('product-detail-page.js'));
const API_SRC = READ(JS('api.js'));
const ACCOUNT_SRC = READ(JS('account.js'));
const MIDDLEWARE_SRC = READ(path.join(INK, 'middleware.js'));

/**
 * Strip line comments so "is this CODE present?" assertions can't be satisfied
 * — or falsely tripped — by prose. The comments added by this fix deliberately
 * quote the very code they deleted (`ilike('name', '%<code>%')`, `search:
 * <BRAND NAME>`) so the next reader understands what was wrong; without this,
 * every ban below would match its own explanation. Block comments are left
 * alone on purpose: a naive block-comment regex treats the "/*" inside a path
 * like `/api/products/*` as a comment opener and eats the rest of the file.
 */
const stripLineComments = (src) => src.replace(/^\s*\/\/[^\n]*$/gm, '');

/** Strip BOTH comment kinds, for bans that must also survive block prose. */
const stripAllComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');

const SHOP_CODE = stripLineComments(SHOP_SRC);
const PDP_CODE = stripLineComments(PDP_SRC);
const API_CODE = stripLineComments(API_SRC);
const UTILS_CODE = stripLineComments(UTILS_SRC);

/**
 * Slice one method body out of a source file, from its signature to the
 * matching dedented `},`. Fixed-width windows silently truncate the moment a
 * method grows a long doc comment, turning a real assertion into a vacuous one.
 */
function methodBody(src, signature) {
    const start = src.indexOf(signature);
    assert.notEqual(start, -1, `expected to find \`${signature}\` in source`);
    const rest = src.slice(start);
    const end = rest.indexOf('\n        },');
    assert.notEqual(end, -1, `expected a dedented close for \`${signature}\``);
    return rest.slice(0, end);
}

/**
 * Evaluate the real utils.js in a sandbox and hand back its globals, so the
 * CompatSource assertions exercise the shipped implementation rather than a
 * paraphrase of it. utils.js touches `location.hostname` at module scope
 * (isCachedSuperAdmin), hence the stubs.
 */
function loadUtils() {
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        location: { hostname: 'localhost', href: 'http://localhost/', search: '', pathname: '/' },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        navigator: { userAgent: 'node' },
        document: {
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} })
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} })
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(UTILS_SRC, sandbox, { filename: 'utils.js' });
    return sandbox;
}

const UTILS = loadUtils();
const CompatSource = UTILS.CompatSource;

// ─────────────────────────────────────────────────────────────────────────────
// §1 — CompatSource is the ONE vocabulary, and it behaves
// ─────────────────────────────────────────────────────────────────────────────

test('§1 CompatSource is exported from utils.js and on window', () => {
    assert.ok(CompatSource, 'utils.js must define CompatSource');
    assert.match(UTILS_SRC, /window\.CompatSource = CompatSource/,
        'CompatSource must be attached to window — api.js and shop-page.js load BEFORE utils.js '
        + 'in document order, so they read it off the window property; a bare binding reference '
        + 'would throw from the temporal dead zone rather than yield undefined');
    for (const fn of ['printerKey', 'isPrinterModelToken', 'codeExactRegex',
        'codeTokenRegex', 'textHasCodeToken', 'productMatchesCode',
        'brandPrefixOf', 'stripBrandPrefix']) {
        assert.equal(typeof CompatSource[fn], 'function', `CompatSource.${fn} must be a function`);
    }
    assert.equal(CompatSource.PROVEN, 'proven');
    assert.equal(CompatSource.UNPROVEN, 'unproven');
});

test('§1 CompatSource lives in utils.js only — no second copy of the vocabulary', () => {
    // One implementation is the entire point: two independent substring matchers
    // is how the wrong one survived unnoticed for months.
    for (const [label, code] of [['shop-page.js', SHOP_CODE], ['product-detail-page.js', PDP_CODE], ['api.js', API_CODE]]) {
        assert.doesNotMatch(code, /const\s+CompatSource\s*=/,
            `${label} must consume CompatSource from utils.js, not declare its own`);
    }
});

test('§1 printerKey collapses every separator spelling to one key', () => {
    // printer_models is not internally consistent — it holds "Brother DCP
    // J1050DW" (spaces) next to "Brother DCP-J1260W" (dash) — and the customer
    // types a third way again. Comparing raw strings is why every previous FE
    // lookup missed a printer that was sitting right there in the table.
    const key = CompatSource.printerKey('Brother DCP-J1050DW');
    assert.equal(key, 'brotherdcpj1050dw');
    for (const spelling of ['Brother DCP J1050DW', 'brother dcpj1050dw',
        'BROTHER  DCP--J1050DW', 'Brother_DCP.J1050DW']) {
        assert.equal(CompatSource.printerKey(spelling), key,
            `"${spelling}" must collapse to the same key as "Brother DCP-J1050DW"`);
    }
    assert.equal(CompatSource.printerKey(null), '');
    assert.equal(CompatSource.printerKey(undefined), '');
});

test('§1 printerKey does NOT collapse genuinely different printers', () => {
    assert.notEqual(
        CompatSource.printerKey('Brother DCP-J1050DW'),
        CompatSource.printerKey('Brother DCP-J1060DW'),
        'separator-insensitivity must not become model-insensitivity');
});

test('§1 codeTokenRegex respects boundaries — the wrong-family rule', () => {
    // The incident, in one assertion: LC431 is the DCP-J1050DW's family and
    // LC531 is not. A substring matcher conflated neighbours like these.
    // The name here is the real live shape, which always spells the bare code
    // out alongside the colour-suffixed one.
    assert.ok(CompatSource.textHasCodeToken(
        'Brother Genuine LC431CMY Ink Cartridge LC431 CMY 3-Pack (200 pages)', 'LC431'));
    assert.ok(!CompatSource.textHasCodeToken('Brother Genuine LC531BK Ink Cartridge', 'LC431'),
        'LC431 must NOT match an LC531 product — different cartridge family, different printer');
    assert.ok(!CompatSource.textHasCodeToken('Brother LC4310 Ink', 'LC431'),
        'LC431 must NOT match inside the longer code LC4310');
    assert.ok(!CompatSource.textHasCodeToken('HP 961XL Ink Cartridge', '61XL'),
        '61XL must NOT match inside 961XL');
    assert.ok(!CompatSource.textHasCodeToken('HP CB435A Toner', 'CE285A'),
        'CE285A must not match CB435A — the old hardcoded table returned exactly this collision');
});

test('§1 a COLOUR-suffixed token alone is not a bare-code match (deliberate)', () => {
    // `LC431` does not match the token `LC431BK`: the boundary rule is strict
    // and the permitted tail is yield markers only, not colours. This is
    // faithful to the two correct matchers CompatSource replaced, and it is
    // what stops q=220 matching "220V". It costs nothing in practice because
    // every real product name spells the bare code out as well — but it is
    // pinned here so nobody "fixes" it by loosening the boundary, which is
    // precisely how a substring matcher gets reintroduced.
    assert.ok(!CompatSource.textHasCodeToken('LC431BK', 'LC431'));
    // Series_codes, not the name, is the right way to answer this question —
    // and productMatchesCode does, via the anchored test.
    assert.ok(CompatSource.productMatchesCode({ series_codes: ['LC431'], sku: 'GLC431BK' }, 'LC431'));
});

test('§1 codeTokenRegex admits a trailing yield marker (same family)', () => {
    // LC431XL genuinely belongs to the LC431 family; yieldTier splits them
    // inside it. This is why the matcher is not a bare equality test.
    for (const name of ['Brother LC431XL Ink', 'Brother LC431XXL Ink', 'Brother LC431HY Ink']) {
        assert.ok(CompatSource.textHasCodeToken(name, 'LC431'),
            `${name} must still match the LC431 family`);
    }
});

test('§1 textHasCodeToken rejects a page count — the %200% collision', () => {
    // This single rule is what stopped `ilike('name','%200%')` from returning
    // 141 products. Every one of these is a real live product name.
    const pageCountNames = [
        'Lexmark Genuine 81C1XCMY Toner Cartridge 81C1X CMY 3-Pack (16,200 pages)',
        'HP Genuine 970XLBK Ink Cartridge 970XL Black (9,200 pages)',
        'Brother Genuine LC431CMY Ink Cartridge LC431 CMY 3-Pack (200 pages)'
    ];
    for (const name of pageCountNames) {
        assert.ok(!CompatSource.textHasCodeToken(name, '200'),
            `"200" must not match its own page count in: ${name}`);
    }
    // …while a real Epson 200 product still matches.
    assert.ok(CompatSource.textHasCodeToken('200XLKCMY Compatible Ink Cartridge for Epson 200XL KCMY 4-Pack', '200'),
        'the yield-prose rule must not cost us the real Epson 200 family');
});

test('§1 productMatchesCode prefers backend series_codes over the name', () => {
    assert.ok(CompatSource.productMatchesCode(
        { series_codes: ['LC431'], name: 'nothing useful here', sku: 'GLC431BK' }, 'LC431'));
    assert.ok(!CompatSource.productMatchesCode(
        { series_codes: ['LC531'], name: 'Brother LC531 Ink', sku: 'GLC531BK' }, 'LC431'),
        'a product the backend says is LC531 must never answer to LC431');
    assert.ok(CompatSource.productMatchesCode(
        { series_codes: ['LC431XL'], name: '', sku: '' }, 'LC431'),
        'yield-suffixed backend codes stay in the family');
});

test('§1 regex metacharacters in a code cannot break out', () => {
    assert.ok(!CompatSource.textHasCodeToken('Brother LC431 Ink', 'LC4.1'),
        'a dot in the code must be literal, not a wildcard');
    assert.doesNotThrow(() => CompatSource.codeTokenRegex('(*+?['));
});

test('§1 brandPrefixOf / stripBrandPrefix split free-text printer names', () => {
    assert.equal(CompatSource.brandPrefixOf('Brother DCP-J1050DW'), 'Brother');
    assert.equal(CompatSource.stripBrandPrefix('Brother DCP-J1050DW'), 'DCP-J1050DW');
    assert.equal(CompatSource.brandPrefixOf('DCP-J1050DW'), null,
        'no leading manufacturer word means no brand — never guess one');
    assert.equal(CompatSource.stripBrandPrefix('HP ENVY 6020'), 'ENVY 6020');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the deleted wrong-family generators stay deleted
// ─────────────────────────────────────────────────────────────────────────────

test('§2 no hardcoded printer→cartridge-code table anywhere in shop-page.js', () => {
    assert.doesNotMatch(SHOP_CODE, /printerProductCodes/,
        'the hardcoded printer→code table is deleted and must not come back — it was stale '
        + '(no entry for any printer in the incident), several of its mappings were wrong, and '
        + 'it fed an unbounded substring search');
    // And no reincarnation under another name: an object literal mapping a
    // printer-shaped key to an array of code strings.
    assert.doesNotMatch(
        stripAllComments(SHOP_SRC),
        /['"](?:DCP|MFC|PIXMA|MAXIFY|DeskJet|OfficeJet|ENVY|LaserJet|CLP|CLX|ML|XP|WF|HL)[- ]?[A-Z0-9]+['"]\s*:\s*\[/i,
        'a printer model used as an object key mapping to an array of cartridge codes is the '
        + 'banned shape, whatever the variable is called — only product_compatibility knows this');
});

test('§2 shop-page.js runs no substring product search', () => {
    const code = stripAllComments(SHOP_SRC);
    assert.doesNotMatch(code, /\.ilike\(\s*['"]name['"]/,
        "ilike('name', …) on the products table is banned in shop-page.js: `%200%` matched 141 "
        + 'products via "(9,200 pages)". Use CompatSource.textHasCodeToken.');
    assert.doesNotMatch(code, /\.ilike\([^)]*%\$\{/,
        'no interpolated %…% wildcard search may decide what fits a printer');
});

test('§2 the brand-name flood cannot reach a compatibility heading', () => {
    const body = methodBody(SHOP_CODE, 'async loadPrinterModelProducts(');
    assert.doesNotMatch(body, /search:\s*brandName/,
        'searching the BRAND NAME returned 100 products across 71 series families — label tapes, '
        + 'drums, photo paper — every one titled "Compatible Products for <printer>"');
    assert.doesNotMatch(body, /getProducts\s*\(/,
        'the printer-model route must not run a generic product search at all');
    assert.doesNotMatch(body, /renderProducts\s*\(/,
        'this route renders NO product grid, so it cannot mislabel one: it resolves and redirects');
    assert.doesNotMatch(body, /Compatible Products for/,
        'no compatibility heading may be written on the printer-model route');
});

test('§2 supabase is no longer consulted for printer resolution', () => {
    const resolver = methodBody(SHOP_CODE, 'async resolvePrinterModelSlug(');
    assert.doesNotMatch(resolver, /supabase|Auth\.supabase|from\(['"]printer_models['"]\)/,
        'printer resolution goes through the backend (API.getPrintersByBrand / API.searchPrinters), '
        + 'not a direct client-side table read — the backend owns compatibility');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — ?printer_model= routes, and never renders an unproven grid
// ─────────────────────────────────────────────────────────────────────────────

test('§3 loadPrinterModelProducts resolves then redirects — both branches', () => {
    const body = methodBody(SHOP_CODE, 'async loadPrinterModelProducts(');
    assert.match(body, /resolvePrinterModelSlug/,
        'it must attempt to resolve the free text to a real printer slug');
    assert.match(body, /location\.replace\(/,
        'it hands off with location.replace so Back does not bounce through the redirect again');
    assert.match(body, /printer_slug=|buildPrinterUrl/,
        'a resolved printer goes to the canonical ?brand=&printer_slug= hub, which is '
        + 'product_compatibility-backed, prerenderable and edge-cacheable');
    assert.match(body, /\/search\?q=/,
        'an UNRESOLVED model goes to search, where results are labelled search results and '
        + "/smart's did-you-mean banner recovers the common typo case");
});

test('§3 the resolver is separator-insensitive via CompatSource.printerKey', () => {
    const resolver = methodBody(SHOP_CODE, 'async resolvePrinterModelSlug(');
    assert.match(resolver, /printerKey/,
        'raw-string comparison is what made every earlier lookup miss: the table holds '
        + '"Brother DCP J1050DW" while the URL carries "Brother DCP-J1050DW"');
    assert.match(resolver, /getPrintersByBrand/, 'stage 1 matches locally against the brand pool');
    assert.match(resolver, /searchPrinters/,
        'stage 2 must exist: /api/printers/search is separator-INTOLERANT and the brand pool is '
        + 'server-capped (HP returns exactly 1000 rows), so stage 1 alone can miss a real printer');
});

test('§3 the resolver guards against navigation moving on mid-flight', () => {
    const body = methodBody(SHOP_CODE, 'async loadPrinterModelProducts(');
    assert.match(body, /navigationVersion !== navVersion/,
        'resolution is async and ends in a redirect — without the async-after-destroy guard it '
        + 'would yank a customer off whatever page they navigated to in the meantime');
});

test('§3 no ?printer_model= URLs are emitted for the shop any more', () => {
    // account.js still emits it for slug-less saved printers — that is the
    // route's remaining legitimate caller, and it now resolves or searches.
    // Nothing should be MINTING new ones in static HTML.
    const homepages = ['index.html', path.join('html', 'index.html')];
    for (const rel of homepages) {
        const html = READ(path.join(INK, rel));
        assert.doesNotMatch(html, /\/shop\?printer_model=/,
            `${rel} must link to canonical /shop?brand=&printer_slug= hubs, not the legacy `
            + '?printer_model= route (those chips were the last emissions in the codebase)');
    }
});

test('§3 account.js saved-printer fallback still has a real destination', () => {
    // Not a ban — this is the one caller that legitimately has free text and no
    // slug. The assertion is that it keeps routing somewhere handled.
    assert.match(ACCOUNT_SRC, /\/shop\?printer_model=/,
        'slug-less saved printers still hand their free text to the printer-model route, which '
        + 'now resolves it or falls through to search');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — no surface borrows compatibility from a sibling
// ─────────────────────────────────────────────────────────────────────────────

test('§4 the PDP never borrows a sibling product\'s printer list', () => {
    const code = stripAllComments(PDP_SRC);
    assert.doesNotMatch(code, /\.ilike\(\s*['"]name['"]/,
        "the PDP's sibling fan-out used ilike('name','%code%') and crossed families — `%LC37%` "
        + 'returns CIB3757CMY — then printed that product\'s printers as this one\'s "For Use In"');
    const body = methodBody(PDP_CODE, 'async renderCompatiblePrinters(');
    assert.doesNotMatch(body, /sibling/i,
        'an absent compatibility list must render NOTHING, not an inferred one');
    assert.match(body, /_fetchPrinters\(info\.sku\)/,
        "the fallback may only ever read THIS product's own compatibility rows");
});

test('§4 the PDP related-products filter delegates to CompatSource', () => {
    assert.match(PDP_CODE, /cs\.textHasCodeToken\(haystack, c\)/,
        'the local whole-token regex had the boundary rule but NOT the yield-prose rule, so a '
        + 'short numeric series code still matched its own page count: "(9,200 pages)" satisfies '
        + '[^A-Z0-9]200[^A-Z0-9] and diverted Related Products to the wrong family');
});

test('§4 the dead compatibility-tab pair is gone', () => {
    // Both were unreachable: renderCompatibilityTab had no caller, and every
    // element they wrote to exists in zero HTML files.
    for (const fn of ['renderCompatPreview', 'renderCompatibilityTab']) {
        assert.doesNotMatch(stripAllComments(PDP_SRC), new RegExp(`${fn}\\s*\\(`),
            `${fn} was dead code writing to element IDs that exist in no HTML — deleted so it `
            + 'stops implying the PDP has a compatibility tab');
    }
});

test('§4 shop-page queryCodeMatch delegates instead of keeping a private matcher', () => {
    const body = methodBody(SHOP_CODE, 'function queryCodeMatch(');
    assert.match(body, /cs\.textHasCodeToken/, 'the bounded-token scan must come from CompatSource');
    assert.match(body, /cs\.codeExactRegex/, 'the anchored series_codes test must come from CompatSource');
    assert.doesNotMatch(body, /new RegExp\(/,
        'no locally-built matcher may survive here — two implementations of this rule is exactly '
        + 'how the broken one went unnoticed');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — printer models are not cartridge codes
// ─────────────────────────────────────────────────────────────────────────────

test('§5 isPrinterModelToken recognises the incident printers', () => {
    for (const tok of ['DCPJ1050DW', 'DCP-J1050DW', 'DCPJ4120DW', 'MFCJ4620DW',
        'MFC-J1010DW', 'XP-4100', 'ENVY6020', 'TS3360', 'HL-2140', 'L3110']) {
        assert.ok(CompatSource.isPrinterModelToken(tok), `${tok} is a printer, not a cartridge code`);
    }
});

test('§5 isPrinterModelToken clears every real cartridge code it was swept against', () => {
    // These are the collisions found by running the guard over all 977 distinct
    // series_codes in the live catalogue. Each one cost a prefix or suffix from
    // the pattern; they are pinned here so a future "improvement" to the regex
    // cannot quietly reintroduce them.
    const realCodes = [
        'LC431', 'LC431XL', 'LC531', 'LC233', 'LC237XL', 'LC133',   // Brother ink
        'MLTD101S', 'CLT406',                                        // Samsung toner (ML- prefix trap)
        'ML182', 'ML590', 'ML720',                                   // OKI ribbons named for the printer
        'IX105', 'IX305', 'IX315', 'IX405',                          // Fuji Xerox toner
        '332DN',                                                     // OKI toner ending in DN
        'TD455X25', 'TD490X29', 'TD4100X149',                        // ribbon codes
        'MX23', 'MP2014H',                                           // Sharp / Ricoh toner
        'TN2150', 'DR2125', 'CE285A', 'CB435A', '81C1X', '970XL',
        'T664', 'GI490', 'TZE231', 'DK11201', 'HSE211', 'CART069'
    ];
    for (const code of realCodes) {
        assert.ok(!CompatSource.isPrinterModelToken(code),
            `${code} is a product we SELL — flagging it as a printer would fork its family`);
    }
});

test('§5 isPrinterModelToken needs digits — a bare word is never a printer', () => {
    for (const tok of ['BLACK', 'CYAN', 'DCP', 'ENVY', '', null, undefined]) {
        assert.ok(!CompatSource.isPrinterModelToken(tok), `${tok} must not be treated as a printer`);
    }
});

test('§5 familyKey drops printer tokens scraped from a product name', () => {
    const familyKey = UTILS.ProductSort && UTILS.ProductSort.familyKey
        ? UTILS.ProductSort.familyKey
        : null;
    // familyKey is internal to the ProductSort IIFE on some builds; assert on
    // source when it is not reachable, on behaviour when it is.
    if (!familyKey) {
        assert.match(UTILS_CODE, /isPrinterTok/,
            "familyKey's name-scrape fallback must filter printer-shaped tokens");
        assert.match(UTILS_CODE, /\.filter\(mm => !isPrinterTok\(mm\[0\]\)\)/,
            'both extraction passes must be filtered, not just the first');
        return;
    }
    const key = familyKey({
        name: 'LC431XLBK Compatible Ink Cartridge for Brother DCP-J1050DW MFC-J1010DW',
        brand: 'Brother',
        series_codes: []
    });
    assert.ok(!/J1050DW|J1010DW/.test(key),
        `family key must not be a PRINTER model; got ${key}. Pass 1 is last-match-wins and a `
        + 'compatible cartridge name ends with the devices it fits');
});

test('§5 _enrichSeriesCodes will not mint a printer model as a series code', () => {
    const body = methodBody(API_CODE, '_enrichSeriesCodes(');
    assert.match(body, /isPrinterModelToken/,
        'the "for <Brand> …" tail is exactly where compatible-cartridge names list the DEVICES '
        + 'they fit, so this loop would otherwise add DCPJ1050DW as a series code — a phantom '
        + 'chip and a family keyed on a printer');
    assert.match(body, /window\.CompatSource/,
        'read via window: utils.js loads AFTER api.js in document order, and a bare binding '
        + 'reference would throw from the temporal dead zone rather than yield undefined');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — middleware printer-prerender gate
//
// This gate was previously UNPINNED while claiming otherwise: its source
// comment cited tests/printer-url-canonical-may2026.test.js, a file that has
// never existed in this repo. Found during the wrong-family audit.
// ─────────────────────────────────────────────────────────────────────────────

test('§6 the dangling test citation is gone from middleware.js', () => {
    assert.doesNotMatch(MIDDLEWARE_SRC, /printer-url-canonical-may2026\.test\.js(?![\s\S]{0,200}never existed)/,
        'middleware.js must not cite a test file that does not exist — a citation to nowhere is '
        + 'worse than no citation, because it stops anyone adding the real guard');
    assert.ok(!fs.existsSync(path.join(ROOT, 'tests', 'printer-url-canonical-may2026.test.js')),
        'sanity: the cited file really is absent (if it is ever added, move these assertions there)');
    assert.match(MIDDLEWARE_SRC, /compat-wrong-family-jul2026\.test\.js/,
        'the gate should cite the file that actually pins it');
});

test('§6 printer prerender requires BOTH brand and printer_slug', () => {
    const shopArm = MIDDLEWARE_SRC.slice(MIDDLEWARE_SRC.indexOf("else if (path === '/shop')"));
    assert.match(shopArm, /searchParams\.get\('brand'\)/);
    assert.match(shopArm, /searchParams\.get\('printer_slug'\)\s*\|\|\s*url\.searchParams\.get\('printer'\)/,
        '?printer= stays a back-compat alias for printer_slug');
    assert.match(shopArm, /if \(brandSlug && printerSlug\)/,
        'a BARE printer_slug must fall through to the SPA: the slug-only prerender endpoint 404s, '
        + 'and the canonical printer-hub URL carries both params');
    assert.match(shopArm, /api\/prerender\/printer\/\$\{encodeURIComponent\(brandSlug\)\}/,
        'the printer prerender path is /api/prerender/printer/:brand/:slug');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — LIVE (LIVE_API=1)
//
// The data half of the fix. These assert the backend state the frontend now
// depends on completely, having given up every local shortcut.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = process.env.LIVE_API === '1';
const BASE = process.env.API_BASE || 'https://api.inkcartridges.co.nz';
const DOC_BASE = process.env.DOC_BASE || 'https://www.inkcartridges.co.nz';

/** The incident, as a table. */
const INCIDENT = [
    { slug: 'brother-dcp-j1050dw', correct: ['LC431'], wrong: /LC53[16]/i },
    { slug: 'brother-dcp-j4120dw', correct: ['LC233', 'LC235', 'LC237'], wrong: /LC536/i },
    { slug: 'brother-mfc-j4620dw', correct: ['LC233', 'LC235', 'LC237'], wrong: /LC536/i }
];

/** SKUs un-linked from those printers. They are STILL SOLD — just not there. */
const UNLINKED_SKUS = ['CLC531XLBK', 'GLC531XLBK', 'CLC536XLBK', 'GLC536XLBK', 'CLC536XXLBK'];

for (const { slug, correct, wrong } of INCIDENT) {
    test(`§7 LIVE — /api/products/printer/${slug} lists ONLY its own family`, { skip: !LIVE }, async () => {
        const url = `${BASE}/api/products/printer/${slug}?limit=200`;
        const res = await fetch(url);
        assert.ok(res.ok, `${url} returned HTTP ${res.status}`);
        const body = await res.json();
        assert.equal(body.ok, true, 'envelope: { ok: true, data }');
        const products = body.data.compatible_products || body.data.products || [];
        assert.ok(products.length > 0, `${slug} should still list its correct cartridges`);

        const offenders = products.filter((p) => wrong.test(
            [(p.series_codes || []).join(','), p.sku, p.name].join(' ')));
        assert.deepEqual(offenders.map((p) => p.sku), [],
            `${slug} must list NO ${wrong} products — this is the defect that sold a customer a `
            + 'cartridge that did not fit');

        const families = [...new Set(products.flatMap((p) => p.series_codes || []))];
        for (const fam of families) {
            assert.ok(correct.some((c) => fam.toUpperCase().startsWith(c)),
                `unexpected family ${fam} on ${slug}; expected only ${correct.join(' / ')}. `
                + `All families seen: ${families.join(', ')}`);
        }
    });
}

for (const sku of UNLINKED_SKUS) {
    test(`§7 LIVE — un-linked SKU ${sku} is still sold`, { skip: !LIVE }, async () => {
        const res = await fetch(`${BASE}/api/products/${sku}`);
        assert.ok(res.ok, `${sku} returned HTTP ${res.status} — un-linking a cartridge from a `
            + 'printer must never deactivate it or create a 404');
        const body = await res.json();
        assert.equal(body.ok, true);
        const product = body.data.product || body.data;
        assert.equal(String(product.sku).toUpperCase(), sku,
            `expected ${sku}; got ${product.sku}`);
    });
}

test('§7 LIVE — the resolver design actually resolves the incident printers', { skip: !LIVE }, async () => {
    // Exercises the same two steps resolvePrinterModelSlug takes: fetch the
    // brand pool, then match on printerKey. Proves the separator-insensitive
    // comparison is what makes this work — the raw strings do not match.
    const res = await fetch(`${BASE}/api/printers/by-brand/brother?grouped=false&exclude_non_ink=true`);
    assert.ok(res.ok, `brand pool returned HTTP ${res.status}`);
    const body = await res.json();
    const rows = body.data.printers || body.data.models || [];
    assert.ok(rows.length > 0, 'the Brother printer pool must not be empty');

    for (const spelling of ['Brother DCP-J1050DW', 'Brother DCP J1050DW', 'brother dcpj1050dw']) {
        const want = CompatSource.printerKey(spelling);
        const bare = CompatSource.printerKey(CompatSource.stripBrandPrefix(spelling));
        const hit = rows.find((r) => [r.slug, r.full_name, r.model_name]
            .map(CompatSource.printerKey)
            .some((k) => k && (k === want || k === bare)));
        assert.ok(hit, `"${spelling}" must resolve against the live brand pool`);
        assert.equal(hit.slug, 'brother-dcp-j1050dw');
    }
});

test('§7 LIVE — bot prerender for the incident pages carries no wrong family', { skip: !LIVE }, async () => {
    for (const { slug, wrong } of INCIDENT) {
        const url = `${DOC_BASE}/shop?brand=brother&printer_slug=${slug}`;
        const res = await fetch(url, {
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
        });
        assert.ok(res.ok, `${url} returned HTTP ${res.status}`);
        assert.equal(res.headers.get('x-prerendered'), 'true',
            `${slug} must serve prerendered HTML to bots, not the SPA shell`);
        const html = await res.text();
        const hits = html.match(new RegExp(wrong.source, 'gi')) || [];
        assert.equal(hits.length, 0,
            `prerendered HTML for ${slug} still mentions ${wrong} ${hits.length} time(s) — if this `
            + 'fails, the CDN really is serving something stale and a purge IS needed (it was not '
            + 'when this was written: cf-cache-status came back DYNAMIC and the HTML was clean)');
    }
});
