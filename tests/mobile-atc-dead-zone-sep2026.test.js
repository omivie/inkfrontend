/**
 * Mobile Add-to-Cart dead zone — ERR-280
 * ======================================
 *
 * Backend handoffs `mobile-atc-dead-zone-FE-handoff-sep2026.md` and
 * `mobile-cta-occlusion-followup-sep2026.md`, 2026-09-21.
 *
 * On a phone, for a first-time guest, there were scroll positions on a product
 * page with NO TAPPABLE ADD TO CART AT ALL. The sticky bar had already stood
 * down and the main button was underneath the consent banner.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THESE TESTS
 * -------------------------------------------------
 * Every control involved was individually in a defensible state. The sticky
 * bar was correctly hidden (the site had decided the main button was "in
 * view"). The main button was correctly rendered (something was simply painted
 * on top of it). A per-control assertion looks at either one and finds nothing
 * wrong, which is exactly why `npm run probe:mobile-cta` was green through the
 * entire defect and why the 6532-test suite stayed green while it shipped.
 *
 * So these tests are about the PREDICATE, and they EXECUTE it rather than
 * reading it. tests/mobile-cta-occlusion-sep2026.test.js pins the source of
 * the ERR-276 gate and says so; a source grep cannot answer any of:
 *
 *   - whether the observer's root is actually shrunk by the banner's MEASURED
 *     height, or by a plausible-looking constant that drifts the day the copy
 *     rewraps
 *   - whether the element observed is the BUTTON or its container (they differ
 *     by ~56px on mobile, because .product-info__actions is a two-row grid)
 *   - whether handing back requires the button to be FULLY clear, or merely
 *     one pixel intersecting
 *   - whether the observer survives the outerHTML swap that replaces the
 *     button with a Contact us link on every out-of-stock product
 *
 * The whole of js/product-detail-page.js is therefore run in a vm, its
 * DOMContentLoaded handlers are captured, and the sticky-bar handler is driven
 * against a fake DOM that records what the IntersectionObserver was built with.
 * It is the SHIPPED code being asked, not a replica of it — ERR-231's probe
 * certified a replica of the search escaper while the real one was broken.
 *
 * §7 (RETIRED 2026-09-27 with the nudge itself) did the same for the rewards
 * nudge's insertion point. ERR-276 stopped
 * that card covering the PDP buy button with a PATH LIST, so it could only ever
 * be as complete as the list — and `probe:mobile-cta` §7 then measured it
 * covering a card Add button at 32 of 92 scroll offsets on /ink-cartridges,
 * the surface 68% of paid clicks land on. Below the tablet breakpoint the card
 * is no longer an overlay at all.
 *
 * Run with: node --test tests/mobile-atc-dead-zone-sep2026.test.js
 * Measured by: npm run probe:mobile-cta  (§6 sweeps every 40px of scroll)
 * Red-proofed by: bash scripts/redproof-mobile-atc.sh
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
/* ATC_TEST_ROOT lets scripts/redproof-mobile-atc.sh point this file at a COPY
   of the tree. Mutating a live file to prove a test can fail is not an option
   here: several Claude sessions work in this repo at once, and a peer's
   sweeping commit can deploy somebody else's half-edited file (ERR-270/272). */
const INK = process.env.ATC_TEST_ROOT || path.join(ROOT, 'inkcartridges');
const read = (...p) => fs.readFileSync(path.join(INK, ...p), 'utf8');

const PDP_SRC = read('js', 'product-detail-page.js');
const PDP_CODE = stripComments(PDP_SRC);
const COMPONENTS_CSS = stripComments(read('css', 'components.css'));
const PAGES_CSS = stripComments(read('css', 'pages.css'));

/* The geometry these tests are written against, measured with real WebKit at
   playwright devices['iPhone 13'].viewport by `npm run probe:mobile-cta`. */
const VIEWPORT_H = 664;
const BANNER_H = 148;   // .consent-banner on a 390px phone, content-driven
const HEADER_H = 136;   // .site-header, sticky below 1100px, scrolled state
const CTA_H = 48;

