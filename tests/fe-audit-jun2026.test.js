/**
 * Frontend audit remediation — June 2026 (ERR-049)
 * ================================================
 *
 * Pins the seven fixes from the backend dev's Playwright audit (FE_DEV_REPORT.md):
 *   §1  CSP frame-src allows the Google Customer Reviews badge frame
 *       (www.google.com) — kills the site-wide console CSP violation, without
 *       dropping any existing allowed origin.
 *   §2  gtag.js sets cookie_flags so first-party GA/Ads cookies (_ga, _gcl_au)
 *       carry Secure.
 *   §3  Collection + printer JSON-LD go through getWithSWR — the init/popstate/
 *       pageshow burst on one URL collapses to a single request (no more 429).
 *   §4  Every indexable storefront page emits hreflang="en-NZ" + "x-default";
 *       every audited page emits twitter:card=summary_large_image. Static tags
 *       (non-JS social scrapers can't run the SPA). Admin (noindex) is excluded.
 *   §5  The dormant newsletter signup is surfaced in the shared footer and wired
 *       to POST /api/newsletter/subscribe via one idempotent binder; landing.js
 *       delegates to it instead of shipping a duplicate handler.
 *   §6  Dynamic-canonical pages (shop, product) keep their hreflang alternates
 *       pointed at the live canonical at runtime.
 *
 * All assertions are static (source/filesystem) — fast, deterministic, no net.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');

const read = (...p) => fs.readFileSync(path.join(INK, ...p), 'utf8');

// ── target HTML set (mirrors scripts/codemod: top-level + html tree, no admin) ──
function walkHtml(dir) {
    let out = [];
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            if (full.includes(path.join('html', 'admin'))) continue; // noindex, excluded
            out = out.concat(walkHtml(full));
        } else if (name.endsWith('.html')) {
            out.push(full);
        }
    }
    return out;
}
const HTML_TARGETS = [
    path.join(INK, 'index.html'),
    path.join(INK, '404.html'),
    ...walkHtml(path.join(INK, 'html')),
].filter((f) => fs.existsSync(f));
const rel = (f) => f.replace(INK + path.sep, '');

// ───────────────────────────────────────────────────────────────────────────
// §1  CSP — Google Reviews badge frame allowed, nothing else dropped
// ───────────────────────────────────────────────────────────────────────────
const VERCEL = JSON.parse(read('vercel.json'));
function cspValue() {
    for (const rule of VERCEL.headers || []) {
        for (const h of rule.headers || []) {
            if (h.key === 'Content-Security-Policy') return h.value;
        }
    }
    return '';
}
function frameSrc() {
    const m = /frame-src ([^;]+)/.exec(cspValue());
    return m ? m[1].trim().split(/\s+/) : [];
}

test('§1 vercel.json is valid JSON and ships a CSP', () => {
    assert.ok(cspValue().length > 0, 'CSP header present');
});

test('§1 frame-src allows the Google Reviews badge (www.google.com)', () => {
    assert.ok(frameSrc().includes('https://www.google.com'),
        'frame-src must include https://www.google.com for the Google Customer Reviews badge');
});

test('§1 no regression — every previously-allowed frame origin survives', () => {
    const fs2 = frameSrc();
    for (const origin of [
        'https://js.stripe.com',
        'https://challenges.cloudflare.com',
        'https://*.paypal.com',
        'https://*.paypalobjects.com',
    ]) {
        assert.ok(fs2.includes(origin), `frame-src still allows ${origin}`);
    }
});

// ───────────────────────────────────────────────────────────────────────────
// §2  gtag cookie_flags — Secure on every config call
// ───────────────────────────────────────────────────────────────────────────
const GTAG = read('js', 'gtag.js');

test('§2 every gtag config call passes cookie_flags', () => {
    const configs = GTAG.match(/gtag\(\s*['"]config['"][^)]*\)/g) || [];
    assert.ok(configs.length >= 3, 'three measurement IDs configured');
    for (const c of configs) {
        assert.ok(/cookie_flags/.test(c) || /GTAG_COOKIE_FLAGS/.test(c),
            `config call passes cookie_flags: ${c}`);
    }
});

test('§2 cookie_flags carries Secure', () => {
    assert.match(GTAG, /cookie_flags:\s*['"][^'"]*Secure[^'"]*['"]/i);
});

test('§2 the Google Ads conversion-linker ID (AW-) is still configured', () => {
    assert.match(GTAG, /gtag\(\s*['"]config['"]\s*,\s*['"]AW-18032498762['"]/);
});

// ───────────────────────────────────────────────────────────────────────────
// §3  Schema JSON-LD via SWR (dedup the navigation burst → no 429)
// ───────────────────────────────────────────────────────────────────────────
const API = read('js', 'api.js');

test('§3 getCollectionSchema fetches via getWithSWR', () => {
    const fn = /getCollectionSchema\([\s\S]*?\n {4}\},/.exec(API);
    assert.ok(fn, 'getCollectionSchema present');
    assert.match(fn[0], /getWithSWR\(`\/api\/schema\/collection/);
    assert.doesNotMatch(fn[0], /return this\.get\(`\/api\/schema\/collection/,
        'must not use the uncached this.get path');
});

test('§3 getPrinterSchema fetches via getWithSWR', () => {
    const fn = /getPrinterSchema\([\s\S]*?\n {4}\},/.exec(API);
    assert.ok(fn, 'getPrinterSchema present');
    assert.match(fn[0], /getWithSWR\(`\/api\/schema\/printer/);
});

// ───────────────────────────────────────────────────────────────────────────
// §4  SEO head tags — hreflang (indexable) + twitter:card (all)
// ───────────────────────────────────────────────────────────────────────────
test('§4 every audited page has twitter:card=summary_large_image', () => {
    for (const f of HTML_TARGETS) {
        const html = fs.readFileSync(f, 'utf8');
        assert.match(html, /<meta\s+name=["']twitter:card["']\s+content=["']summary_large_image["']/i,
            `${rel(f)} missing twitter:card`);
    }
});

test('§4 every indexable page (has canonical) emits both hreflang alternates, exactly once', () => {
    let checked = 0;
    for (const f of HTML_TARGETS) {
        const html = fs.readFileSync(f, 'utf8');
        if (!/<link\b[^>]*\brel=["']canonical["']/i.test(html)) continue; // noindex → hreflang N/A
        checked++;
        const en = (html.match(/hreflang=["']en-NZ["']/gi) || []).length;
        const def = (html.match(/hreflang=["']x-default["']/gi) || []).length;
        assert.equal(en, 1, `${rel(f)} should have exactly one hreflang=en-NZ`);
        assert.equal(def, 1, `${rel(f)} should have exactly one hreflang=x-default`);
        // self-referential: alternates carry the canonical id hooks for runtime sync
        assert.match(html, /id=["']hreflang-en["']/, `${rel(f)} hreflang-en id hook`);
        assert.match(html, /id=["']hreflang-default["']/, `${rel(f)} hreflang-default id hook`);
    }
    assert.ok(checked >= 10, `sanity: a healthy set of indexable pages checked (got ${checked})`);
});

test('§4 admin pages are left untouched (noindex, out of scope)', () => {
    const adminDir = path.join(INK, 'html', 'admin');
    if (!fs.existsSync(adminDir)) return;
    const adminIndex = path.join(adminDir, 'index.html');
    if (fs.existsSync(adminIndex)) {
        const html = fs.readFileSync(adminIndex, 'utf8');
        assert.doesNotMatch(html, /hreflang/i, 'admin must not get hreflang');
    }
});

// ───────────────────────────────────────────────────────────────────────────
// §5  Footer newsletter — surfaced + single idempotent binder
// ───────────────────────────────────────────────────────────────────────────
const FOOTER = read('js', 'footer.js');
const LANDING = read('js', 'landing.js');

test('§5 footer renders the newsletter form + email input', () => {
    assert.match(FOOTER, /class="[^"]*newsletter__form[^"]*"/);
    assert.match(FOOTER, /type="email"[^>]*name="email"/);
    assert.match(FOOTER, /footer-newsletter__button/);
});

test('§5 the binder is idempotent (dataset guard) and posts via API.subscribe', () => {
    assert.match(FOOTER, /function bindNewsletterForm/);
    assert.match(FOOTER, /dataset\.nlBound\s*===\s*['"]1['"]/, 'double-bind guard');
    assert.match(FOOTER, /dataset\.nlBound\s*=\s*['"]1['"]/, 'guard is set');
    assert.match(FOOTER, /API\.subscribe\(/);
    assert.match(FOOTER, /source:\s*source\s*\|\|\s*['"]footer['"]/);
});

test('§5 the binder is exported and called after the footer mounts', () => {
    assert.match(FOOTER, /window\.NewsletterForm\s*=\s*\{\s*bind:\s*bindNewsletterForm\s*\}/);
    assert.match(FOOTER, /bindNewsletterForm\(footer\.querySelector\('\.newsletter__form'\),\s*'footer'\)/);
});

test('§5 landing.js delegates to the shared binder (no duplicate inline handler)', () => {
    assert.match(LANDING, /window\.NewsletterForm/);
    assert.match(LANDING, /\.bind\(f,\s*['"]landing['"]\)/);
    // the old inline implementation (its own addEventListener submit + Turnstile
    // render) must be gone, so there is exactly one implementation site.
    assert.doesNotMatch(LANDING, /newsletterTurnstileToken/,
        'duplicate inline newsletter handler should be removed from landing.js');
});

// the email gate the binder applies — pin the contract by reproducing it
test('§5 email validation accepts valid and rejects malformed addresses', () => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // identical to footer.js
    for (const ok of ['a@b.co', 'jun.jackson+ads@inkcartridges.co.nz']) {
        assert.ok(re.test(ok), `${ok} should be accepted`);
    }
    for (const bad of ['', 'plainaddress', 'a@b', 'a@@b.com', 'spaces in@x.com']) {
        assert.ok(!re.test(bad), `${bad} should be rejected`);
    }
});

// ───────────────────────────────────────────────────────────────────────────
// §6  Dynamic-canonical pages keep hreflang in sync at runtime
// ───────────────────────────────────────────────────────────────────────────
test('§6 shop-page updateSEO syncs both hreflang ids to the canonical', () => {
    const SHOP = read('js', 'shop-page.js');
    assert.match(SHOP, /set\('hreflang-en',\s*'href',\s*canonical\)/);
    assert.match(SHOP, /set\('hreflang-default',\s*'href',\s*canonical\)/);
});

test('§6 product-detail-page syncs both hreflang ids to the canonical', () => {
    const PDP = read('js', 'product-detail-page.js');
    assert.match(PDP, /getElementById\('hreflang-en'\)/);
    assert.match(PDP, /getElementById\('hreflang-default'\)/);
    assert.match(PDP, /\.href\s*=\s*canonicalUrl/);
});
