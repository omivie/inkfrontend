const BACKEND = 'https://ink-backend-zaeq.onrender.com';

const BOT_PATTERN = /googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|applebot|pinterest|semrushbot|ahrefsbot|mj12bot|dotbot|rogerbot|embedly|quora link preview|showyoubot|outbrain|chrome-lighthouse|google-structured-data-testing-tool/i;

export default async function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  if (!BOT_PATTERN.test(ua)) return;

  const url = new URL(request.url);
  const path = url.pathname;
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
  // /brands/:slug → brand
  else if (path.startsWith('/brands/')) {
    const slug = path.split('/').filter(Boolean)[1];
    if (slug) prerenderPath = `/api/prerender/brand/${encodeURIComponent(slug)}`;
  }
  // /ink-cartridges → category/ink
  else if (path === '/ink-cartridges') {
    prerenderPath = '/api/prerender/category/ink';
  }
  // /toner-cartridges → category/toner
  else if (path === '/toner-cartridges') {
    prerenderPath = '/api/prerender/category/toner';
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
  // /printers/:slug → printer (extract brand from slug prefix)
  else if (path.startsWith('/printers/')) {
    const slug = path.split('/').filter(Boolean)[1];
    if (slug) {
      // Printer slugs are like "hp-deskjet-2700" — extract brand as first segment
      const parts = slug.split('-');
      const brand = parts[0];
      prerenderPath = `/api/prerender/printer/${encodeURIComponent(brand)}/${encodeURIComponent(slug)}`;
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
    '/products/:path*',
    '/brands/:path*',
    '/ink-cartridges',
    '/toner-cartridges',
    '/html/ribbons',
    '/html/ribbons.html',
    '/html/shop',
    '/html/shop.html',
    '/printers/:path*',
  ],
};
