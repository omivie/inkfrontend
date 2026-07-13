/**
 * SEO meta rewrite — May 2026
 * ===========================
 *
 * Pins the storefront half of the backend hand-off `seo-meta-rewrite-may2026.md`
 * (backend commit `6e266c8` "fix(seo): psychology-driven SERP copy for higher
 * CTR"). The backend rewrote `<title>` + `<meta name="description">` for the
 * highest-traffic SEO surfaces and serves the new copy through the bot-prerender
 * layer. Google's no-cloaking rule requires the SPA's title + meta-description
 * to be byte-identical to what a crawler is served, so the SPA mirrors the
 * backend's authoritative output:
 *   - product pages: the API `seo.title`/`seo.description` (already wired in
 *     product-detail-page.js — not re-tested here).
 *   - listing surfaces: js/seo-meta.js fetches the matching prerender endpoint,
 *     extracts the decoded <title> + <meta name=description>, and applies them.
 *
 * The spec checklist (trust fetch, formatDispatchCutoff, fallback ladders,
 * per-surface builders) is the FAIL-OPEN fallback used when the prerender is
 * unreachable. Hard constraints carried over: no superlatives/scarcity/
 * competitor name-drops, no price in <title>, trust facts fetched (never
 * inlined — fail-open by omitting the clause), title <=60, desc <=155.
 *
 * §1  Pure helpers — formatDispatchCutoff
 * §2  Pure helpers — titleLadder
 * §3  Pure helpers — truncateDescription
 * §4  Pure helpers — decodeEntities + extractHead
 * §5  prerenderPathForLocation mirrors middleware (incl. printer brand/slug fix)
 * §6  surfaceForLocation
 * §7  Trust fetch + normalize (fail-open)
 * §8  Fallback builders — shape, length, ladders, clause-omission
 * §9  Compliance — no superlatives/scarcity/competitor/price-in-title
 * §10 render() applies fallback then reconciles; fail-open; seq-guard
 * §11 reconcile() overwrites with prerender head; caches; fail-open
 * §12 Middleware printer prerender path fix (:brand/:slug)
 * §13 Wiring — script tags + controller calls + no inlined trust facts
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SEO_JS_PATH    = path.join(ROOT, 'inkcartridges', 'js', 'seo-meta.js');
const MIDDLEWARE_PATH = path.join(ROOT, 'inkcartridges', 'middleware.js');
const SHOP_JS_PATH    = path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js');
const RIBBONS_JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'ribbons-page.js');

const SEO_SRC = fs.readFileSync(SEO_JS_PATH, 'utf8');

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Objects built inside the vm sandbox have a different Object prototype, so
// assert.deepEqual (strict) rejects them on prototype identity. Compare by value.
function sameShape(actual, expected) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox loader. Loading runs only top-level declarations; the browser-global
// block is skipped unless a `window` is supplied. We grab SeoMeta from
// module.exports (the node-export tail).
// ─────────────────────────────────────────────────────────────────────────────
function makeStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _map: m,
    };
}

function makeDoc() {
    const metas = {};
    const doc = {
        _title: '',
        addEventListener() {},
        querySelector(sel) {
            if (!(sel in metas)) {
                metas[sel] = {
                    _content: null,
                    setAttribute(k, v) { if (k === 'content') this._content = v; },
                    getAttribute(k) { return k === 'content' ? this._content : null; },
                };
            }
            return metas[sel];
        },
        _metas: metas,
    };
    Object.defineProperty(doc, 'title', {
        get() { return doc._title; },
        set(v) { doc._title = v; },
    });
    return doc;
}

function loadSeoMeta(overrides = {}) {
    const sandbox = {
        console,
        URL, URLSearchParams, Promise, JSON, Date, RegExp, Math,
        Object, Array, String, Number, Boolean, Error,
        parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
        setTimeout, clearTimeout,
        module: { exports: {} },
        ...overrides,
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SEO_SRC, ctx, { filename: 'seo-meta.js' });
    return { SeoMeta: sandbox.module.exports, sandbox };
}

const { SeoMeta } = loadSeoMeta();

// ─────────────────────────────────────────────────────────────────────────────
// §1 — formatDispatchCutoff (mirrors backend trustSignals.formatDispatchCutoff)
// ─────────────────────────────────────────────────────────────────────────────
test('§1 14:00 -> 2pm (the spec example)', () => {
    assert.equal(SeoMeta.formatDispatchCutoff('14:00'), '2pm');
});
test('§1 12h conversions across the clock', () => {
    assert.equal(SeoMeta.formatDispatchCutoff('00:00'), '12am');
    assert.equal(SeoMeta.formatDispatchCutoff('09:00'), '9am');
    assert.equal(SeoMeta.formatDispatchCutoff('12:00'), '12pm');
    assert.equal(SeoMeta.formatDispatchCutoff('13:00'), '1pm');
    assert.equal(SeoMeta.formatDispatchCutoff('23:00'), '11pm');
});
test('§1 keeps non-zero minutes', () => {
    assert.equal(SeoMeta.formatDispatchCutoff('09:30'), '9:30am');
    assert.equal(SeoMeta.formatDispatchCutoff('14:05'), '2:05pm');
});
test('§1 unparseable -> null (so the clause is omitted, never guessed)', () => {
    for (const bad of ['', '2pm', '24:00', '14:60', 'nope', null, undefined, 1400, '14', '14:0']) {
        assert.equal(SeoMeta.formatDispatchCutoff(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — titleLadder
// ─────────────────────────────────────────────────────────────────────────────
test('§2 returns first candidate within 60 chars', () => {
    const long = 'X'.repeat(61);
    assert.equal(SeoMeta.titleLadder([long, 'Short Title']), 'Short Title');
});
test('§2 first already fitting is returned untouched', () => {
    assert.equal(SeoMeta.titleLadder(['Fits fine', 'shorter']), 'Fits fine');
});
test('§2 all too long -> shortest (last) candidate', () => {
    const a = 'A'.repeat(70), b = 'B'.repeat(65);
    assert.equal(SeoMeta.titleLadder([a, b]), b);
});
test('§2 ignores empty / non-string candidates', () => {
    assert.equal(SeoMeta.titleLadder([null, '', 'ok']), 'ok');
    assert.equal(SeoMeta.titleLadder([]), '');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — truncateDescription
// ─────────────────────────────────────────────────────────────────────────────
test('§3 <=155 unchanged', () => {
    const s = 'Short description.';
    assert.equal(SeoMeta.truncateDescription(s), s);
});
test('§3 >155 truncates at last space <=152 and appends ...', () => {
    const s = ('word '.repeat(50)).trim(); // 249 chars, spaces every 5
    const out = SeoMeta.truncateDescription(s);
    assert.ok(out.length <= SeoMeta.DESC_MAX, `len ${out.length} must be <= 155`);
    assert.ok(out.endsWith('...'), 'must end with ...');
    assert.ok(!/\s\.\.\.$/.test(out), 'no dangling space before ...');
});
test('§3 exactly 155 is left intact', () => {
    const s = 'y'.repeat(155);
    assert.equal(SeoMeta.truncateDescription(s), s);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — decodeEntities + extractHead
// ─────────────────────────────────────────────────────────────────────────────
test('§4 decodeEntities handles &amp; &mdash; numeric', () => {
    assert.equal(SeoMeta.decodeEntities('Ink &amp; Toner'), 'Ink & Toner');
    assert.equal(SeoMeta.decodeEntities('a &#8212; b'), 'a — b');
    assert.equal(SeoMeta.decodeEntities('It&#39;s'), "It's");
    assert.equal(SeoMeta.decodeEntities('x &#x2014; y'), 'x — y');
});
test('§4 extractHead pulls decoded title + description from prerender HTML', () => {
    const html = `<!doctype html><html><head>
        <title>Canon NZ &amp; More — Same-Day Dispatch | InkCartridges.co.nz</title>
        <meta charset="utf-8">
        <meta property="og:title" content="ignore me">
        <meta name="description" content="200 Canon cartridges &amp; toner. Free shipping over $100.">
      </head><body>...</body></html>`;
    const head = SeoMeta.extractHead(html);
    assert.equal(head.title, 'Canon NZ & More — Same-Day Dispatch | InkCartridges.co.nz');
    assert.equal(head.description, '200 Canon cartridges & toner. Free shipping over $100.');
});
test('§4 extractHead is attribute-order independent and tolerant of single quotes', () => {
    const html = `<meta content='Desc here' name='description'>`;
    assert.equal(SeoMeta.extractHead(html).description, 'Desc here');
});
test('§4 extractHead returns nulls for empty / missing tags', () => {
    sameShape(SeoMeta.extractHead(''), { title: null, description: null });
    sameShape(SeoMeta.extractHead('<html></html>'), { title: null, description: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — prerenderPathForLocation MUST mirror middleware.js
// ─────────────────────────────────────────────────────────────────────────────
const P = (pathname, search = '') => SeoMeta.prerenderPathForLocation({ pathname, search });

test('§5 home', () => {
    assert.equal(P('/'), '/api/prerender/home');
    assert.equal(P('/index.html'), '/api/prerender/home');
});
test('§5 bare /shop -> null (middleware does NOT prerender it — ai-search §4)', () => {
    assert.equal(P('/shop'), null);
});
test('§5 category landings', () => {
    assert.equal(P('/ink-cartridges'), '/api/prerender/category/ink');
    assert.equal(P('/toner-cartridges'), '/api/prerender/category/toner');
    assert.equal(P('/ribbons'), '/api/prerender/category/ribbons');
    assert.equal(P('/ink-cartridges/'), '/api/prerender/category/ink');
});
test('§5 brand hub', () => {
    assert.equal(P('/shop', '?brand=canon'), '/api/prerender/brand/canon');
});
test('§5 brand hub IGNORES ?category (matches middleware — brand prerender is category-agnostic)', () => {
    assert.equal(P('/shop', '?brand=canon&category=ink'), '/api/prerender/brand/canon');
});
test('§5 brand+code still routes to the brand prerender (middleware ignores code)', () => {
    assert.equal(P('/shop', '?brand=canon&code=PG-540'), '/api/prerender/brand/canon');
});
test('§5 printer hub uses :brand/:slug (the fixed contract — slug-only 404s)', () => {
    assert.equal(P('/shop', '?brand=brother&printer_slug=brother-mfc-j5945dw'),
        '/api/prerender/printer/brother/brother-mfc-j5945dw');
});
test('§5 printer wins over brand when both present (narrower intent)', () => {
    const out = P('/shop', '?brand=brother&printer_slug=x&category=ink');
    assert.equal(out, '/api/prerender/printer/brother/x');
});
test('§5 legacy ?printer= alias accepted only with brand', () => {
    assert.equal(P('/shop', '?brand=hp&printer=hp-officejet'), '/api/prerender/printer/hp/hp-officejet');
});
test('§5 NO prerender for non-canonical / deep surfaces -> null', () => {
    assert.equal(P('/shop', '?q=650'), null);            // search
    assert.equal(P('/shop', '?search=650'), null);
    assert.equal(P('/shop', '?printer_slug=x'), null);   // bare printer (no brand) — middleware skips
    assert.equal(P('/account'), null);
    assert.equal(P('/products/foo/SKU1'), null);         // products use API seo, not this
});

// IA reorg Jul 2026: a canonical category as the SOLE /shop filter routes to
// its category prerender — middleware gained the matching arm, and
// Drums/Label/Paper have no dedicated landing route so /shop?category=<slug>
// IS their landing.
test('§5 sole-filter category on /shop -> category prerender (IA reorg Jul 2026)', () => {
    assert.equal(P('/shop', '?category=ink'), '/api/prerender/category/ink');
    assert.equal(P('/shop', '?category=drums'), '/api/prerender/category/drums');
    assert.equal(P('/shop', '?category=label'), '/api/prerender/category/label');
    assert.equal(P('/shop', '?category=paper'), '/api/prerender/category/paper');
    assert.equal(P('/shop', '?category=ribbon'), '/api/prerender/category/ribbon');
    assert.equal(P('/shop', '?category=consumable'), null);        // non-canonical
    assert.equal(P('/shop', '?category=drums&code=DR2325'), null); // not sole filter
    assert.equal(P('/shop', '?category=drums&q=x'), null);
    assert.equal(P('/shop', '?category=drums&type=genuine'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — surfaceForLocation
// ─────────────────────────────────────────────────────────────────────────────
const S = (pathname, search = '') => SeoMeta.surfaceForLocation({ pathname, search });
test('§6 surface mapping', () => {
    assert.equal(S('/'), 'home');
    assert.equal(S('/shop'), 'shop-landing');
    assert.equal(S('/ink-cartridges'), 'category-ink');
    assert.equal(S('/toner-cartridges'), 'category-toner');
    assert.equal(S('/ribbons'), 'category-ribbons');
    assert.equal(S('/shop', '?brand=canon'), 'brand');
    assert.equal(S('/shop', '?brand=canon&category=ink'), 'brand');
    assert.equal(S('/shop', '?brand=brother&printer_slug=x'), 'printer');
    assert.equal(S('/shop', '?q=650'), null);
    assert.equal(S('/shop', '?brand=canon&code=PG-540'), 'brand');
    // IA reorg Jul 2026 — sole-filter canonical categories get their own
    // surface (ribbon reuses the existing category-ribbons name).
    assert.equal(S('/shop', '?category=ink'), 'category-ink');
    assert.equal(S('/shop', '?category=drums'), 'category-drums');
    assert.equal(S('/shop', '?category=label'), 'category-label');
    assert.equal(S('/shop', '?category=paper'), 'category-paper');
    assert.equal(S('/shop', '?category=ribbon'), 'category-ribbons');
    assert.equal(S('/shop', '?category=consumable'), null);
    assert.equal(S('/shop', '?category=drums&code=X'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — trust fetch + normalize (fail-open)
// ─────────────────────────────────────────────────────────────────────────────
test('§7 normalizeTrust maps the spec envelope', () => {
    const t = SeoMeta._normalizeTrust({
        guarantee: { days: 30 },
        shipping_promise: { dispatch_cutoff_nzt: '14:00' },
        organization: { founded_year: 2008 },
    });
    sameShape(t, { foundedYear: 2008, guaranteeDays: 30, cutoff: '2pm' });
});
test('§7 normalizeTrust fail-open on garbage -> all null', () => {
    sameShape(SeoMeta._normalizeTrust(null), { foundedYear: null, guaranteeDays: null, cutoff: null });
    sameShape(SeoMeta._normalizeTrust({}), { foundedYear: null, guaranteeDays: null, cutoff: null });
});

test('§7 getTrust caches in sessionStorage and fails open on non-200', async () => {
    let calls = 0;
    const storage = makeStorage();
    const { SeoMeta: S2 } = loadSeoMeta({
        sessionStorage: storage,
        fetch: async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; },
        Config: { API_URL: '', getSetting: (k, d) => d },
    });
    const t = await S2.getTrust();
    sameShape(t, { foundedYear: null, guaranteeDays: null, cutoff: null });
    // failed fetch must NOT poison the cache (so a later success can populate it)
    assert.equal(storage.getItem(S2.TRUST_CACHE_KEY), null);
    assert.equal(calls, 1);
});

test('§7 getTrust returns + caches the parsed envelope, then serves from cache', async () => {
    let calls = 0;
    const storage = makeStorage();
    const body = { ok: true, data: { guarantee: { days: 30 }, shipping_promise: { dispatch_cutoff_nzt: '14:00' }, organization: { founded_year: 2008 } } };
    const { SeoMeta: S2 } = loadSeoMeta({
        sessionStorage: storage,
        fetch: async () => { calls++; return { ok: true, status: 200, json: async () => body }; },
        Config: { API_URL: '', getSetting: (k, d) => d },
    });
    const t1 = await S2.getTrust();
    sameShape(t1, { foundedYear: 2008, guaranteeDays: 30, cutoff: '2pm' });
    const t2 = await S2.getTrust();
    sameShape(t2, t1);
    assert.equal(calls, 1, 'second call must hit the session cache, not the network');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — fallback builders
// ─────────────────────────────────────────────────────────────────────────────
const FULL_TRUST = { foundedYear: 2008, guaranteeDays: 30, cutoff: '2pm' };
const EMPTY_TRUST = { foundedYear: null, guaranteeDays: null, cutoff: null };
const ctx = (trust, extra = {}) => ({ trust, free: 100, brandDisplay: null, printerDisplay: null, brandSlug: null, printerSlug: null, ...extra });

const SURFACES = ['home', 'shop-landing', 'category-ink', 'category-toner', 'category-ribbons'];

test('§8 every listing surface builds a title <=60 and description <=155 (full trust)', () => {
    for (const surf of SURFACES) {
        const b = SeoMeta.buildForSurface(surf, ctx(FULL_TRUST));
        assert.ok(b && b.title && b.description, `${surf} must build`);
        assert.ok(b.title.length <= 60, `${surf} title ${b.title.length} <= 60: "${b.title}"`);
        assert.ok(b.description.length <= 155, `${surf} desc ${b.description.length} <= 155`);
    }
    const brand = SeoMeta.buildForSurface('brand', ctx(FULL_TRUST, { brandDisplay: 'Canon' }));
    assert.ok(brand.title.length <= 60 && brand.description.length <= 155);
    const printer = SeoMeta.buildForSurface('printer', ctx(FULL_TRUST, { printerDisplay: 'Brother MFC-J5945DW' }));
    assert.ok(printer.title.length <= 60 && printer.description.length <= 155, `printer title "${printer.title}" (${printer.title.length})`);
});

test('§8 toner title uses the ladder (full form would exceed 60)', () => {
    const b = SeoMeta.buildForSurface('category-toner', ctx(FULL_TRUST));
    // "Toner Cartridges NZ — Same-Day Dispatch | InkCartridges.co.nz" is 61 chars
    assert.ok(b.title.length <= 60);
    assert.ok(b.title.startsWith('Toner Cartridges NZ'));
    assert.ok(!b.title.includes('| InkCartridges.co.nz'), 'ladder should have dropped the brand suffix');
});

test('§8 trust clauses OMITTED (not guessed) when trust is empty', () => {
    const home = SeoMeta.buildForSurface('home', ctx(EMPTY_TRUST));
    assert.ok(!/NZ-owned since/.test(home.description), 'no founded clause without trust');
    assert.ok(!/same-day dispatch/i.test(home.description), 'no dispatch clause without cutoff');
    assert.ok(!/-day guarantee/.test(home.description), 'no guarantee clause without days');
    // still produces a valid, useful description
    assert.ok(home.description.includes('Free shipping over $100.'));
});

test('§8 trust clauses PRESENT when trust resolved', () => {
    const home = SeoMeta.buildForSurface('home', ctx(FULL_TRUST));
    assert.ok(home.description.includes('NZ-owned since 2008.'));
    assert.ok(home.description.includes('2pm Auckland same-day dispatch.'));
    assert.ok(home.description.includes('30-day guarantee.'));
});

test('§8 brand fallback derives display from slug when no hint', () => {
    const b = SeoMeta.buildForSurface('brand', ctx(FULL_TRUST, { brandSlug: 'canon' }));
    assert.ok(b.title.startsWith('Canon NZ'));
});

test('§8 free threshold flows from ctx', () => {
    const b = SeoMeta.buildForSurface('home', { ...ctx(FULL_TRUST), free: 75 });
    assert.ok(b.description.includes('Free shipping over $75.'));
});

test('§8 unknown surface -> null (leaves the page copy untouched)', () => {
    assert.equal(SeoMeta.buildForSurface('search', ctx(FULL_TRUST)), null);
    assert.equal(SeoMeta.buildForSurface(null, ctx(FULL_TRUST)), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — compliance (the hard constraints) on every built string
// ─────────────────────────────────────────────────────────────────────────────
const SUPERLATIVES = /save up to|lowest price|best in nz|cheapest|guaranteed (?:to|result|lowest)|#1|number one|unbeatable/i;
const SCARCITY = /only \d+ left|ending soon|last chance|hurry|while stocks last|selling fast/i;
const COMPETITORS = /officemax|harvey norman|noel\s*leeming|warehouse stationery|the warehouse|jb hi-fi|pb tech/i;

function allBuilt() {
    const out = [];
    for (const surf of SURFACES) out.push(SeoMeta.buildForSurface(surf, ctx(FULL_TRUST)));
    out.push(SeoMeta.buildForSurface('brand', ctx(FULL_TRUST, { brandDisplay: 'Canon' })));
    out.push(SeoMeta.buildForSurface('printer', ctx(FULL_TRUST, { printerDisplay: 'Brother MFC-J5945DW' })));
    // also exercise the empty-trust variants
    for (const surf of SURFACES) out.push(SeoMeta.buildForSurface(surf, ctx(EMPTY_TRUST)));
    return out;
}

test('§9 no superlatives in any built title or description', () => {
    for (const b of allBuilt()) {
        assert.ok(!SUPERLATIVES.test(b.title), `superlative in title: ${b.title}`);
        assert.ok(!SUPERLATIVES.test(b.description), `superlative in desc: ${b.description}`);
    }
});
test('§9 no scarcity wording', () => {
    for (const b of allBuilt()) {
        assert.ok(!SCARCITY.test(b.title) && !SCARCITY.test(b.description), `scarcity: ${b.title} / ${b.description}`);
    }
});
test('§9 no competitor name-drops', () => {
    for (const b of allBuilt()) {
        assert.ok(!COMPETITORS.test(b.title) && !COMPETITORS.test(b.description), `competitor: ${b.title} / ${b.description}`);
    }
});
test('§9 NO price anchor ($) in any <title> (descriptions may carry price)', () => {
    for (const b of allBuilt()) {
        assert.ok(!b.title.includes('$'), `price in title: ${b.title}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — render(): fallback then reconcile; fail-open; seq-guard
// ─────────────────────────────────────────────────────────────────────────────
function rigForRender({ fetchImpl, location }) {
    const doc = makeDoc();
    const { SeoMeta: S2, sandbox } = loadSeoMeta({
        sessionStorage: makeStorage(),
        fetch: fetchImpl,
        document: doc,
        window: { location },
        location,
        Config: { API_URL: '', getSetting: (k, d) => (k === 'FREE_SHIPPING_THRESHOLD' ? 100 : d) },
    });
    return { S2, doc, sandbox };
}

test('§10 render() applies the trust-built fallback when the prerender fetch fails', async () => {
    const trustBody = { ok: true, data: { guarantee: { days: 30 }, shipping_promise: { dispatch_cutoff_nzt: '14:00' }, organization: { founded_year: 2008 } } };
    const { S2, doc } = rigForRender({
        location: { pathname: '/', search: '' },
        fetchImpl: async (url) => {
            if (String(url).includes('/api/site/trust')) return { ok: true, status: 200, json: async () => trustBody };
            return { ok: false, status: 503, text: async () => '' }; // prerender down
        },
    });
    await S2.render({ surface: 'home' });
    assert.ok(doc.title.startsWith('Ink Cartridges NZ — Same-Day Dispatch'), `title was "${doc.title}"`);
    assert.ok(doc._metas['meta[name="description"]']._content.includes('NZ-owned since 2008.'));
});

test('§10 render() reconciles to the byte-exact prerender head when available', async () => {
    const prerenderHtml = `<head><title>Canon NZ — Same-Day Dispatch | InkCartridges.co.nz</title>
        <meta name="description" content="200 Canon ink cartridges &amp; toner — 200 genuine, 0 compatible. NZ-owned since 2008. Free shipping over $100."></head>`;
    const { S2, doc } = rigForRender({
        location: { pathname: '/shop', search: '?brand=canon' },
        fetchImpl: async (url) => {
            if (String(url).includes('/api/site/trust')) return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
            if (String(url).includes('/api/prerender/brand/canon')) return { ok: true, status: 200, text: async () => prerenderHtml };
            return { ok: false, status: 404, text: async () => '' };
        },
    });
    await S2.render({ hints: { brand: 'Canon' } });
    assert.equal(doc.title, 'Canon NZ — Same-Day Dispatch | InkCartridges.co.nz');
    assert.equal(doc._metas['meta[name="description"]']._content,
        '200 Canon ink cartridges & toner — 200 genuine, 0 compatible. NZ-owned since 2008. Free shipping over $100.');
    // og mirrors are kept in sync
    assert.equal(doc._metas['meta[property="og:title"]']._content, 'Canon NZ — Same-Day Dispatch | InkCartridges.co.nz');
});

test('§10 render() is a no-op on non-prerendered surfaces (search) — leaves page copy', async () => {
    const { S2, doc } = rigForRender({
        location: { pathname: '/shop', search: '?q=650' },
        fetchImpl: async (url) => {
            if (String(url).includes('/api/site/trust')) return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
            throw new Error('should not fetch a prerender for search');
        },
    });
    doc.title = 'Search: "650" | InkCartridges.co.nz'; // what shop-page set
    await S2.render({});
    assert.equal(doc.title, 'Search: "650" | InkCartridges.co.nz', 'search title must be untouched');
});

test('§10 seq-guard: a stale reconcile does not clobber a newer render', async () => {
    // resolve the first prerender fetch slowly; bump _seq mid-flight.
    let resolveSlow;
    const slow = new Promise((r) => { resolveSlow = r; });
    const { S2, doc } = rigForRender({
        location: { pathname: '/shop', search: '?brand=canon' },
        fetchImpl: async (url) => {
            if (String(url).includes('/api/site/trust')) return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
            await slow;
            return { ok: true, status: 200, text: async () => '<head><title>STALE</title><meta name="description" content="stale"></head>' };
        },
    });
    const p = S2.render({ hints: { brand: 'Canon' } });
    S2._seq += 5;            // simulate the user navigating away
    resolveSlow();
    await p;
    assert.notEqual(doc.title, 'STALE', 'stale prerender must not be applied after navigation');
});

// ─────────────────────────────────────────────────────────────────────────────
// §11 — reconcile() caching + fail-open
// ─────────────────────────────────────────────────────────────────────────────
test('§11 reconcile caches the extracted head (one fetch for repeat paths)', async () => {
    let calls = 0;
    const storage = makeStorage();
    const doc = makeDoc();
    const { SeoMeta: S2 } = loadSeoMeta({
        sessionStorage: storage, document: doc,
        fetch: async () => { calls++; return { ok: true, status: 200, text: async () => '<head><title>T</title><meta name="description" content="D"></head>' }; },
        Config: { API_URL: '', getSetting: (k, d) => d },
    });
    assert.equal(await S2.reconcile('/api/prerender/shop', S2._seq), true);
    assert.equal(await S2.reconcile('/api/prerender/shop', S2._seq), true);
    assert.equal(calls, 1, 'second reconcile served from cache');
    assert.equal(doc.title, 'T');
});
test('§11 reconcile fail-open: null path / non-200 / throw all return false and touch nothing', async () => {
    const doc = makeDoc();
    doc.title = 'KEEP';
    const { SeoMeta: S2 } = loadSeoMeta({
        sessionStorage: makeStorage(), document: doc,
        fetch: async () => { throw new Error('network'); },
        Config: { API_URL: '', getSetting: (k, d) => d },
    });
    assert.equal(await S2.reconcile(null, S2._seq), false);
    assert.equal(await S2.reconcile('/api/prerender/shop', S2._seq), false);
    assert.equal(doc.title, 'KEEP');
});

// ─────────────────────────────────────────────────────────────────────────────
// §12 — middleware printer prerender path fix
// ─────────────────────────────────────────────────────────────────────────────
const MIDDLEWARE_SRC = fs.readFileSync(MIDDLEWARE_PATH, 'utf8');
const MIDDLEWARE_CODE = stripComments(MIDDLEWARE_SRC);

test('§12 middleware builds the printer prerender path as :brand/:slug', () => {
    assert.match(MIDDLEWARE_CODE,
        /prerender\/printer\/\$\{encodeURIComponent\(brandSlug\)\}\/\$\{encodeURIComponent\(printerSlug\)\}/,
        'printer prerender must pass brand THEN slug (slug-only 404s)');
});
test('§12 middleware no longer emits the slug-only printer path', () => {
    // the only printer-path interpolation must start with brandSlug
    const m = MIDDLEWARE_CODE.match(/prerender\/printer\/\$\{encodeURIComponent\((\w+)\)\}/);
    assert.ok(m, 'a printer prerender interpolation must exist');
    assert.equal(m[1], 'brandSlug', 'first interpolated segment must be brandSlug, not printerSlug');
});
test('§12 printer ref still precedes brand ref inside /shop branch (narrower wins) — ai-search §3 invariant', () => {
    const start = MIDDLEWARE_CODE.indexOf("path === '/shop'");
    const end = MIDDLEWARE_CODE.indexOf('if (!prerenderPath)', start);
    const block = MIDDLEWARE_CODE.slice(start, end);
    assert.ok(block.indexOf('/api/prerender/printer/') < block.indexOf('/api/prerender/brand/'));
});
test('§12 legacy ?printer= alias preserved', () => {
    assert.match(MIDDLEWARE_CODE, /searchParams\.get\('printer_slug'\)\s*\|\|\s*url\.searchParams\.get\('printer'\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §13 — wiring + compliance source pins
// ─────────────────────────────────────────────────────────────────────────────
const INDEX_HTML   = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'index.html'), 'utf8');
const SHOP_HTML    = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'shop.html'), 'utf8');
const RIBBONS_HTML = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'ribbons.html'), 'utf8');
const SHOP_CODE    = stripComments(fs.readFileSync(SHOP_JS_PATH, 'utf8'));
const RIBBONS_CODE = stripComments(fs.readFileSync(RIBBONS_JS_PATH, 'utf8'));
const SEO_CODE     = stripComments(SEO_SRC);

test('§13 seo-meta.js is loaded on the home, shop and ribbons pages', () => {
    // Assert the script is LOADED and cache-busted — not that its token still equals
    // this feature's era literal. The token rides forward with every seo-meta.js edit,
    // so pinning the literal here just guarantees this test breaks on the next bump.
    // Token correctness (consistency + freshness) is owned by tests/asset-cache-tokens.test.js.
    for (const [name, html] of [['index', INDEX_HTML], ['shop', SHOP_HTML], ['ribbons', RIBBONS_HTML]]) {
        assert.match(html, /<script[^>]+src="\/js\/seo-meta\.js\?v=[^"]+"/, `${name} must load seo-meta.js (cache-busted)`);
    }
});
test('§13 shop-page.updateSEO delegates to SeoMeta.render with brand/printer hints', () => {
    assert.match(SHOP_CODE, /SeoMeta\.render\(/);
    assert.match(SHOP_CODE, /typeof SeoMeta !== 'undefined'/);
    assert.match(SHOP_CODE, /hints:\s*\{[\s\S]*brand:[\s\S]*printer:/);
});
test('§13 ribbons-page mirrors only the unfiltered /ribbons surface', () => {
    assert.match(RIBBONS_CODE, /SeoMeta\.render\(\{\s*surface:\s*'category-ribbons'\s*\}\)/);
    assert.match(RIBBONS_CODE, /!activeBrand\s*&&\s*!model/);
});
test('§13 NO trust facts are inlined in seo-meta.js (constraint #5 — fetched, never hard-coded)', () => {
    assert.ok(!/since 20\d\d/.test(SEO_CODE), 'founded year must not be inlined');
    assert.ok(!/\b30-day guarantee\b/.test(SEO_CODE), 'guarantee days must come from trust, not a literal');
    assert.ok(!/\b\d{1,2}(?:am|pm) Auckland/.test(SEO_CODE), 'dispatch cutoff must come from trust, not a literal');
});
test('§13 home/shop fixed titles are <=60 chars', () => {
    const home = SeoMeta.buildForSurface('home', ctx(FULL_TRUST));
    const shop = SeoMeta.buildForSurface('shop-landing', ctx(FULL_TRUST));
    assert.ok(home.title.length <= 60 && shop.title.length <= 60);
    assert.equal(home.title, 'Ink Cartridges NZ — Same-Day Dispatch | InkCartridges.co.nz');
    assert.equal(shop.title, 'Ink & Toner NZ — Same-Day Dispatch | InkCartridges.co.nz');
});
