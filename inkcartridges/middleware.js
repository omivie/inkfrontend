const BACKEND = 'https://ink-backend-zaeq.onrender.com';

const BOT_PATTERN = /googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|pinterest|semrushbot|ahrefsbot|mj12bot|dotbot|rogerbot|embedly|quora link preview|showyoubot|outbrain|chrome-lighthouse|google-structured-data-testing-tool/i;

export default async function middleware(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Gate admin routes — redirect to login if no auth cookie
  if (path.startsWith('/html/admin')) {
    const cookie = request.headers.get('cookie') || '';
    if (!/__ink_auth=1/.test(cookie)) {
      const loginUrl = new URL('/html/account/login.html', request.url);
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
  // /html/ribbons → category/ribbons
  else if (path === '/html/ribbons' || path === '/html/ribbons.html') {
    prerenderPath = '/api/prerender/category/ribbons';
  }
  // /html/shop?brand=X&printer_slug=Y → printer
  else if (path === '/html/shop' || path === '/html/shop.html') {
    const brand = url.searchParams.get('brand');
    const printerSlug = url.searchParams.get('printer_slug');
    if (brand && printerSlug) {
      prerenderPath = `/api/prerender/printer/${encodeURIComponent(brand)}/${encodeURIComponent(printerSlug)}`;
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
    '/html/admin/:path*',
    '/html/admin',
    '/products/:path*',
    '/product/:path*',
    '/html/product',
    '/html/ribbons',
    '/html/ribbons.html',
    '/html/shop',
    '/html/shop.html',
  ],
};
