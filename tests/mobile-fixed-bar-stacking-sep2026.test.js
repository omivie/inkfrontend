/**
 * ERR-238 / ERR-239 / ERR-240 — the phone pass.
 * =============================================
 *
 * These are SOURCE CONTRACTS. They cannot prove a box is the size it says —
 * that is `npm run probe:mobile-ux`, which measures real geometry at three
 * phone viewports against the deployed site. What they can do is stop a
 * specific defect being re-introduced by an edit that looks reasonable, which
 * is how every one of these three arrived in the first place.
 *
 * Read the failure messages before "fixing" a failure here: each one names the
 * measurement behind the rule.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const COMPONENTS = fs.readFileSync(path.join(ROOT, 'css/components.css'), 'utf8');
const PAGES = fs.readFileSync(path.join(ROOT, 'css/pages.css'), 'utf8');
const EFFECTS = fs.readFileSync(path.join(ROOT, 'css/modern-effects.css'), 'utf8');
const SEARCH_CSS = fs.readFileSync(path.join(ROOT, 'css/search.css'), 'utf8');
const SEARCH_JS = fs.readFileSync(path.join(ROOT, 'js/search.js'), 'utf8');
const MAIN_JS = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');

/** Strip comments so a rule cannot be satisfied by a comment that mentions it. */
const codeOnly = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// ─── §1 ERR-238: the consent banner must clear every fixed bottom bar ───────

test('§1 the consent-banner lift covers all three sticky bars, not just the badge', () => {
    const css = codeOnly(COMPONENTS);
    const m = css.match(/body\.has-consent-banner[^{]*\{[^}]*bottom:\s*var\(--consent-banner-height[^}]*\}/g) || [];
    const joined = m.join('\n');
    for (const sel of ['.cart-sticky-bar', '.sticky-atc', '.filter-sort-bar']) {
        assert.ok(joined.includes(sel) || css.includes(`body.has-consent-banner ${sel}`),
            `${sel} must be lifted clear of the consent banner. It is position:fixed;bottom:0 at `
            + `--z-sticky (200) and the banner is --z-popover (600), so the banner paints over it. `
            + `Measured on production at 390x844: elementFromPoint at the PDP Add-to-Cart button's `
            + `own centre returned button.consent-banner__btn (ERR-238).`);
    }
});

test('§1 the lift uses the MEASURED height, never a constant', () => {
    const css = codeOnly(COMPONENTS);
    const rule = css.slice(css.indexOf('body.has-consent-banner .cart-sticky-bar'));
    const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));
    assert.match(body, /var\(--consent-banner-height/,
        'the offset must be the custom property consent-banner.js writes from the rendered box — '
        + 'a constant reserving space for something that has a height is a measurement someone '
        + 'declined to take (ERR-189/196)');
    // The only px allowed is the var()'s own fallback, which is 0 — i.e. "no lift
    // when the banner is not showing", not a guessed height.
    assert.doesNotMatch(body.replace(/var\([^)]*\)/g, 'VAR'), /\d+px/,
        'no hardcoded pixel offset: the bar stacks at 148px on a 390px phone and less on a wider one');
});

test('§1 only the Google badge carries !important, and it still does', () => {
    const css = codeOnly(COMPONENTS);
    const badge = css.slice(css.indexOf('body.has-consent-banner #google-reviews-badge'));
    assert.match(badge.slice(0, 200), /!important/,
        '!important is load-bearing on the badge: an author !important is the only thing that '
        + 'beats a non-important INLINE style, and Google re-asserts bottom:0 inline on resize (ERR-233)');
    const ours = css.slice(css.indexOf('body.has-consent-banner .cart-sticky-bar'));
    assert.doesNotMatch(ours.slice(0, ours.indexOf('}')), /!important/,
        'our own three bars must NOT use !important — a more specific selector already wins, and '
        + 'an unnecessary !important reads as though we were fighting something');
});

test('§1 the consent banner reserves the home-indicator inset', () => {
    const css = codeOnly(COMPONENTS);
    const rule = css.slice(css.indexOf('.consent-banner {'));
    const body = rule.slice(0, rule.indexOf('}'));
    assert.match(body, /padding-bottom:\s*var\(--safe-bottom\)/,
        'this bar is what the other three are now lifted ABOVE, so its height is their offset. '
        + 'On a notched iPhone its buttons sat in the gesture strip.');
});

test('§1 the false "only one fixed bottom bar" claim is gone from pages.css', () => {
    assert.ok(!codeOnly(PAGES).includes('only one fixed bottom bar is ever present per page'),
        'that comment asserted an invariant nothing checked, and the consent banner is the '
        + 'counter-example on every page. Invariant F of probe:mobile-ux holds it now.');
});

