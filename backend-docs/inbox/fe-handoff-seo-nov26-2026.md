# Frontend handoff: SEO recovery fixes (26 Nov 2026)

**For:** frontend developer, `omivie/inkfrontend`. **From:** backend.
**Line numbers** are from frontend `main` at `85bbc90` (2026-11-26). If `main` has moved, find the lines by the quoted code, not by the number.
**Background:** `docs/seo/seo-recovery-phase1-nov2026.md` and `docs/seo/seo-recovery-phase2-nov2026.md`.
**Never deploy between 13:55 and 15:30 UTC.** The daily import runs then.

| Priority | What | Where | Effort |
|---|---|---|---|
| **P0** | A prerender 429 gives crawlers the empty shell with a 200. Forward the crawler's IP plus a shared secret. | `middleware.js` ~327–366 + Vercel env | 1 h |
| **P1** | Release the FE-1…FE-4b patches through Preview, then Production | `docs/seo/phase2-nov2026/fe-handoff-preview.md` | staged, ≥ 48 h apart |
| **P2** | Bare domain 307 → 308. Trailing slash 404 → 308. | Vercel Domains + `vercel.json` | 15 min |
| **P2/P3** | Mobile speed: checklist item 32, image dimensions and lazy loading | `index.html`, `html/index.html`, `css/pages.css`, `js/*` | 1–2 days |

---

## P0. Crawlers get the empty shell once the prerender limit is hit

### What happens today

`/api/prerender/*` allows **30 requests per minute per IP** (backend `src/routes/prerender.js`, `prerenderLimiter`).
Your middleware fetches every bot page from a few Vercel egress IPs. So Googlebot, Bingbot and every AI crawler share
**one** 30/min bucket. Once that bucket is empty, the backend answers 429. `middleware.js:366` (`if (!response.ok) return;`)
then falls through to the SPA shell, and the crawler gets a **200 with an empty canonical and no content**. Google
reads that as a Soft 404.

Measured on 2026-11-26: we sent 40 Googlebot-UA requests to sitemap URLs. The first 30 were prerendered. The last 10
were the shell (`X-Prerendered` absent, canonical `/shop` or empty).

### Backend side (already shipped)

The limiter now keys on the crawler's real IP, but only when the request proves it came from your middleware:

| Header (sent by middleware.js) | Value |
|---|---|
| `X-Prerender-Secret` | the value of env `PRERENDER_PROXY_SECRET` |
| `X-Prerender-Client-IP` | the crawler's IP: one IPv4 or IPv6 address, nothing else |

In each of these cases the backend ignores both headers and keys on the connecting IP, as before:

- the secret is missing or wrong;
- the backend has no secret, or one shorter than 32 characters;
- the IP header is not a single valid IP.

The backend never skips the limit on User-Agent. A request that only claims to be Googlebot is still limited.

We use a dedicated header, not `X-Forwarded-For`, because Render's proxy rewrites `X-Forwarded-For` on the way in.

### Env var: one name, the same value on both sides

```
PRERENDER_PROXY_SECRET=<64 hex chars>
```

1. **Backend (owner, done on our side):** the value was generated once (`openssl rand -hex 32`) and set on Render, service `ink-backend-sg` → Environment. The owner sends it to you by a private channel. Never put it in a commit, a ticket or a chat log.
2. **Vercel (FE dev, your step):** Project → Settings → Environment Variables → add `PRERENDER_PROXY_SECRET` with the value the owner sent:
   - tick **Production** and **Preview** (both call the same backend);
   - mark it **Sensitive**;
   - redeploy, because a new env var only reaches the middleware after a deploy.
   - Do not generate your own value. A value that differs from the backend's falls back to the shared bucket, and nothing will tell you.

Order does not matter, and every partial state is safe:

- secret on one side only → the headers are ignored, and behaviour is exactly as today;
- values that do not match → same as today, as the fallback.

Nothing breaks during the change-over.

