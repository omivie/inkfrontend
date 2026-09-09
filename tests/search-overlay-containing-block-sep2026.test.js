/**
 * A scroll-reveal transform is a containing block (ERR-217)
 * =========================================================
 *
 * `transform: translateY(0)` is NOT `transform: none`. Any non-none transform
 * makes the element the containing block — and the stacking context — for every
 * `position: fixed` descendant. modern-effects.js adds `.will-animate` to the
 * literal selector `'section'`, i.e. to EVERY section on the site, and
 * modern-effects.css resolves that to `transform: translateY(0)` once revealed.
 * So every section on this site is a trap for a fixed overlay, and it had
 * exactly one victim: 404.html's in-page search box, the only `.search-form`
 * on the site that is not in the `<header>`.
 *
 * Measured on the live page, 1440x800: positionDropdown() asked for
 * `top: 654px` and the panel painted at `top: 809` — offset by precisely the
 * section's own 155px page position. Setting `transform: none` on that section
 * in the live DOM moved it to 655. Its `z-index: 50` was trapped in the
 * section's stacking context too, under the header's 200.
 *
 * The fix exempts any section hosting a search form, the way `.hero` is already
 * exempt. This file pins the exemption FUNCTIONALLY — it runs the real
 * initScrollAnimations() against a stub DOM — because a rule that is only
 * described in a comment is not a rule.
 *
 * Sibling: tests/search-dropdown-viewport-fit-sep2026.test.js pins the other
 * half (the panel must also FIT once it is in the right coordinate space).
 *
 * Run with: node --test tests/search-overlay-containing-block-sep2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'modern-effects.js');
const CSS_PATH = path.join(ROOT, 'inkcartridges', 'css', 'modern-effects.css');
const HTML_404 = path.join(ROOT, 'inkcartridges', '404.html');

// ─── A stub DOM, just wide enough for initScrollAnimations ─────────────────

function makeEl({ tag = 'section', classes = [], contains = [], parentHero = false }) {
    const set = new Set(classes);
    return {
        tag,
        style: {},
        _contains: contains,
        classList: {
            add: (...c) => c.forEach((x) => set.add(x)),
            contains: (c) => set.has(c),
            has: (c) => set.has(c),
            all: () => [...set],
        },
        closest: (sel) => (parentHero && sel === '.hero' ? {} : null),
        querySelector: (sel) => (contains.includes(sel) ? {} : null),
        getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
    };
}

function runInitScrollAnimations(elements) {
    const js = fs.readFileSync(JS_PATH, 'utf8');
    const start = js.indexOf('initScrollAnimations() {');
    assert.ok(start !== -1, 'initScrollAnimations must exist in modern-effects.js');
    const open = js.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (i < js.length && depth > 0) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') depth--;
        if (depth === 0) break;
        i++;
    }
    const body = js.slice(open + 1, i);

    const observed = [];
    class IntersectionObserver {
        constructor(cb) { this.cb = cb; }
        observe(el) { observed.push(el); }
        unobserve() {}
    }
    const document = {
        // Only the literal 'section' selector returns our fixtures; the other
        // selectors in the list (.product-card, .faq-item, …) match nothing.
        querySelectorAll: (sel) => (sel === 'section' ? elements : []),
    };
    const window = { innerHeight: 800 };
    const requestAnimationFrame = () => {};
    const setTimeout = () => {};

    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'window', 'IntersectionObserver', 'requestAnimationFrame', 'setTimeout', body);
    fn(document, window, IntersectionObserver, requestAnimationFrame, setTimeout);
    return { observed };
}

// ─── §1 The exemption, exercised ───────────────────────────────────────────

test('§1 a section hosting a search form is never given the reveal transform', () => {
    const errorSection = makeEl({ classes: ['error-page'], contains: ['.search-form'] });
    const { observed } = runInitScrollAnimations([errorSection]);

    assert.equal(errorSection.style.transform, 'none',
        'the section must be pinned to transform:none — translateY(0) would capture ' +
        'the search dropdown\'s position:fixed panel (measured: asked 654px, painted 809px)');
    assert.equal(errorSection.style.opacity, '1', 'and stay visible, like .hero');
    assert.equal(errorSection.classList.contains('will-animate'), false,
        'it must not get .will-animate — that class IS the transform');
    assert.equal(observed.length, 0, 'and it must not be observed, or .in-view re-adds it');
});

test('§1 an ordinary section still animates — the exemption is narrow', () => {
    const plain = makeEl({ classes: ['trust-bar'], contains: [] });
    const { observed } = runInitScrollAnimations([plain]);

    assert.equal(plain.classList.contains('will-animate'), true,
        'sections without a search form keep the scroll reveal');
    assert.equal(observed.length, 1, 'and are still observed');
    assert.equal(plain.style.transform, undefined, 'and are not pinned');
});

test('§1 the hero exemption that came first still holds', () => {
    const hero = makeEl({ classes: ['hero'] });
    const inHero = makeEl({ classes: ['hero-content'], parentHero: true });
    const { observed } = runInitScrollAnimations([hero, inHero]);
    assert.equal(hero.style.transform, 'none');
    assert.equal(inHero.style.transform, 'none');
    assert.equal(observed.length, 0);
});

// ─── §2 The exemption is load-bearing, not decorative ──────────────────────

/* THIS TEST INVERTED ON PURPOSE — ERR-239, and the old version predicted it.
   It used to assert the revealed state was `translateY(0)` and NOT `none`, and
   said so explicitly: "if this ever becomes `transform: none`, the
   containing-block trap is gone and the exemption in modern-effects.js can be
   revisited (deliberately, not by accident)."

   This is that deliberate revisit. The trap was not confined to the one section
   the JS exemption covered. EVERY section carries .will-animate, .in-view is
   never removed after the reveal, and `translateY(0)` is a transform, so every
   revealed section on the site was a containing block for `position: fixed`
   descendants — permanently. Measured on production at 390x844, /cart scrolled
   to the bottom: the sticky Checkout bar declares `position: fixed; bottom: 0`
   and painted at top: -1161px, anchored to the bottom of section.cart-page
   instead of the viewport. Off-screen, on the busiest page of the funnel.

   So the resting state is now `none`, which paints and interpolates identically
   and fixes the whole class rather than one instance of it.

   THE JS EXEMPTION STAYS. Removing it would be a behaviour change dressed up as
   cleanup (ERR-158): those sections would start animating for the first time,
   which is a separate decision from this one and nobody has asked for it. §1
   above still pins it, and it is now defence in depth rather than the only
   defence. */
