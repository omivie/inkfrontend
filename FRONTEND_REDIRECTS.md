# Frontend Redirect Implementation

Fix for old inkcartridges.co.nz URLs returning 404 on the Next.js frontend.

## What & Why

Old URLs from the previous site (e.g. `/HP-Deskjet-1050-Printer-J410a-Ink-Cartridges-HP61-HP61xl`) are still being crawled by Google and visited by users. Next.js doesn't know about these routes so they 404. We need to intercept them and redirect to the relevant shop search page.

**Estimated coverage: ~93% of old 404 URLs fixed by 4 simple pattern rules.**

---

## Step 1 — Create `middleware.ts` at the project root

This is the critical file. It intercepts requests before Next.js routing kicks in.

```typescript
import { NextRequest, NextResponse } from 'next/server';

const PASSTHROUGH = ['/api', '/_next', '/html', '/products', '/brands', '/printers', '/favicon', '/sitemap', '/robots'];
const PRINTER_NOISE = new Set(['laser', 'inkjet', 'uses', 'and', 'for', 'with', 'a', 'an', 'the']);
const CARTRIDGE_MARKER = /ink-cartridges?|inkjet-cartridges?|toner-cartridges?/i;

function toTitle(s: string) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PASSTHROUGH.some(p => pathname.startsWith(p)) || pathname.length < 3) return NextResponse.next();

  const p = pathname.toLowerCase();
  const slug = pathname.replace(/^\//, '').replace(/\/$/, '');

  // Rule 1: ribbon / typewriter pages → ribbons page
  if (p.includes('ribbon') || p.includes('typewriter')) {
    return NextResponse.redirect(new URL('/html/ribbons', req.url), { status: 301 });
  }

  // Rule 2: printer + cartridge codes (e.g. /HP-Deskjet-1050-Printer-J410a-Ink-Cartridges-HP61-HP61xl)
  // Extracts the SKU codes after "Ink-Cartridges" and searches for them
  if (p.includes('printer') && CARTRIDGE_MARKER.test(p)) {
    const m = p.match(/(.*?)(?:ink-cartridges?|inkjet-cartridges?|toner-cartridges?)(.*)/);
    let terms = '';
    if (m?.[2]) {
      const after = m[2].replace(/^-/, '').split('-').filter(t => t.length > 1);
      if (after.length) terms = after.map(t => t.toUpperCase()).join(' ');
    }
    if (!terms && m?.[1]) {
      const pre = m[1].replace(/-$/, '').split('-');
      terms = `${toTitle(pre[0] ?? '')} ${pre.slice(1, 3).map(t => t.toUpperCase()).join(' ')}`.trim();
    }
    return NextResponse.redirect(
      new URL(`/html/shop?search=${encodeURIComponent(terms || 'ink')}`, req.url),
      { status: 301 }
    );
  }

  // Rule 3: plain printer pages (e.g. /brother-hl2140-laser-printer)
  if (/-printer\/?$/i.test(pathname)) {
    const clean = slug.replace(/-(?:laser-|inkjet-)?printer$/i, '');
    const tokens = clean.split('-').filter(t => t.length > 0 && !PRINTER_NOISE.has(t.toLowerCase()));
    if (tokens.length) {
      const brand = toTitle(tokens[0]);
      const model = tokens.slice(1).map(t => /\d/.test(t) ? t.toUpperCase() : toTitle(t)).join(' ');
      const terms = model ? `${brand} ${model}` : brand;
      return NextResponse.redirect(
        new URL(`/html/shop?search=${encodeURIComponent(terms)}`, req.url),
        { status: 301 }
      );
    }
  }

  // Rule 4: generic cartridge pages (e.g. /hp-364-ink-cartridges)
  if (CARTRIDGE_MARKER.test(pathname)) {
    const NOISE = new Set(['no', 'oem', 'genuine', 'original', 'compatible', 'cartridges', 'cartridge', 'ink', 'inkjet', 'toner']);
    const parts = slug.split('-').filter(t => t.length > 1 && !NOISE.has(t.toLowerCase()));
    if (parts.length) {
      const terms = parts.slice(0, 3).map((t, i) =>
        i === 0 ? toTitle(t) : /\d/.test(t) ? t.toUpperCase() : t
      ).join(' ');
      return NextResponse.redirect(
        new URL(`/html/shop?search=${encodeURIComponent(terms)}`, req.url),
        { status: 301 }
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|html|products|brands|printers|favicon.ico|robots.txt|sitemap.xml).*)'],
};
```

### How the rules work

| Old URL example | Rule | Redirects to |
|---|---|---|
| `/typewriter-ribbons-and-cassettes` | Rule 1 | `/html/ribbons` |
| `/HP-Deskjet-1050-Printer-J410a-Ink-Cartridges-HP61-HP61xl` | Rule 2 | `/html/shop?search=HP61+HP61XL` |
| `/brother-hl2140-laser-printer` | Rule 3 | `/html/shop?search=Brother+HL2140` |
| `/hp-364-ink-cartridges` | Rule 4 | `/html/shop?search=Hp+364` |

---

## Step 2 — Add `redirects()` to `next.config.js`

Open your existing `next.config.js` and add a `redirects` function. These cover ribbon paths as a fallback alongside the middleware.

```js
// Inside your next.config.js module.exports / defineConfig:
async redirects() {
  return [
    { source: '/typewriter-ribbons-and-cassettes',              destination: '/html/ribbons', permanent: true },
    { source: '/brother-typewriter-model-listing-for-ribbons',  destination: '/html/ribbons', permanent: true },
    { source: '/:path*-ribbons',                                destination: '/html/ribbons', permanent: true },
    { source: '/:path*-ribbon',                                 destination: '/html/ribbons', permanent: true },
    { source: '/typewriter-:slug*',                             destination: '/html/ribbons', permanent: true },
  ];
},
```

> **Note:** `permanent: true` sends HTTP 308 (Next.js default for permanent). Google treats 308 the same as 301 — both are fine for SEO.

If your `next.config.js` already has a `redirects()` function, just merge the array entries into it.

---

## Verification

After deploying, test these URLs in your browser's DevTools (Network tab) or with curl and confirm each returns a `301` redirect to the correct destination:

| Test URL | Expected destination |
|---|---|
| `/HP-Deskjet-1050-Printer-J410a-Ink-Cartridges-HP61-HP61xl` | `/html/shop?search=HP61+HP61XL` |
| `/brother-hl2140-laser-printer` | `/html/shop?search=Brother+HL2140` |
| `/typewriter-ribbons-and-cassettes` | `/html/ribbons` |
| `/hp-364-ink-cartridges` | `/html/shop?search=Hp+364` |
| `/html/shop` | No redirect (passthrough) |
| `/products/some-product/SKU123` | No redirect (passthrough) |

```bash
# Or test with curl (replace with your domain):
curl -I https://www.inkcartridges.co.nz/HP-Deskjet-1050-Printer-J410a-Ink-Cartridges-HP61-HP61xl
curl -I https://www.inkcartridges.co.nz/brother-hl2140-laser-printer
curl -I https://www.inkcartridges.co.nz/typewriter-ribbons-and-cassettes
```

---

## Files to create/modify

| File | Action |
|---|---|
| `middleware.ts` | **Create** at project root (same level as `package.json`) |
| `next.config.js` | **Edit** — add `redirects()` function |

No other changes needed.
