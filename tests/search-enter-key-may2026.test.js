/**
 * Search bar Enter-key navigation invariant — May 2026
 * =====================================================
 *
 * Pins the fix described in the backend repo's
 * `docs/storefront/search-enter-key-may2026.md` postmortem.
 *
 * Bug: Pressing Enter on the homepage search input did nothing once the
 * autocomplete dropdown had opened. The search-form's bottom "View all
 * results" anchor still navigated. Per HTML5's implicit-form-submission
 * rule, a bare `<button>` defaults to `type="submit"`. The dropdown is
 * mounted INSIDE the search `<form>` (state.form.appendChild(wrap) in
 * search.js — required so the dropdown anchors to the form's bounding
 * box), so every "Add to Cart" card-button became an implicit-submit
 * candidate. attachCardListeners()'s preventDefault on click then ate
 * the form-submit attempt, leaving Enter visually dead.
 *
 * One-line fix: emit `<button type="button" …>` instead of bare
 * `<button …>` in renderCard()'s in-stock branch.
 *
 * These tests fail if:
 *   - the in-stock add-to-cart button regresses to a bare <button>
 *   - any sibling list/card surface (shop-page, ribbons-page) emits a
 *     bare cart/contact button (defensive — same risk class)
 *   - the search dropdown stops mounting inside the form (would silently
 *     remove the *need* for type="button" without removing the test —
 *     so this test also pins the DOM-shape invariant that motivates it)
 *   - main.js stops gating short queries / threading Enter to /search?q=
 *
 * Run with: node --test tests/search-enter-key-may2026.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS   = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const HTML = (rel) => path.join(ROOT, 'inkcartridges', 'html', rel);
const READ = (p)   => fs.readFileSync(p, 'utf8');

function stripComments(src) {
    // Strip line comments FIRST so URL fragments like `/api/search/*` inside
    // `// …` don't trick the block-comment regex into eating the rest of the
    // file. Then strip block comments. This is naive (it doesn't honour
    // string literals) but the JS we scan never contains `/*` or `*/` inside
    // a string at module scope.
    return src
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

const PRODUCTS_SRC = READ(JS('products.js'));
const SHOP_SRC     = READ(JS('shop-page.js'));
const RIBBONS_SRC  = READ(JS('ribbons-page.js'));
const SEARCH_SRC   = READ(JS('search.js'));
const MAIN_SRC     = READ(JS('main.js'));

const PRODUCTS_CODE = stripComments(PRODUCTS_SRC);
const SHOP_CODE     = stripComments(SHOP_SRC);
const RIBBONS_CODE  = stripComments(RIBBONS_SRC);
const SEARCH_CODE   = stripComments(SEARCH_SRC);
const MAIN_CODE     = stripComments(MAIN_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — products.js: in-stock Add-to-Cart MUST declare type="button"
// ─────────────────────────────────────────────────────────────────────────────

test('products.js in-stock add-to-cart renders type="button"', () => {
    // The in-stock <button …> in renderCard is the only <button> in the file
    // that carries data-product-source — anchor on that and walk back to the
    // opening tag, then assert it carries type="button".
    const sliceIdx = PRODUCTS_CODE.indexOf('data-product-source=');
    assert.ok(sliceIdx !== -1, 'data-product-source not found — did renderCard get refactored?');

    // Walk backwards from sliceIdx to find the most recent `<button`.
    const openTagIdx = PRODUCTS_CODE.lastIndexOf('<button', sliceIdx);
    assert.ok(openTagIdx !== -1, 'no opening <button found before data-product-source');

    const openTag = PRODUCTS_CODE.slice(openTagIdx, sliceIdx + 'data-product-source='.length);
    assert.match(
        openTag,
        /<button\s+type="button"\s+class="product-card__add-btn/,
        '`<button type="button" class="product-card__add-btn …>` is the canonical opening tag\n' +
        'for the in-stock CTA in renderCard. Without type="button" the dropdown card\n' +
        'becomes an implicit-submit candidate inside the search <form>.\n\n' +
        `Found instead: ${openTag.slice(0, 200)}…`,
    );
});

