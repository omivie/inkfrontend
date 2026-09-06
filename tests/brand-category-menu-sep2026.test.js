/**
 * Brand × category menu — the mega's claims vs the shelf (Sep 2026, ERR-215)
 * ==========================================================================
 *
 * A customer clicked Lexmark → Ink Cartridges and got "No products found."
 * We have never stocked a Lexmark ink cartridge. The link had been in the menu
 * since it was written, and nothing had ever checked it.
 *
 * `BRANDS` in js/mega-nav.js is ~29 hardcoded brand+category claims. The
 * /api/site/nav feed can reorder the cards or drop a whole brand, but
 * mega-nav.js lifts the CATEGORY lists straight out of that local array, so the
 * feed can never correct a single wrong link. The only instrument pointed at
 * those claims was a customer noticing.
 *
 * The measurement lives in `npm run audit:brand-categories` (live catalogue —
 * a static test cannot count products). What THIS file pins is everything that
 * has to stay true for that audit to keep working, plus the specific fix:
 *
 *   1. THE DEAD LINK STAYS DEAD. Lexmark offers no `ink`.
 *   2. THE AUDIT CAN STILL READ THE MENU. The audit slices `const BRANDS = [`
 *      out of mega-nav.js and evaluates it. If someone renames or restructures
 *      that array, the audit must fail LOUDLY — an audit that finds no brands
 *      reports no bad links, which is the absence-read-as-zero mistake it
 *      exists to catch. So the contract between the two is pinned here.
 *   3. A ZERO FOR A MULTI-TYPE FAMILY STAYS UNPROVEN. shop-page.js must not go
 *      back to hiding a category tile on a bare `counts.X || 0`. That is what
 *      buried Epson's 5 maintenance boxes: the backend omits `maintenance_box`
 *      from `counts.drums`, the key came back ABSENT, and absent read as zero.
 *   4. THE AUDIT STAYS READ-ONLY. No write verb, no --record, no baseline.
 *   5. ENROLMENT. Every brand in the mega is also in shop-page.js's brandInfo.
 *      Two hardcoded copies of the brand list exist; neither may gain a brand
 *      the other lacks ("every surface calls X" is a list nobody maintains —
 *      ERR-150/160).
 *
 * Invariants, not lines (ERR-053): a source-pin that quotes the buggy line
 * freezes the bug in place.
 *
 * Run: node --test tests/brand-category-menu-sep2026.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'inkcartridges');

const MEGA_NAV = fs.readFileSync(path.join(SITE, 'js/mega-nav.js'), 'utf8');
const SHOP_JS = fs.readFileSync(path.join(SITE, 'js/shop-page.js'), 'utf8');
const API_JS = fs.readFileSync(path.join(SITE, 'js/api.js'), 'utf8');
const AUDIT = fs.readFileSync(path.join(ROOT, 'scripts/audit-brand-categories.mjs'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * Extract BRANDS exactly the way scripts/audit-brand-categories.mjs does.
 * If this helper and the audit ever disagree, one of them is reading a menu
 * that is not shipping.
 */
