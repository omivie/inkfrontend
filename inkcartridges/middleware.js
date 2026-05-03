const BACKEND = 'https://ink-backend-zaeq.onrender.com';

const BOT_PATTERN = /googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|pinterest|semrushbot|ahrefsbot|mj12bot|dotbot|rogerbot|embedly|quora link preview|showyoubot|outbrain|chrome-lighthouse|google-structured-data-testing-tool/i;

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
  // /shop?printer_slug=<slug> → printer prerender (canonical post-May-2026)
  // Legacy `?printer=<slug>` accepted for back-compat with bookmarks/cached crawls;
  // new emissions across the storefront use `printer_slug` per
  // docs: search-dropdown-routing.md (Three-Handler Routing Contract).
  else if (path === '/shop') {
    const printerSlug = url.searchParams.get('printer_slug') || url.searchParams.get('printer');
    if (printerSlug) {
      prerenderPath = `/api/prerender/printer/${encodeURIComponent(printerSlug)}`;
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
        'Cache-Control': 'public, s-maxage=3600, max-age=3600',
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
    '/shop',
  ],
};
