/**
 * Backend handoff 2 Nov 2026 (fe-handoff-2nov2026.md, items 38, 46, 50,
 * 59–63) — ERR-377.
 *
 *  63 the PDP "Customer Reviews" summary reads the summary endpoint's
 *     `average_rating` / `review_count` (it never sent `average`: "NaN based
 *     on 1 review"), and shows nothing when there are no reviews.
 *  59 a compatible page never prints `manufacturer_part_number` (it is the
 *     supplier's code); a RIBBON keeps it even when compatible ("Group 24").
 *  38 the two "Done" lines changed on 1 Nov ("likely running low").
 *  46 printer pages: `compatibility_promise.label` under each Add, from the
 *     API (site trust → cart envelope → the product's own payload), never typed.
 *  50 "Last updated" on the policy pages moved to the publish day.
 *  60 /about + /genuine-vs-compatible copy word for word; and, site-wide (owner
 *     7 Nov): no opening hours, no reply-time promise, no Kelston dispatch, no
 *     openingHours JSON-LD, no "Fast NZ", no comparison with genuine prices.
 *  61 fallback titles drop "— Fast NZ Delivery"; the printer title reads the
 *     printer's display_name, not the slug.
 *  62 /ribbons title, H1, intro and FAQ are the bot page's (fixture saved
 *     2026-11-07), and the live prerender's intro + FAQ are mirrored over them.
 * (51, 52 are ERR-376 and pinned in backend-handoff-26oct-2026.)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'prerender-ribbons-2026-11-07.html'), 'utf8');

/** Visible text of an HTML fragment: tags out, the entities these pages use decoded. */
const text = (html) => html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&middot;/g, '·').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

function methodSrc(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0; let q = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { params: m[1], body: src.slice(open, i + 1), async: /async/.test(m[0]) };
    }
    throw new Error(`unbalanced ${name}`);
}
function method(file, name, self = {}, globals = {}) {
    const { params, body, async } = methodSrc(stripComments(read(file)), name);
    const keys = Object.keys(globals);
    return new Function(...keys, `return (${async ? 'async ' : ''}function (${params}) ${body});`)(...keys.map((k) => globals[k])).bind(self);
}
const loadSeoMeta = () => new Function(`${read('js/seo-meta.js')}; return SeoMeta;`)();

// ═══ 63 review summary ═════════════════════════════════════════════════════

test('63 the summary reads average_rating / review_count — the live shape (C604XLKCMY, 2026-11-07)', () => {
    const stats = method('js/product-detail-page.js', '_reviewSummaryStats');
    // Measured live: GET /api/products/a85cbec6-…/reviews/summary
    const live = { product_id: 'a85cbec6', review_count: 1, average_rating: 5, avg_rating: 5, count: 1, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 } };
    assert.deepEqual(stats(live), { avg: 5, count: 1 });
    assert.equal(stats(live).avg.toFixed(1), '5.0', '"5.0 based on 1 review"');
    assert.deepEqual(stats({ avg_rating: '4.5', count: '2' }), { avg: 4.5, count: 2 }, 'aliases');
    assert.equal(stats({ review_count: 0, average_rating: 0 }), null, 'no reviews ⇒ no summary');
    assert.equal(stats({ average: 5, count: 1 }), null, 'the field that never existed is not read');
    assert.equal(stats(null), null);
});

test('63 NEGATIVE CONTROL — the old read printed NaN on the live shape', () => {
    const live = { review_count: 1, average_rating: 5, count: 1 };
    assert.equal(Number(live.average).toFixed(1), 'NaN');
});

