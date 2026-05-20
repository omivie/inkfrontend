/**
 * AI search readiness — May 2026
 * ===============================
 *
 * Pins the storefront half of the backend handoff `ai-search-readiness-may2026.md`
 * (backend commit `64618e9 feat(seo): AI search bot citation readiness`).
 *
 * Goal of the release: get inkcartridges.co.nz cited as a source in ChatGPT /
 * Perplexity / Google AI Overviews / Claude / Gemini answers. The backend now
 * allows the relevant AI bots in robots.txt, routes them to rich prerender HTML
 * with `dateModified` + visible `<section class="faq">` (string-identical to
 * the FAQPage JSON-LD acceptedAnswer.text, cloaking-safe) + a `<p class=
 * "page-updated">` footer, and exposes a root `/llms.txt` catalog for agent
 * auto-discovery (llmstxt.org spec).
 *
 * The Vercel layer is the first hop on the customer domain. If the middleware
 * BOT_PATTERN doesn't recognise the AI UAs, the request falls through to the
 * SPA shell and the backend signals never reach them. If /shop?brand=<slug>
 * (the canonical brand-hub URL — /brand/<slug> 301s here) isn't wired to the
 * brand prerender endpoint, bots get the same SPA shell. If /llms.txt isn't
 * proxied, agents looking for the catalog get a 404. This file guards all of
 * those.
 *
 * §1  Vercel middleware BOT_PATTERN includes every May-2026 AI bot
 * §2  Middleware routes /shop?brand=<slug> → /api/prerender/brand/<slug>
 * §3  Middleware routes /shop?brand=X&printer_slug=Y → printer prerender
 *     (printer is the narrower intent and wins when both are present)
 * §4  Bare /shop (no brand, no printer) returns nothing → SPA shell
 * §5  CCBot / Bytespider are deliberately NOT in BOT_PATTERN (low-value
 *     scrapers; backend robots.txt blocks them, FE matches)
 * §6  Brand-hub canonical paths: /brand/:slug + /brands/:slug 301 to
 *     /shop?brand=:slug (so brand prerender is the single entry point)
 * §7  /llms.txt is proxied through Vercel to the backend (root convention)
 * §8  SPA-side CollectionPage emits dateModified so DOM-reading agents see
 *     a freshness signal that matches the prerender layer
 * §9  Product detail page emits ZERO client-side JSON-LD (the backend
 *     prerender is the single source — marketing-audit-may2026 invariant)
 *
 * Static-source assertions are deliberate: they pin the *contract shape* in
 * middleware.js, vercel.json, and shop-page.js — which is what regresses —
 * and they run without a DOM or a network.
 *
 * Run with: node --test tests/ai-search-readiness-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const MIDDLEWARE = path.join(ROOT, 'middleware.js');
const VERCEL_JSON = path.join(ROOT, 'vercel.json');
const SHOP_PAGE = path.join(ROOT, 'js', 'shop-page.js');
const PDP_HTML = path.join(ROOT, 'html', 'product', 'index.html');

const middlewareSrc = fs.readFileSync(MIDDLEWARE, 'utf8');
const vercelCfg = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));
const shopPageSrc = fs.readFileSync(SHOP_PAGE, 'utf8');
const pdpHtml = fs.readFileSync(PDP_HTML, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// §1 — BOT_PATTERN must recognise every May-2026 AI bot
// ─────────────────────────────────────────────────────────────────────────────
//
// Backend handoff §FYI: "Bot prerender middleware — same 12 UAs now route to
// the rich prerender HTML." Vercel is upstream of Render; if Vercel doesn't
// fire bot routing for these UAs, the request becomes a plain SPA pageload
// and the backend prerender is never reached.

const REQUIRED_AI_BOTS = [
    // OpenAI (ChatGPT browse + search)
    'gptbot',
    'chatgpt-user',
    'oai-searchbot',
    // Perplexity
    'perplexitybot',
    'perplexity-user',
    // Anthropic (Claude)
    'claudebot',
    'anthropic-ai',
    'claude-web',
    // Google AI Overviews + Bard / Gemini
    'google-extended',
    // Apple Intelligence
    'applebot-extended',
    // Meta AI (Llama crawlers)
    'meta-externalagent',
    // Amazon AI search
    'amazonbot',
];

function botPatternBody() {
    const m = middlewareSrc.match(/const BOT_PATTERN\s*=\s*\/([^\n]+)\/i;/);
    assert.ok(m, 'middleware.js must define BOT_PATTERN as /…/i regex literal');
    return m[1];
}

test('§1 BOT_PATTERN includes every required AI-search bot UA', () => {
    const body = botPatternBody();
    for (const ua of REQUIRED_AI_BOTS) {
        assert.match(body, new RegExp(ua, 'i'),
            `BOT_PATTERN must include "${ua}" — backend prerender otherwise never sees ${ua} requests`);
    }
});

test('§1 BOT_PATTERN is anchored as a case-insensitive regex', () => {
    // /…/i is mandatory — User-Agent header casing is unpredictable
    // (e.g. "GPTBot" vs "gptbot/1.0"). A case-sensitive pattern would let
    // real-world UAs slip through.
    assert.match(middlewareSrc, /const BOT_PATTERN\s*=\s*\/[^\n]+\/i;/,
        'BOT_PATTERN must end with /i flag');
});

test('§1 BOT_PATTERN keeps the legacy Google + social tokens', () => {
    // Regression guard — adding AI bots must NOT drop the May-15 baseline.
    const body = botPatternBody();
    for (const ua of [
        'googlebot', 'adsbot-google', 'storebot-google',
        'bingbot', 'facebookexternalhit', 'twitterbot', 'linkedinbot',
        'applebot', 'pinterest',
    ]) {
        assert.match(body, new RegExp(ua, 'i'),
            `BOT_PATTERN must keep legacy token "${ua}"`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — /shop?brand=<slug> → /api/prerender/brand/<slug>
// ─────────────────────────────────────────────────────────────────────────────

test('§2 middleware references the brand prerender endpoint', () => {
    assert.match(middlewareSrc, /\/api\/prerender\/brand\//,
        'middleware.js must route brand-hub bots to /api/prerender/brand/<slug>');
});

test('§2 brand prerender path is built from the ?brand= query param', () => {
    // The brand slug must come from url.searchParams.get('brand') — never
    // from path slicing (Vercel 301s /brand/:slug to /shop?brand=:slug, so
    // by the time middleware fires, brand only lives in the query).
    assert.match(middlewareSrc,
        /searchParams\.get\('brand'\)[\s\S]{0,400}\/api\/prerender\/brand\/\$\{encodeURIComponent\(/,
        'brand prerender path must encodeURIComponent(url.searchParams.get("brand"))');
});

test('§2 brand slug is URL-encoded before interpolation', () => {
    // A slug containing apostrophes or non-ascii chars must not break the
    // backend URL. encodeURIComponent is the canonical guard.
    const m = middlewareSrc.match(/\/api\/prerender\/brand\/\$\{(encodeURIComponent\([^)]+\))\}/);
    assert.ok(m, 'brand prerender slug must be wrapped in encodeURIComponent(...)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — /shop?brand=X&printer_slug=Y → printer prerender (narrower wins)
// ─────────────────────────────────────────────────────────────────────────────

test('§3 middleware still references the printer prerender endpoint', () => {
    assert.match(middlewareSrc, /\/api\/prerender\/printer\//,
        'printer hub bot routing must remain — printer-canonical contract');
});

test('§3 printer prerender route comes BEFORE brand inside the /shop branch', () => {
    // Both branches read printer_slug + brand and the printer arm must fire
    // first when both are set. We pin this by source order: the
    // `prerender/printer` reference must appear ahead of `prerender/brand`
    // inside the /shop block.
    const shopBlockStart = middlewareSrc.indexOf("path === '/shop'");
    const shopBlockEnd = middlewareSrc.indexOf('if (!prerenderPath)', shopBlockStart);
    assert.ok(shopBlockStart > 0 && shopBlockEnd > shopBlockStart, 'expected a /shop branch in middleware');
    const block = middlewareSrc.slice(shopBlockStart, shopBlockEnd);
    const printerIdx = block.indexOf('/api/prerender/printer/');
    const brandIdx = block.indexOf('/api/prerender/brand/');
    assert.ok(printerIdx > -1 && brandIdx > -1, 'both prerender refs must live inside /shop branch');
    assert.ok(printerIdx < brandIdx,
        'printer prerender ref must precede brand ref so the narrower intent wins');
});

test('§3 legacy ?printer= alias for printer_slug is preserved', () => {
    // Old bookmarks + indexed URLs still emit /shop?printer=<slug>. Even
    // though new emissions use printer_slug, we must keep the back-compat
    // fallback so crawlers visiting cached URLs still get the prerender.
    assert.match(middlewareSrc,
        /searchParams\.get\('printer_slug'\)\s*\|\|\s*(?:url\.)?searchParams\.get\('printer'\)/,
        'middleware must accept legacy ?printer= as a fallback for ?printer_slug=');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — bare /shop (no brand, no printer) falls through to the SPA
// ─────────────────────────────────────────────────────────────────────────────

test('§4 /shop branch only sets prerenderPath when brand or printer is present', () => {
    // We extract the /shop branch and assert that prerenderPath is never
    // assigned unconditionally — it must be gated on a query-param check.
    const shopBlockStart = middlewareSrc.indexOf("path === '/shop'");
    const shopBlockEnd = middlewareSrc.indexOf('if (!prerenderPath)', shopBlockStart);
    const block = middlewareSrc.slice(shopBlockStart, shopBlockEnd);
    // Every prerenderPath assignment inside the block must be inside an `if (...)`.
    const assigns = block.match(/prerenderPath\s*=\s*`/g) || [];
    assert.ok(assigns.length >= 2,
        '/shop branch must assign prerenderPath at least twice (brand + printer)');
    // No bare assignment outside an `if` — search for assignment at column 4
    // / 6 (function-body indents) outside a conditional. We approximate by
    // requiring an `if (` appears between the branch start and every
    // assignment.
    let cursor = 0;
    let m;
    const ifRe = /if\s*\(/g;
    const assignRe = /prerenderPath\s*=/g;
    while ((m = assignRe.exec(block)) !== null) {
        const lastIf = block.lastIndexOf('if (', m.index);
        assert.ok(lastIf > -1 && lastIf < m.index,
            'every prerenderPath= inside /shop branch must follow an `if (...)` guard');
        cursor = m.index;
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — CCBot / Bytespider are deliberately NOT routed
// ─────────────────────────────────────────────────────────────────────────────

test('§5 BOT_PATTERN does NOT include CCBot or Bytespider', () => {
    // Backend robots.txt blocks both (low-value scrapers, Common Crawl /
    // ByteDance). The Vercel middleware should not waste a Render hop on
    // them either — falling through to the SPA matches the robots.txt
    // block in spirit.
    const body = botPatternBody();
    assert.doesNotMatch(body, /ccbot/i,
        'BOT_PATTERN must not include CCBot — backend blocks it via robots.txt');
    assert.doesNotMatch(body, /bytespider/i,
        'BOT_PATTERN must not include Bytespider — backend blocks it via robots.txt');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — /brand/:slug + /brands/:slug 301 to /shop?brand=:slug
// ─────────────────────────────────────────────────────────────────────────────

test('§6 /brand/:slug redirects to /shop?brand=:slug (permanent)', () => {
    const r = (vercelCfg.redirects || []).find(x => x.source === '/brand/:slug');
    assert.ok(r, 'vercel.json must redirect /brand/:slug');
    assert.equal(r.destination, '/shop?brand=:slug');
    assert.equal(r.permanent, true, 'must be a 301 — brand-hub URL canonicalises to /shop?brand=');
});

test('§6 /brands/:slug + /brands/:slug/hub also redirect to /shop?brand=:slug', () => {
    // Multiple brand-hub URL shapes have existed historically — every one
    // must funnel into the single ?brand= canonical so the brand prerender
    // is the only entry point AI bots see.
    const sources = ['/brands/:slug', '/brands/:slug/hub'];
    for (const src of sources) {
        const r = (vercelCfg.redirects || []).find(x => x.source === src);
        assert.ok(r, `vercel.json must redirect ${src}`);
        assert.equal(r.destination, '/shop?brand=:slug');
        assert.equal(r.permanent, true);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — /llms.txt proxied through Vercel
// ─────────────────────────────────────────────────────────────────────────────

test('§7 /llms.txt rewrites to the backend', () => {
    // llmstxt.org defines /llms.txt at the root of the domain. Agents look
    // for it via the same convention as /robots.txt — a same-host
    // root-relative GET. Without a Vercel rewrite, the customer domain
    // returns 404 and agents never discover the catalog.
    const r = (vercelCfg.rewrites || []).find(x => x.source === '/llms.txt');
    assert.ok(r, 'vercel.json must rewrite /llms.txt to the backend');
    assert.match(r.destination, /ink-backend-zaeq\.onrender\.com\/llms\.txt$/,
        '/llms.txt destination must be the backend');
});

test('§7 /robots.txt is still proxied (regression guard)', () => {
    // Adding /llms.txt must not displace the existing /robots.txt proxy —
    // the backend robots.txt is the source of truth for AI bot allow lists.
    const r = (vercelCfg.rewrites || []).find(x => x.source === '/robots.txt');
    assert.ok(r, 'vercel.json must keep the /robots.txt proxy');
    assert.match(r.destination, /ink-backend-zaeq\.onrender\.com\/robots\.txt$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 — SPA-side dateModified parity (Gemini-live / Bing-live see the DOM)
// ─────────────────────────────────────────────────────────────────────────────

test('§8 shop-page.js CollectionPage JSON-LD emits dateModified', () => {
    // The backend prerender already emits MAX(items.updated_at) for bots that
    // read the static HTML. AI agents that re-render the SPA (Gemini live,
    // some Bing-live reads) see the DOM, so the client emission must carry a
    // matching freshness signal — otherwise the two surfaces disagree and AI
    // engines may weight neither well.
    assert.match(shopPageSrc, /"dateModified"\s*:\s*this\._collectionDateModified\(\)/,
        'shop-page.js CollectionPage payload must include a dateModified field');
});

test('§8 _collectionDateModified prefers MAX(updated_at) over render time', () => {
    // The honest signal is the freshest product timestamp on the page; only
    // when no product carries updated_at does the helper fall back to now.
    assert.match(shopPageSrc, /_collectionDateModified\s*\(/,
        'shop-page.js must define _collectionDateModified()');
    assert.match(shopPageSrc, /updated_at[\s\S]{0,400}Date\.parse\(/,
        '_collectionDateModified must parse product.updated_at to compute MAX');
    assert.match(shopPageSrc, /new Date\(max \|\| Date\.now\(\)\)\.toISOString\(\)/,
        '_collectionDateModified must fall back to render time when no updated_at exists');
});

// ─────────────────────────────────────────────────────────────────────────────
// §9 — PDP emits ZERO client-side JSON-LD (regression of marketing-audit)
// ─────────────────────────────────────────────────────────────────────────────

test('§9 product/index.html ships no static JSON-LD', () => {
    // The backend product prerender is the single source for Product /
    // BreadcrumbList / FAQPage JSON-LD. Re-introducing a static <script>
    // tag here would create dual emission (one from SPA + one from
    // prerender), which Google deduplicates by weight rather than merge.
    // Locked by marketing-audit-may2026; re-asserted here so an AI-search
    // refactor can't accidentally undo it.
    assert.doesNotMatch(pdpHtml, /application\/ld\+json/,
        'product/index.html must not ship any static JSON-LD');
});

test('§9 middleware routes /products/:slug/:sku to product prerender', () => {
    // The static-JSON-LD removal in §9 is only safe if every bot hitting a
    // PDP URL ends up at the backend prerender layer. The /products/ branch
    // is the canonical post-May-2026 path; pin it so a refactor can't drop it.
    assert.match(middlewareSrc, /path\.startsWith\('\/products\/'\)[\s\S]{0,400}\/api\/prerender\/product\//,
        'middleware must route /products/:slug/:sku to /api/prerender/product/<sku>');
});

// ─────────────────────────────────────────────────────────────────────────────
// §10 — Cache headers on prerender responses keep AI bots seeing fresh HTML
// ─────────────────────────────────────────────────────────────────────────────

test('§10 prerender responses include stale-while-revalidate', () => {
    // Backend handoff §2 requires a Cloudflare cache purge after deploy —
    // but the Vercel response itself also caches for 1h with SWR=24h. SWR
    // is what lets post-deploy edits surface to bots without a manual purge.
    assert.match(middlewareSrc, /stale-while-revalidate=86400/,
        'prerender responses must set stale-while-revalidate=86400 (24h)');
    assert.match(middlewareSrc, /s-maxage=3600/,
        'prerender responses must set s-maxage=3600');
});

test('§10 prerender responses set X-Prerendered: true (observability)', () => {
    // The header makes "did the bot see prerender HTML or SPA?" answerable
    // from a single curl. Without it, the only way to tell is by content
    // shape (faq-heading / dateModified) — slow and unreliable.
    assert.match(middlewareSrc, /'X-Prerendered'\s*:\s*'true'/,
        "middleware must stamp X-Prerendered: true on every prerender response");
});
