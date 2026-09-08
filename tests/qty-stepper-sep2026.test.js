/**
 * ERR-218 — the quantity stepper beside every Add-to-Cart button.
 *
 * WHY THIS FILE IS AN ENROLMENT TEST, NOT A FEATURE TEST.
 *
 * ERR-150/160 is the precedent and it burned twice: the same feature vanished
 * silently on two separate surfaces, once at a whitelist parser and once at a
 * call site, because "every surface calls X" is a list nobody maintains. The
 * lesson recorded then was to put the enrolment in a test. So the assertions
 * below are mostly about WHO PARTICIPATES, not about what one function returns:
 * a sixth card renderer added next year fails here until it is wired up.
 *
 * The storefront has no shared card renderer — products.js and shop-page.js
 * hold two deliberately duplicated templates (products.js says so, and warns
 * the divergence "always bites on the surface that ships the feature second"),
 * plus ribbons-page.js, favourites.js, cart.js's cross-sell modal and
 * business-page.js's reorder tiles. Six places, one component.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const JS = (...p) => path.join(ROOT, 'inkcartridges', 'js', ...p);
const CSS = (...p) => path.join(ROOT, 'inkcartridges', 'css', ...p);
const read = (p) => fs.readFileSync(p, 'utf8');

const { QtyStepper } = require(JS('utils.js'));

const UTILS = read(JS('utils.js'));
const PRODUCTS = read(JS('products.js'));
const SHOP = read(JS('shop-page.js'));
const RIBBONS = read(JS('ribbons-page.js'));
const FAVOURITES = read(JS('favourites.js'));
const CART = read(JS('cart.js'));
const SEARCH = read(JS('search.js'));
const BUSINESS = read(JS('business.js'));
const BUSINESS_PAGE = read(JS('business-page.js'));
const COMPONENTS = read(CSS('components.css'));
const SEARCH_CSS = read(CSS('search.css'));

// ─────────────────────────────────────────────────────────────────────────────
// §1 — The component is reachable. Not by a guard that is always false.
// ─────────────────────────────────────────────────────────────────────────────

test('QtyStepper is published on window, not left a bare const', () => {
    // ERR-167/156: security.js and config.js are bare consts with no window
    // assignment, so every `window.Security?.x ? … : fallback` guard in the tree
    // was an OFF SWITCH and the fallback was the only branch that ever ran.
    assert.match(UTILS, /if \(typeof window !== 'undefined'\) window\.QtyStepper = QtyStepper;/,
        'utils.js must publish QtyStepper on window');
    assert.match(UTILS, /module\.exports\s*=\s*\{[\s\S]*?\bQtyStepper\b[\s\S]*?\};/,
        'QtyStepper must be in module.exports so this test runs the real one');
});

test('no call site guards on window.QtyStepper — the bare name is the contract', () => {
    // QtyStepper is a top-level const reachable by bare name exactly as
    // ProductSort and Security are. A `window.QtyStepper ? … : fallback` guard
    // would be the ERR-167 bug all over again.
    for (const [name, src] of Object.entries({
        'products.js': PRODUCTS, 'shop-page.js': SHOP, 'ribbons-page.js': RIBBONS,
        'favourites.js': FAVOURITES, 'cart.js': CART, 'search.js': SEARCH,
    })) {
        assert.doesNotMatch(src, /window\.QtyStepper\s*\?[^?]/,
            `${name} guards on window.QtyStepper. If the fallback is the only branch `
            + `that ever runs, the guard IS the bug (ERR-167).`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — One vocabulary for the label
// ─────────────────────────────────────────────────────────────────────────────

test('ctaLabel is the single source of the button wording', () => {
    assert.equal(QtyStepper.ctaLabel(1), 'Add');
    assert.equal(QtyStepper.ctaLabel(3), 'Add 3');
    assert.equal(QtyStepper.ctaLabel(10), 'Add 10');
    // Nonsense in, sane out — never "Add 0", never "Add NaN", never "Add -2".
    assert.equal(QtyStepper.ctaLabel(0), 'Add');
    assert.equal(QtyStepper.ctaLabel(-5), 'Add');
    assert.equal(QtyStepper.ctaLabel(NaN), 'Add');
    assert.equal(QtyStepper.ctaLabel('7'), 'Add 7');
});

test('the accessible name is NOT abbreviated with the visible label', () => {
    // The label is short because the card's button row is 140.3px wide. That is
    // a layout constraint and assistive tech does not share it.
    assert.equal(QtyStepper.ctaAriaLabel(3, 'LC3317BK Compatible'),
        'Add 3 × LC3317BK Compatible to cart');
    assert.equal(QtyStepper.ctaAriaLabel(1, 'LC3317BK Compatible'),
        'Add LC3317BK Compatible to cart');
    assert.equal(QtyStepper.ctaAriaLabel(1, ''), 'Add to cart');
    assert.equal(QtyStepper.ctaAriaLabel(4, ''), 'Add 4 to cart');
});

test('every card renderer sets an aria-label on its CTA', () => {
    for (const [name, src] of Object.entries({
        'products.js': PRODUCTS, 'shop-page.js': SHOP,
        'ribbons-page.js': RIBBONS, 'favourites.js': FAVOURITES,
    })) {
        assert.match(src, /ctaAriaLabel\(/,
            `${name} must build its CTA aria-label through QtyStepper.ctaAriaLabel — `
            + `the visible label is abbreviated and the accessible name must not be`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — The ceiling is the cart's number, not a second one
// ─────────────────────────────────────────────────────────────────────────────

test('the ceiling is read from Cart.MAX_QUANTITY, never restated', () => {
    assert.match(UTILS, /Cart\.MAX_QUANTITY/,
        'QtyStepper.ceiling must read Cart.MAX_QUANTITY');
    const cartMax = CART.match(/MAX_QUANTITY:\s*(\d+)/);
    assert.ok(cartMax, 'cart.js must declare MAX_QUANTITY');
    // Without Cart loaded the fallback applies; it must agree with the cart, or
    // a card could offer a quantity the cart line then refuses.
    assert.equal(QtyStepper.ceiling(), Number(cartMax[1]),
        'the stepper fallback ceiling and Cart.MAX_QUANTITY must be the same number');
});

test('clamp never yields a quantity the cart would refuse', () => {
    const max = QtyStepper.ceiling();
    assert.equal(QtyStepper.clamp(0), 1);
    assert.equal(QtyStepper.clamp(-99), 1);
    assert.equal(QtyStepper.clamp(max + 500), max);
    assert.equal(QtyStepper.clamp(3.9), 3);
    assert.equal(QtyStepper.clamp('abc'), 1);
    assert.equal(QtyStepper.clamp(undefined), 1);
    assert.equal(QtyStepper.clamp(null), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — ENROLMENT. Every surface that can add to the cart participates.
// ─────────────────────────────────────────────────────────────────────────────

const CARD_SURFACES = {
    'products.js (dropdown, PDP related, featured, filters grid, /shop rail)': PRODUCTS,
    'shop-page.js (/shop, /search, brand pages)': SHOP,
    'ribbons-page.js (/ribbons)': RIBBONS,
    'favourites.js (the reorder list)': FAVOURITES,
    'cart.js (cross-sell modal)': CART,
    'business-page.js (reorder tiles)': BUSINESS_PAGE,
};

test('ENROLMENT — every add-to-cart surface emits the stepper', () => {
    for (const [name, src] of Object.entries(CARD_SURFACES)) {
        assert.match(src, /QtyStepper\.markup\(/,
            `${name} does not emit QtyStepper.markup(). Every surface a shopper can `
            + `add from gets the stepper — "every surface calls X" is a list nobody `
            + `maintains, which is why it lives in this test (ERR-150/160).`);
        assert.match(src, /product-card__buy/,
            `${name} must wrap its CTA in .product-card__buy so the stepper and the `
            + `button share one row`);
    }
});

test('ENROLMENT — every add path passes a real quantity', () => {
    for (const [name, src] of Object.entries(CARD_SURFACES)) {
        assert.match(src, /QtyStepper\.read\(/,
            `${name} does not read the stepper. Cart.addItem and API.addToCart have `
            + `always taken a quantity; hard-coding 1 is how this feature disappears.`);
    }
});

test('ENROLMENT — no card add path hard-codes quantity: 1', () => {
    // ONE named exemption, stated rather than skipped silently. shop-page.js's
    // colour-pack "Add all" loops the pack's items and adds ONE OF EACH — the
    // quantity there is per-item and is genuinely 1, not an un-migrated card.
    const EXEMPT = {
        // Colour-pack "Add all" loops the pack's items and adds ONE OF EACH.
        // The quantity is per-item and genuinely 1.
        'shop-page.js': 1,
        // Cart._swapLineForPack: an internal cart operation, not a card CTA —
        // it replaces one single-cartridge line with one value pack. Whether a
        // shopper holding three singles should get three packs is a real
        // question, but it is a PRE-EXISTING one and not this change's to answer
        // silently. Logged in errors.md under ERR-218 as a follow-up.
        'cart.js': 1,
    };
    for (const [name, src] of Object.entries({
        'products.js': PRODUCTS, 'shop-page.js': SHOP, 'ribbons-page.js': RIBBONS,
        'favourites.js': FAVOURITES, 'cart.js': CART, 'business-page.js': BUSINESS_PAGE,
    })) {
        const hits = (src.match(/quantity:\s*1\b/g) || []).length;
        const allowed = EXEMPT[name] || 0;
        assert.ok(hits <= allowed,
            `${name} has ${hits} hard-coded \`quantity: 1\` (allowed: ${allowed}). `
            + `If this is a new legitimate single-unit add, name it in EXEMPT above `
            + `with the reason — a skip is not a pass.`);
    }
});

test('ENROLMENT — every grid binds one delegated stepper listener', () => {
    for (const [name, src] of Object.entries({
        'products.js': PRODUCTS, 'shop-page.js': SHOP, 'ribbons-page.js': RIBBONS,
        'favourites.js': FAVOURITES, 'cart.js': CART, 'business-page.js': BUSINESS_PAGE,
    })) {
        assert.match(src, /QtyStepper\.bind\(/,
            `${name} never calls QtyStepper.bind — its + and − would do nothing`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — The dead button this change also fixed
// ─────────────────────────────────────────────────────────────────────────────

test('Cart.add does not exist and nothing calls it', () => {
    assert.doesNotMatch(CART, /^\s{4}add\s*\(/m,
        'the Cart module has addItem, not add — if that ever changes, revisit ERR-218');
    // Comments may discuss it; code may not call it.
    const code = PRODUCTS.split('\n')
        .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');
    assert.doesNotMatch(code, /Cart\.add\s*\(/,
        'products.js calls Cart.add(), which does not exist. Behind a truthiness '
        + 'guard that made the /shop by-printer rail a silently dead Add to Cart.');
});

test('attachCardListeners reaches a live add path', () => {
    const m = PRODUCTS.match(/attachCardListeners\(container\)\s*\{[\s\S]*?\n    \},/);
    assert.ok(m, 'attachCardListeners must still exist — shop-page.js binds it by name');
    assert.match(m[0], /bindAddToCartEvents\(container\)/,
        'attachCardListeners must forward to the one real add path');
});

test('the add binder cannot double-bind and double the quantity', () => {
    assert.match(PRODUCTS, /atcBound/,
        'bindAddToCartEvents must guard against binding the same button twice — '
        + 'attachCardListeners now forwards to it, and two listeners means two adds');
});

test('business-page reorder no longer passes a SKU string to addItem', () => {
    assert.doesNotMatch(BUSINESS_PAGE, /Cart\.addItem\(btn\.getAttribute\(/,
        'Cart.addItem takes a product OBJECT and has no second parameter; passing a '
        + 'bare SKU string POSTed product_id: undefined');
    assert.match(BUSINESS_PAGE, /API\.getProduct\(/,
        '/api/business/top-products carries no product id, so the SKU must be '
        + 'resolved against the catalogue before adding');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Collision with the cart page's own stepper
// ─────────────────────────────────────────────────────────────────────────────

test('the card stepper does not wear the cart line stepper\'s class names', () => {
    for (const [name, src] of Object.entries(CARD_SURFACES)) {
        if (name.startsWith('cart.js')) continue; // cart.js legitimately renders both
        assert.doesNotMatch(src, /quantity-selector__btn--(increase|decrease)/,
            `${name} emits a cart-line stepper class. Cart.bindEvents delegates on `
            + `those at document level and reads a cart line's data-item-key, so a card `
            + `wearing them drives _debouncedQuantityUpdate(undefined, n).`);
    }
    assert.match(UTILS, /product-card__qty-btn/,
        'the card stepper uses its own class names');
});

test('the cart-line quantity delegate is scoped to .cart-item', () => {
    assert.match(CART, /closest\('\.cart-item \.quantity-selector__btn--increase'\)/,
        'the increase delegate must be scoped to a cart line');
    assert.match(CART, /closest\('\.cart-item \.quantity-selector__btn--decrease'\)/,
        'the decrease delegate must be scoped to a cart line');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — The search dropdown's specific traps
// ─────────────────────────────────────────────────────────────────────────────

test('both stepper buttons carry type="button"', () => {
    // The dropdown is mounted INSIDE the search <form>. A bare <button> defaults
    // to type="submit" and HTML5's default-button rule then hijacks Enter in the
    // search input.
    const markup = QtyStepper.markup({ value: 1 });
    const buttons = markup.match(/<button[^>]*>/g) || [];
    assert.equal(buttons.length, 2, 'the stepper has exactly two buttons');
    for (const b of buttons) {
        assert.match(b, /type="button"/, `stepper button missing type="button": ${b}`);
    }
});

test('the stepper is in the dropdown mousedown blur-guard', () => {
    const guard = SEARCH.match(/state\.list\.addEventListener\('mousedown'[\s\S]*?\}\);/);
    assert.ok(guard, 'the mousedown blur-guard must exist');
    assert.match(guard[0], /product-card__qty-btn/,
        'without the stepper in this selector the FIRST click on − blurs the search '
        + 'input, the panel closes, and the click lands on nothing');
    assert.match(guard[0], /product-card__qty-input/,
        'the quantity input needs the same protection as the buttons');
});

test('dropdown stepper controls are removed from the tab order', () => {
    assert.match(SEARCH, /product-card__qty-btn, \.product-card__qty-input[\s\S]{0,120}tabindex.*-1/,
        'the panel\'s keyboard model is aria-activedescendant on the search input and '
        + 'Tab closes the panel, so a focusable control inside a row sits outside it');
    // …but only in the dropdown. Everywhere else the stepper tabs normally.
    assert.doesNotMatch(UTILS, /tabindex="-1"[\s\S]{0,40}always/,
        'tabindex="-1" must be opt-in via markup({ focusable: false }), not global');
});

test('the disabled state ships in the markup, not on first interaction', () => {
    // A freshly painted stepper sits at 1, where − does nothing. An
    // enabled-looking control that does nothing is the small version of the
    // dead button this change exists to remove.
    const at1 = QtyStepper.markup({ value: 1 });
    assert.match(at1, /data-step="down"[^>]*disabled/, '− must be disabled at 1');
    assert.doesNotMatch(at1, /data-step="up"[^>]*disabled/, '+ must be live at 1');

    const atMax = QtyStepper.markup({ value: QtyStepper.ceiling() });
    assert.match(atMax, /data-step="up"[^>]*disabled/, '+ must be disabled at the ceiling');
    assert.doesNotMatch(atMax, /data-step="down"[^>]*disabled/, '− must be live at the ceiling');

    const mid = QtyStepper.markup({ value: 5 });
    assert.doesNotMatch(mid, /disabled/, 'neither control is disabled in the middle');
});

test('markup({ focusable: false }) is what makes it pointer-only', () => {
    const open = QtyStepper.markup({ value: 1 });
    const closed = QtyStepper.markup({ value: 1, focusable: false });
    assert.doesNotMatch(open, /tabindex/, 'the default stepper is keyboard reachable');
    assert.equal((closed.match(/tabindex="-1"/g) || []).length, 3,
        'focusable:false must take all three controls out of the tab order');
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — Bulk pricing reacts to the quantity, and stays honest without a ladder
// ─────────────────────────────────────────────────────────────────────────────

test('Business.syncCardQuantity exists and is synchronous', () => {
    assert.match(BUSINESS, /\n    syncCardQuantity\(card, qty\) \{/,
        'syncCardQuantity must be sync — it runs on every + tap');
    assert.doesNotMatch(BUSINESS, /async syncCardQuantity/,
        'an async hook here would put a promise in the click path of a + button');
});

test('an undecorated card gets no invented bulk line', () => {
    // Absence is not zero (ERR-063/068/150). A card with no ladder is one we
    // have no bulk data for; inventing "at 3 you pay $X each" would state as
    // fact something the backend never sent.
    const fn = BUSINESS.match(/syncCardQuantity\(card, qty\) \{[\s\S]*?\n    \},/);
    assert.ok(fn, 'syncCardQuantity must exist');
    assert.match(fn[0], /biz-price'\);\s*\n\s*if \(!host\) return false;/,
        'syncCardQuantity must bail on a card with no rendered bulk line');
});

test('syncCardQuantity selects a backend rung — it does not compute a price', () => {
    const fn = BUSINESS.match(/syncCardQuantity\(card, qty\) \{[\s\S]*?\n    \},/)[0];
    assert.match(fn, /this\.offerAtQuantity\(ladder, q\)/,
        'the rung must come from offerAtQuantity, which picks a break the backend sent');
    assert.doesNotMatch(fn, /[*/]\s*(?:quantity|qty)\b/,
        'no arithmetic on the price here — the front end never computes prices');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — Layout: the measurement that decided the label
