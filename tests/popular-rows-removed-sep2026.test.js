/**
 * The "Popular … right now" and "Full colour sets" rows are GONE (ERR-290)
 * ========================================================================
 *
 * Owner, 2026-09-28, via the backend handoff
 * `remove-popular-and-colour-set-rows-FE-sep2026.md`: "these two rows are no
 * longer needed since users have different printers requiring different
 * cartridges. Please remove this logic across all pages."
 *
 * A best-seller or colour-set row shows cartridges for printers the visitor does
 * not own. The product list, the printer finder and the "Fits …" lines already
 * answer the question the visitor came with.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THESE TESTS
 * -------------------------------------------------
 *   - The rows were `hidden` sections in html/shop.html, which serves EVERY
 *     /shop, landing and /search URL. Hiding them again (CSS, `hidden`) would
 *     look like a fix and still leave the h2s in the DOM for the backend's
 *     acceptance check to find, and the fetch still firing. §1 + §2.
 *   - The backend deletes GET /api/products/popular once we stop calling it. Any
 *     caller left behind — including the INERT home-page grid in landing.js the
 *     handoff did not list — becomes a call to a deleted route. §2.
 *   - The zero-results fallback rail was titled "Browse popular categories", an
 *     h3 that matches the acceptance regex /Popular/ without being a best-seller
 *     row at all. §3.
 *   - The handoff also says what to KEEP. Deleting "colour set" things by grep
 *     would take /value-packs (a Google Ads sitelink), the card badge, the PDP
 *     pack offer and the cart's "Switch to the set" with it. §4 are positive
 *     controls: they must stay green while §1-§3 go red on the old tree.
 *
 * Live check (both viewports, every URL in the handoff):
 *   npm run probe:popular-rows-removed
 *
 * Run: node --test tests/popular-rows-removed-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const INK = path.resolve(__dirname, '..', 'inkcartridges');
const read = (...p) => fs.readFileSync(path.join(INK, ...p), 'utf8');
const markupOnly = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Every storefront page: root pages + html/** (admin excluded — it is not a shop page). */
function storefrontHtml() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'admin') walk(p); }
            else if (e.name.endsWith('.html')) out.push(p);
        }
    };
    walk(path.join(INK, 'html'));
    for (const f of fs.readdirSync(INK)) if (f.endsWith('.html')) out.push(path.join(INK, f));
    return out;
}

/** Every storefront script (js/*.js, not js/admin). */
function storefrontJs() {
    const dir = path.join(INK, 'js');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
}

const headings = (html) => markupOnly(html).match(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi) || [];
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const ROW_HEADING = /popular\b.*\bright now|full colou?r sets/i;
const rel = (p) => path.relative(INK, p);

// ═════════════════════════════════════════════════════════════════════════════
// §1 the markup is deleted, not hidden
// ═════════════════════════════════════════════════════════════════════════════

test('§1 no storefront page ships either row, hidden or not', () => {
    const files = storefrontHtml();
    assert.ok(files.length > 20, `only ${files.length} pages scanned — the walk has drifted`);
    const offenders = [];
    for (const f of files) {
        const html = markupOnly(fs.readFileSync(f, 'utf8'));
        if (/id="(popular-row|popular-row-grid|popular-row-title|value-pack-rail|value-pack-rail-grid|value-pack-rail-lead)"/.test(html)) {
            offenders.push(`${rel(f)}: row container`);
        }
        if (rel(f) === path.join('html', 'value-packs.html')) continue; // §4 — its OWN page, kept
        for (const h of headings(html)) if (ROW_HEADING.test(text(h))) offenders.push(`${rel(f)}: "${text(h)}"`);
    }
    assert.deepEqual(offenders, [], 'the owner removed these rows on every page (ERR-290)');
});

test('§1 the pages the handoff lists carry no "Popular" heading at all (its own acceptance regex)', () => {
    // shop.html serves /shop*, /ink-cartridges, /toner-cartridges, /search;
    // ribbons.html serves /ribbons. The backend re-checks these with /Popular/.
    for (const page of ['shop.html', 'ribbons.html']) {
        const hits = headings(read('html', page)).map(text).filter((t) => /popular|full colou?r sets/i.test(t));
        assert.deepEqual(hits, [], `html/${page}`);
    }
});

