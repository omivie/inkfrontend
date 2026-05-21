const BACKEND = 'https://ink-backend-zaeq.onrender.com';

// `adsbot-google` and `storebot-google` are intentionally listed even though
// `googlebot` is already present — the AdsBot ("AdsBot-Google", "AdsBot-Google-
// Mobile") and StoreBot ("Storebot-Google") user-agents do NOT contain the
// substring "googlebot", so without explicit tokens they would fall through to
// the SPA. marketing-audit-may-2026.md §4 states the prerender layer is meant
// to serve "Googlebot/Storebot/AdsBot"; these tokens make that true. It also
// keeps client-side JSON-LD removal (§4) safe: every Google crawler that reads
// structured data now receives the backend-prerendered HTML (one Product
// schema), never the SPA.
//
// AI-search bots (May 2026 — see readfirst/ai-search-readiness-may2026.md):
// ChatGPT/Perplexity/Claude/Google-AI-Overviews/Gemini agents identify with
// their own UA strings (GPTBot, ChatGPT-User, OAI-SearchBot, PerplexityBot,
// Perplexity-User, ClaudeBot, anthropic-ai, Claude-Web, Google-Extended,
// Applebot-Extended, meta-externalagent, Amazonbot). The backend's robots.txt
// + botPrerender now explicitly *allow* these UAs and route them to the
// rich prerender HTML (with dateModified + visible FAQ + page-updated). The
// Vercel middleware is the first hop on the customer domain, so those UAs
// must be in BOT_PATTERN here too — otherwise the request falls through to
// the SPA shell (no FAQ, no dateModified, no citation signal) and the
// backend changes are cosmetic. CCBot + Bytespider are deliberately NOT
// listed: the backend robots.txt blocks them (low-value scrapers); FE
// matches by simply not routing them to the prerender either.
const BOT_PATTERN = /googlebot|adsbot-google|storebot-google|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|pinterest|semrushbot|ahrefsbot|mj12bot|dotbot|rogerbot|embedly|quora link preview|showyoubot|outbrain|chrome-lighthouse|google-structured-data-testing-tool|gptbot|chatgpt-user|oai-searchbot|perplexitybot|perplexity-user|claudebot|anthropic-ai|claude-web|google-extended|applebot-extended|meta-externalagent|amazonbot/i;