// ─────────────────────────────────────────────────────────────────────────────

test('the buy row keeps the CTA flexible inside a narrow card', () => {
    assert.match(COMPONENTS, /\.product-card__buy \{[\s\S]*?display: flex;/,
        '.product-card__buy must be a flex row');
    assert.match(COMPONENTS, /\.product-card__buy \.product-card__cart-btn[\s\S]*?flex: 1 1 auto;/,
        'the CTA must flex so the stepper keeps its width');
    // The @container rule that stacks price above button at ≤200px sets
    // width:100% on the CTA. Inside a buy row that would push the stepper out.
    assert.match(COMPONENTS, /\.product-card__buy \.product-card__cart-btn,[\s\S]*?width: auto;/,
        'the container query must not force width:100% on a CTA inside a buy row');
});

test('the phone dropdown shows the add button again, deliberately', () => {
    const block = SEARCH_CSS.match(/@media \(max-width: 480px\) \{[\s\S]*?\n\}/);
    assert.ok(block, 'the ≤480px dropdown block must exist');
    assert.doesNotMatch(block[0], /\.smart-ac__grid \.product-card__add-btn \{\s*display: none;/,
        'the ≤480px rule hiding the dropdown CTA was reversed by ERR-218 — the row '
        + 'has ~300px of text column, so [− 1 +] [Add to Cart] fits with the FULL label');
    assert.match(block[0], /\.smart-ac__grid \.product-card__add-btn \{[\s\S]*?min-height: 44px/,
        'the restored CTA must still be a 44px touch target');
    assert.match(block[0], /ERR-218/,
        'reversing a deliberate rule is a behaviour change — the comment must say so');
});

test('touch sizing reaches 44px on the CONTROLS, not just their wrapper', () => {
    // A 44px wrapper with a 1px border each side yields 42px children, and 42px
    // is not 44px. Measured in a browser at 375px before this was corrected.
    assert.match(COMPONENTS,
        /@media \(pointer: coarse\) \{[\s\S]*?\.product-card__qty-btn \{ width: 44px; min-height: 44px; \}/,
        'WCAG 2.5.5 — the stepper BUTTONS need 44x44 where the pointer is coarse');
});

test('the buy row stacks on touch, because one row cannot hold 44px targets', () => {
    // Arithmetic, not taste. At a 375px viewport cards are two-across at
    // 159.5px, giving a 137.5px inner row. Two 44px buttons plus a 26px input
    // plus borders is 116px, leaving the CTA 17.5px — a text budget of 5.5px
    // against the 37px "Add 5" needs. So on touch it stacks.
    // Capture from the coarse-pointer media query to the end of its nested
    // container query — a non-greedy match to the first "\n}" stops inside the
    // nested rule and silently proves nothing.
    const coarse = COMPONENTS.match(
        /@media \(pointer: coarse\) \{[\s\S]*?@container pcard \(max-width: 260px\) \{[\s\S]*?\n    \}\n\}/);
    assert.ok(coarse, 'the coarse-pointer block with its nested container query must exist');
    assert.match(coarse[0], /\.product-card__buy \{\s*\n\s*flex-direction: column;/,
        'the buy row must stack inside that container query');
    assert.match(coarse[0], /width: 100%;/,
        'both controls go full width once stacked');
    // The measurement that forced the stack lives in the comment ABOVE the
    // block. Recording it is the point (ERR-189/196).
    assert.match(COMPONENTS, /137\.5px/,
        'the measured inner row width must be recorded — a constant reserving space '
        + 'for text is a measurement someone declined to take');
    assert.match(COMPONENTS, /159\.5px/,
        'the measured mobile card width must be recorded alongside it');
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — POSITIVE CONTROL
//
// A test that cannot fail proves nothing (ERR-181/183/184/185/186: a test can
// pass for the wrong reason — keep a positive control). Each predicate below is
// run against the shape of the code BEFORE this change and must reject it.
// ─────────────────────────────────────────────────────────────────────────────

test('POSITIVE CONTROL — the pre-fix shapes fail the predicates above', () => {
    const preFixAdd = `
        attachCardListeners(container) {
            if (!container) return;
            container.querySelectorAll('.product-card__add-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    if (typeof Cart !== 'undefined' && Cart.add) {
                        Cart.add(btn.dataset.productId, 1);
                    }
                });
            });
        },`;
    assert.match(preFixAdd, /Cart\.add\s*\(/,
        'control: the pre-fix source DID call the non-existent Cart.add');
    assert.doesNotMatch(preFixAdd, /bindAddToCartEvents\(container\)/,
        'control: the pre-fix attachCardListeners did NOT forward');

    const preFixCta = `<button type="button" class="product-card__add-btn btn btn--primary">Add to Cart</button>`;
    assert.doesNotMatch(preFixCta, /product-card__buy/,
        'control: the pre-fix CTA had no buy row');

    const preFixQty = `quantity: 1,`;
    assert.match(preFixQty, /quantity:\s*1\b/,
        'control: the pre-fix add paths hard-coded a single unit');

    const preFixCss = `@media (max-width: 480px) { .smart-ac__grid .product-card__add-btn { display: none; } }`;
    assert.match(preFixCss, /\.smart-ac__grid \.product-card__add-btn \{ display: none;/,
        'control: the pre-fix mobile rule DID hide the dropdown CTA');

    const preFixGuard = `if (e.target.closest('.product-card, .smart-ac__chip, .product-card__add-btn, .product-card__link'))`;
    assert.doesNotMatch(preFixGuard, /product-card__qty/,
        'control: the pre-fix blur guard did NOT cover the stepper');
});


// ─────────────────────────────────────────────────────────────────────────────
// §8 — ERR-228: the number box is inside the card's <a>, and only
// preventDefault() stops an anchor
//
// ERR-218 verified "+ does not navigate" and stopped there. The number box
// between the two buttons was never cancelled, so clicking it navigated to the
// PDP — measured on the live dropdown AND on the /search grid, which has no
// mousedown blur-guard at all (that is what proves the guard innocent).
//
// These are source predicates. A source grep is not a measurement (ERR-224),
// so the behaviour itself is pinned by `npm run probe:qty-typing`, which clicks
// the real box in a real browser and reads the URL back.
// ─────────────────────────────────────────────────────────────────────────────

const CLICK_HANDLER = (() => {
    const m = UTILS.match(/scope\.addEventListener\('click', function \(e\) \{[\s\S]*?\n {8}\}\);/);
    assert.ok(m, 'QtyStepper.bind must still register a delegated click listener');
    return m[0];
})();

test('the click guard covers the whole stepper zone, not just the two buttons', () => {
    assert.match(CLICK_HANDLER, /closest\('\[data-qty-stepper\]'\)/,
        'the entry guard must be the stepper ZONE — a guard keyed on '
        + '.product-card__qty-btn lets a click on the number box through to the '
        + 'wrapping <a class="product-card__link">, which then navigates (ERR-228)');

    // The zone guard has to come FIRST, and preventDefault has to run before the
    // handler branches on which part was hit — an early `return` for the input
    // is exactly the bug.
    const zoneAt = CLICK_HANDLER.indexOf('[data-qty-stepper]');
    const btnAt = CLICK_HANDLER.indexOf('.product-card__qty-btn');
    const pdAt = CLICK_HANDLER.indexOf('e.preventDefault()');
    assert.ok(zoneAt >= 0 && pdAt > zoneAt, 'preventDefault must follow the zone guard');
    assert.ok(btnAt > pdAt,
        'the button branch must come AFTER preventDefault, or the box goes uncancelled');
});

test('the click guard says WHY preventDefault, not stopPropagation, is the one that matters', () => {
    // The next reader will be tempted to "simplify" this back to a button-only
    // guard. The reason has to survive in the file, not only in errors.md.
    assert.match(UTILS, /default action/i,
        'QtyStepper must record that navigation is the anchor\'s DEFAULT ACTION');
    assert.match(UTILS, /stopPropagation\(\) does not cancel a\s*\n?\s*\*?\s*default action/i,
        'and that stopPropagation() does not cancel one — that is the whole bug');
});

test('a click on the box places the caret, because the dropdown suppresses the native one', () => {
    // search.js preventDefaults mousedown to hold the panel open, which also
    // suppresses focus. Cancelling navigation without focusing would leave a box
    // that can be clicked and never typed into — a quieter version of the bug.
    assert.match(CLICK_HANDLER, /input\.focus\(\)/,
        'the non-button branch must focus the quantity input');
    assert.match(CLICK_HANDLER, /document\.activeElement !== input/,
        'focus only when it is not already there — every other grid focuses '
        + 'natively at mousedown and re-selecting would destroy the caret');
    assert.match(CLICK_HANDLER, /try \{ input\.select\(\); \} catch/,
        'select() is legal on type="number" but must stay guarded');
});

test('ENROLMENT — the anchor guard lives in QtyStepper alone', () => {
    // Every renderer that nests the stepper INSIDE the card anchor relies on
    // bind(). None may grow its own copy of the guard: two guards on one click
    // is how ERR-218\'s double-add nearly shipped.
    const NESTED_IN_ANCHOR = {
        'products.js': PRODUCTS,      // <a class="product-card__link"> wraps the buy row
        'shop-page.js': SHOP,         // same shape, second template
        'ribbons-page.js': RIBBONS,   // same shape
        'cart.js': CART,              // <a class="crosssell-modal__card">
    };
    // Named exemptions, not a silent skip (a skip is not a pass):
    //   favourites.js     — the buy row is OUTSIDE .favourite-item__link
    //   business-page.js  — reorder tiles have no wrapping anchor at all
    for (const [name, src] of Object.entries(NESTED_IN_ANCHOR)) {
        assert.match(src, /QtyStepper\.bind\(/,
            `${name} nests the stepper inside an anchor and must call QtyStepper.bind`);
        assert.doesNotMatch(src, /addEventListener\('click'[^)]{0,200}product-card__qty/,
            `${name} must not re-implement the stepper click guard — one guard, one place`);
    }
    for (const [name, src] of Object.entries({ 'favourites.js': FAVOURITES, 'business-page.js': BUSINESS_PAGE })) {
        assert.match(src, /QtyStepper\.bind\(/,
            `${name} is exempt from the anchor guard, not from binding the stepper`);
    }
});

test('Escape has an answer while focus is in the dropdown quantity box', () => {
    // onKeyDown is bound to the search input and never sees these keystrokes.
    const handler = SEARCH.match(/state\.list\.addEventListener\('keydown'[\s\S]*?\n {12}\}\);/);
    assert.ok(handler, 'the dropdown list needs its own keydown listener (ERR-228)');
    assert.match(handler[0], /Escape/, 'it must handle Escape');
    assert.match(handler[0], /product-card__qty-input/, 'scoped to the quantity box');
    assert.match(handler[0], /state\.input\.focus\(\)/,
        'focus returns to the search input — the shopper was mid-quantity, not mid-exit');
});

test('POSITIVE CONTROL — the pre-fix click handler fails the §8 predicates', () => {
    const preFixClick = `
        scope.addEventListener('click', function (e) {
            const btn = e.target.closest && e.target.closest('.product-card__qty-btn');
            if (!btn || !scope.contains(btn)) return;
            e.preventDefault();
            e.stopPropagation();
        });`;
    assert.doesNotMatch(preFixClick, /\[data-qty-stepper\]/,
        'control: the pre-fix guard was keyed on the buttons only');
    assert.doesNotMatch(preFixClick, /input\.focus\(\)/,
        'control: the pre-fix handler never focused the box');
    assert.match(preFixClick, /if \(!btn \|\| !scope\.contains\(btn\)\) return;\n\s+e\.preventDefault/,
        'control: a click on the number box returned before preventDefault ever ran');
});
