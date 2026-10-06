/**
 * FE master checklist (backend, 2026-10-05) — feink-dc's items 5, 7, 8, 13 (ERR-306).
 *
 * §5  ServiceRow (js/service-row.js): REQUIRED and EXECUTED — every fact from
 *     /api/site/trust (+ a product's delivery_estimate), none invented.
 * §7  consent card bottom-RIGHT on /shop only, lifted above Google's badge.
 * §8  South Island 1–3: no "2–4"/"1–4" delivery-day string left anywhere, and
 *     /faq's visible answer says the same as its FAQPage JSON-LD.
 * §13 guest account card on the confirmation page: methods lifted from the
 *     shipped source and run in a vm.
 *
 * The live half is `npm run probe:fe-master` (READ-ONLY, paced).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const Security = {
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    escapeAttr: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'),
};
global.Security = Security;
const ServiceRow = require(path.join(ROOT, 'js', 'service-row.js'));

/** Brace-matched `head(...) { ... }` from shipped source (same as turnaround-fixes). */
function lift(src, head) {
    let start = src.indexOf(`${head} {`);
    if (start < 0) start = src.indexOf(head);
    assert.ok(start >= 0, `${head} must exist in the shipped source`);
    let i = src.indexOf('(', start), pd = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') pd++;
        else if (src[i] === ')') { pd--; if (!pd) break; }
    }
    let depth = 0;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced ${head}`);
}

// The live GET /api/site/trust `data`, trimmed to what the row reads.
// Re-measured 2026-10-06 after BF-101: `tax_invoice` and
// `shipping_promise.delivery_label` / min_days / max_days are new.
const TRUST = () => ({
    returns: { days: 30, label: '30-day returns', change_of_mind_days: 30, url_path: '/returns' },
    shipping_promise: { dispatch_cutoff_nzt: '14:00', label: 'Same-day dispatch before 2pm', delivery_label: '1–3 business days NZ-wide', min_days: 1, max_days: 3 },
    tax_invoice: { emailed_with_every_order: true, label: 'GST tax invoice emailed with every order' },
    organization: { gst_number: '94-509-459', trading_name: 'InkCartridges.co.nz' },
    contact: { phone_display: '027 474 0115', phone_tel_href: '+64274740115', support_email: 'support@inkcartridges.co.nz' },
    compatibility_promise: { label: 'Not sure it fits? 30-day returns on unopened items' },
});
const DELIVERY = () => ({ label: '1–3 business days NZ-wide', dispatch_cutoff_human: '2pm', dispatch_cutoff_nzt: '14:00' });
const texts = (facts) => facts.map((f) => f.text);

// ─────────────────────────────────────────────────────────────────────────────
// §5 ServiceRow
// ─────────────────────────────────────────────────────────────────────────────

test('§5 series page (site trust only): four facts, exact words, in checklist order', () => {
    // The days half now comes from shipping_promise.delivery_label (BF-101).
    assert.deepEqual(texts(ServiceRow.facts(TRUST())), [
        'Auckland metro orders by 2pm ship same day · most of NZ in 1–3 business days',
        'Questions? Call 027 474 0115 or email support@inkcartridges.co.nz',
        'GST tax invoice emailed with every order',
        '30-day returns on unopened items',
    ]);
});

test('§5 PDP (with delivery_estimate): the speed fact carries the days from the label', () => {
    const f = ServiceRow.facts(TRUST(), { deliveryEstimate: DELIVERY() });
    assert.equal(f[0].text, 'Auckland metro orders by 2pm ship same day · most of NZ in 1–3 business days');
});

test('§5 each absent field drops ONLY its own fact — nothing is defaulted', () => {
    const drop = (mut, gone) => {
        const t = TRUST(); mut(t);
        const keys = ServiceRow.facts(t).map((f) => f.key);
        assert.ok(!keys.includes(gone), `${gone} must be absent`);
        assert.equal(keys.length, 3, `only ${gone} went: ${keys}`);
    };
    drop((t) => { delete t.shipping_promise; }, 'speed');
    drop((t) => { delete t.contact; }, 'people');
    drop((t) => { t.tax_invoice = { emailed_with_every_order: false, label: null }; }, 'paperwork');
    drop((t) => { delete t.tax_invoice; }, 'paperwork');
    drop((t) => { delete t.returns; delete t.compatibility_promise; }, 'returns');
    assert.deepEqual(ServiceRow.facts({}), [], 'empty trust ⇒ no facts (row stays hidden)');
    assert.deepEqual(ServiceRow.facts(null), []);
});

test('§5 BF-101: the tax-invoice fact reads tax_invoice, NOT the GST number; days fall back to the site promise', () => {
    const t = TRUST(); delete t.organization;
    assert.ok(ServiceRow.facts(t).some((f) => f.key === 'paperwork'), 'no gst_number needed when tax_invoice says so');
    const g = TRUST(); delete g.tax_invoice;
    assert.ok(!ServiceRow.facts(g).some((f) => f.key === 'paperwork'), 'a GST number alone no longer makes the claim');
    const l = TRUST(); l.tax_invoice.label = 'Tax invoice with every order';
    assert.equal(ServiceRow.facts(l).find((f) => f.key === 'paperwork').text, 'Tax invoice with every order', 'the label is printed verbatim');
    const m = TRUST(); m.tax_invoice.emailed_with_every_order = 'yes';
    assert.ok(!ServiceRow.facts(m).some((f) => f.key === 'paperwork'), 'only a literal true makes the claim');
    // The product's own label wins on a PDP; the site's label is the fallback.
    const p = ServiceRow.facts(TRUST(), { deliveryEstimate: { ...DELIVERY(), label: '2–5 business days NZ-wide' } });
    assert.match(p[0].text, /most of NZ in 2–5 business days$/);
    const n = TRUST(); delete n.shipping_promise.delivery_label;
    assert.equal(ServiceRow.facts(n)[0].text, 'Auckland metro orders by 2pm ship same day', 'no label anywhere ⇒ cutoff half alone');
});

test('§5 returns falls back to compatibility_promise; phone-only / email-only contact read right', () => {
    const t = TRUST(); delete t.returns;
    assert.equal(ServiceRow.facts(t).find((f) => f.key === 'returns').text, '30-day returns on unopened items');
    const p = TRUST(); delete p.contact.support_email;
    assert.equal(ServiceRow.facts(p).find((f) => f.key === 'people').text, 'Questions? Call 027 474 0115');
    const e = TRUST(); delete e.contact.phone_display;
    assert.equal(ServiceRow.facts(e).find((f) => f.key === 'people').text, 'Questions? Email support@inkcartridges.co.nz');
});

test('§5 never an unscoped same-day, never Afterpay (owner 2026-10-05), in data or in source', () => {
    for (const opts of [undefined, { deliveryEstimate: DELIVERY() }]) {
        for (const t of texts(ServiceRow.facts(TRUST(), opts))) {
            if (/same day|same-day/i.test(t)) assert.match(t, /Auckland metro/);
            assert.doesNotMatch(t, /afterpay/i);
        }
    }
    assert.doesNotMatch(stripComments(read('js/service-row.js')), /afterpay/i);
});

test('§5 formatCutoff: 24h NZT to shopper words; junk ⇒ null', () => {
    assert.equal(ServiceRow.formatCutoff('14:00'), '2pm');
    assert.equal(ServiceRow.formatCutoff('09:30'), '9:30am');
    assert.equal(ServiceRow.formatCutoff('00:00'), '12am');
    assert.equal(ServiceRow.formatCutoff('12:00'), '12pm');
    for (const bad of ['25:00', '14:60', '2pm', '', null, undefined, 1400]) assert.equal(ServiceRow.formatCutoff(bad), null, String(bad));
});

test('§5 render: tel: from phone_tel_href, mailto:, everything escaped; empty ⇒ hidden', () => {
    const el = { hidden: true, innerHTML: '' };
    const t = TRUST();
    t.contact.support_email = 'a"<b>@x.nz';
    assert.equal(ServiceRow.render(el, ServiceRow.facts(t)), true);
    assert.equal(el.hidden, false);
    assert.match(el.innerHTML, /<a href="tel:\+64274740115" class="service-row__link">027 474 0115<\/a>/);
    assert.match(el.innerHTML, /href="mailto:a&quot;<b>@x.nz"/, 'attribute escaped');
    assert.doesNotMatch(el.innerHTML, /<b>@x\.nz<\/a>/, 'link text escaped');
    assert.equal(ServiceRow.render(el, []), false);
    assert.equal(el.hidden, true);
    assert.equal(el.innerHTML, '');
});

test('§5 mount: empty trust read ⇒ hidden AND logged (fail-soft is loud)', async () => {
    const warns = [];
    global.TrustStats = { raw: async () => ({}) };
    global.DebugLog = { warn: (m) => warns.push(m) };
    try {
        const el = { hidden: false, innerHTML: 'x' };
        const r = await ServiceRow.mount(el);
        assert.deepEqual(r, { shown: false, facts: [], reason: 'no-facts' });
        assert.equal(el.hidden, true);
        assert.equal(warns.length, 1);
        assert.match(warns[0], /\/api\/site\/trust returned nothing/);
        global.TrustStats = { raw: async () => TRUST() };
        const ok = await ServiceRow.mount(el);
        assert.equal(ok.shown, true);
        assert.equal(ok.facts.length, 4);
    } finally {
        delete global.TrustStats;
        delete global.DebugLog;
    }
});

test('§5 wiring: shop.html container + script after utils.js; shop-page shows it on code pages and printer hubs only', () => {
    const html = read('html/shop.html');
    assert.match(html, /<div class="service-row" id="service-row"[^>]*hidden><\/div>/);
    const utils = html.indexOf('/js/utils.js?v=');
    const row = html.indexOf('/js/service-row.js?v=');
    assert.ok(utils > 0 && row > utils, 'service-row.js loads after utils.js (TrustStats, Security)');

    const SHOP = read('js/shop-page.js');
    const body = lift(SHOP, '_syncServiceRow()');
    const run = (state) => {
        const el = { hidden: true, dataset: {}, firstChild: null };
        let mounted = 0;
        const obj = vm.runInNewContext(`({ ${body} })`, {
            document: { getElementById: (id) => (id === 'service-row' ? el : null) },
            ServiceRow: { mount: () => { mounted++; return Promise.resolve({}); } },
        });
        obj.state = state;
        obj._syncServiceRow();
        return { el, mounted };
    };
    assert.equal(run({ level: 'products', code: '288' }).mounted, 1, 'code page mounts');
    assert.equal(run({ level: 'printer-products' }).mounted, 1, 'printer hub mounts');
    for (const s of [{ level: 'products', code: '' }, { level: 'brands' }, { level: 'search-results' }, { level: 'codes' }]) {
        const r = run(s);
        assert.equal(r.mounted, 0, JSON.stringify(s));
        assert.equal(r.el.hidden, true, JSON.stringify(s));
    }
    assert.match(lift(SHOP, 'updateTitle()'), /this\._syncServiceRow\(\);/);
});

test('§5 CSS: one clipped 18px line with NO margin on laptops (the 1280x551 fold budget), scrolls on phones', () => {
    const css = stripComments(read('css/components.css'));
    assert.match(css, /\.service-row \{[^}]*margin: 0;[^}]*line-height: 18px;/);
    assert.match(css, /\.service-row__list \{[^}]*flex-wrap: wrap;[^}]*max-height: 18px;[^}]*overflow: hidden;/);
    assert.match(css, /@media \(max-width: 768px\) \{\s*\.service-row__list \{[^}]*max-height: none;[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 consent card
// ─────────────────────────────────────────────────────────────────────────────

test('§7 /shop (body.page-shop) moves the corner card bottom-RIGHT, lifted by the badge clip box', () => {
    const css = stripComments(read('css/components.css'));
    const m = /@media \(min-width: 1100px\) \{\s*body\.page-shop \.consent-banner \{([^}]*)\}/.exec(css);
    assert.ok(m, 'scoped ≥1100 rule exists');
    assert.match(m[1], /left: auto;/);
    assert.match(m[1], /right: 16px;/);
    assert.match(m[1], /bottom: calc\(16px \+ var\(--google-badge-max, 100px\) \+ 8px/,
        'lifted by OUR clip box, not the late-settling measured height');
    assert.match(css, /--google-badge-max: 100px;/);
    assert.match(css, /#google-reviews-badge \{[^}]*max-width: var\(--google-badge-max\);[^}]*max-height: var\(--google-badge-max\);/,
        'the lift and the clip are the same number');
    assert.match(read('html/shop.html'), /<body class="page-shop">/);
});

test('§7 everywhere else (PDP, cart, checkout) keeps the bottom-LEFT card', () => {
    const css = stripComments(read('css/components.css'));
    assert.match(css, /@media \(min-width: 1100px\) \{\s*\.consent-banner \{\s*left: 16px;\s*right: auto;/);
    for (const page of ['html/product/index.html', 'html/cart.html', 'html/checkout.html', 'html/payment.html']) {
        assert.doesNotMatch(read(page), /<body[^>]*page-shop/, `${page} must not opt into the right card`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 delivery days
// ─────────────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['vendor', 'node_modules', 'admin'].includes(e.name)) walk(p, out); }
        else if (/\.(html|js)$/.test(e.name)) out.push(p);
    }
    return out;
}

test('§8 no "2–4" / "1–4" business/working days anywhere in the storefront (html + js)', () => {
    const OLD = /\b[12]\s*(?:–|-|&ndash;|\\u2013)\s*4\s+(?:business|working)\s+days/i;
    // Comments may NAME the old window (to say it is gone); shipped text may not.
    const shipped = (f) => {
        const src = fs.readFileSync(f, 'utf8');
        return f.endsWith('.js') ? stripComments(src) : src.replace(/<!--[\s\S]*?-->/g, '');
    };
    const hits = walk(ROOT).filter((f) => OLD.test(shipped(f))).map((f) => path.relative(ROOT, f));
    assert.deepEqual(hits, []);
});

test('§8 the four named sites now say 1–3', () => {
    assert.match(read('js/shipping.js'), /'south-island': '1\\u20133 business days'/);
    assert.match(read('js/legal-config.js'), /zone: 'South Island',[^\n]*eta: '1–3 working days'/);
    assert.match(read('html/about.html'), /South Island<\/strong> &mdash; 1&ndash;3 working days/);
});

test('§8 /faq: the visible South Island line equals the FAQPage JSON-LD answer', () => {
    const html = read('html/faq.html');
    const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    const data = JSON.parse(ld[1]);
    const q = data.mainEntity.find((e) => e.name === 'How fast do you ship within New Zealand?');
    const json = /South Island ([^.;]+)/.exec(q.acceptedAnswer.text)[1];
    const visible = /<li>South Island: ([^<.]+)\.<\/li>/.exec(html)[1];
    assert.equal(json, '1–3 working days');
    assert.equal(visible, json);
});

// ─────────────────────────────────────────────────────────────────────────────
// §13 guest account card
// ─────────────────────────────────────────────────────────────────────────────

const CONF_SRC = read('js/order-confirmation-page.js');
function conf() {
    const sandbox = { Security, storageUrl: (u) => u, BrandSource: undefined, OrderTotals: undefined };
    vm.createContext(sandbox);
    const src = ['transformAPIOrder(apiOrder)', 'guestPointsText(row, welcome)', 'nextOrderLine(offer)']
        .map((h) => lift(CONF_SRC, h)).join(',\n');
    vm.runInContext(`globalThis.P = { ${src} };`, sandbox);
    return sandbox.P;
}

test('§13 next_order_offer is tri-state through transformAPIOrder', () => {
    const P = conf();
    const base = { order_number: 'X1', total: 50 };
    assert.equal(P.transformAPIOrder(base).nextOrderOffer, undefined, 'absent ⇒ undefined');
    assert.equal(P.transformAPIOrder({ ...base, next_order_offer: null }).nextOrderOffer, null, 'null kept');
    const offer = { points: 150, dollars: 1.5, by: '2026-10-19', guest: true };
    assert.deepEqual(JSON.parse(JSON.stringify(P.transformAPIOrder({ ...base, next_order_offer: offer }).nextOrderOffer)), offer);
});

test('§13 nextOrderLine: the sentence only for a usable offer; null / absent / malformed ⇒ nothing', () => {
    const P = conf();
    assert.equal(P.nextOrderLine({ points: 150, dollars: 1.5, by: '2026-10-19', guest: true }),
        'Your next order by 19 October earns 150 bonus points ($1.50).');
    assert.equal(P.nextOrderLine({ points: 1200, dollars: 12, by: '2026-11-02T10:59:00Z' }),
        'Your next order by 2 November earns 1,200 bonus points ($12.00).', 'by is read in NZ time');
    for (const bad of [null, undefined, 'x', {}, { points: 0, dollars: 1, by: '2026-10-19' },
        { points: 1.5, dollars: 1, by: '2026-10-19' }, { points: 10, dollars: -1, by: '2026-10-19' },
        { points: 10, dollars: 'x', by: '2026-10-19' }, { points: 10, dollars: 1, by: 'soon' }, { points: 10, dollars: 1 }]) {
        assert.equal(P.nextOrderLine(bad), '', JSON.stringify(bad));
    }
});

test('§13 guestPointsText: "You get N points for this order plus W welcome points." — clauses drop, never default', () => {
    const P = conf();
    assert.equal(P.guestPointsText({ amount: 45 }, 200), 'You get 45 points for this order plus 200 welcome points.');
    assert.equal(P.guestPointsText({ amount: 45, note: 'estimate' }, 200), 'You get about 45 points for this order plus 200 welcome points.');
    assert.equal(P.guestPointsText({ amount: 45 }, null), 'You get 45 points for this order.');
    assert.equal(P.guestPointsText(null, 200), "You get 200 welcome points, and this order's points are added when you first sign in.");
    assert.equal(P.guestPointsText(null, null), "This order's points are added to your account when you first sign in.");
    assert.equal(P.guestPointsText({ amount: 0 }, 0), "This order's points are added to your account when you first sign in.");
});

test('§13 markup: heading, read-only order email, one password field, one button, offer slot; earn rule verbatim', () => {
    const html = read('html/order-confirmation.html');
    const card = /<div class="confirmation-card confirmation-card--accent" id="create-account-prompt" hidden>([\s\S]*?)<\/form>/.exec(html)[1];
    assert.match(card, /<h3>Save your order and collect your points<\/h3>/);
    assert.match(card, /<input type="email" id="confirmation-account-email" class="form-input" readonly autocomplete="username">/);
    assert.equal((card.match(/type="password"/g) || []).length, 1);
    assert.equal((card.match(/<button[^>]*type="submit"[^>]*>Create my account<\/button>/g) || []).length, 1);
    assert.match(card, /id="create-account-offer" hidden/);
    // The earn rule stays VERBATIM (matches /account/loyalty; mobile-cta-occlusion §5).
    assert.ok(card.includes('1 point for every $1') && card.includes('100 points = $1'));
    const code = stripComments(CONF_SRC);
    assert.match(code, /emailEl\.value = email/, 'the email is a field value now, not text');
    assert.doesNotMatch(code, /create-account[^\n]*signedLink|\/create-account\?t=/, 'no signed-link one-click account from this page');
});

test('§13 the points line re-renders once the ORDER lands (it ran before the earned row existed)', () => {
    const body = stripComments(lift(CONF_SRC, 'renderOrderDetails()'));
    assert.match(body, /if \(Auth\.isAuthenticated\(\)\) return;\s*this\.renderAccountForm\(\);\s*this\.renderGuestPointsLine\(\);/);
    const fn = stripComments(lift(CONF_SRC, 'async renderGuestPointsLine()'));
    assert.ok(fn.indexOf('await ValueProps.load()') < fn.indexOf('const row = this._earnedRow'),
        'the earned row is read AFTER the await');
});