test('products.js OOS contact button keeps type="button"', () => {
    assert.match(
        PRODUCTS_CODE,
        /<button\s+type="button"\s*\n?\s*class="product-card__add-btn btn btn--primary product-card__contact-btn"/,
        'OOS contact CTA must remain type="button" — same form-submission concern.',
    );
});

test('products.js renderCard emits no other bare cart/contact <button>', () => {
    // Anything inside renderCard that looks like a CTA — add-btn or
    // contact-btn — must be type="button". Scan the entire renderCard
    // template for <button class="…(add-btn|contact-btn)…> with no
    // preceding type="button".
    const bareBtnRe = /<button(?![^>]*\btype=)[^>]*\bclass="[^"]*(?:product-card__add-btn|product-card__contact-btn|product-card__cart-btn)[^"]*"/g;
    const matches = PRODUCTS_CODE.match(bareBtnRe) || [];
    assert.equal(
        matches.length, 0,
        `Found ${matches.length} bare <button …add-btn/contact-btn/cart-btn> tag(s) in products.js — ` +
        `they need an explicit type="button":\n  ${matches.join('\n  ')}`,
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Sibling card surfaces (shop, ribbons): defensive type="button"
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js in-stock cart button renders type="button"', () => {
    const bareBtnRe = /<button(?![^>]*\btype=)[^>]*\bclass="[^"]*product-card__cart-btn[^"]*"/g;
    const matches = SHOP_CODE.match(bareBtnRe) || [];
    assert.equal(
        matches.length, 0,
        `shop-page.js has ${matches.length} bare <button …product-card__cart-btn> — ` +
        `add type="button" so future surfaces (e.g. modal/search context) can't ` +
        `accidentally treat them as implicit submit:\n  ${matches.join('\n  ')}`,
    );

    assert.match(
        SHOP_CODE,
        /<button\s+type="button"\s+class="btn btn--primary btn--sm product-card__cart-btn"/,
        'expected canonical `<button type="button" class="btn btn--primary btn--sm product-card__cart-btn"` opening tag in shop-page.js',
    );
});

test('ribbons-page.js in-stock cart button renders type="button"', () => {
    const bareBtnRe = /<button(?![^>]*\btype=)[^>]*\bclass="[^"]*product-card__cart-btn[^"]*"/g;
    const matches = RIBBONS_CODE.match(bareBtnRe) || [];
    assert.equal(
        matches.length, 0,
        `ribbons-page.js has ${matches.length} bare <button …product-card__cart-btn> — ` +
        `add type="button":\n  ${matches.join('\n  ')}`,
    );

    assert.match(
        RIBBONS_CODE,
        /<button\s+type="button"\s+class="btn btn--primary btn--sm product-card__cart-btn"/,
        'expected canonical `<button type="button" class="btn btn--primary btn--sm product-card__cart-btn"` in ribbons-page.js',
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — DOM-shape invariant the fix relies on
// ─────────────────────────────────────────────────────────────────────────────
//
// search.js mounts its dropdown INSIDE the search form. That's load-bearing
// for layout (it positions relative to the form), but it's also what makes
// type="button" mandatory on every card CTA. If a future refactor portals the
// dropdown outside the form, the type="button" hardening becomes belt-and-
// suspenders — which is fine — but we still want the test suite to flag the
// shape change so this whole file gets re-read.

test('search.js mounts the autocomplete dropdown inside the search <form>', () => {
    assert.match(
        SEARCH_CODE,
        /state\.form\.appendChild\s*\(\s*wrap\s*\)/,
        'search.js no longer mounts the dropdown into state.form — re-read ' +
        'search-enter-key-may2026.md, the implicit-submit risk vector may have shifted.',
    );
});

test('search.js renders cards via Products.renderCard (so the products.js fix flows through)', () => {
    assert.match(
        SEARCH_CODE,
        /Products\.renderCard\s*\(/,
        'SmartSearch must keep delegating to Products.renderCard — otherwise we ' +
        'lose the type="button" guarantee for dropdown cards.',
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — main.js: Enter handler still threads /search?q=… and gates < MIN_LEN
// ─────────────────────────────────────────────────────────────────────────────

test('main.js submit handler routes to /search?q=… (canonical destination)', () => {
    assert.match(
        MAIN_CODE,
        /window\.location\.href\s*=\s*`\/search\?q=\$\{encodeURIComponent\(query\)\}`/,
        'Enter / form-submit must navigate to /search?q=<encoded> per ' +
        'docs/storefront/search-dropdown-routing.md three-handler invariant.',
    );
});

test('main.js gates form submit on MIN_LEN = 2 (matches backend Joi)', () => {
    assert.match(MAIN_CODE, /MIN_LEN\s*=\s*2/, 'MIN_LEN constant should equal 2');
    assert.match(
        MAIN_CODE,
        /if\s*\(\s*query\.length\s*<\s*MIN_LEN\s*\)\s*return/,
        'submit handler must short-circuit on too-short queries to avoid 400 from /api/search/*',
    );
});

test('main.js mirrors MIN_LEN by toggling submit button disabled state', () => {
    assert.match(
        MAIN_CODE,
        /submitBtn\.disabled\s*=\s*tooShort/,
        'syncSubmitState should disable the search submit button while q.length < MIN_LEN',
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Site search form HTML keeps the explicit submit button
// ─────────────────────────────────────────────────────────────────────────────
//
// The implicit-submission "default button" is the FIRST submit button in tree
// order. As long as the real .search-form__button stays declared as
// type="submit" and lives ahead of the dropdown DOM, even a fully empty
// dropdown cannot promote a card-button into the default-submit role.

test('every site-header search form keeps an explicit type="submit" button before the dropdown', () => {
    // The site-header is duplicated across HTML pages (navbar parity rule —
    // see project_navbar_parity_may2026). Walk every .html under
    // inkcartridges/html and inkcartridges/account, find each #site-search-form,
    // and assert it contains a type="submit" search-form__button.
    const roots = [
        path.join(ROOT, 'inkcartridges'),
        path.join(ROOT, 'inkcartridges', 'html'),
        path.join(ROOT, 'inkcartridges', 'account'),
        path.join(ROOT, 'inkcartridges', 'product'),
        path.join(ROOT, 'inkcartridges', 'business'),
    ];

    function walk(dir) {
        if (!fs.existsSync(dir)) return [];
        const out = [];
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) out.push(...walk(full));
            else if (ent.isFile() && full.endsWith('.html')) out.push(full);
        }
        return out;
    }

    const seen = new Set();
    const files = roots.flatMap(walk).filter(f => {
        if (seen.has(f)) return false;
        seen.add(f);
        return true;
    });

    let formsChecked = 0;
    const offenders = [];

    for (const file of files) {
        const html = READ(file);
        // Match every <form …id="site-search-form" …>…</form> in the file.
        const formRe = /<form[^>]*\bid="site-search-form"[^>]*>[\s\S]*?<\/form>/g;
        let m;
        while ((m = formRe.exec(html)) !== null) {
            formsChecked++;
            const submitOk = /<button[^>]*\btype="submit"[^>]*\bclass="[^"]*\bsearch-form__button/.test(m[0]);
            if (!submitOk) {
                offenders.push(path.relative(ROOT, file));
            }
        }
    }

    assert.ok(formsChecked > 0, 'expected at least one #site-search-form across the HTML tree — ' +
        'navbar parity should put one on every customer page.');
    assert.deepEqual(
        offenders, [],
        `Some #site-search-form blocks are missing the explicit ` +
        `<button type="submit" class="search-form__button …">. The browser's ` +
        `implicit-submit "default button" is the FIRST submit button in tree order; ` +
        `losing it lets card buttons in the open dropdown win the role.\n` +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    );
});