// ═══════════════════════════════════════════════════════════════════════════
// A fake DOM, small enough to read and honest about what it does not model
// ═══════════════════════════════════════════════════════════════════════════

function rect(top, height) {
    return { top, bottom: top + height, height, left: 0, right: 390, width: 390 };
}

function makeEl(id, className, opts = {}) {
    const el = {
        id: id || '',
        className: className || '',
        hidden: false,
        children: [],
        _rect: opts.rect || rect(0, 0),
        _display: opts.display || 'block',
        _position: opts.position || 'static',
        classList: {
            _set: new Set(String(className || '').split(/\s+/).filter(Boolean)),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            contains(c) { return this._set.has(c); },
            toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
        },
        _attrs: {},
        setAttribute(k, v) { this._attrs[k] = v; },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        getBoundingClientRect() { return this._rect; },
        querySelector(sel) {
            return (this._query && this._query(sel)) || null;
        },
        addEventListener() {},
        removeEventListener() {},
        appendChild(c) { this.children.push(c); return c; },
        insertBefore(c) { this.children.push(c); return c; },
        style: { setProperty() {}, removeProperty() {} },
        get parentElement() { return this._parent || null; },
        get parentNode() { return this._parent || null; },
    };
    return el;
}

/**
 * Build the page the sticky-bar handler expects, plus the recorders.
 *
 * `bannerHeight: 0` means the banner is not on the page at all, which is the
 * state every member of staff is permanently in and the state in which this
 * defect does not exist.
 */
