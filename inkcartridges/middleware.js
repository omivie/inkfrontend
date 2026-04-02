export default async function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  const isCrawler = /googlebot|bingbot|yandex|baiduspider|facebookexternalhit|twitterbot|linkedinbot|slurp/i.test(ua);

  if (!isCrawler) return;

  const url = new URL(request.url);

  if (!url.pathname.startsWith('/products/')) return;

  // Extract SKU from /products/{slug}/{sku}
  const segments = url.pathname.split('/').filter(Boolean);
  const sku = segments[segments.length - 1];

  if (!sku) return;

  const prerenderUrl = `https://ink-backend-zaeq.onrender.com/api/prerender/product/${encodeURIComponent(sku)}`;

  const response = await fetch(prerenderUrl, {
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
      'Cache-Control': 'public, s-maxage=86400, max-age=3600',
      'X-Prerendered': 'true',
    },
  });
}

export const config = {
  matcher: '/products/:path*',
};