// ─── §2 ERR-239: no section may capture a fixed child ──────────────────────

test('§2 the scroll-reveal resting state is `none`, not the identity matrix', () => {
    const css = codeOnly(EFFECTS);
    const i = css.indexOf('.will-animate.in-view');
    assert.ok(i !== -1, 'the .in-view rule must exist');
    const body = css.slice(css.indexOf('{', i), css.indexOf('}', i));
    assert.match(body, /transform:\s*none/,
        'translateY(0) is NOT none. A non-none transform makes the element a containing block for '
        + 'every position:fixed descendant, and .in-view is never removed — so every section on the '
        + 'site was one. Measured: /cart\'s sticky Checkout bar painted at top:-1161px (ERR-239).');
    assert.doesNotMatch(body, /translateY\(0\)/,
        'and it must not come back — the identity matrix looks like a no-op and is not one');
});

// ─── §3 ERR-240: the 16px floor and the buy-row axis ───────────────────────

test('§3 the 16px floor applies to input, select AND textarea at equal specificity', () => {
    const css = codeOnly(COMPONENTS);
    const i = css.indexOf('body input:not(');
    assert.ok(i !== -1, 'the floor rule must exist');
    const selector = css.slice(i, css.indexOf('{', css.indexOf('font-size: 16px', i) - 200) + 1);
    for (const el of ['input', 'select', 'textarea']) {
        assert.ok(new RegExp(`body ${el}`).test(selector),
            `${el} must be in the floor. Below 16px iOS Safari zooms the page on focus and does `
            + 'not zoom back.');
    }
    // The :not() chain is what makes the three arms weigh the same. Without it on
    // select/textarea the rule half-works: (0,3,2) vs (0,0,2), and (0,0,2) loses
    // to `.contact-form-wrapper .form-input` (0,2,0). Measured exactly that.
    const arms = selector.split(',').filter((a) => /body (input|select|textarea)/.test(a));
    assert.equal(arms.length, 3, 'three arms');
    const counts = arms.map((a) => (a.match(/:not\(/g) || []).length);
    assert.ok(counts.every((c) => c === counts[0] && c > 0),
        'all three arms need the SAME number of :not() clauses. select and textarea never carry a '
        + '`type`, so those clauses filter nothing — they carry SPECIFICITY. The first version had '
        + 'them only on `input` and every select/textarea on /contact and /quote stayed at 15.2px.');
});

test('§3 the buy row is never given row-thinking inside a column', () => {
    const css = codeOnly(PAGES);
    const i = css.indexOf('.products-sections--split .products-row .product-card__buy');
    if (i !== -1) {
        const body = css.slice(css.indexOf('{', i), css.indexOf('}', i));
        assert.doesNotMatch(body, /flex-wrap:\s*wrap/,
            '`flex-wrap: wrap` + `flex-basis: 100%` is the "own line" idiom for a ROW. This box is a '
            + 'COLUMN under @container pcard (max-width:260px) inside @media (pointer: coarse), so '
            + 'flex-basis became the HEIGHT and the button collapsed to the width of the word "Add" '
            + '— 38x96px at every phone width (ERR-240, and ERR-224 before it).');
    }
    assert.ok(!/\.products-sections--split[^{]*\.product-card__cart-btn\s*\{[^}]*flex:\s*1\s+0\s+100%/.test(css),
        'and the CTA must not carry flex-basis:100% there either — the container query already '
        + 'stacks the column and sets width:100%; it needed no help');
});

test('§3 the shop-columns probe emulates touch, or it measures a layout no phone gets', () => {
    const probe = fs.readFileSync(path.join(__dirname, '..', 'scripts/probe-shop-source-columns.mjs'), 'utf8');
    assert.match(probe, /hasTouch:\s*true/,
        'the rules that broke live inside @media (pointer: coarse). Built as '
        + 'newContext({ viewport }) the pointer is FINE, so the probe was measuring a layout no '
        + 'phone ever gets and reporting it green — which is why the 38x96 button shipped.');
});

// ─── §4 ERR-238: the phone segmented control ───────────────────────────────

test('§4 the split collapses to one column below 700px', () => {
    const css = codeOnly(SEARCH_CSS);
    // search.css has more than one <=699px block; the collapse may live in any of
    // them, so check them all rather than assuming which.
    const blocks = [];
    let at = -1;
    while ((at = css.indexOf('@media (max-width: 699px)', at + 1)) !== -1) {
        const next = css.indexOf('@media', at + 10);
        blocks.push(css.slice(at, next === -1 ? undefined : next));
    }
    assert.ok(blocks.length, 'the phone breakpoint block must exist');
    const block = blocks.join('\n');
    assert.match(block, /\.smart-ac__sections--split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
        'two ~150px columns on a phone is under the card\'s own measured floor — that is the panel '
        + 'in the owner\'s screenshot');
});

test('§4 the tab bar is a phone control and desktop keeps its two columns', () => {
    const css = codeOnly(SEARCH_CSS);
    assert.match(css, /@media \(min-width: 700px\)[\s\S]{0,200}\.smart-ac__tablist\s*\{[^}]*display:\s*none/,
        'above 700px both sections are on screen with their own badge headings, so a tab bar would '
        + 'be two buttons that change nothing');
    assert.match(css, /\.smart-ac__sections--split\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/,
        'the base two-column split must survive untouched — desktop is not what was broken');
});

test('§4 tab state lives in JS, not in the markup it re-renders', () => {
    assert.match(SEARCH_JS, /activeSource/,
        'renderResults replaces state.list.innerHTML on every debounced keystroke; read off the DOM '
        + 'the selected tab would reset to Compatible mid-word');
    assert.doesNotMatch(SEARCH_CSS, /:has\(\.smart-ac__section/,
        'the layout decision stays in search.js — one place counts the sources '
        + '(search-dropdown-grouping.test.js pins this too)');
});

test('§4 switching tabs re-points state.results at what is VISIBLE', () => {
    const i = SEARCH_JS.indexOf('function applyActiveSource');
    assert.ok(i !== -1, 'applyActiveSource must exist');
    const body = SEARCH_JS.slice(i, i + 2600);
    assert.match(body, /state\.results\s*=/,
        'setActive(i) highlights DOM card i while Enter navigates to state.results[i]. Hiding a '
        + 'section without re-pointing this lets an arrow key open a product that is not on screen '
        + '— the ERR-144 failure in a new costume.');
    assert.match(body, /\.hidden\s*=\s*true/,
        'the inactive section must be hidden with the `hidden` ATTRIBUTE so it leaves the a11y tree '
        + 'and the tab order, not just the paint');
});

test('§4 the tabs are in the mousedown guard (ERR-218)', () => {
    const i = SEARCH_JS.indexOf("state.list.addEventListener('mousedown'");
    const body = SEARCH_JS.slice(i, i + 700);
    assert.match(body, /smart-ac__tab/,
        'without it the first tap on a tab blurs the search input, the panel closes, and the click '
        + 'lands on nothing — byte-for-byte the ERR-218 failure the stepper controls are in that list for');
});

test('§4 the dropdown height floor MEASURES the tab bar', () => {
    assert.match(SEARCH_JS, /PREFERRED\s*=\s*280\s*\+/,
        'a tab bar adds a row, so a gap that "fits" 280px would in fact hold the tab bar, one card '
        + 'row and the footer. Measured off offsetHeight, never a constant (ERR-189/196).');
});

// ─── §5 ERR-238: the dead mega-panel handler stays dead ────────────────────

test('§5 main.js does not bind a second handler to the mega toggles', () => {
    const code = MAIN_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!code.includes('initMegaPanels()'),
        'initMegaPanels read a `data-target` attribute that appears in no HTML in this repo and a '
        + '`.mega-panel` class that matches nothing. It desynced aria-expanded on a visibly open '
        + 'menu, and rewards-nudge.js:164 reads exactly that attribute to decide whether to '
        + 'suppress itself — so the nudge could fire over an open mega menu. mega-nav.js owns these.');
    assert.ok(!code.includes("data-target"),
        'and the attribute it invented must not come back');
});

test('§5 the CSS half went with it', () => {
    assert.ok(!codeOnly(fs.readFileSync(path.join(ROOT, 'css/layout.css'), 'utf8')).includes('.mega-panel'),
        '.mega-panel matched nothing — the panels are #brands-mega and #ribbons-mega');
});

// ─── §6 the viewport contract ──────────────────────────────────────────────

test('§6 every page ships the same viewport meta, with viewport-fit=cover', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name))
            : (e.name.endsWith('.html') ? [path.join(dir, e.name)] : []));
    const pages = walk(ROOT);
    assert.ok(pages.length >= 40, `expected the full page set, found ${pages.length}`);
    for (const f of pages) {
        const html = fs.readFileSync(f, 'utf8');
        const m = html.match(/<meta name="viewport" content="([^"]*)">/);
        assert.ok(m, `${path.relative(ROOT, f)} has no viewport meta`);
        assert.ok(m[1].includes('viewport-fit=cover'),
            `${path.relative(ROOT, f)} is missing viewport-fit=cover — without it env(safe-area-inset-*) `
            + 'resolves to 0 and every fixed bottom bar sits under the home indicator');
        assert.ok(!/user-scalable\s*=\s*no|maximum-scale/.test(m[1]),
            `${path.relative(ROOT, f)} must not disable pinch-zoom`);
    }
});
