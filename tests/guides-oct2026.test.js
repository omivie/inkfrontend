/**
 * How-to guides — checklist item 41 (backend reply 2026-10-25, Appendix A).
 *
 *   §1 the nine guides + the /guides index exist and route in BOTH configs
 *   §2 copy rules: no prices, no typed returns/guarantee day counts, no "tested
 *      for", every compatible mention says compatible (inv 9 / inv 13)
 *   §3 structured data: Article (or CollectionPage) + BreadcrumbList that
 *      matches the visible breadcrumb; no FAQPage (inv 11 would need the
 *      on-page text byte for byte)
 *   §4 links: products / printers by our URL shapes, the data defects the plan
 *      named are NOT linked, maker links open in a new tab safely
 *   §5 printer + series pages link back (one rule, ShopPage._guideFor)
 *   §6 the footer links /guides
 *
 * Live link health is NOT a unit test: `npm run probe:guides` (READ-ONLY).
 *
 * Run with: node --test tests/guides-oct2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INK = path.resolve(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');
const SLUGS = [
    'replace-brother-toner', 'replace-brother-drum-unit', 'printer-blank-pages-streaks-print-head-cleaning',
    'change-hp-ink-cartridge', 'change-canon-pixma-ink-cartridge', 'page-yield-how-long-cartridges-last',
    'refill-epson-ecotank', 'brother-cannot-detect-ink', 'what-ink-does-my-printer-use',
];
const PAGES = [['/guides', 'html/guides.html'], ...SLUGS.map((s) => [`/guides/${s}`, `html/guides/${s}.html`])];
const mainOf = (html) => html.slice(html.indexOf('<main'), html.indexOf('</main>'));
const textOf = (html) => mainOf(html).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
const ldOf = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

// §1 ─────────────────────────────────────────────────────────────────────────
test('§1 nine guides + the index exist, and route in vercel.json AND serve.json (ERR-092)', () => {
    for (const [, file] of PAGES) assert.ok(fs.existsSync(path.join(INK, file)), file);
    assert.equal(fs.readdirSync(path.join(INK, 'html', 'guides')).filter((f) => f.endsWith('.html')).length, SLUGS.length);
    const vercel = JSON.parse(read('vercel.json')).rewrites;
    assert.ok(vercel.some((r) => r.source === '/guides' && r.destination === '/html/guides'));
    assert.ok(vercel.some((r) => r.source === '/guides/:slug' && r.destination === '/html/guides/:slug'));
    const serve = JSON.parse(read('serve.json')).rewrites;
    assert.ok(serve.some((r) => r.source === 'guides' && r.destination === '/html/guides.html'));
    assert.ok(serve.some((r) => r.source === 'guides/:slug' && r.destination === '/html/guides/:slug.html'));
});

test('§1 each page: own canonical + hreflang, one h1, title and description', () => {
    for (const [route, file] of PAGES) {
        const html = read(file);
        const url = `https://www.inkcartridges.co.nz${route}`;
        assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${file} canonical`);
        assert.equal((html.match(new RegExp(`hreflang="(en-NZ|x-default)"[^>]*href="${url.replace(/[/.]/g, '\\$&')}"`, 'g')) || []).length, 2, `${file} hreflang`);
        assert.equal((mainOf(html).match(/<h1\b/g) || []).length, 1, `${file} one h1`);
        assert.match(html, /<title>[^<]+ \| InkCartridges\.co\.nz<\/title>/);
        assert.match(html, /<meta name="description" content="[^"]{60,}">/);
        assert.doesNotMatch(html, /genuine-vs-compatible"[^>]*rel="canonical"|canonical" href="[^"]*genuine-vs-compatible/, `${file} kept the template canonical`);
    }
});

// §2 ─────────────────────────────────────────────────────────────────────────
test('§2 copy rules: no prices, no typed day counts, no "tested for", no OEM-warranty claims', () => {
    for (const [, file] of PAGES) {
        const t = textOf(read(file));
        assert.doesNotMatch(t, /\$\s?\d|NZD|\bfrom \$/i, `${file}: prices move nightly — link the product instead`);
        assert.doesNotMatch(t, /\b\d+[- ]day\b|\bwithin \d+ days\b/i, `${file}: returns/guarantee days come from /api/site/trust, never typed`);
        assert.doesNotMatch(t, /tested for|guaranteed|lowest price|best in nz|save up to|void(s|ing)? (your|the) warranty/i, `${file}: inv 13`);
    }
});

test('§2 every link text naming a compatible cartridge says "Compatible"', () => {
    for (const [, file] of PAGES) {
        for (const m of mainOf(read(file)).matchAll(/<a href="\/products\/[^"]+\/(C[A-Z0-9.]+)">([^<]+)<\/a>/g)) {
            if (/^C(TN|DR|LC|PG|CL|T5|65|63|955|81|73)/.test(m[1])) assert.match(m[2], /Compatible/, `${file}: ${m[1]} "${m[2]}"`);
        }
    }
});

// §3 ─────────────────────────────────────────────────────────────────────────
test('§3 Article/CollectionPage + BreadcrumbList parse and match the visible breadcrumb; no FAQPage', () => {
    for (const [route, file] of PAGES) {
        const html = read(file);
        const ld = ldOf(html);
        const types = ld.map((x) => x['@type']);
        assert.ok(types.includes('BreadcrumbList'), file);
        assert.ok(types.includes(route === '/guides' ? 'CollectionPage' : 'Article'), file);
        assert.ok(!types.includes('FAQPage') && !types.includes('HowTo'), `${file}: FAQPage needs byte-identical on-page text (inv 11); HowTo is retired`);
        const crumbs = [...html.matchAll(/<li class="breadcrumb__item[^"]*"[^>]*>(?:<a href="[^"]*">)?([^<]+)/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        const bl = ld.find((x) => x['@type'] === 'BreadcrumbList').itemListElement.map((i) => i.name);
        assert.deepEqual(bl, crumbs, `${file}: JSON-LD breadcrumb = visible breadcrumb`);
        if (route !== '/guides') {
            const art = ld.find((x) => x['@type'] === 'Article');
            assert.equal(art.headline, /<h1 class="legal-page__title">([^<]+)<\/h1>/.exec(html)[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"'), file);
            assert.equal(art.mainEntityOfPage, `https://www.inkcartridges.co.nz${route}`);
        }
    }
});

// §4 ─────────────────────────────────────────────────────────────────────────
test('§4 links use our URL shapes; the plan\'s data defects are not linked', () => {
    const all = PAGES.map(([, f]) => mainOf(read(f))).join('\n');
    for (const m of all.matchAll(/href="(\/[^"]*)"/g)) {
        assert.match(m[1], /^\/$|^\/(products\/[^/]+\/[A-Z0-9.-]+|shop\?brand=[a-z-]+&amp;printer_slug=[a-z0-9+-]+|guides(\/[a-z-]+)?|genuine-vs-compatible|returns|contact)$/, m[1]);
    }
    // Backend plan + maker check 2026-10-26: wrong colour / name / yield or not ours.
    for (const sku of ['CCL646XLRD', 'G72PHC', 'G72PHY', 'G72PHGY', 'G70PHMBK', 'G70PHLC', 'G70PHLGY', 'G70PHGY', 'GCL646', 'GCL646XL', 'CLC73CMY', 'CLC73KCMY']) {
        assert.ok(!all.includes(`/${sku}"`), `${sku} must not be linked until its data is fixed`);
    }
    // Printers the maker check dropped (not NZ models / wrong code).
    for (const slug of ['brother-mfc-l2750dw', 'brother-hl-l3280cdw', 'brother-dcp-l3520cdw', 'brother-dcp-j1140dw', 'canon-pixma-ts3560', 'brother-mfc-j6730dw']) {
        assert.ok(!all.includes(`printer_slug=${slug}"`), slug);
    }
    for (const m of all.matchAll(/<a href="https?:[^"]+"([^>]*)>/g)) assert.match(m[1], /rel="noopener" target="_blank"/, m[0]);
});

// §5 ─────────────────────────────────────────────────────────────────────────
function shopMethod(name) {
    const src = read('js/shop-page.js');
    const m = new RegExp(`\\n {8}${name}\\(([^)]*)\\) \\{`).exec(src);
    assert.ok(m, name);
    let i = m.index + m[0].length - 1; let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return new Function(`return function (${m[1]}) ${src.slice(i, j + 1)}`)();
    }
    throw new Error(name);
}
function guidesLiteral() {
    const src = read('js/shop-page.js');
    return new Function(`return ${/\n {8}GUIDES: (\{[\s\S]*?\n {8}\}),/.exec(src)[1]};`)();
}

test('§5 _guideFor: a printer / series page links the guide for what it LISTS', () => {
    const self = { GUIDES: guidesLiteral() };
    const g = (brand, rows) => shopMethod('_guideFor').call(self, brand, rows).map((x) => x.href);
    const row = (product_type, ...codes) => ({ product_type, series_codes: codes });
    assert.deepEqual(g('brother', [row('toner_cartridge', 'TN2445'), row('drum_unit', 'DR2415')]),
        ['/guides/replace-brother-toner', '/guides/replace-brother-drum-unit']);
    assert.deepEqual(g('brother', [row('ink_cartridge', 'LC431XL')]), ['/guides/brother-cannot-detect-ink']);
    assert.deepEqual(g('hp', [row('ink_cartridge', '67')]), ['/guides/change-hp-ink-cartridge']);
    assert.deepEqual(g('canon', [row('ink_cartridge', 'PG645/CL646')]), ['/guides/change-canon-pixma-ink-cartridge']);
    assert.deepEqual(g('epson', [row('ink_bottle', '522')]), ['/guides/refill-epson-ecotank']);
    assert.deepEqual(g('epson', [row('ink_bottle', '502')]), ['/guides/refill-epson-ecotank']);
    // NEGATIVE CONTROLS: nothing the guides are not about.
    assert.deepEqual(g('epson', [row('ink_cartridge', '676')]), [], '676 is not an EcoTank bottle');
    assert.deepEqual(g('canon', [row('ink_cartridge', 'PG540/CL541')]), []);
    assert.deepEqual(g('brother', [row('ink_cartridge', 'LC233')]), []);
    assert.deepEqual(g('hp', [row('toner_cartridge', '05A')]), [], 'HP toner has no guide');
    assert.deepEqual(g('brother', []), []);
    for (const { href } of Object.values(self.GUIDES)) assert.ok(SLUGS.includes(href.replace('/guides/', '')), href);
});

test('§5 ONE writer renders #guide-link after the cards, never throws, and every level resets it', () => {
    const src = read('js/shop-page.js');
    assert.match(read('html/shop.html'), /<p class="guide-link" id="guide-link" hidden><\/p>/);
    assert.equal((src.match(/this\._renderGuideLink\(compatible\.concat\(genuine\)\);/g) || []).length, 2, 'code page + printer page');
    assert.match(src, /async loadCurrentLevel\(navVersion\) \{\n\s+this\._renderGuideLink\(null\);/);
    const from = src.indexOf('        _renderGuideLink(rows) {');
    const body = src.slice(from, src.indexOf('\n        },\n', from));
    assert.match(body, /try \{[\s\S]*\} catch \(e\) \{/, 'a guide link must never turn a loaded page into the error pane');
    assert.match(body, /Security\.escapeAttr\(g\.href\)/);
});

// §6 ─────────────────────────────────────────────────────────────────────────
test('§6 the footer Help column links /guides', () => {
    assert.match(read('js/footer.js'), /<li><a href="\/faq">FAQ<\/a><\/li>\n\s*<li><a href="\/guides">How-to Guides<\/a><\/li>/);
});