export default async function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Gate admin routes — redirect to login if no auth cookie
  if (path === '/admin' || path.startsWith('/admin/')) {
    const cookie = request.headers.get('cookie') || '';
    if (!/__ink_auth=1/.test(cookie)) {
      const loginUrl = new URL('/account/login', request.url);
      loginUrl.searchParams.set('redirect', path + url.search);
      return Response.redirect(loginUrl.toString(), 302);
    }
  }

  const ua = request.headers.get('user-agent') || '';
  if (!BOT_PATTERN.test(ua)) return;

  let prerenderPath = null;

  // / → home
  if (path === '/' || path === '') {
    prerenderPath = '/api/prerender/home';
  }
  // /products/:slug/:sku → product
  else if (path.startsWith('/products/')) {
    const segments = path.split('/').filter(Boolean);
    const sku = segments[segments.length - 1];
    if (sku) prerenderPath = `/api/prerender/product/${encodeURIComponent(sku)}`;
  }
  // /product/:slug → legacy product (redirects to by-slug prerender)
  else if (path.startsWith('/product/')) {
    const segments = path.split('/').filter(Boolean);
    const slug = segments[1];
    if (slug) prerenderPath = `/api/prerender/product-by-slug/${encodeURIComponent(slug)}`;
  }
  // /html/product?sku=X → product (direct hits from scanners/crawlers)
  else if (path === '/html/product' || path === '/html/product/') {
    const sku = url.searchParams.get('sku');
    if (sku) prerenderPath = `/api/prerender/product/${encodeURIComponent(sku)}`;
  }
  // /p/:sku → product (clean SKU-only fallback)
  else if (path.startsWith('/p/')) {
    const sku = path.slice(3).replace(/\/+$/, '');
    if (sku) prerenderPath = `/api/prerender/product/${encodeURIComponent(sku)}`;
  }
  // /ribbons → category/ribbons
  else if (path === '/ribbons') {
    prerenderPath = '/api/prerender/category/ribbons';
  }
  // /ink-cartridges → category/ink, /toner-cartridges → category/toner.
  //
  // Spec (brand-canonical audit, May 2026): the backend's CollectionPage
  // schema for `/api/schema/collection?category=ink` returns
  // `collectionPage.url = /ink-cartridges` (not the old /ink 404 path), and
  // the SPA is now mounted at /ink-cartridges and /toner-cartridges as
  // rewrites (vercel.json) so the rendered URL matches the schema. Bots get
  // the dedicated category prerender from the backend here.
  else if (path === '/ink-cartridges' || path === '/ink-cartridges/') {
    prerenderPath = '/api/prerender/category/ink';
  }
  else if (path === '/toner-cartridges' || path === '/toner-cartridges/') {
    prerenderPath = '/api/prerender/category/toner';
  }
  // /shop?brand=<slug>&printer_slug=<slug> → printer prerender (canonical).
  //
  // Spec (brand-canonical audit, May 2026 — backend handoff): the canonical
  // printer-hub URL ALWAYS carries both `brand` AND `printer_slug`. The
  // backend's prerender endpoint requires both — `/shop?printer_slug=<slug>`
  // alone is no longer a canonical shape (sitemap and internal links never
  // emit it). Gating here on both params keeps the prerender/canonical
  // contract intact: a bot hitting a legacy bare-printer_slug URL falls
  // through to the SPA shell while the backend's slug_redirects layer
  // canonicalises subsequent crawls to the branded form.
  //
  // /shop?brand=<slug> → brand prerender (May 2026 AI-search readiness).
  // /brand/<slug> 301-redirects here (see vercel.json) so this branch is the
  // canonical entry point for brand-hub bots. The backend's brand prerender
  // emits CollectionPage with dateModified + a visible <section class="faq">
  // whose Q/A text is string-identical to the FAQPage JSON-LD acceptedAnswer
  // (cloaking-safe) + a <p class="page-updated"><time> footer. AI engines
  // (ChatGPT/Perplexity/Claude/Gemini/Google-AI-Overviews) cite freshness +
  // FAQ structure heavily; without this branch, AI bots hitting the brand
  // hub get the SPA shell and the backend signals never reach them.
  //
  // Precedence: printer_slug + brand wins. The printer hub is the narrower,
  // more useful intent — a bot landing on /shop?brand=brother&printer_slug=…
  // should get the printer-scoped prerender (compatible cartridges for that
  // model), not the broader brand catalog. `?printer=<slug>` is still
  // accepted as a back-compat alias for printer_slug, but only when paired
  // with brand.
  //
  // Pinned by tests/printer-url-canonical-may2026.test.js (middleware gates
  // section): bare printer_slug must NOT trigger printer prerender.
  //
  // The printer prerender endpoint is `/api/prerender/printer/:brand/:slug`
  // (the slug-only form 404s — see seo-meta-rewrite-may2026.md). A 404 here
  // makes the fetch below bail (`!response.ok`) and the bot falls through to
  // the SPA shell, so the printer hub's SEO copy never reaches crawlers.
  else if (path === '/shop') {
    const brandSlug = url.searchParams.get('brand');
    const printerSlug = url.searchParams.get('printer_slug') || url.searchParams.get('printer');
    if (brandSlug && printerSlug) {
      prerenderPath = `/api/prerender/printer/${encodeURIComponent(brandSlug)}/${encodeURIComponent(printerSlug)}`;
    } else if (brandSlug) {
      prerenderPath = `/api/prerender/brand/${encodeURIComponent(brandSlug)}`;
    }
  }

  if (!prerenderPath) return;

  try {
    const response = await fetch(`${BACKEND}${prerenderPath}`, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html',
      },
    });

    if (!response.ok) return;

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // s-maxage caps how long the CDN serves a single response without
        // revalidating; stale-while-revalidate lets the next request after
        // expiry serve stale immediately while a fresh fetch happens in the
        // background. Without SWR, post-backend-deploy catalog changes
        // (e.g. May 2026 pack-resolver fix that surfaced ~232 more packs)
        // can stay invisible to crawlers for a full hour. With SWR=86400,
        // the first crawler hit after s-maxage expiry triggers a refresh
        // without blocking, so subsequent hits see the new HTML almost
        // immediately. Pinned by tests/dense-pack-rollout-may2026.test.js.
        'Cache-Control': 'public, s-maxage=3600, max-age=3600, stale-while-revalidate=86400',
        'X-Prerendered': 'true',
      },
    });
  } catch {
    return;
  }
}

export const config = {
  matcher: [
    '/',
    '/admin/:path*',
    '/admin',
    '/products/:path*',
    '/product/:path*',
    '/p/:path*',
    '/html/product',
    '/ribbons',
    '/ink-cartridges',
    '/toner-cartridges',
    '/shop',
  ],
};