test('§2 the revealed state is `none`, so no section captures a fixed child', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    assert.match(css, /\.will-animate\s*\{[^}]*transform:\s*translateY\(30px\)/,
        'the RESTING state must still be a real transform — that is what animates');
    const idx = css.indexOf('.will-animate.in-view');
    assert.ok(idx !== -1, '.in-view rule must exist');
    const body = css.slice(css.indexOf('{', idx), css.indexOf('}', idx));
    assert.match(body, /transform:\s*none/,
        'the REVEALED state must be `none`, not `translateY(0)`: a non-none transform ' +
        'makes the section a containing block for every position:fixed descendant, ' +
        'which put /cart\'s sticky Checkout bar 1,161px off-screen (ERR-239)');
    assert.doesNotMatch(body, /transform:\s*translateY\(0\)/,
        'and translateY(0) must not come back — it is the identity matrix, so it looks ' +
        'like a no-op and is not one');
});

// ─── §3 The shipped markup this protects ───────────────────────────────────

test('§3 404.html really does put its search form inside a <section>', () => {
    const html = fs.readFileSync(HTML_404, 'utf8');
    const secStart = html.indexOf('<section class="error-page">');
    assert.ok(secStart !== -1, '404.html must still have <section class="error-page">');
    const secEnd = html.indexOf('</section>', secStart);
    const section = html.slice(secStart, secEnd);
    assert.match(section, /class="search-form search-form--large"/,
        'the in-page search box lives inside that section — this is the pairing ' +
        '(revealed section + fixed overlay) that the exemption exists for');
});

test('§3 the header search form is NOT inside a section (which is why it always worked)', () => {
    const html = fs.readFileSync(HTML_404, 'utf8');
    const navFormIdx = html.indexOf('id="site-search-form"');
    const firstSection = html.indexOf('<section');
    assert.ok(navFormIdx !== -1 && firstSection !== -1);
    assert.ok(navFormIdx < firstSection,
        'the header form must stay in <header>, ahead of any <section> — it is the ' +
        'control that proved the JS was right and only its coordinate space was wrong');
});
