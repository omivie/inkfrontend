/**
 * FE master checklist (backend, 2026-10-05) — feink-dc's items 5, 7, 8, 13 (ERR-306).
 *
 * §5  The service row (js/service-row.js) was REMOVED by the owner on
 *     2026-10-13 (ERR-329); §5 now guards that it stays gone.
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

// ─────────────────────────────────────────────────────────────────────────────
// §5 service row — removed (ERR-329)
// ─────────────────────────────────────────────────────────────────────────────

test('§5 the service row is GONE everywhere (owner 2026-10-13, ERR-329) — never re-add', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'js', 'service-row.js')), false, 'module deleted, not just unloaded');
    for (const rel of ['html/shop.html', 'html/product/index.html']) {
        const html = read(rel).replace(/<!--[\s\S]*?-->/g, '');
        assert.doesNotMatch(html, /service-row/, `${rel}: no container, no script tag (a hidden div still fails a DOM check)`);
    }
    for (const rel of ['js/shop-page.js', 'js/product-detail-page.js', 'css/components.css']) {
        assert.doesNotMatch(stripComments(read(rel)), /service-row|ServiceRow/, `${rel}: no caller, no style`);
    }
    // The line itself, wherever it might be rebuilt from. (The PDP's separate
    // "Questions? Call … · NZ company since …" value line is NOT this row and stays.)
    for (const rel of ['js/shop-page.js', 'js/product-detail-page.js']) {
        assert.doesNotMatch(stripComments(read(rel)), /ship same day · most of NZ|Questions\? Call \$\{phone\} or email/, rel);
    }
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
