/**
 * The homepage emitted Organization, WebSite and LocalBusiness TWICE (Sep 2026)
 * =============================================================================
 *
 * ERR-276 · backend handoff `mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md`
 *
 * WHAT WAS WRONG
 * --------------
 * index.html carries three JSON-LD documents statically in <head>, so they exist
 * with JavaScript disabled and for a crawler that does not run scripts.
 * js/footer.js then emitted the SAME three as literal <script> tags inside
 * `footer.innerHTML`. A <script> inserted via innerHTML never EXECUTES — but
 * `application/ld+json` is data, not code, so it parses perfectly. The rendered
 * homepage therefore held Organization x2, WebSite x2 and LocalBusiness x2.
 *
 * js/schema.js already had the right mechanism — `write(id, payload)` reuses an
 * existing node with that id and only creates one when there is none — and it
 * could not help, because the static blocks had no `id` at all. Two writers,
 * three documents, and one pair invisible to the other. Measured on production
 * 2026-09-20: 4 ld+json blocks pre-JS, 6 after footer.js ran. (The backend's
 * own prerender, which is what Googlebot is served on `/`, was always clean —
 * one Organization, one WebSite — so this was the rendered DOM only.)
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THESE TESTS
 * -------------------------------------------------
 *   1. THE ID COMES OFF AGAIN. The whole fix is the `id` attribute. Nothing
 *      about an id-less <script type="application/ld+json"> looks wrong, and
 *      removing one silently restores the duplication. §1/§2.
 *   2. A LITERAL TAG GOES BACK INTO THE TEMPLATE. The obvious way to add a
 *      fourth document is to type it into footer.innerHTML next to the others —
 *      which is precisely what caused this. §3.
 *   3. THE UPSERT STOPS REUSING. `document.head.appendChild` without the
 *      `getElementById` check is a one-character-looking change that appends a
 *      second node on every call. §4 EXECUTES the shipped upsert against a DOM
 *      stub and counts nodes, rather than trusting that it reads correctly.
 *   4. A FACT IS LOST IN THE REFACTOR. The documents moved from hand-written
 *      interpolated JSON to real objects. Structured data that disagrees with
 *      the bot render reads as cloaking, and the NZBN/GST/address are the
 *      Business Transparency facts an ads reviewer looks for. §5.
 *   5. THE STATIC FALLBACK IS "CLEANED UP". Deleting the static blocks now that
 *      footer.js writes them would look like removing duplication and would
 *      actually remove the no-JS copy — removing a fallback is a behaviour
 *      change, not cleanup (ERR-158). §6.
 *
 * Run: node --test tests/homepage-jsonld-single-owner-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (...p) => fs.readFileSync(path.join(INK, ...p), 'utf8');

const FOOTER_JS = read('js', 'footer.js');
const FOOTER_CODE = stripComments(FOOTER_JS);
const SCHEMA_JS = read('js', 'schema.js');
const ROOT_INDEX = read('index.html');
const HTML_INDEX = read('html', 'index.html');

const IDS = ['site-jsonld-organization', 'site-jsonld-website', 'site-jsonld-localbusiness'];

/** Markup only — a comment that NAMES a tag is not a tag (the ERR-253 family). */
const markupOnly = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** Count `<script type="application/ld+json" ...>` openings in real markup. */
function jsonLdTags(html) {
    return [...markupOnly(html).matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>/g)].map((m) => m[0]);
}

/**
 * Lift the two shipped helpers out of footer.js and run them.
 *
 * This slices the REAL source text rather than re-typing the logic here. A test
 * that re-implements the thing it is testing certifies a replica — that is how
 * a probe once passed against a copy of the search escaper while the shipped
 * one was broken (ERR-231).
 */
function loadUpsert() {
    const start = FOOTER_JS.indexOf('  const SITE_JSONLD_IDS =');
    const end = FOOTER_JS.indexOf('  function writeSiteSchema(TRUST) {');
    assert.ok(start > -1 && end > start, 'the JSON-LD helpers must still be in footer.js');
    const src = FOOTER_JS.slice(start, end);
    // eslint-disable-next-line no-new-func
    return new Function('document', `${src}\n return { SITE_JSONLD_IDS, siteSchemaDocs, upsertJsonLd };`);
}

/** The smallest DOM that can tell "reused a node" from "appended another". */
function fakeDom() {
    const nodes = [];
    const doc = {
        head: { appendChild(el) { nodes.push(el); } },
        documentElement: { appendChild(el) { nodes.push(el); } },
        createElement: () => ({ type: '', id: '', textContent: '' }),
        getElementById: (id) => nodes.find((n) => n.id === id) || null,
    };
    return { doc, nodes };
}

const TRUST = {
    tradingName: 'InkCartridges.co.nz',
    legalEntity: 'Office Consumables Ltd',
    nzbn: '9429033934204',
    gstNumber: '94-509-459',
    phoneSchema: '+64-27-474-0115',
    email: 'support@inkcartridges.co.nz',
};