test('63 loadReviews renders from the stats only, and clears the summary when there are none', () => {
    const body = methodSrc(stripComments(read('js/product-detail-page.js')), 'loadReviews').body;
    assert.doesNotMatch(body, /summary\.average\b/);
    assert.match(body, /const stats = this\._reviewSummaryStats\(summary\)/);
    assert.match(body, /\$\{stats\.avg\.toFixed\(1\)\}/);
    assert.match(body, /based on \$\{stats\.count\} review/);
    assert.match(body, /else if \(summaryEl\) \{\s*summaryEl\.innerHTML = '';/);
});

// ═══ 59 manufacturer_part_number ═══════════════════════════════════════════

test('59 "Model:" — hidden on a compatible cartridge, kept on a genuine, a ribbon and a roll', () => {
    const code = stripComments(read('js/product-detail-page.js'));
    const line = code.match(/const showModel = [^;]+;\s*document\.getElementById\('product-sku'\)\.textContent = [^;]+;/);
    assert.ok(line);
    const f = new Function('info', 'document', line[0]);
    const run = (info) => { const el = {}; f(info, { getElementById: () => el }); return el.textContent; };
    // Live 2026-11-07: C62XLBK carries IHP62BXL, C-OKI-IO182-RIB-BK carries IO182.
    assert.equal(run({ sku: 'C62XLBK', source: 'compatible', category: 'ink', manufacturer_part_number: 'IHP62BXL' }), 'SKU: C62XLBK');
    assert.equal(run({ sku: 'C-OKI-IO182-RIB-BK', source: 'compatible', category: 'ribbon', manufacturer_part_number: 'IO182' }), 'SKU: C-OKI-IO182-RIB-BK | Model: IO182');
    assert.equal(run({ sku: 'GTN2345', source: 'genuine', category: 'toner', manufacturer_part_number: 'TN-2345' }), 'SKU: GTN2345 | Model: TN-2345');
    assert.equal(run({ sku: 'R1', source: null, category: 'receipt', manufacturer_part_number: 'ITR80X80' }), 'SKU: R1 | Model: ITR80X80');
});

// ═══ 38 Done lines ═════════════════════════════════════════════════════════

test('38 the two Done lines say "likely running low", never "before you run out"', () => {
    const f = method('js/order-confirmation-page.js', 'reminderOutcome');
    assert.equal(f({ delivery_blocked: null, reminders_resumed: false }, 'x'), "Done — we'll email you when these are likely running low.");
    assert.equal(f({ delivery_blocked: null, reminders_resumed: true }, 'x'), "Done — reorder reminders are back on. We'll email you when these are likely running low.");
    assert.doesNotMatch(stripComments(read('js/order-confirmation-page.js')), /We'll email you before you run out/i);
});

// ═══ 46 compatibility promise under each Add ═══════════════════════════════

function slotWorld({ siteTrust = {}, cartMeta = null, product = null } = {}) {
    const slots = [0, 1, 2].map(() => ({ textContent: '', hidden: true, dataset: {}, closest: () => ({ getAttribute: () => 'C62XLBK' }) }));
    const calls = { getProduct: [] };
    const globals = {
        TrustStats: { raw: async () => siteTrust },
        Cart: { serverCartMeta: cartMeta },
        API: { getProduct: async (sku) => { calls.getProduct.push(sku); return product ? { ok: true, data: product } : { ok: false }; } },
    };
    const self = {};
    self._compatPromiseLabel = method('js/shop-page.js', '_compatPromiseLabel', self, globals);
    self.renderPromiseLines = method('js/shop-page.js', 'renderPromiseLines', self, globals);
    const root = { querySelectorAll: (sel) => (sel === '[data-promise]' ? slots : []) };
    return { self, root, slots, calls };
}
const PROMISE = { compatibility_promise: { label: 'Not sure it fits? 30-day returns on unopened items' } };

test('46 a first-time visitor (no cart read): the label comes from the product\'s own payload', async () => {
    const w = slotWorld({ product: { trust_signals: PROMISE } });
    assert.equal(await w.self.renderPromiseLines(w.root), 'ok');
    for (const el of w.slots) {
        assert.equal(el.textContent, 'Not sure it fits? 30-day returns on unopened items');
        assert.equal(el.hidden, false);
        assert.equal(el.dataset.promise, 'ok');
    }
    assert.deepEqual(w.calls.getProduct, ['C62XLBK']);
});

test('46 the cart envelope wins over a product read; site trust wins over both', async () => {
    const a = slotWorld({ cartMeta: { trust_signals: PROMISE }, product: { trust_signals: { compatibility_promise: { label: 'other' } } } });
    await a.self.renderPromiseLines(a.root);
    assert.equal(a.slots[0].textContent, PROMISE.compatibility_promise.label);
    assert.deepEqual(a.calls.getProduct, [], 'no product read when the cart has it');
    const b = slotWorld({ siteTrust: { compatibility_promise: { label: '  From site trust  ' } }, cartMeta: { trust_signals: PROMISE } });
    await b.self.renderPromiseLines(b.root);
    assert.equal(b.slots[0].textContent, 'From site trust');
});

test('46 no source carries it: the slots stay hidden and say "absent" (never typed copy)', async () => {
    const w = slotWorld();
    assert.equal(await w.self.renderPromiseLines(w.root), 'absent');
    for (const el of w.slots) {
        assert.equal(el.hidden, true);
        assert.equal(el.textContent, '');
        assert.equal(el.dataset.promise, 'absent');
    }
    const code = stripComments(read('js/shop-page.js'));
    assert.doesNotMatch(code, /30-day returns on unopened items/, 'the label is never hard-coded');
    assert.doesNotMatch(code, /guaranteed fit/i);
});

test('46 the writer sets text, never HTML; the slot is printer-page + in-stock only, after the Add', () => {
    const body = methodSrc(stripComments(read('js/shop-page.js')), 'renderPromiseLines').body;
    assert.match(body, /el\.textContent = label/);
    assert.doesNotMatch(body, /innerHTML/);
    const card = methodSrc(stripComments(read('js/shop-page.js')), 'createProductCard').body;
    const add = card.indexOf('product-card__cart-btn"');
    const slot = card.indexOf('product-card__promise');
    assert.ok(add > 0 && slot > add, 'the line sits below the Add, so the Add never moves');
    assert.match(card, /\$\{inStock && this\.state\.level === 'printer-products' \? '<p class="product-card__promise" data-promise hidden><\/p>' : ''\}/);
    const render = methodSrc(stripComments(read('js/shop-page.js')), 'renderProducts').body;
    assert.match(render, /this\.renderPromiseLines\(container\)\.catch\(/, 'every re-render (sort/filter) refills the slots');
    assert.match(read('css/components.css'), /\.product-card__promise \{/);
});

// ═══ 50 Last updated ═══════════════════════════════════════════════════════

test('50 the policy date is the publish day, in the config and in every static fallback', () => {
    const cfg = read('js/legal-config.js');
    assert.match(cfg, /policyEffectiveDate:\s*'2026-11-07'/);
    assert.match(cfg, /policyVersion:\s*'2026\.11'/);
    for (const f of ['privacy', 'terms', 'returns', 'shipping', 'genuine-vs-compatible']) {
        const html = read(`html/${f}.html`);
        assert.match(html, /data-legal-bind="policy-date">7 November 2026</, f);
        assert.match(html, /data-legal-bind="policy-version">2026\.11</, f);
    }
});

// ═══ 60 /about + /genuine-vs-compatible, word for word ═════════════════════

const ABOUT_NEW = [
    'We started InkCartridges.co.nz to be a New Zealand business that sells the cartridge you actually need.',
    'on the NZ Post, Aramex and NZ Couriers courier networks.',
    'Auckland metro orders placed before 12pm on a business day are dispatched same-day.',
    'Warranty and guarantee',
    'Genuine cartridges carry the original manufacturer warranty. Compatible cartridges are covered by our 30-day satisfaction guarantee.',
    'No surcharges',
    'Compatible: third-party cartridges built to comparable specifications. Each one is tested before dispatch and covered by our 30-day satisfaction guarantee.',
    'Every order ships by courier.',
    'Phone: 027 474 0115 · Email: support@inkcartridges.co.nz',
    'Call 027 474 0115 or email support@inkcartridges.co.nz.',
    'Real support',
];
const ABOUT_OLD = [
    'Most New Zealand printer-supply websites',
    'usually within one to two working days',
    'metro typically has the parcel the next morning',
    'Outside Auckland metro, dispatch is the next working day',
    'outside Auckland metro, dispatch is the next working day',
    'Auckland metro — 1–2 working days from dispatch',
    'Buy once, prints right',
    'Fair pricing, no surcharges',
    'offered at a lower cost than genuine',
    'quality-checked on receipt',
    'dispatched from our Kelston',
    'Hours:',
    'not staffed for retail walk-ins',
    'in business hours',
    'within one business day',
    'within one working day',
];

test('60 /about carries every new line exactly, and none of the replaced ones', () => {
    const t = text(read('html/about.html'));
    for (const line of ABOUT_NEW) assert.ok(t.includes(line), `missing: ${line}`);
    for (const line of ABOUT_OLD) assert.ok(!t.includes(line), `still there: ${line}`);
    // "Call 027… or email …." appears twice: "Call or write" and "Real support".
    assert.equal(t.split('Call 027 474 0115 or email support@inkcartridges.co.nz.').length - 1, 2);
    assert.ok(t.includes('100% NZ owned'), '"100% NZ owned" stays (owner, 1 Nov)');
});

test('60 /genuine-vs-compatible: the summary line and no reply-time promise', () => {
    const t = text(read('html/genuine-vs-compatible.html'));
    assert.ok(t.includes('Covered by our 30-day satisfaction guarantee.'));
    assert.ok(!t.includes('Lower cost, and covered'));
    assert.ok(!t.includes('We reply within one business day'));
});

test('60 /contact and /returns: phone + email stay, hours / reply time / appointment go', () => {
    for (const f of ['contact', 'returns']) {
        const t = text(read(`html/${f}.html`));
        assert.ok(t.includes('027 474 0115') && t.includes('support@inkcartridges.co.nz'), f);
        // (Refund timelines — "within 3–5 business days" — are not reply times.)
        assert.doesNotMatch(t, /reply[^.]*business day|within one business day|9am|Mon\s*[–-]\s*Fri|appointment|call ahead/i, f);
    }
    assert.doesNotMatch(stripComments(read('js/contact-page.js')), /business day/);
});

// Site-wide (owner, 7 Nov: "site-wide"). Public pages and scripts only; admin
// screens are not customer-facing (the QR poster is, and is included).
const PUBLIC_HTML = () => {
    const out = ['index.html', 'html/admin/quote-qr.html'];
    const walk = (dir) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = `${dir}/${e.name}`;
            if (e.isDirectory()) { if (e.name !== 'admin') walk(rel); } else if (e.name.endsWith('.html')) out.push(rel);
        }
    };
    walk('html');
    return out;
};
const PUBLIC_JS = () => fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`);
const BANNED = [
    [/within (?:one|1) (?:business|working) day/i, 'reply-time promise'],
    [/\b9(?::00)?\s*am\b/i, 'opening hours'],
    // "Mon–Fri, 9am…" is opening hours; "12pm NZT, Monday – Friday, is the
    // daily cut-off" (/shipping) is the dispatch cut-off, and stays.
    [/Mon(?:day)?\s*(?:–|-|&ndash;|to)\s*Fri(?:day)?,?\s*\d/i, 'opening hours'],
    [/business hours/i, 'opening hours'],
    [/openingHours/, 'openingHours JSON-LD'],
    [/dispatched from our Kelston|Kelston, Auckland office/i, 'Kelston dispatch'],
    [/walk-ins?|by appointment/i, 'customers are not met at the address'],
    [/\bFast NZ\b/i, '"fast" with no number'],
    [/outside Auckland metro,? dispatch|outside Auckland metro dispatch/i, 'outside-metro dispatch claim (removed from /about, 1 Nov)'],
    [/lower cost than genuine|at a lower cost|more affordable alternative|fraction of the price|cost less than genuine/i, 'comparison with genuine prices'],
];

test('60 site-wide: no opening hours, reply-time promise, Kelston dispatch, "Fast NZ" or genuine-price comparison', () => {
    const offenders = [];
    for (const f of PUBLIC_HTML()) {
        const t = read(f).replace(/<!--[\s\S]*?-->/g, '');
        for (const [re, why] of BANNED) if (re.test(t)) offenders.push(`${f}: ${why} (${t.match(re)[0]})`);
    }
    for (const f of PUBLIC_JS()) {
        const t = stripComments(read(f));
        for (const [re, why] of BANNED) if (re.test(t)) offenders.push(`${f}: ${why} (${t.match(re)[0]})`);
    }
    assert.deepEqual(offenders, []);
});

test('60 the hours / reply-time bindings are deleted, not blanked', () => {
    const cfg = stripComments(read('js/legal-config.js'));
    assert.doesNotMatch(cfg, /hoursDisplay|responseSLA/);
    assert.doesNotMatch(stripComments(read('js/legal-page.js')), /'hours'|'response-sla'/);
    for (const f of PUBLIC_HTML()) assert.doesNotMatch(read(f), /data-legal-bind="(?:hours|response-sla)"/, f);
});

test('60 the registered address stays (customers are not met there, but it is the company\'s)', () => {
    assert.match(read('js/legal-config.js'), /suburb:\s*'Kelston'/);
    assert.ok(text(read('html/about.html')).includes('37A Archibald Road'));
});

// ═══ 61 titles ═════════════════════════════════════════════════════════════

test('61 no fallback title says "Fast"; each matches the bot title measured 2026-11-07', () => {
    const S = loadSeoMeta();
    const ctx = { trust: { foundedYear: 2008, cutoff: '12pm', guaranteeDays: 30, returnsDays: 30 }, free: 100,
        brandDisplay: 'Canon', printerDisplay: 'Brother HL-L2375DW', printerListing: { count: 5, sources: ['compatible', 'genuine'], noun: 'toner' } };
    const want = {
        'shop-landing': 'Shop Ink Cartridges & Toner NZ | InkCartridges.co.nz',
        'category-ink': 'Ink Cartridges NZ | InkCartridges.co.nz',
        'category-toner': 'Toner Cartridges NZ | InkCartridges.co.nz',
        'category-receipt': 'Thermal Receipt & EFTPOS Rolls NZ | InkCartridges.co.nz',
        'category-ribbons': 'Typewriter & Printer Ribbons NZ | InkCartridges.co.nz',
        brand: 'Canon NZ | InkCartridges.co.nz',
        printer: 'Brother HL-L2375DW Toner Cartridges | InkCartridges.co.nz',
    };
    for (const [surface, title] of Object.entries(want)) assert.equal(S.buildForSurface(surface, ctx).title, title, surface);
    for (const s of ['home', 'shop-landing', 'category-ink', 'category-toner', 'category-drums', 'category-label', 'category-paper', 'category-receipt', 'category-ribbons', 'brand', 'printer']) {
        const b = S.buildForSurface(s, ctx);
        assert.doesNotMatch(`${b.title} ${b.description}`, /\bfast\b/i, s);
    }
    const mixed = S.buildForSurface('printer', { ...ctx, printerListing: { count: 4, sources: ['compatible'], noun: '' } });
    assert.equal(mixed.title, 'Brother HL-L2375DW Cartridges | InkCartridges.co.nz', 'mixed listing ⇒ no noun');
});

test('61 the printer page title reads display_name (state.printerName), never "Compatible Ink for <slug>"', () => {
    const code = stripComments(read('js/shop-page.js'));
    assert.doesNotMatch(code, /Compatible Ink for \$\{/);
    assert.match(code, /const printerFull = this\.state\.printerName \|\| \[pBrandName, printerDisplay\]/);
    assert.match(code, /title {7}= `\$\{printerFull\} Cartridges \| InkCartridges\.co\.nz`;/);
    assert.match(code, /const printerFull = this\.state\.printerName \|\| \[\s*this\.state\.printerBrand/, 'the SeoMeta hint too');
});

// ═══ 62 /ribbons ═══════════════════════════════════════════════════════════

test('62 extractHead reads the bot page\'s intro and FAQ (fixture: live prerender 2026-11-07)', () => {
    const head = loadSeoMeta().extractHead(FIXTURE);
    assert.equal(head.title, 'Typewriter & Printer Ribbons NZ | InkCartridges.co.nz');
    assert.equal(head.h1, 'Typewriter and Printer Ribbons NZ');
    assert.match(head.intro, /^We stock 22 typewriter ribbons and 6 correction tapes for Brother, Canon, IBM/);
    assert.equal(head.faq.length, 4);
    assert.deepEqual(head.faq[0], {
        q: 'How do I find the right ribbon for my typewriter?',
        a: 'Check the make and model on your typewriter and search for it, or search the code printed on your current ribbon spool. Unopened items can be returned within 30 days.',
    });
});

test('62 the static /ribbons copy equals the bot page: title, H1, intro, every FAQ', () => {
    const html = read('html/ribbons.html');
    const head = loadSeoMeta().extractHead(FIXTURE);
    assert.match(html, /<title>Typewriter & Printer Ribbons NZ \| InkCartridges\.co\.nz<\/title>/);
    assert.match(html, /<h1 class="drilldown-title" id="drilldown-title">Typewriter and Printer Ribbons NZ<\/h1>/);
    const intro = /<p class="ribbons-intro" id="ribbons-intro">([\s\S]*?)<\/p>/.exec(html);
    assert.equal(text(intro[1]).trim(), head.intro);
    const qs = [...html.matchAll(/<summary class="faq-question">([\s\S]*?)<\/summary>\s*<div class="faq-answer"><p>([\s\S]*?)<\/p>/g)]
        .map((m) => ({ q: text(m[1]).trim(), a: text(m[2]).trim() }));
    assert.deepEqual(qs, head.faq);
    assert.doesNotMatch(html, /FAQPage/, 'www carries no FAQPage: bots get the prerender\'s');
});

function fakeDom() {
    const nodes = {};
    const mk = (tag) => ({
        tag, className: '', textContent: '', hidden: false, dataset: {}, children: [],
        appendChild(c) { this.children.push(c); return c; },
        append(...c) { this.children.push(...c); },
    });
    nodes['ribbons-intro'] = mk('p');
    nodes['ribbons-faq-list'] = mk('div');
    nodes['ribbons-faq-list'].children.push('STATIC');
    Object.defineProperty(nodes['ribbons-faq-list'], 'textContent', { set() { this.children = []; }, get() { return ''; } });
    return { nodes, document: { getElementById: (id) => nodes[id] || null, createElement: mk } };
}

test('62 reconcile mirrors the live intro + FAQ as text, so the counts never go stale', () => {
    const S = loadSeoMeta();
    const { nodes, document } = fakeDom();
    const prev = global.document; global.document = document;
    try {
        S._setRibbonsCopy({ intro: 'We stock 23 <b>typewriter</b> ribbons.', faq: [{ q: 'Q1 <img>', a: 'A1' }, { q: 'Q2', a: 'A2' }] });
    } finally { global.document = prev; }
    assert.equal(nodes['ribbons-intro'].textContent, 'We stock 23 <b>typewriter</b> ribbons.', 'text, never parsed as HTML');
    assert.equal(nodes['ribbons-intro'].dataset.mirror, 'prerender');
    const list = nodes['ribbons-faq-list'];
    assert.equal(list.children.length, 2, 'the static items are replaced');
    assert.equal(list.children[0].children[0].textContent, 'Q1 <img>');
    assert.equal(list.children[0].children[1].children[0].textContent, 'A1');
    assert.equal(list.dataset.mirror, 'prerender');
});

test('62 a prerender with no intro / FAQ keeps the static copy and says so', () => {
    const S = loadSeoMeta();
    const { nodes, document } = fakeDom();
    nodes['ribbons-intro'].textContent = 'static intro';
    const prev = global.document; global.document = document;
    try { S._setRibbonsCopy({ intro: null, faq: null }); } finally { global.document = prev; }
    assert.equal(nodes['ribbons-intro'].textContent, 'static intro');
    assert.equal(nodes['ribbons-intro'].dataset.mirror, 'static');
    assert.deepEqual(nodes['ribbons-faq-list'].children, ['STATIC']);
    assert.equal(nodes['ribbons-faq-list'].dataset.mirror, 'static');
});

test('62 reconcile on category-ribbons shows the bot h1 and fills the copy', async () => {
    const S = loadSeoMeta();
    const { nodes, document } = fakeDom();
    nodes['drilldown-title'] = { textContent: 'old', hidden: true, classList: { remove() {} } };
    const prevDoc = global.document; const prevFetch = global.fetch; const prevSS = global.sessionStorage;
    global.document = { ...document, title: '', querySelector: () => null, head: { appendChild() {} } };
    global.fetch = async () => new Response(FIXTURE, { status: 200 });
    global.sessionStorage = { getItem: () => null, setItem() {} };
    try {
        assert.equal(await S.reconcile('/api/prerender/category/ribbons', undefined, 'category-ribbons'), true);
    } finally { global.document = prevDoc; global.fetch = prevFetch; global.sessionStorage = prevSS; }
    assert.equal(nodes['drilldown-title'].textContent, 'Typewriter and Printer Ribbons NZ');
    assert.equal(nodes['drilldown-title'].hidden, false);
    assert.match(nodes['ribbons-intro'].textContent, /^We stock 22 typewriter ribbons/);
    assert.equal(nodes['ribbons-faq-list'].children.length, 4);
    assert.equal(S.h1For('/api/prerender/category/ribbons'), 'Typewriter and Printer Ribbons NZ');
});

test('62 ribbons-page: unfiltered h1 = the mirrored one; intro + FAQ only on the unfiltered view', () => {
    const els = { 'ribbons-intro': { hidden: false }, 'ribbons-faq': { hidden: false } };
    const doc = { title: '', getElementById: (id) => els[id] || null };
    const title = { textContent: '', hidden: true };
    const run = (state, mirrored) => {
        const self = { elements: { title }, state };
        method('js/ribbons-page.js', 'updateTitle', self, { document: doc, SeoMeta: { h1For: () => mirrored, render() {} } })();
    };
    run({}, null);
    assert.equal(title.textContent, 'Typewriter and Printer Ribbons NZ');
    assert.equal(doc.title, 'Typewriter & Printer Ribbons NZ | InkCartridges.co.nz');
    assert.equal(els['ribbons-intro'].hidden, false);
    run({}, 'Mirrored H1');
    assert.equal(title.textContent, 'Mirrored H1');
    run({ brand: 'epson' }, 'Mirrored H1');
    assert.equal(title.textContent, 'epson Typewriter & Printer Ribbons');
    assert.equal(els['ribbons-intro'].hidden, true);
    assert.equal(els['ribbons-faq'].hidden, true);
});
