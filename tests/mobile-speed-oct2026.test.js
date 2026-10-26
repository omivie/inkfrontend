/**
 * Mobile speed — checklist item 32, fixes 3–6 (backend reply 2026-10-25,
 * Appendix B). Fixes 1–2 are pinned in fe-checklist-22oct-listing-2026.test.js.
 *
 *   §3 PDP related products start near the viewport / after the hero image
 *   §4 self-hosted fonts, no Google Fonts, system mono, gtag.js deferred with
 *      first-paint.js the only blocking script, no `transition: all`,
 *      supabase-js and search.js on demand
 *   §5 home hero WebP + phone crop + preload; brand logos optimised + sized
 *   §6 contrast token, inert sticky bar, sized PDP hero
 *
 * NOT done, by decision (owner, 2026-10-26): minifying CSS/JS and splitting
 * pages.css — the repo has no build step. Recorded in errors.md.
 *
 * Run with: node --test tests/mobile-speed-oct2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stripComments = require('./helpers/strip-comments');

const INK = path.resolve(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

function allHtml(dir = INK, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['node_modules', 'scripts', '.git'].includes(e.name)) allHtml(p, out); } else if (e.name.endsWith('.html')) out.push(p);
    }
    return out;
}
const PAGES = allHtml();
const STOREFRONT = PAGES.filter((f) => !f.includes(`${path.sep}admin${path.sep}`));
const rel = (f) => path.relative(INK, f);

// §3 ─────────────────────────────────────────────────────────────────────────
test('§3 PDP related products wait for the viewport (600px) or the hero image, once', () => {
    const js = stripComments(read('js/product-detail-page.js'));
    assert.match(js, /this\._startRelatedWhenNeeded\(info\);/);
    assert.doesNotMatch(js.slice(js.indexOf('renderProduct('), js.indexOf('_startRelatedWhenNeeded(info) {')), /this\.renderRelatedProducts\(info\);\n\s*\/\/ Ribbon/);
    const body = js.slice(js.indexOf('_startRelatedWhenNeeded(info) {'), js.indexOf('async renderRelatedProducts(info) {'));
    assert.match(body, /rootMargin: '600px 0px'/);
    assert.match(body, /hero\.addEventListener\('load', start, \{ once: true \}\)/);
    assert.match(body, /if \(started\) return;/, 'never twice');
    assert.match(body, /typeof IntersectionObserver !== 'function'\) \{ start\(\); return; \}/, 'old browsers: at once');
});

// §4 fonts ──────────────────────────────────────────────────────────────────
test('§4 fonts are self-hosted: files exist, @font-face swap, preloaded on every page, no Google Fonts', () => {
    const css = stripComments(read('css/base.css'));
    for (const f of ['inter-latin-wght.woff2', 'inter-latin-ext-wght.woff2', 'plus-jakarta-sans-latin-wght.woff2', 'plus-jakarta-sans-latin-ext-wght.woff2']) {
        const buf = fs.readFileSync(path.join(INK, 'assets', 'fonts', f));
        assert.equal(buf.slice(0, 4).toString('latin1'), 'wOF2', `${f} is a woff2`);
        assert.ok(css.includes(`url('/assets/fonts/${f}') format('woff2')`), `${f} declared`);
    }
    assert.equal((css.match(/font-display: swap;/g) || []).length, 4);
    assert.match(css, /--font-family-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;/);
    assert.doesNotMatch(read('css/admin.css') + read('js/admin/components/charts.js'), /JetBrains Mono'/);
    for (const f of PAGES) {
        const html = read(rel(f));
        assert.ok(!html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com'), `${rel(f)} still references Google Fonts`);
    }
    const csp = JSON.stringify(JSON.parse(read('vercel.json')));
    assert.doesNotMatch(csp, /fonts\.g(oogleapis|static)\.com/, 'CSP no longer allows Google Fonts');
    assert.match(csp, /font-src 'self';/);
});

test('§4 gtag.js is deferred everywhere; first-paint.js is the one blocking script, on shop.html only', () => {
    for (const f of STOREFRONT) {
        const html = read(rel(f));
        const tags = html.match(/<script src="\/js\/gtag\.js\?v=[0-9a-f]{8}"[^>]*>/g) || [];
        for (const t of tags) assert.match(t, / defer>$/, `${rel(f)}: ${t}`);
        if (!rel(f).endsWith(path.join('html', 'shop.html'))) assert.ok(!html.includes('/js/first-paint.js'), `${rel(f)} loads first-paint.js`);
    }
    const gtag = read('js/gtag.js');
    assert.match(stripComments(gtag).trim().split('\n')[0], /^window\.dataLayer = window\.dataLayer \|\| \[\];$/);
    assert.ok(gtag.indexOf("gtag('consent', 'default'") < gtag.indexOf("gtag('config'"), 'consent default is still the first command');
});

// §4 transitions ──────────────────────────────────────────────────────────────
test('§4 no storefront stylesheet transitions `all`', () => {
    for (const f of ['base', 'layout', 'components', 'modern-effects', 'pages', 'search', 'cart-checkout', 'checkout-compact']) {
        const css = stripComments(read(`css/${f}.css`));
        assert.doesNotMatch(css, /transition(?:-property)?:\s*all\b/, `css/${f}.css`);
    }
});

// §4 supabase-js on demand ──────────────────────────────────────────────────
const SDK_TAG = /<script (?:defer )?src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@([^"]+)"( integrity="([^"]+)")?/g;

test('§4 browsing pages ship no supabase-js tag; pages that use it directly keep it; one pinned build + SRI', () => {
    const BROWSE = ['index.html', '404.html', 'html/404.html', 'html/index.html', 'html/shop.html', 'html/product/index.html',
        'html/ribbons.html', 'html/cart.html', 'html/about.html', 'html/contact.html', 'html/faq.html',
        'html/genuine-vs-compatible.html', 'html/privacy.html', 'html/terms.html', 'html/returns.html',
        'html/shipping.html', 'html/bulk-pricing.html', 'html/value-packs.html', 'html/rewards.html'];
    for (const p of BROWSE) assert.doesNotMatch(read(p), /supabase-js/, `${p} still ships supabase-js`);
    for (const p of ['html/account/login.html', 'html/account/index.html', 'html/checkout.html', 'html/payment.html', 'html/quote.html', 'html/admin/index.html']) {
        assert.match(read(p), /supabase-js@2\.98\.0/, `${p} uses the SDK directly and must keep its tag`);
    }
    const auth = read('js/auth.js');
    const url = /SDK_URL: '([^']+)'/.exec(auth)[1];
    const sri = /SDK_INTEGRITY: '([^']+)'/.exec(auth)[1];
    for (const f of PAGES) {
        for (const m of read(rel(f)).matchAll(SDK_TAG)) {
            assert.equal(`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${m[1]}`, url, `${rel(f)} pins a different build`);
            assert.equal(m[3], sri, `${rel(f)} must carry the same SRI as Auth.SDK_INTEGRITY`);
        }
    }
});

test('§4 Auth starts the client only when needed; every SDK-using method can start it', () => {
    const js = stripComments(read('js/auth.js'));
    const init = js.slice(js.indexOf('async init() {'), js.indexOf('SDK_URL:'));
    assert.match(init, /if \(!this\._needsClientNow\(\)\) \{[\s\S]*?this\._resolveReady\(\);[\s\S]*?return true;/, 'anonymous: ready, no SDK');
    assert.match(init, /await this\._loadSdk\(\);[\s\S]*return this\._startClient\(\);/);
    const needs = js.slice(js.indexOf('_needsClientNow() {'), js.indexOf('_watchForSignIn() {'));
    assert.match(needs, /Auth\._persistMode\(\) === 'session' \? sessionStorage : localStorage/, 'reads the store the adapter reads (ERR-209)');
    assert.match(needs, /catch \(e\) \{\s*return true;/, 'storage that throws ⇒ load (never a silent sign-out)');
    assert.match(js, /el\.integrity = Auth\.SDK_INTEGRITY;/);
    assert.match(js, /window\.addEventListener\('storage'/, 'a sign-in in another tab starts the client');
    const guards = js.match(/if \(!this\.supabase\) return /g) || [];
    const ensured = js.match(/if \(!this\.supabase\) await this\.ensureClient\(\);\n\s*if \(!this\.supabase\) return /g) || [];
    assert.ok(guards.length >= 7 && ensured.length === guards.length, `${ensured.length}/${guards.length} SDK methods start the client first`);
    // site-guard: a LOCKED site must still be able to check for an admin.
    assert.match(stripComments(read('js/site-guard.js')), /await window\.Auth\._loadSdk\(\)/);
    assert.match(stripComments(read('js/product-detail-page.js')), /Auth\.ensureClient\(\)/);
});

test('§4 Auth._needsClientNow: anonymous ⇒ false; stored token / OAuth hash / throwing storage ⇒ true', () => {
    const vm = require('node:vm');
    const store = (keys) => ({ length: keys.length, key: (i) => keys[i], getItem: () => null });
    const run = ({ local = [], session = [], mode = null, hash = '', throws = false }) => {
        const ctx = {
            Config: { SUPABASE_URL: 'https://lmdlgldjgcanknsjrcxh.supabase.co' },
            location: { hash },
            localStorage: throws ? { get length() { throw new Error('denied'); }, getItem: () => { throw new Error('denied'); } }
                : { ...store(local), getItem: (k) => (k === 'ic_auth_persist' ? mode : null) },
            sessionStorage: store(session),
            document: { addEventListener() {} }, window: {}, DebugLog: { warn() {}, error() {} },
        };
        vm.createContext(ctx);
        vm.runInContext(`${read('js/auth.js')}\n;this.__r = Auth._needsClientNow();`, ctx);
        return ctx.__r;
    };
    assert.equal(run({}), false, 'a first-time visitor loads no SDK');
    assert.equal(run({ local: ['cart_count', 'trendingPrinters'] }), false);
    assert.equal(run({ local: ['sb-lmdlgldjgcanknsjrcxh-auth-token'] }), true);
    assert.equal(run({ session: ['sb-lmdlgldjgcanknsjrcxh-auth-token'], mode: 'session' }), true, 'session mode reads sessionStorage');
    assert.equal(run({ local: ['sb-lmdlgldjgcanknsjrcxh-auth-token'], mode: 'session' }), false, 'session mode ignores a stale local token, like the adapter');
    assert.equal(run({ hash: '#access_token=x&refresh_token=y' }), true, 'OAuth implicit return');
    assert.equal(run({ hash: '#type=recovery' }), true);
    assert.equal(run({ throws: true }), true, 'storage that throws keeps the old always-load behaviour');
});

// §4 search.js on demand ───────────────────────────────────────────────────
test('§4 search.js ships as an idle prefetch, run by main.js on first focus/pointer/touch', () => {
    const tok = crypto.createHash('md5').update(fs.readFileSync(path.join(INK, 'js', 'search.js'))).digest('hex').slice(0, 8);
    for (const f of STOREFRONT) {
        const html = read(rel(f));
        assert.doesNotMatch(html, /<script[^>]+src="\/js\/search\.js/, `${rel(f)} still runs search.js at load`);
        if (html.includes('/js/search.js')) {
            assert.ok(html.includes(`<link rel="prefetch" href="/js/search.js?v=${tok}" as="script">`), `${rel(f)}: prefetch with the current token`);
        }
    }
    const main = stripComments(read('js/main.js'));
    assert.match(main, /querySelector\('link\[rel="prefetch"\]\[href\^="\/js\/search\.js"\]'\)/, 'the URL comes from the page, never a token typed into JS');
    assert.match(main, /\['focus', 'pointerdown', 'touchstart'\]\.forEach\(function\(ev\) \{ searchInput\.addEventListener\(ev, onFirstUse/);
    assert.match(main, /searchInput\.dispatchEvent\(new Event\('focus'\)\)/, 'the focus that triggered the load still opens the panel');
});

// §5 images ──────────────────────────────────────────────────────────────────
test('§5 home hero: WebP + phone crop, dark fallback, preloaded with the same URLs and media split', () => {
    const css = stripComments(read('css/pages.css'));
    assert.match(css, /background: #0C1222 url\('\/assets\/images\/hero-background\.webp'\) center center \/ cover no-repeat;/);
    assert.match(css, /@media \(max-width: 768px\) \{\s*\.hero \{ background-image: url\('\/assets\/images\/hero-background-phone\.webp'\); \}/);
    for (const p of ['index.html', 'html/index.html']) {
        const html = read(p);
        assert.ok(html.includes('<link rel="preload" href="/assets/images/hero-background-phone.webp" as="image" type="image/webp" media="(max-width: 768px)" fetchpriority="high">'), p);
        assert.ok(html.includes('<link rel="preload" href="/assets/images/hero-background.webp" as="image" type="image/webp" media="(min-width: 768.02px)" fetchpriority="high">'), p);
    }
    for (const f of ['hero-background.webp', 'hero-background-phone.webp']) {
        const b = fs.readFileSync(path.join(INK, 'assets', 'images', f));
        assert.equal(b.slice(8, 12).toString('latin1'), 'WEBP', f);
        assert.ok(b.length < 40 * 1024, `${f} is ${b.length} bytes`);
    }
});

test('§5 brand logos: optimiser WebP at 2x, sized, lazy past the first six, sanitized once', () => {
    const vm = require('node:vm');
    const js = read('js/shop-page.js');
    const lit = (name) => new Function(`return ${/\n\s+LOGO_DIMS: (\{[\s\S]*?\n\s+\}),/.exec(js)[1]};`)();
    const body = /\n\s+brandLogoImg\(slug, displayName, \{ lazy = false \} = \{\}\) \{([\s\S]*?)\n {8}\},/.exec(js)[1];
    const self = {
        LOGO_W: 280, LOGO_DIMS: lit(),
        brandLogo: (s) => ({ hp: 'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/logos/hp.png',
            oki: 'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/logos/oki.svg',
            evil: 'javascript:alert(1)', newbrand: 'https://x.supabase.co/logos/new.png' }[s] || ''),
    };
    const Security = {
        sanitizeUrl: (u, fb) => (/^https?:/.test(u) ? u : fb),
        escapeAttr: (v) => String(v).replace(/"/g, '&quot;'),
    };
    const optimizedImageUrl = (p, w, f) => `https://api.inkcartridges.co.nz/api/images/optimize?url=${encodeURIComponent(p)}&w=${w}&format=${f}`;
    const fn = vm.runInNewContext(`(function (slug, displayName, { lazy = false } = {}) {${body}})`, { Security, optimizedImageUrl });
    const hp = fn.call(self, 'hp', 'HP');
    assert.match(hp, /src="https:\/\/api\.inkcartridges\.co\.nz\/api\/images\/optimize\?url=https%3A%2F%2F[^"]+hp\.png&w=280&format=webp"/);
    assert.match(hp, / width="280" height="280"/);
    assert.doesNotMatch(hp, /loading="lazy"/);
    assert.match(fn.call(self, 'hp', 'HP', { lazy: true }), /loading="lazy"/);
    const oki = fn.call(self, 'oki', 'OKI');
    assert.match(oki, /src="https:\/\/lmdlgldjgcanknsjrcxh[^"]+oki\.svg"/, 'an SVG is already small: served as-is');
    assert.equal(fn.call(self, 'evil', 'Evil'), '', 'a rejected URL renders the text tile');
    assert.doesNotMatch(fn.call(self, 'newbrand', 'New'), /width=/, 'an unmeasured brand gets no guessed size');
});

// §6 accessibility ──────────────────────────────────────────────────────────
test('§6 contrast: one darker cyan text token (≥4.5:1 on white) on every flagged selector', () => {
    const L = (hex) => {
        const c = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
            .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const tok = /--color-primary-text: (#[0-9A-Fa-f]{6});/.exec(read('css/base.css'))[1];
    assert.ok(ratio(tok, '#FFFFFF') >= 4.5 && ratio(tok, '#F1F5F9') >= 4.5, `${tok} must pass AA on white and steel-100`);
    assert.ok(ratio('#267FB5', '#FFFFFF') < 4.5, 'negative control: the brand cyan really fails as text');
    const block = (file, sel) => { const css = read(file); const i = css.indexOf(sel); assert.ok(i > -1, sel); return css.slice(i, css.indexOf('}', i)); };
    for (const [file, sel, want] of [
        ['css/pages.css', '.ink-finder__subtitle {', 'var(--color-text-light)'],
        ['css/pages.css', '.ink-finder__tab {', 'var(--color-text-light)'],
        ['css/pages.css', '.ink-finder__help {', 'var(--color-text-light)'],
        ['css/pages.css', '.ink-finder__tab--active {', 'var(--color-primary-text)'],
        ['css/pages.css', '.ink-finder__help a {', 'var(--color-primary-text)'],
        ['css/pages.css', '.compatible-printers-list a {', 'var(--color-primary-text)'],
        ['css/pages.css', '\n.printer-link {', 'var(--color-primary-text)'],
        ['css/layout.css', '.breadcrumb--pdp .breadcrumb__item a {', 'var(--color-primary-text)'],
        ['css/components.css', '.consent-banner__link', 'var(--color-primary-text, #2173A5)'],
    ]) assert.ok(block(file, sel).includes(`color: ${want}`), `${sel} → ${want}`);
    assert.ok(block('css/components.css', '.consent-banner__btn--accept {').includes('background: var(--color-primary-text, #2173A5)'));
});

test('§6 the hidden sticky bar is inert (not just aria-hidden); the PDP hero box is reserved by CSS, not img attributes', () => {
    assert.match(read('html/product/index.html'), /<div class="sticky-atc" id="sticky-atc" aria-hidden="true" inert>/);
    const js = stripComments(read('js/product-detail-page.js'));
    assert.match(js, /stickyBar\.setAttribute\('aria-hidden', visible \? 'false' : 'true'\);\s*stickyBar\.inert = !visible;/);
    // 800x800 attributes + inline height:auto shifted .product-info__actions:
    // Lighthouse mobile CLS 0.30 on GLC233BK (2026-10-26). The frame's
    // aspect-ratio is what reserves the space.
    assert.doesNotMatch(js, /width="800" height="800"/);
    assert.match(stripComments(read('css/pages.css')), /\.product-gallery__main \{\s*aspect-ratio: 1;/);
});

// §6b — the regression Lighthouse caught after deploy (2026-10-26) ─────────
test('§6b the Add row stays unpainted until the rows above it are final (CLS 0.30 → 0.03)', () => {
    const css = stripComments(read('css/pages.css'));
    assert.match(css, /\.product-info:not\(\[data-ready\]\) > \.product-info__actions,\s*\.product-info:not\(\[data-ready\]\) > \.product-info__actions ~ \* \{\s*visibility: hidden;\s*animation: pdp-buybox-reveal 0s linear 8s forwards;/);
    assert.match(css, /@keyframes pdp-buybox-reveal \{ to \{ visibility: visible; \} \}/, 'CSS-only safety net: never a permanently hidden Add button');
    const js = stripComments(read('js/product-detail-page.js'));
    assert.match(js, /const valueLinesDone = this\.renderValueLines\(info\);/);
    assert.match(js, /const volumeDone = this\.renderVolumePricing\(info\);\s*this\._revealBuyBox\(\[valueLinesDone, volumeDone\]\);/);
    assert.match(js, /REVEAL_CAP_MS: 1500,/);
    const showError = js.slice(js.indexOf('showError(message) {'));
    assert.match(showError.slice(0, 2500), /box\.setAttribute\('data-ready', ''\)/, 'an error state reveals at once');
    // Fallback faces keep the swap from re-wrapping lines.
    assert.match(stripComments(read('css/base.css')), /--font-family-primary: 'Inter', 'Inter Fallback'/);
});

test('§6b _revealBuyBox: waits for the renders, then at most the cap, and marks once', async () => {
    const js = read('js/product-detail-page.js');
    const m = /\n {8}_revealBuyBox\(pending\) \{([\s\S]*?)\n {8}\},/.exec(js);
    assert.ok(m);
    const mk = () => { const attrs = {}; return { attrs, hasAttribute: (k) => k in attrs, setAttribute: (k, v) => { attrs[k] = v; } }; };
    const run = (box, pending, cap) => new Function('document', `return function (pending) {${m[1]}}`)({ querySelector: () => box }).call({ REVEAL_CAP_MS: cap }, pending);
    let box = mk(); let release;
    run(box, [new Promise((r) => { release = r; })], 10000);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!box.hasAttribute('data-ready'), 'not before the rows settle');
    release(); await new Promise((r) => setTimeout(r, 0));
    assert.ok(box.hasAttribute('data-ready'), 'as soon as they do');
    box = mk();
    run(box, [new Promise(() => {})], 30);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(box.hasAttribute('data-ready'), 'a hung request cannot hold the Add button past the cap');
    box = mk();
    run(box, [Promise.reject(new Error('ladder 500'))], 10000);
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(box.hasAttribute('data-ready'), 'a failed render still reveals');
});