// ═══════════════════════════════════════════════════════════════════════════
// §1 one vocabulary, shared by every writer
// ═══════════════════════════════════════════════════════════════════════════

test('§1 the static blocks carry the ids the writers address', () => {
    for (const id of IDS) {
        assert.match(ROOT_INDEX, new RegExp(`<script type="application/ld\\+json" id="${id}">`),
            `index.html must tag its static ${id} block. The id IS the fix: without it, footer.js's `
            + 'upsert cannot see the block and appends a second copy beside it.');
    }
});

test('§1 footer.js and schema.js use the same three ids', () => {
    for (const id of IDS) {
        assert.ok(FOOTER_CODE.includes(`'${id}'`), `footer.js must address ${id}`);
    }
    /* js/schema.js builds these ids by convention (`site-jsonld` + the schema
     * type, lowercased) rather than listing them, so assert the prefix its
     * _writeMixed call produces rather than three literals it does not contain. */
    assert.match(stripComments(SCHEMA_JS), /_writeMixed\('site-jsonld'/,
        'schema.js must keep writing under the site-jsonld prefix — its write(id) is the other '
        + 'half of the single-owner rule on the pages that load it');
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 exactly one static node per document
// ═══════════════════════════════════════════════════════════════════════════

test('§2 no document is declared twice in the static HTML', () => {
    for (const [name, html] of [['index.html', ROOT_INDEX], ['html/index.html', HTML_INDEX]]) {
        const ids = jsonLdTags(html)
            .map((t) => (t.match(/id="([^"]+)"/) || [])[1])
            .filter(Boolean);
        assert.equal(new Set(ids).size, ids.length,
            `${name} declares the same JSON-LD id twice: ${ids.join(', ')}`);
    }
});

test('§2 FAQPage is deliberately left id-less', () => {
    /* Nothing upserts it, so giving it an id would imply an owner it does not
     * have. Stated as a test so the next person adding ids does not "finish the
     * job" and create a node footer.js will then start fighting over. */
    const tags = jsonLdTags(ROOT_INDEX);
    const idless = tags.filter((t) => !/id="/.test(t));
    assert.equal(idless.length, 1,
        `exactly one id-less JSON-LD block is expected (FAQPage); found ${idless.length}`);
    const faqAt = ROOT_INDEX.indexOf('"FAQPage"');
    assert.ok(faqAt > -1 && ROOT_INDEX.lastIndexOf(idless[0], faqAt) > -1,
        'the id-less block must be the FAQPage one');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 the template must not grow a literal tag again
// ═══════════════════════════════════════════════════════════════════════════

test('§3 footer.innerHTML emits no JSON-LD at all', () => {
    const template = FOOTER_JS.slice(FOOTER_JS.indexOf('footer.innerHTML = `'));
    assert.equal(jsonLdTags(template).length, 0,
        'a literal <script type="application/ld+json"> inside footer.innerHTML is exactly what '
        + 'duplicated these documents. innerHTML does not EXECUTE a script, but ld+json is data '
        + 'and parses regardless — so the tag is a second copy, not a no-op.');
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 the upsert REUSES — executed, not read
// ═══════════════════════════════════════════════════════════════════════════

test('§4 writing twice produces one node per document, not two', () => {
    const { doc, nodes } = fakeDom();
    const { SITE_JSONLD_IDS, siteSchemaDocs, upsertJsonLd } = loadUpsert()(doc);
    const docs = siteSchemaDocs(TRUST);

    SITE_JSONLD_IDS.forEach((id) => upsertJsonLd(id, docs[id]));
    assert.equal(nodes.length, 3, 'first pass creates three nodes');
    SITE_JSONLD_IDS.forEach((id) => upsertJsonLd(id, docs[id]));
    assert.equal(nodes.length, 3,
        'a second pass must REUSE them. If this is 6, the upsert has stopped checking '
        + 'getElementById and every page load appends another copy.');
    for (const n of nodes) assert.equal(n.type, 'application/ld+json');
});

test('§4 an existing static node is adopted, never duplicated', () => {
    /* The real homepage case: index.html has already put the node in the
     * document before footer.js runs. */
    const { doc, nodes } = fakeDom();
    const staticNode = { type: 'application/ld+json', id: 'site-jsonld-organization', textContent: '{"@type":"Organization","stale":true}' };
    nodes.push(staticNode);

    const { siteSchemaDocs, upsertJsonLd } = loadUpsert()(doc);
    upsertJsonLd('site-jsonld-organization', siteSchemaDocs(TRUST)['site-jsonld-organization']);

    assert.equal(nodes.length, 1, 'the static node must be reused, not joined by a second one');
    assert.equal(nodes[0], staticNode, 'the SAME node object must be updated in place');
    assert.doesNotMatch(staticNode.textContent, /stale/, 'its contents must be replaced');
});

test('§4 a node of the wrong type is refused rather than hijacked', () => {
    const { doc, nodes } = fakeDom();
    const foreign = { type: 'text/javascript', id: 'site-jsonld-website', textContent: 'alert(1)' };
    nodes.push(foreign);
    const { siteSchemaDocs, upsertJsonLd } = loadUpsert()(doc);
    const wrote = upsertJsonLd('site-jsonld-website', siteSchemaDocs(TRUST)['site-jsonld-website']);
    assert.equal(wrote, false, 'writing JSON into a node that is not an ld+json script must be refused');
    assert.equal(foreign.textContent, 'alert(1)', 'and it must be left alone');
});

test('§4 `</` is escaped, so a value can never close the tag early', () => {
    const { doc, nodes } = fakeDom();
    const { upsertJsonLd } = loadUpsert()(doc);
    upsertJsonLd('site-jsonld-organization', { '@type': 'Organization', name: 'Evil</script><script>x' });
    assert.doesNotMatch(nodes[0].textContent, /<\/script/,
        'an unescaped "</script" inside a value ends the block early and turns the rest of the '
        + 'document into markup — the reason js/schema.js escapes it too');
    assert.match(nodes[0].textContent, /<\\\/script/);
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 nothing was lost when the JSON became objects
// ═══════════════════════════════════════════════════════════════════════════

test('§5 the transparency facts survive, and come from LegalConfig', () => {
    const { doc } = fakeDom();
    const { siteSchemaDocs } = loadUpsert()(doc);
    const docs = siteSchemaDocs(TRUST);

    const org = docs['site-jsonld-organization'];
    assert.equal(org['@type'], 'Organization');
    assert.equal(org.legalName, TRUST.legalEntity);
    assert.equal(org.taxID, TRUST.gstNumber);
    assert.deepEqual(org.identifier, [
        { '@type': 'PropertyValue', propertyID: 'NZBN', value: TRUST.nzbn },
        { '@type': 'PropertyValue', propertyID: 'GST', value: TRUST.gstNumber },
    ], 'NZBN and GST are the Google Ads Business Transparency facts — the account was suspended '
     + 'for misrepresentation in May 2026, and structured data that disagrees with the bot render '
     + 'reads as cloaking');
    assert.equal(org.address.addressLocality, 'Kelston, Auckland');

    const site = docs['site-jsonld-website'];
    assert.equal(site['@type'], 'WebSite');
    assert.equal(site.potentialAction.target.urlTemplate,
        'https://www.inkcartridges.co.nz/shop?q={search_term_string}');

    const local = docs['site-jsonld-localbusiness'];
    assert.equal(local['@type'], 'LocalBusiness');
    assert.deepEqual(local.geo, { '@type': 'GeoCoordinates', latitude: -36.9005, longitude: 174.6669 });
    assert.deepEqual(local.openingHoursSpecification.dayOfWeek,
        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
});

test('§5 every document is serialisable — a broken one reports as NO structured data', () => {
    /* The old form spliced ${TRUST.legalEntity} into hand-written JSON. One
     * apostrophe or backslash from LegalConfig would have produced a document
     * that silently fails to parse, and invalid JSON-LD is not an error anyone
     * sees — it is simply absent. */
    const { doc } = fakeDom();
    const { siteSchemaDocs } = loadUpsert()(doc);
    const hostile = { ...TRUST, legalEntity: 'O\'Brien "Office" \\ Ltd </script>' };
    for (const [id, payload] of Object.entries(siteSchemaDocs(hostile))) {
        const json = JSON.stringify(payload).replace(/<\//g, '<\\/');
        assert.doesNotThrow(() => JSON.parse(json.replace(/<\\\//g, '</')), `${id} must round-trip`);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 the static copy is a FALLBACK and must stay
// ═══════════════════════════════════════════════════════════════════════════

test('§6 the no-JS copy is not deleted as "duplication"', () => {
    /* With footer.js now writing these, deleting the static blocks looks like
     * finishing the cleanup. It is not: it removes the only copy a crawler that
     * does not execute scripts can see, and root index.html does not even load
     * js/schema.js. Removing a fallback is a behaviour change (ERR-158). */
    assert.equal(jsonLdTags(ROOT_INDEX).length, 4,
        'index.html must keep its four static JSON-LD blocks (Organization, WebSite, '
        + 'LocalBusiness, FAQPage)');
    for (const t of ['"Organization"', '"WebSite"', '"LocalBusiness"']) {
        assert.ok(ROOT_INDEX.includes(t), `${t} must still be present statically`);
    }
});

test('§6 footer.js still calls the writer after the footer paints', () => {
    assert.match(FOOTER_CODE, /writeSiteSchema\(TRUST\);/,
        'the upsert has to actually be invoked — a helper nobody calls is the shape of ERR-194, '
        + 'where a guard was an off-switch at every real entry point');
    const writer = FOOTER_CODE.match(/function writeSiteSchema\(TRUST\)[\s\S]*?\n  \}/);
    assert.match(writer[0], /catch \(_\)/,
        'it must not throw into initFooter — a throw here leaves the page with exactly one copy '
        + 'of each document (the static one), which is the correct outcome, not none');
});