function extractBrands(src) {
    const start = src.indexOf('const BRANDS = [');
    if (start === -1) return null;
    const open = src.indexOf('[', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    const raw = vm.runInNewContext(`(${src.slice(open, end + 1)})`, Object.create(null), { timeout: 1000 });
    // Cross-realm: the array literal is constructed inside the vm context, so its
    // prototype is that realm's Array. Round-trip it into native objects or every
    // deepStrictEqual in this file compares prototypes and fails on identical data.
    return JSON.parse(JSON.stringify(raw));
}

// ───────────────────────────────────────────────────────────────────────────
// §1 The dead link stays dead
// ───────────────────────────────────────────────────────────────────────────

test('§1 Lexmark offers no Ink Cartridges link', () => {
    const brands = extractBrands(MEGA_NAV);
    assert.ok(brands, 'could not extract BRANDS from mega-nav.js');
    const lexmark = brands.find(b => b.slug === 'lexmark');
    assert.ok(lexmark, 'the mega menu no longer has a Lexmark card');

    const params = lexmark.categories.map(c => c.param);
    assert.ok(!params.includes('ink'),
        'Lexmark → Ink Cartridges is back in mega-nav.js BRANDS. We stock zero Lexmark ' +
        'ink_cartridge and zero ink_bottle rows, so that link lands on "No products found" ' +
        '(ERR-215). Run `npm run audit:brand-categories` before re-adding it.');
    assert.deepEqual(params, ['toner', 'drums'],
        'Lexmark should offer exactly Toner Cartridges and Drums & Supplies');
});

test('§1 no brand card is left with an empty category list', () => {
    const brands = extractBrands(MEGA_NAV);
    for (const b of brands) {
        assert.ok(b.categories.length > 0,
            `${b.slug} has a card in the mega menu but no category links — remove the ` +
            'card, or give it a link. A logo that goes nowhere is worse than no logo.');
    }
});

// ───────────────────────────────────────────────────────────────────────────
// §2 The audit can still read the menu
// ───────────────────────────────────────────────────────────────────────────

test('§2 BRANDS stays machine-extractable by the audit', () => {
    const brands = extractBrands(MEGA_NAV);
    assert.ok(Array.isArray(brands) && brands.length > 0,
        'scripts/audit-brand-categories.mjs slices `const BRANDS = [` out of mega-nav.js ' +
        'and evaluates it. That extraction just failed, which means the audit would exit ' +
        'rather than certify — fix the extractor in BOTH places, never delete the check.');

    for (const b of brands) {
        assert.equal(typeof b.slug, 'string', `a BRANDS entry has no slug: ${JSON.stringify(b)}`);
        assert.ok(Array.isArray(b.categories), `${b.slug} has no categories array`);
        for (const c of b.categories) {
            assert.equal(typeof c.param, 'string', `${b.slug} has a category with no param`);
            assert.equal(typeof c.label, 'string', `${b.slug} has a category with no label`);
        }
    }
});

test('§2 every mega param is a canonical /shop category', () => {
    // canonicalizeCategory() in utils.js is the URL boundary. A param it does not
    // recognise is stripped from the address bar and the drilldown silently falls
    // back to the brand picker — a link that looks fine and goes nowhere.
    const CANONICAL = new Set(['ink', 'toner', 'ribbon', 'drums', 'label', 'paper']);
    for (const b of extractBrands(MEGA_NAV)) {
        for (const c of b.categories) {
            assert.ok(CANONICAL.has(c.param),
                `${b.slug} links category="${c.param}", which canonicalizeCategory() ` +
                '(js/utils.js) does not recognise — the param would be stripped on arrival.');
        }
    }
});

test('§2 the audit is wired to an npm script', () => {
    assert.equal(PKG.scripts['audit:brand-categories'], 'node scripts/audit-brand-categories.mjs',
        'the audit only runs if someone can run it');
});

// ───────────────────────────────────────────────────────────────────────────
// §3 A zero for a multi-type family stays unproven
// ───────────────────────────────────────────────────────────────────────────

test('§3 shop-page confirms a multi-type zero before hiding a tile', () => {
    assert.match(SHOP_JS, /_confirmMultiTypeZeros\s*\(/,
        'loadCategories() must confirm a zero count for a multi-type family before hiding ' +
        'its tile. Without it, an absent counts key reads as 0 and buries a stocked ' +
        'category (ERR-215: Epson\'s 5 maintenance boxes).');
    assert.match(SHOP_JS, /await this\._confirmMultiTypeZeros\(categoryCounts, navVersion\)/,
        'the confirm must actually run inside loadCategories, not merely be defined');
});

test('§3 the confirm reads family size from the shipped map, not a hardcoded list', () => {
    const fn = SHOP_JS.slice(SHOP_JS.indexOf('async _confirmMultiTypeZeros'));
    const body = fn.slice(0, fn.indexOf('\n        },'));
    assert.match(body, /API\._CATEGORY_PRODUCT_TYPES/,
        'membership must come from api.js _CATEGORY_PRODUCT_TYPES so a category that gains ' +
        'a product_type is covered without editing this function');
    assert.ok(!/['"]drums['"]\s*[,:)\]]/.test(body),
        'the confirm must not hardcode "drums" — it was the family that bit us, not the ' +
        'only multi-type family. Derive the suspects from the map.');
    assert.match(body, /length > 1/,
        'the rule is "more than one product_type in the family", stated in code');
});

test('§3 the confirm is tri-state: null is unmeasured, never zero', () => {
    const fn = SHOP_JS.slice(SHOP_JS.indexOf('async _confirmMultiTypeZeros'));
    const body = fn.slice(0, fn.indexOf('\n        },'));
    assert.match(body, /total === null/,
        'a failed confirm must be handled as its own case — "the shelf is empty" and ' +
        '"I could not see the shelf" are different sentences');
    assert.match(body, /DebugLog\.warn/,
        'both the drift case and the unmeasured case must say so out loud; a fail-soft ' +
        'that says nothing is how this bug survived');
    const warns = body.match(/DebugLog\.warn/g) || [];
    assert.ok(warns.length >= 2,
        `expected a warn for the drift case AND the unmeasured case, found ${warns.length}`);
});

test('§3 getCategoryTotal returns null on failure and bypasses the compat sidecar', () => {
    const fn = API_JS.slice(API_JS.indexOf('async getCategoryTotal'));
    const body = fn.slice(0, fn.indexOf('\n    },'));
    assert.match(body, /catalogEndpoint\('\/api\/shop'/,
        'must build its URL through catalogEndpoint so CATALOG_PARAM_ORDER holds and it ' +
        'mints no parallel edge-cache key (ERR-124/159)');
    assert.ok(!/getShopData/.test(body),
        'must NOT route through getShopData — with brand+category and no source that fires ' +
        'a 200-row compat-recovery sidecar just to read a count');
    assert.match(body, /return null/,
        'an unreadable count must be null (unmeasured), never 0');
    assert.match(body, /typeof total === 'number' \? total : null/,
        'a missing meta.total is unmeasured too');
});

test('§3 the category-counts cache key was retired with the fix', () => {
    // A v4 entry was built by reading an absent facet key as zero. Leaving the key
    // unchanged would serve that stale wrong answer to returning visitors.
    assert.ok(!SHOP_JS.includes('-category-counts-v4'),
        'the v4 cache key holds pre-fix counts — bump it when the counting rule changes');
    assert.match(SHOP_JS, /-category-counts-v5/,
        'expected the bumped v5 category-counts cache key');
});

// ───────────────────────────────────────────────────────────────────────────
// §4 The audit stays read-only
// ───────────────────────────────────────────────────────────────────────────

test('§4 the audit has no write path', () => {
    // Grep for the flag being CONSUMED, not merely mentioned — the file's own
    // header promises it accepts none of these, and that promise is the reason
    // the words appear at all.
    for (const flag of ['--record', '--update-baseline', '--write', '--fix']) {
        const consumed = new RegExp(`(ARGS\\.has|argv[^\\n]*(includes|indexOf))\\([^)]*${flag}`);
        assert.ok(!consumed.test(AUDIT),
            `scripts/audit-brand-categories.mjs must not accept ${flag}. A probe that can ` +
            'record is a probe that can pass because it just overwrote what it was ' +
            'comparing against (sweep:b2b ate a committed fixture on 2026-08-12).');
    }
    assert.ok(!/fs\.(writeFile|appendFile|createWriteStream|rm|unlink|mkdir|copyFile)/.test(AUDIT),
        'the audit must not write to disk at all');
    assert.match(AUDIT, /MODE: READ-ONLY/, 'the mode must be printed on every run');
});

test('§4 the audit paces its catalogue walk', () => {
    // An unpaced walk of /api/products 502'd the whole backend instance (ERR-188).
    assert.match(AUDIT, /REQUEST_DELAY_MS\s*=\s*Number\(process\.env\.PROBE_DELAY_MS \|\| 650\)/,
        'the 650ms pace is not optional');
    assert.match(AUDIT, /PACE: \$\{REQUEST_DELAY_MS\}ms/,
        'the pace must be printed, so a run that skipped it is visible');
});

test('§4 an unreadable catalogue fails, and the ribbons exemption is named', () => {
    assert.match(AUDIT, /This is a FAILURE, not a pass/,
        '"I could not read the catalogue" must never exit 0');
    assert.match(AUDIT, /Exemptions — checked, then deliberately not counted/,
        'the ribbons exemption must be PRINTED. A skip nobody sees is indistinguishable ' +
        'from a check that passed.');
    assert.match(AUDIT, /B2_EXEMPT_CATEGORIES/,
        'the exemption must be a named constant, not an inline continue');
});

test('§4 B1 and B2 resolve against the catalogue, never the counts facet', () => {
    // The facet is measurably wrong (it omits maintenance_box from drums), so a
    // check that trusts it would have deleted Epson's Drums & Supplies.
    const b1 = AUDIT.slice(AUDIT.indexOf('B1 — a link we OFFER'), AUDIT.indexOf('B2 — rows that are LIVE'));
    assert.match(b1, /categoryTotal\(/,
        'B1 must confirm an empty shelf with a real ?category= query before calling a link dead');
    assert.ok(!/facetCounts\(/.test(b1),
        'B1 must not resolve against the counts facet — the facet undercounts multi-type families');
});

// ───────────────────────────────────────────────────────────────────────────
// §5 Enrolment — the two hardcoded brand lists cannot drift apart
// ───────────────────────────────────────────────────────────────────────────

test('§5 every mega brand is also in shop-page brandInfo', () => {
    const brands = extractBrands(MEGA_NAV);
    const infoBlock = SHOP_JS.match(/brandInfo:\s*\{([\s\S]*?)\n\s{8}\}/);
    assert.ok(infoBlock, 'could not find brandInfo in shop-page.js');
    const known = new Set([...infoBlock[1].matchAll(/^\s*'?([a-z-]+)'?:\s*\{/gm)].map(m => m[1]));

    for (const b of brands) {
        assert.ok(known.has(b.slug),
            `${b.slug} has a card in the mega menu but no entry in shop-page.js brandInfo — ` +
            'the offline brand fallback would render it nameless. Two hardcoded copies of ' +
            'the brand list exist; neither may gain a brand the other lacks (ERR-150/160).');
    }
});

test('§5 the mega still carries no per-brand allowlist for the /shop grid', () => {
    // The /shop brand grid is DATA (brands.show_on_shop) since ERR-192. The mega's
    // BRANDS array is a link table, not a membership list, and must not creep back
    // into deciding which brands exist.
    assert.ok(!/SHOP_BRAND_ALLOWLIST/.test(MEGA_NAV),
        'mega-nav.js must not carry a shop brand allowlist — show_on_shop decides');
    assert.match(MEGA_NAV, /hydrateFromSiteNav/,
        'the feed must still be able to reorder and drop cards');
});