### Change 1: forward the crawler IP and the secret

**www is behind Cloudflare** (`server: cloudflare`, `cf-ray` on every response). So on Vercel, `x-real-ip` is a
Cloudflare edge IP, not the crawler. The crawler's IP is in `cf-connecting-ip`. Anyone can send that header straight
to Vercel and skip Cloudflare, so trust it **only** when the connecting IP is one of Cloudflare's own addresses.
Otherwise a scraper could rotate a fake IP per request and never hit the limit.

Add the following near `prerenderUnavailable()` (`middleware.js` ~455):

```js
// Cloudflare's published ranges: https://www.cloudflare.com/ips-v4 and /ips-v6.
// Re-check them against those two URLs when you add this.
const CF_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CF_V6 = [/^2400:cb00:/i, /^2606:4700:/i, /^2803:f800:/i, /^2405:b500:/i, /^2405:8100:/i, /^2a06:98c[0-7]:/i, /^2c0f:f248:/i];

const v4int = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  return Math.floor(v4int(ip) / size) === Math.floor(v4int(base) / size);
}
function fromCloudflare(ip) {
  if (!ip) return false;
  return ip.includes(':') ? CF_V6.some((re) => re.test(ip)) : CF_V4.some((c) => inV4(ip, c));
}

// The crawler's IP: cf-connecting-ip only when Cloudflare itself connected to us, else the connecting IP.
function crawlerIp(request) {
  const edge = (request.headers.get('x-real-ip') || '').trim();
  const viaCf = (request.headers.get('cf-connecting-ip') || '').trim();
  return fromCloudflare(edge) && viaCf ? viaCf : edge;
}

// Lets the backend rate-limit per crawler, not per Vercel egress IP. Empty when the env var is unset.
function prerenderProxyHeaders(request) {
  const secret = process.env.PRERENDER_PROXY_SECRET;
  const ip = crawlerIp(request);
  return secret && ip ? { 'X-Prerender-Secret': secret, 'X-Prerender-Client-IP': ip } : {};
}
```

Then change the prerender fetch at `middleware.js:327`:

```diff
     const response = await fetch(`${BACKEND}${prerenderPath}`, {
       headers: {
         'User-Agent': ua,
         'Accept': 'text/html',
+        ...prerenderProxyHeaders(request),
       },
       redirect: 'manual',
```

`slugHop()` (~line 413) fetches a www-style path, not `/api/prerender/*`, so it needs no change.
**Never send these headers to any host except `BACKEND`.**

### Change 2: a 429 is an outage, not a missing page

`middleware.js:365–366`:

```diff
-    if (response.status >= 500) return prerenderUnavailable();
+    // 429 = the prerender limit, a temporary refusal. Serving the shell with a 200 here is a Soft 404.
+    if (response.status >= 500 || response.status === 429) return prerenderUnavailable();
     if (!response.ok) return;
```

`prerenderUnavailable()` already returns **503 + `Retry-After: 120`**, `no-store` and `noindex` (ERR-296).
Googlebot slows down and retries a 503 without dropping the URL.

### Tests to add (`node --test`)

- With the env var set, the prerender fetch carries both headers.
- With it unset, the fetch carries neither.
- `crawlerIp`:
  - `x-real-ip` 162.158.1.1 (Cloudflare) + `cf-connecting-ip` 66.249.66.1 → 66.249.66.1;
  - `x-real-ip` 203.0.113.9 (not Cloudflare) + `cf-connecting-ip` 66.249.66.1 → 203.0.113.9.
- A backend 429 returns 503 with `Retry-After`. A backend 404 still falls through.

### Done when

The checks are §5 rows 1–3 below:

- one network sends a Googlebot burst of 40: the result is 30 prerendered and then 503s, never a 200 without `X-Prerendered`;
- a second network, straight after, gets its own 30.

---

## P1. Release FE-1 to FE-4b (patches are ready)