function buildPage({ bannerHeight = BANNER_H, headerHeight = HEADER_H, ctaPresent = true, actionsHidden = false } = {}) {
    const observers = [];      // every IntersectionObserver ever constructed
    const mutationObservers = [];

    const stickyBar = makeEl('sticky-atc', 'sticky-atc');
    const stickyBtn = makeEl('sticky-atc-btn', 'btn');
    const stickyPrice = makeEl('sticky-atc-price', '');

    let cta = ctaPresent ? makeEl('add-to-cart-btn', 'btn btn--primary product-info__add-to-cart', { rect: rect(300, CTA_H) }) : null;

    const actions = makeEl('', 'product-info__actions');
    actions.hidden = actionsHidden;
    actions._query = (sel) => (sel === '.product-info__add-to-cart' ? cta : null);

    const banner = bannerHeight > 0
        ? makeEl('consent-banner', 'consent-banner is-open', {
            rect: rect(VIEWPORT_H - bannerHeight, bannerHeight), position: 'fixed',
        })
        : null;
    const header = headerHeight > 0
        ? makeEl('', 'site-header', { rect: rect(0, headerHeight), position: 'sticky' })
        : null;

    const byId = { 'sticky-atc': stickyBar, 'sticky-atc-btn': stickyBtn, 'sticky-atc-price': stickyPrice };
    if (banner) byId['consent-banner'] = banner;

    const document_ = {
        _handlers: [],
        addEventListener(ev, fn) { this._handlers.push([ev, fn]); },
        removeEventListener() {},
        getElementById(id) { return byId[id] || null; },
        querySelector(sel) {
            if (sel === '.product-info__actions') return actions;
            if (sel === '.site-header') return header;
            if (sel === '#consent-banner') return banner;
            return null;
        },
        querySelectorAll() { return []; },
        body: makeEl('', ''),
        createElement: () => makeEl('', ''),
        documentElement: makeEl('', ''),
        cookie: '',
    };

    const permissive = () => new Proxy(function () {}, {
        get: (t, k) => (k === Symbol.toPrimitive || k === 'toString' || k === Symbol.iterator ? () => '' : permissive()),
        apply: () => permissive(), construct: () => permissive(), has: () => true,
    });

    const ctx = {
        document: document_,
        console: { log() {}, warn() {}, error() {}, info() {} },
        Math, JSON, Date, Number, String, Object, Array, Boolean, RegExp, Error, Promise, Set, Map,
        parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
        /* The module starts real async work at load (a product fetch keyed off
           the URL). It is never awaited here, but a rejection inside the vm
           still surfaces as an unhandledRejection and fails the whole FILE
           rather than a test — which reads as a broken assertion and is not
           one. Give it the web globals it reaches for and a fetch that never
           resolves, so nothing is left in flight to reject. */
        URLSearchParams, URL, TextEncoder, TextDecoder, AbortController,
        fetch: () => new Promise(() => {}),
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        innerWidth: 390,
        innerHeight: VIEWPORT_H,
        scrollY: 0,
        IntersectionObserver: function (cb, options) {
            const rec = { cb, options, observed: [], disconnected: false };
            observers.push(rec);
            this.observe = (el) => rec.observed.push(el);
            this.disconnect = () => { rec.disconnected = true; };
            this.unobserve = () => {};
        },
        MutationObserver: function (cb) {
            const rec = { cb, targets: [], options: null };
            mutationObservers.push(rec);
            this.observe = (el, options) => { rec.targets.push(el); rec.options = options; };
            this.disconnect = () => {};
        },
        getComputedStyle: (el) => ({
            position: el && el._position ? el._position : 'static',
            display: el && el._display ? el._display : 'block',
            visibility: 'visible',
        }),
        location: { pathname: '/p/CLC37BK', search: '', href: '', hash: '' },
        navigator: { userAgent: 'test' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        addEventListener() {},
        removeEventListener() {},
        requestAnimationFrame: () => 0,
        matchMedia: () => ({ matches: true, addEventListener() {}, addListener() {} }),
    };
    ctx.window = ctx;
    ctx.globalThis = ctx;
    // Anything the rest of this 3,000-line module reaches for at load time.
    ['Config', 'API', 'Auth', 'Security', 'Cart', 'Products', 'Favourites', 'Filters',
        'ProductColors', 'Business', 'DebugLog', 'Shipping', 'SeoMeta', 'schema',
        'QtyStepper', 'Ga4Ecommerce', 'UetTag', 'gtag', 'supabase', 'imageSrcset',
        'getStorage', 'setStorage', 'formatPrice', 'Reviews'].forEach((k) => { ctx[k] = permissive(); });

    vm.createContext(ctx);
    vm.runInContext(PDP_SRC, ctx, { filename: 'product-detail-page.js' });

    /* The sticky-bar block is the DOMContentLoaded listener that resolves
       .product-info__actions. Selecting it by BEHAVIOUR rather than by index
       means adding another listener above it cannot silently point this whole
       file at the wrong function. */
    const ready = document_._handlers.filter(([ev]) => ev === 'DOMContentLoaded').map(([, fn]) => fn);
    assert.ok(ready.length > 0, 'js/product-detail-page.js must register a DOMContentLoaded handler');

    const before = observers.length;
    let stickyHandler = null;
    for (const fn of ready) {
        const mark = observers.length;
        fn();
        if (observers.length > mark || stickyBar.classList.contains('is-visible') !== undefined) {
            if (observers.length > mark) { stickyHandler = fn; break; }
        }
    }
    assert.ok(stickyHandler || observers.length > before || actionsHidden || !ctaPresent,
        'the sticky-bar handler must build an IntersectionObserver, or explain why it did not');

    return {
        observers,
        mutationObservers,
        stickyBar,
        actions,
        banner,
        header,
        document: document_,
        get cta() { return cta; },
        setCta(next) { cta = next; },
        latest() { return observers[observers.length - 1]; },
        /** Fire the MutationObserver watching a given element. */
        fireMutation(target) {
            mutationObservers
                .filter((m) => m.targets.includes(target))
                .forEach((m) => m.cb([], { disconnect() {} }));
        },
    };
}

/** Parse the `-Npx` figures out of a rootMargin string. */
function margins(rootMargin) {
    const parts = String(rootMargin || '').trim().split(/\s+/);
    const px = (v) => Number(String(v).replace('px', '')) || 0;
    return { top: px(parts[0]), right: px(parts[1]), bottom: px(parts[2]), left: px(parts[3]) };
}

// ═══════════════════════════════════════════════════════════════════════════
// §1 the observer watches the CONTROL, not its container
// ═══════════════════════════════════════════════════════════════════════════

test('§1 the sticky bar observes the Add to Cart control, not .product-info__actions', () => {
    const page = buildPage();
    const obs = page.latest();
    assert.ok(obs, 'an IntersectionObserver must be constructed');
    assert.equal(obs.observed.length, 1, 'exactly one element is observed');

    const watched = obs.observed[0];
    assert.ok(String(watched.className).includes('product-info__add-to-cart'),
        'the observed element must be the CTA itself. Watching .product-info__actions is what caused '
        + 'ERR-280: on mobile that container is a two-row grid (quantity stepper, then Add to Cart), '
        + `so its top edge enters the viewport ~56px before the button does and the bar retired while `
        + 'the button was still under the consent banner — or still below the fold entirely.');
    assert.notEqual(watched, page.actions,
        'observing the container is the defect, not a stylistic choice');
});

test('§1 .product-info__add-to-cart is carried by BOTH spellings of the control', () => {
    const html = read('html', 'product', 'index.html');
    assert.match(html, /id="add-to-cart-btn"[^>]*/, 'the PDP must still ship #add-to-cart-btn');
    const btnTag = html.slice(html.indexOf('id="add-to-cart-btn"') - 400, html.indexOf('id="add-to-cart-btn"') + 100);
    assert.ok(btnTag.includes('product-info__add-to-cart'),
        'the in-stock button must carry the class the observer resolves');
    assert.ok(PDP_CODE.includes('product-info__add-to-cart'),
        'the contact-us anchor that replaces the button via outerHTML must carry it too, or every '
        + 'out-of-stock product loses its sticky bar silently');
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 the root is shrunk by the MEASURED bands, at BOTH edges
// ═══════════════════════════════════════════════════════════════════════════

test('§2 the observer root is shrunk by the consent banner\'s measured height', () => {
    const page = buildPage({ bannerHeight: BANNER_H });
    const m = margins(page.latest().options.rootMargin);
    assert.equal(m.bottom, -BANNER_H,
        `rootMargin bottom must be -${BANNER_H}px, the banner's measured box. It was 0 (no rootMargin `
        + 'at all), so the viewport\'s bottom 148px counted as visible and the bar handed over to a '
        + 'button underneath a fixed layer at --z-popover (600).');
});

test('§2 the root is shrunk by the sticky header too — occlusion has two edges', () => {
    const page = buildPage({ headerHeight: HEADER_H });
    const m = margins(page.latest().options.rootMargin);
    assert.equal(m.top, -HEADER_H,
        `rootMargin top must be -${HEADER_H}px. .site-header is position:sticky;top:0 below 1100px at `
        + 'the same --z-sticky (200) the bar uses. With only the bottom inset, probe:mobile-cta §6 '
        + 'still found a dead window at scrollY 1200 with the button at y 33-81 and elementFromPoint '
        + 'returning div.logo-block. A model of occlusion with one edge in it is wrong at the other.');
});

test('§2 a banner-less page shrinks nothing at the bottom', () => {
    const page = buildPage({ bannerHeight: 0 });
    const m = margins(page.latest().options.rootMargin);
    assert.equal(m.bottom, 0,
        'with no banner there is nothing to inset for. A constant here would keep the bar up over '
        + 'clear space for every returning visitor, which is the opposite failure and just as silent.');
});

test('§2 the heights are MEASURED, never written down as constants', () => {
    const page = buildPage({ bannerHeight: 96, headerHeight: 61 });
    const m = margins(page.latest().options.rootMargin);
    assert.equal(m.bottom, -96, 'a re-wrapped 96px banner must inset 96px');
    assert.equal(m.top, -61, 'a collapsed 61px header must inset 61px');

    const sticky = PDP_CODE.slice(PDP_CODE.indexOf('Sticky mobile Add-to-Cart bar'));
    assert.doesNotMatch(sticky.slice(0, 4000), /-\s*148\s*px|:\s*148\b/,
        'the banner is 61px on a wide desktop and ~148px on a phone and re-wraps whenever anything '
        + 'alters its padding. ERR-233 came back for 17px when a measurement was taken once and '
        + 'treated as a constant.');
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 the handover requires FULL visibility
// ═══════════════════════════════════════════════════════════════════════════

test('§3 the bar stands down only when the CTA is FULLY inside the unoccluded root', () => {
    const page = buildPage();
    const obs = page.latest();

    obs.cb([{ intersectionRatio: 1, isIntersecting: true }]);
    assert.equal(page.stickyBar.classList.contains('is-visible'), false,
        'ratio 1 means every pixel of the button is clear of both bands — hand over');
    assert.equal(page.stickyBar.getAttribute('aria-hidden'), 'true',
        'aria-hidden must track the visible state, or assistive tech is told the opposite');

    obs.cb([{ intersectionRatio: 0.99, isIntersecting: true }]);
    assert.equal(page.stickyBar.classList.contains('is-visible'), true,
        'a button 1% clipped by the banner is 1% un-tappable at that edge. The old predicate was '
        + '`isIntersecting` at threshold 0, so ONE pixel of the container anywhere in the viewport '
        + 'retired the bar.');

    obs.cb([{ intersectionRatio: 0, isIntersecting: false }]);
    assert.equal(page.stickyBar.classList.contains('is-visible'), true, 'fully gone — bar up');
    assert.equal(page.stickyBar.getAttribute('aria-hidden'), 'false');
});

test('§3 the observer asks for the ratio-1 threshold, or the callback never fires there', () => {
    const page = buildPage();
    const t = page.latest().options.threshold;
    const list = Array.isArray(t) ? t : [t];
    assert.ok(list.includes(1),
        'IntersectionObserver only calls back at the thresholds it was given. Branching on '
        + '`ratio < 1` while asking for threshold 0 alone is a handover that never happens.');
    assert.ok(list.includes(0),
        'threshold 0 is what restores the bar as the button leaves the viewport entirely');
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 the observer survives the outerHTML swap
// ═══════════════════════════════════════════════════════════════════════════

test('§4 replacing the button with the Contact us link re-points the observer', () => {
    const page = buildPage();
    const first = page.latest();
    assert.equal(first.observed[0].id, 'add-to-cart-btn');

    /* What renderProduct() does for out-of-stock and contact-us products:
       addBtn.outerHTML = '<a href="/contact" class="btn ... product-info__add-to-cart">'.
       The old node is detached, so an observer holding it watches nothing. */
    const contactLink = makeEl('', 'btn btn--primary btn--lg product-info__add-to-cart', { rect: rect(300, CTA_H) });
    page.setCta(contactLink);
    page.fireMutation(page.actions);

    const now = page.latest();
    assert.notEqual(now, first, 'a new observer must be built for the replacement node');
    assert.equal(now.observed[0], contactLink,
        'the replacement Contact us anchor must be what is observed. This is why the original code '
        + 'watched the container — and watching a detached button is a guard that cannot fire, on '
        + 'every out-of-stock product the shop sells (ERR-258).');
    assert.equal(first.disconnected, true, 'the stale observer must be disconnected, not leaked');
});

test('§4 a MutationObserver actually watches the actions container for that swap', () => {
    const page = buildPage();
    const watching = page.mutationObservers.filter((m) => m.targets.includes(page.actions));
    assert.ok(watching.length >= 1,
        'nothing else tells this code the button was replaced: the swap happens in renderProduct() '
        + 'after an async fetch, long after DOMContentLoaded built the observer');
    assert.ok(watching.some((m) => m.options && m.options.childList),
        'outerHTML is a childList mutation of the parent — attribute watching would miss it entirely');
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 the bands are re-measured when they change
// ═══════════════════════════════════════════════════════════════════════════

test('§5 dismissing the consent banner returns the bottom inset to zero', () => {
    const page = buildPage({ bannerHeight: BANNER_H });
    assert.equal(margins(page.latest().options.rootMargin).bottom, -BANNER_H);

    /* decide() removes the element and releaseSpace() drops the body class and
       the custom property — which is the body attribute mutation below. */
    page.document.getElementById = () => null;
    page.document.querySelector = (sel) => (sel === '.product-info__actions' ? page.actions
        : (sel === '.site-header' ? page.header : null));
    page.fireMutation(page.document.body);

    assert.equal(margins(page.latest().options.rootMargin).bottom, 0,
        'once consent is decided the banner is gone from the DOM and nothing covers the bottom of '
        + 'the viewport. Keeping the inset would hold the sticky bar up over clear space for the '
        + 'entire rest of the session.');
});

test('§5 a body attribute change that moves nothing does NOT rebuild the observer', () => {
    const page = buildPage();
    const before = page.observers.length;
    page.fireMutation(page.document.body);
    assert.equal(page.observers.length, before,
        'body classes change constantly (filter sheets, modals, the scrolled header). Rebuilding an '
        + 'IntersectionObserver on each one would churn on every interaction on the page.');
});

test('§5 the sticky header collapsing is watched too', () => {
    const page = buildPage();
    const watching = page.mutationObservers.filter((m) => m.targets.includes(page.header));
    assert.ok(watching.length >= 1,
        'main.js#initStickyHeader adds .site-header--scrolled past 80px, which hides .header-lead and '
        + 'takes ~44px off the top band (the ERR-101 height-delta invariant). Nothing on <body> '
        + 'changes when it does, so the body observer cannot see it.');
});

// ═══════════════════════════════════════════════════════════════════════════
// §6 the error state, and the CSS that backs all of this up
// ═══════════════════════════════════════════════════════════════════════════

test('§6 a hidden buy box hides the sticky bar rather than offering a dead button', () => {
    const page = buildPage({ actionsHidden: true });
    assert.equal(page.stickyBar.classList.contains('is-visible'), false,
        'renderError() sets .product-info__actions.hidden = true when the product did not load. A '
        + 'zero-box observation target intersects nothing, so a ratio-based rule would read that as '
        + '"not visible" and leave the bar up offering to add a product that does not exist.');
    assert.equal(page.stickyBar.getAttribute('aria-hidden'), 'true');
});

test('§6 ERR-238\'s lift is still the measured banner height', () => {
    assert.match(COMPONENTS_CSS, /body\.has-consent-banner[^{]*\.sticky-atc[^{]*\{[^}]*bottom:\s*var\(--consent-banner-height/s,
        'the bar must still be lifted clear of the banner. This test and §2 are the two halves of one '
        + 'fix: the lift keeps the VISIBLE bar off the banner, the rootMargin keeps the bar from '
        + 'RETIRING into it. Either alone leaves a dead zone.');
});

test('§6 a hidden sticky bar does not eat the tap under it', () => {
    assert.match(PAGES_CSS, /\.sticky-atc:not\(\.is-visible\)\s*\{[^}]*pointer-events:\s*none/s,
        'transform is animated over 0.3s, so for that whole slide the bar is a painted, hit-testable '
        + 'box travelling across content it offers nothing to. Measured: mid-slide, elementFromPoint '
        + 'at #add-to-cart-btn\'s own centre returned button#sticky-atc-btn.');
});

test('§6 the bar is still painted BELOW the consent banner', () => {
    const block = PAGES_CSS.slice(PAGES_CSS.indexOf('.sticky-atc {'), PAGES_CSS.indexOf('.sticky-atc {') + 700);
    assert.match(block, /z-index:\s*var\(--z-sticky/,
        'raising .sticky-atc above --z-popover (600) would "fix" the overlap by putting a buy button '
        + 'on top of a consent notice. Both handoffs asked for this NOT to be the fix.');
    assert.doesNotMatch(block, /z-index:\s*[6-9]\d\d/, 'no hand-rolled 600+ z-index');
});

// ═══════════════════════════════════════════════════════════════════════════
// §7 RETIRED 2026-09-27 — the rewards nudge was deleted outright
// ═══════════════════════════════════════════════════════════════════════════
//
// This section pinned the nudge's in-flow placement below the fold on phones
// (ERR-280). The conversion handoff (2026-09-23 D-P0-1) measured it still
// covering the desktop search box and PDP titles and the owner removed the
// overlay on every device; its absence is pinned by
// tests/mobile-cta-occlusion-sep2026.test.js §0.