test('§1 no stylesheet keeps rules for the deleted rows', () => {
    for (const f of fs.readdirSync(path.join(INK, 'css')).filter((n) => n.endsWith('.css'))) {
        const css = read('css', f).replace(/\/\*[\s\S]*?\*\//g, '');
        assert.doesNotMatch(css, /#popular-row|#value-pack-rail|\.popular-row__grid|\.value-pack-rail__lead|\.product-card--placeholder/,
            `css/${f} styles a row that no longer exists`);
    }
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 the data calls are deleted, so the backend can delete the endpoints
// ═════════════════════════════════════════════════════════════════════════════

test('§2 no storefront script calls /api/products/popular or /api/search/popular', () => {
    const offenders = [];
    for (const f of storefrontJs()) {
        const code = stripComments(fs.readFileSync(f, 'utf8'));
        if (/getPopularProducts|getPopularSearches|\/products\/popular|\/search\/popular/.test(code)) offenders.push(path.basename(f));
    }
    assert.deepEqual(offenders, [],
        'the backend deletes both endpoints once nothing calls them (handoff 2026-09-28) — '
        + 'a surviving caller becomes a request to a deleted route');
});

test('§2 no row renderer survives in the page controllers', () => {
    for (const f of ['shop-page.js', 'ribbons-page.js', 'landing.js']) {
        const code = stripComments(read('js', f));
        assert.doesNotMatch(code, /renderPopularRow|splitPopularRows|renderValuePackRail|POPULAR_(ROW|FETCH|CATEGORY)|VALUE_PACK_RAIL_LIMIT|loadFeaturedProducts/,
            `js/${f}`);
    }
});

test('§2 no script paints either heading', () => {
    for (const f of storefrontJs()) {
        const code = stripComments(fs.readFileSync(f, 'utf8'));
        assert.doesNotMatch(code, /Popular[^'"`\n]*right now|Full colou?r sets/i, path.basename(f));
    }
});

test('§2 the home page renders no product cards — so it is off every card-parity list', () => {
    // landing.js was removed from five "every card surface must …" lists in
    // ERR-290 because its only card surface was the featured grid. If a card
    // comes back here, those lists must take it back too.
    const code = stripComments(read('js', 'landing.js'));
    assert.doesNotMatch(code, /product-card|featured-products/, 'landing.js');
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 zero-results search
// ═════════════════════════════════════════════════════════════════════════════

function recoveryBody() {
    const code = stripComments(read('js', 'shop-page.js'));
    const start = code.indexOf('async renderZeroResultsRecovery(');
    assert.ok(start > 0, 'renderZeroResultsRecovery must exist');
    return code.slice(start, code.indexOf('\n        },', start));
}

test('§3 no recovery rail is titled "Popular"', () => {
    const titles = (recoveryBody().match(/search-recovery__rail-title">([^<]*)</g) || []).map((t) => t.replace(/.*">/, '').replace(/<$/, ''));
    assert.ok(titles.length >= 4, `expected the compat, by-printer, brand and help rails; saw ${titles.join(' | ')}`);
    assert.deepEqual(titles.filter((t) => /popular/i.test(t)), []);
});

test('§3 the backend\'s `kind: "popular"` rail is not rendered', () => {
    const body = recoveryBody();
    assert.doesNotMatch(body, /kind\s*===\s*['"]popular['"]/);
    assert.match(body, /kind === 'compat-printers'/);
    assert.match(body, /kind === 'by-printer'/);
});

test('§3 with no `recovery` the page still offers the printer finder and contact', () => {
    // Backend: "If neither applies, `recovery` is absent. Please show your normal
    // 'no results' message and the contact / printer-finder help in that case."
    const body = recoveryBody();
    const help = body.indexOf('search-recovery__rail--help');
    assert.ok(help > 0, 'help rail must exist');
    // Unconditional: not inside the per-rail loop and not behind the brand-grid branch.
    assert.ok(help > body.lastIndexOf('Browse by category'), 'rendered after both brand-grid branches, whichever ran');
    assert.match(body.slice(help), /href="\/\?scroll=ink-finder"/);
    assert.match(body, /No results for/);
    // Contact is the page's own `.need-help` box, not repeated in the rail —
    // so that box must stay on the page that serves /search.
    const shop = markupOnly(read('html', 'shop.html'));
    assert.match(shop, /class="need-help"[\s\S]*?href="tel:[\s\S]*?href="mailto:/,
        'html/shop.html must keep its phone + email help box — it is the contact half of the handoff\'s ask');
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 what the handoff says to KEEP — positive controls
// ═════════════════════════════════════════════════════════════════════════════

test('§4 /value-packs keeps its "Full colour sets" heading and its own pack request', () => {
    const h = headings(read('html', 'value-packs.html')).map(text);
    assert.ok(h.includes('Full colour sets'), `value-packs.html headings: ${h.join(' | ')}`);
    assert.match(stripComments(read('js', 'value-pages.js')), /pack:\s*'value_pack'/);
    // The detector above must be able to see the heading it is told to skip.
    assert.ok(h.some((t) => ROW_HEADING.test(t)), 'ROW_HEADING must match the kept heading, or §1 proves nothing');
});

test('§4 the "Full-set value pack" card badge stays', () => {
    assert.match(stripComments(read('js', 'shop-page.js')), /Full-set value pack/);
});

test('§4 the PDP pack offer and the cart\'s "Switch to the set" stay', () => {
    assert.match(stripComments(read('js', 'product-detail-page.js')), /\.pack_suggestion\b/);
    assert.match(stripComments(read('js', 'cart.js')), /pack_suggestion_for_line/);
});