Everything is in `docs/seo/phase2-nov2026/fe-handoff-preview.md` (backend repo):

- six `git format-patch` files in `fe-patches/`, with `SHA256SUMS`;
- the base is `064879a5` and the tested tip is `90798b4a`;
- the tree hash must be `4ef169c76c334ed680e1bb37079bef07e8e919cc`.

Follow §2 of that file to apply them on a preview branch. P0 above is separate: it can ship first, on its own.

**Three stages:**

1. **Vercel Preview.** Apply all six patches on `seo-phase2-preview`, push, and let Vercel build the Preview. Then check:
   - **Canonicals:** every listing and product URL has a self-referencing canonical in the **raw** HTML (`curl`, no JS). Never `/shop` and never empty.
   - **Titles and H1:** the raw HTML `<title>` and `<h1>` match what the API prerender gives for the same URL (FE-1).
   - **Content parity:** a category page shows visitors the same intro, product list and FAQ that Googlebot gets. Today a visitor sees about **532 words** and the bot HTML has about **2,031**. After FE-3/3b the two must be within a few percent of each other.
   - **Real 404s:** an unknown printer or product returns **404 + `X-Robots-Tag: noindex`** (FE-2), not the shell with a 200. Try `/shop?brand=hp&printer_slug=zz-not-a-printer` and `/products/zz-not-a-product/ZZNOTASKU`.
   - **Valid URLs are untouched:** a real printer, product, category and `/ribbons` all return 200 with the correct canonical.
   - **Tests:** `node --test tests/*.test.js` gives fail 0.
2. **Production, staged** (§6 of the preview doc):
   - **Stage A:** 0001–0002 (head/H1, real 404).
   - **Stage B, at least 48 h later:** 0003–0004 (listing content, JSON-LD).
   - **Stage C, at least 48 h later:** 0005–0006 (home FAQ JSON-LD, `/ribbons`).

   Each stage needs the owner's go-ahead. Before each stage, note the current production deployment ID so you can roll back.
3. **After each stage (at 1 h, 24 h and 48 h):**
   - rerun the §5 checks below;
   - in Search Console, run URL Inspection (live test) on one category, one product and one not-found URL;
   - check Vercel logs for 5xx errors.

   **Roll back** with Vercel Instant Rollback on any trigger in §6 of the preview doc. Examples: a real URL returns 404, a canonical points at `/shop`, p75 TTFB rises by more than 300 ms.

---

## P2. Redirects: 308 everywhere

Measured on 2026-11-26:

| Request | Today | Want |
|---|---|---|
| `https://inkcartridges.co.nz/` | **307** → `https://www.inkcartridges.co.nz/` | **308**, same target, path and query kept |
| `https://www.inkcartridges.co.nz/ink-cartridges/` | **404** | **308** → `/ink-cartridges` |

A 307 is temporary, so Google keeps the bare domain as a separate URL. A 308 passes the signals to www for good.

**Bare domain:**

1. In Vercel, open Project → Settings → **Domains** → `inkcartridges.co.nz` → Edit.
2. Choose "Redirect to `www.inkcartridges.co.nz`" with status **308 Permanent Redirect** → Save.
3. If the redirect is not set there, it is a Cloudflare Redirect Rule (dash → Rules → Redirect Rules). In that case set status **308** there instead, with "Preserve query string" on.

**Trailing slash:** `vercel.json:2` already has `"cleanUrls": true`. Add one line under it:

```diff
 {
   "cleanUrls": true,
+  "trailingSlash": false,
   "buildCommand": "npm run build",
```

With `trailingSlash: false`, Vercel answers any path ending in `/` (except `/` itself) with a **308** to the path without
it, and the query string is kept. Check on the Preview that the middleware matcher paths (`/products/:path*` etc.) and
`/shop?…` still answer 200 without the slash.

---

## P2/P3. Mobile speed (checklist item 32) and images

