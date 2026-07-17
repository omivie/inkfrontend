/**
 * TEXT-FIT AUDIT — Jul 2026
 * =========================
 * A Playwright sweep (inkcartridges/scripts/fit-audit.js, `npm run audit:fit`)
 * found text overflowing its boxes on small viewports across the storefront.
 * These static assertions pin the CSS/markup fixes so they can't regress:
 *
 *  1. /shop shipping pill: the bullet separator uses NORMAL spaces (a span),
 *     not `&nbsp;&bull;&nbsp;` — the nbsp glue made "…$100 • Fast" one
 *     unbreakable run that overflowed the pill and viewport at <=390px.
 *  2. Contact/quote cards: the value cell can shrink (minmax(0,1fr)) and
 *     long unbreakable values (the support@ email) wrap (overflow-wrap).
 *  3. Buttons wrap instead of clipping on small phones (<=480px) — the base
 *     .btn is white-space:nowrap for desktop composure.
 *  4. Auth social buttons stack <=480px ("Microsoft" can't wrap).
 *  5. 404 search input can shrink below the UA's ~170px min-width.
 *  6. Footer logo text is fluid (clamp), not a fixed 25px that overflowed 320px.
 *  7. Scrollable policy/legal table wrappers carry the edge-fade scroll hint.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PAGES = read('inkcartridges/css/pages.css');
const COMPONENTS = read('inkcartridges/css/components.css');
const LAYOUT = read('inkcartridges/css/layout.css');
const SHOP_HTML = read('inkcartridges/html/shop.html');

test('T1 shop shipping pill has no nbsp-glued bullet and can shrink', () => {
    assert.ok(!SHOP_HTML.includes('&nbsp;&bull;&nbsp;'),
        'the pill separator must use normal spaces (span.shipping-info-bar__sep), not &nbsp; glue');
    assert.match(SHOP_HTML, /shipping-info-bar__sep/,
        'the pill separator span must exist');
    assert.match(PAGES, /\.shipping-info-bar--inline\s*\{[^}]*min-width:\s*0/s,
        '.shipping-info-bar--inline needs min-width:0 to shrink inside its flex row');
});

test('T2 contact card value cell shrinks and long values wrap', () => {
    assert.match(PAGES, /\.contact-card__item\s*\{[^}]*grid-template-columns:\s*36px\s+minmax\(0,\s*1fr\)/s,
        '.contact-card__item value column must be minmax(0,1fr) — implicit min-width:auto let the email prop the card open');
    assert.match(PAGES, /\.contact-card__value\s*\{[^}]*overflow-wrap:\s*anywhere/s,
        '.contact-card__value must wrap unbreakable values (email addresses)');
});

test('T3 buttons wrap instead of clipping on small phones', () => {
    assert.match(COMPONENTS, /@media \(max-width: 480px\)\s*\{\s*\.btn\s*\{[^}]*white-space:\s*normal/,
        '.btn must allow label wrapping <=480px (base rule is nowrap)');
});

test('T4 auth social buttons stack on small phones', () => {
    assert.match(PAGES, /@media \(max-width: 480px\)\s*\{\s*\.auth-social__buttons\s*\{[^}]*flex-direction:\s*column/,
        '.auth-social__buttons must stack <=480px — single-word labels cannot wrap');
});

test('T5 404 search input can shrink below the UA min-width', () => {
    assert.match(PAGES, /\.error-content__search \.search-form__input\s*\{[^}]*min-width:\s*0/s,
        'the 404 search input needs min-width:0');
});

test('T6 footer logo text is fluid, not a fixed size', () => {
    assert.match(LAYOUT, /\.footer-brand__logo \.logo__text\s*\{[^}]*font-size:\s*clamp\(/s,
        'footer logo font-size must be a clamp() — fixed 25px overflowed 320px viewports');
});

test('T7 scrollable table wrappers carry the edge-fade scroll hint', () => {
    assert.match(PAGES, /\.policy-table-wrap,\s*\.legal-table-wrap\s*\{[^}]*background-attachment:\s*local, local, scroll, scroll/s,
        'policy/legal table wraps need the background-attachment scroll-hint shadows');
});

test('T8 the fit-audit tool exists and is wired to npm', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'inkcartridges/scripts/fit-audit.js')),
        'inkcartridges/scripts/fit-audit.js must exist');
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.scripts['audit:fit'], 'node inkcartridges/scripts/fit-audit.js',
        'npm run audit:fit must run the fit-audit script');
});