**Spec: `docs/storefront/mobile-speed-FE-handoff-oct2026.md`.** Summary in `docs/storefront/FE-MASTER-CHECKLIST-oct2026.md`, item 32.

Lighthouse mobile scores 58–60, with LCP 11.8–15.0 s. These are still open on `85bbc90`:

1. **No entrance animation on the first screen.** `body` and `main` fade in from `opacity: 0`, and each `<section>` waits for the scroll reveal or its 2 s safety net. The first visible frame comes at 1.6–3.2 s even with no throttling. Paint the first screen at full opacity, and keep the reveal only for sections below the fold.
2. **`css/pages.css` blocks rendering:** 391,807 B raw (85,922 B over the wire), 14,313 lines. It is loaded at `index.html:45` on every page. Split it per page, or inline the first-screen CSS and load the rest with `media="print" onload="this.media='all'"`. Target: under 60 KB of render-blocking CSS on a mobile first view.
3. **Too many scripts on the home page.** `index.html` has 30 `<script>` tags, about 25 of them external. Put `defer` on everything not needed for the first paint (`gtag.js` included), and load each page's JS only on that page.

### Ink-finder brand logos: 18 `<img>` with no `width`/`height`

There are nine logos each in `index.html:405–429` and `html/index.html:353–377`. The same nine are in `html/account/printers.html:336–360`; fix them there too.

Give each `<img>` the `width`/`height` of its **displayed** size. The height comes from `css/pages.css:345–353`, and the width keeps the file's aspect ratio. Add `loading="lazy" decoding="async"` as well, after checking on a 390×844 screen that the finder sits below the fold. (If it is in the first screen, use no `loading` attribute on it.)

| File | Intrinsic | CSS height | `width` × `height` | File size |
|---|---|---|---|---|
| `brother.png` | 3461×809 | 48px | `width="205" height="48"` | 41,633 B |
| `canon.png` | 3840×839 | 39px | `width="179" height="39"` | 29,974 B |
| `epson.png` | 1280×315 | 21px | `width="85" height="21"` | 28,204 B |
| `hp.png` | 2129×2129 | 36px | `width="36" height="36"` | 74,554 B |
| `samsung.svg` | 7051×1080 (viewBox) | 21px | `width="137" height="21"` | 4,459 B |
| `lexmark.png` | 1200×237 | 24px | `width="122" height="24"` | 22,199 B |
| `oki.svg` | 100×50 (viewBox) | 28px | `width="56" height="28"` | 223 B |
| `fuji-xerox.png` | 400×80 | 28px | `width="140" height="28"` | 21,953 B |
| `kyocera.svg` | 180×40 (viewBox) | 24px | `width="108" height="24"` | 228 B |

Example:

```html
<img src="/assets/brands/brother.png" alt="Brother" width="205" height="48" loading="lazy" decoding="async"
     class="ink-finder__brand-img ink-finder__brand-img--brother">
```

`pages.css:713` sets kyocera to 18px on small screens. The CSS height still wins; the attributes only reserve the aspect ratio.

**Resize the PNGs too.** They are 1,200–3,840 px wide and display at 36–48 px tall (about 218 KB in total). Re-export each at 2× its display size, for example `brother.png` at 410×96, and use WebP. Target: under 5 KB each.

### Images rendered by JS

| Line | What | Change |
|---|---|---|
| `js/cart.js:861` | cart line thumbnail | add `loading="lazy" decoding="async"` and `width`/`height` equal to the CSS thumbnail box |
| `js/order-detail-page.js:157` | order line thumbnail | same as above |
| `js/product-detail-page.js:1011`, `:1018` | PDP main image (the LCP element; it has `fetchpriority="high"`) | **do not lazy-load it.** Add `width`/`height` (the product images are square, so the rendered box size, e.g. `width="600" height="600"`) so the box is reserved before the image arrives |
| `js/product-detail-page.js:1070` | placeholder SVG | add `width`/`height` matching the main image box |
| `js/product-detail-page.js:3937` | lightbox `<img>` | none: it loads on click |

Also lazy-load every other `<img>` built for a below-the-fold list: related products, pack offers and the drilldown grids.

**Item 32 is done when:**

- with Lighthouse mobile settings, the series page and `GLC233BK` have **LCP < 4.0 s** and **CLS < 0.1**;
- a cold desktop load of `/ink-cartridges` has CLS < 0.05;
- the first frame shows the header and the h1.

---

## 5. Verification checklist (run after each deploy)

```bash
UA_G='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

# 1. P0: Googlebot burst of 40 cold URLs from ONE network.
#    Before the fix: 30 × "200 true", then 10 × "200 -" (shell = Soft 404).
#    After the fix:  "200 true" for every request under the limit, then "503 -" with Retry-After. NEVER "200 -".
curl -s https://www.inkcartridges.co.nz/sitemap-printers.xml | grep -o '<loc>[^<]*' | sed 's/<loc>//; s/&amp;/\&/g' | head -40 > /tmp/urls.txt
while read -r u; do
  curl -s -o /dev/null -A "$UA_G" -w '%{http_code} %header{x-prerendered}\n' "$u" | sed 's/ $/ -/'
done < /tmp/urls.txt | sort | uniq -c
# (%header needs curl 7.84+. On an older curl: curl -s -D - -o /dev/null … | grep -iE '^(HTTP|x-prerender)')

# 2. P0: run row 1 again at once from a SECOND network (phone hotspot), using the next 40 URLs (sed -n 41,80p).
#    It must start again at "200 true". That proves the limit is per crawler, not per Vercel egress IP.

# 3. Backend alone (owner, with the secret): 35 distinct client IPs in one minute all pass.
S='<PRERENDER_PROXY_SECRET>'
for i in $(seq 1 35); do
  curl -s -o /dev/null -w '%{http_code}\n' -H "X-Prerender-Secret: $S" -H "X-Prerender-Client-IP: 203.0.113.$i" \
    https://ink-backend-sg.onrender.com/api/prerender/static/about
done | sort | uniq -c        # expect: 35 200

# 4. P2: trailing slash → 308 to the path without it.
curl -sI https://www.inkcartridges.co.nz/ink-cartridges/ | grep -iE '^(HTTP|location)'
#    expect: HTTP/2 308 · location: /ink-cartridges

# 5. P2: bare domain → 308 to www, path and query kept.
curl -sI 'https://inkcartridges.co.nz/ink-cartridges?x=1' | grep -iE '^(HTTP|location)'
#    expect: HTTP/2 308 · location: https://www.inkcartridges.co.nz/ink-cartridges?x=1

# 6. P1 (FE-2): an unknown printer or product returns a real 404 + noindex, for a bot and for a browser.
for ua in "$UA_G" 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'; do
  curl -sI -A "$ua" 'https://www.inkcartridges.co.nz/shop?brand=hp&printer_slug=zz-not-a-printer' | grep -iE '^(HTTP|x-robots-tag)'
  curl -sI -A "$ua" 'https://www.inkcartridges.co.nz/products/zz-not-a-product/ZZNOTASKU' | grep -iE '^(HTTP|x-robots-tag)'
done
#    expect each: HTTP/2 404 · x-robots-tag: noindex

# 7. P1 (FE-1): a self-referencing canonical in the raw HTML (no JS).
curl -s -A "$UA_G" https://www.inkcartridges.co.nz/ink-cartridges | grep -o '<link rel="canonical"[^>]*>'
#    expect: href="https://www.inkcartridges.co.nz/ink-cartridges"

# 8. P2/P3: mobile performance.
npx -y lighthouse@12 https://www.inkcartridges.co.nz/ink-cartridges --form-factor=mobile --only-categories=performance --view
```

Send back:

- the output of rows 1, 2, 4, 5 and 6;
- the Lighthouse LCP, CLS and score;
- the Vercel deployment ID for each stage.
