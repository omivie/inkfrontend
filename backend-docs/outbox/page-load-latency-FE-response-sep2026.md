# Page-load latency — frontend response (2026-09-25)

**Answers:** `page-load-latency-findings-sep2026.md` (yours, 2026-09-21; filed at `backend-docs/inbox/`).
**FE refs:** ERR-282, ERR-283, ERR-284, ERR-285. **New ask:** BF-069.

Every item was re-measured against production on 2026-09-25 before we changed anything. Every "after"
figure below comes from `npm run probe:page-latency -- --browser`, a READ-ONLY probe that runs a first-time
visitor in a fresh browser context and aborts analytics/beacon/search writes before they leave the browser.

Both of your backend fixes held when we checked them: `/api/products/popular` is cached, and
`counts?brands=` returns what you describe, including `meta.unknown_brands`. Thank you for the diagnosis.
Two of your premises did not hold, and one of them would have shipped stale code if we had applied it as
written. Details below.

## Item by item

| Your item | Verdict | What we did |
|---|---|---|
| Content-Type on every GET forces a preflight | **Right** | Fixed. Before: /shop 13 of 17 API GETs preflighted, PDP 9 of 22. `_rawJsonFetch` (the PDP's product read) had the same header, and we fixed that too. |
| `counts?brands=` — adopt on /shop | **Right, and worse than you saw** | Adopted, one request. Also: the tile code read `data.count`, a field this endpoint has never returned. **Every brand tile's count had been blank since it was written**, so the ten requests painted nothing. |
| `immutable` on `/(css\|js\|assets)/(.*)` "because the URLs are hash-versioned" | **Premise false** | Applied only where it is true (below). |
| Cloudflare: four families `DYNAMIC` | **Already done by 2026-09-25** | All four go MISS→HIT now. Details below. |
| `site_settings` read straight from Mumbai | **Right** | Needs your route: **BF-069** below. |
| Beacon posts to the Render host | **Right, and the code looked right** | Fixed. Cause below. |
| `pages.css` 418KB | Agreed | The owner deferred the split until the caching fix has been measured. |
| PDP: two 200-row pulls | Overlap confirmed | Kept on purpose. See below. |
| Search page: "same query three times" | **Framing not right** | Kept. See below. |

## The `immutable` premise

Only the HTML `<script>`/`<link>` tags are hash-versioned. `stamp-versions.js` rewrites those at deploy
with an 8-hex md5. Nothing else under `/js` or `/assets` is versioned:

- about 114 admin modules load by bare `import './x.js'`;
- three lazy imports carry a hand-bumped `?v=APP_VERSION` / `CC_VERSION` / `SETTINGS_VERSION`;
- `traffic-tracker.js` and `business-demo.js` are injected from JS with no token;
- 0 of 97 `/assets` references carry a token.

With `immutable` on the whole prefix, any edit to one of these would have stayed stale in a browser
for up to a year.

What shipped: `/js` and `/css` each have two mutually exclusive rules, keyed on the query string:

```json
{ "source": "/js/(.*)", "has":     [{ "type": "query", "key": "v", "value": "^[0-9a-f]{8}$" }],
  "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
{ "source": "/js/(.*)", "missing": [{ "type": "query", "key": "v", "value": "^[0-9a-f]{8}$" }],
  "headers": [{ "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }] }
```

So only a deploy-stamped content hash is immutable. `/assets` and the root icons get `max-age=86400`,
because they are unversioned. HTML is unchanged. The probe checks three negative controls on every run:
the bare URL, a non-hex `?v=`, and the live `APP_VERSION` import. All three must keep revalidating.
Without those controls, "immutable everywhere" would also read green.

## The beacon

`traffic-tracker.js` already used `Config.API_URL`, which is the api subdomain on production. The
problem was load order. `gtag.js` is a synchronous `<head>` script that injects the tracker async, while
`config.js` is `defer` at the end of `<body>`. So the tracker usually ran **before `Config` existed** and
fell back to `onrender.com`. We confirmed this live on /shop and on a PDP. The fallback now uses the same
host rule as `config.js`.

## Also found: the site lock locked out its owner (ERR-283)

On production, `site-guard.js` verified the admin at a relative `/api/admin/verify`. That path 404s on www
since the `/api` rewrite was removed. With the site locked, the owner could not get past the overlay. It
now calls `api.inkcartridges.co.nz`, where the route answers 401 without a token, as expected.
**Nothing needed on your side.** We mention it because `/api/admin/verify` will now receive these calls
from the www origin with `credentials: 'include'`.

## Cloudflare — already done, and two things it changes

Measured 2026-09-25 with the browser `Origin`, three GETs each:

| path | now |
|---|---|
| `/api/images/optimize?url=<real image>` | MISS→HIT (a bogus `url` BYPASSes, so measure with a real one) |
| `/api/prerender/category/ink` | MISS→HIT, `s-maxage=86400` |
| `/api/schema/collection?category=ink` | MISS→HIT, `s-maxage=3600` |
| `/api/search/smart`, `/api/search/suggest` | MISS→HIT |
| `/api/schema/site` | HIT (was uncached) |

1. **BF-039 is closed again on our side.** Our `audit:edge-cache` could not see the fix until today. Its
   search rows expected `header-only`, and the probe only waits for a HIT on rows that expect `cached`.
   We have corrected that.
2. **BF-064 is live again.** Search payloads carry `in_stock`/`stock_quantity`. With `/api/search/*`
   edge-cached, a stock write can go unseen in search for up to `s-maxage` + `stale-while-revalidate`.
   The ask in the 2026-09-16 brief stands: purge the search keyspace on a stock write, or use
   `Cache-Tag: product:<sku>`. Please do **not** fix it by removing the cache.

Your note about the 250ms debounce also changes: a repeated keystroke-settle is now answered at the edge
and spends no rate-limit slot.

## Kept on purpose

- **PDP `/api/products?…&source=compatible&limit=200`** is the compat sidecar in `getShopData`. It was
  kept under ERR-158 ("removing a fallback is a behaviour change") and ERR-277. `probe:lookalike`
  re-measures what it recovers. The last two rows it recovered were retired packs, so it is a candidate for
  removal on the next measurement, but not blind.
- **Search page.** `/suggest` and `/products?search` fire **only** on a hard miss, a soft miss (a digit
  query with fewer than 50 direct rows), a hijack, or `?exact=1`. `/smart` alone mis-corrects numeric
  codes: q=511 became "Lexmark MX 511", and q=650 missed PGI650. The merged set is what makes the results
  page a superset of the dropdown. If `/smart` stops mis-correcting numeric codes, the soft-miss leg can go.

## BF-069 — the site lock over Cloudflare

`site-guard.js` runs on every public page:
`GET lmdlgldjgcanknsjrcxh.supabase.co/rest/v1/site_settings?select=value&key=eq.site_locked`.
You measured 0.47–1.59s for it. You offered an edge-cached `/api/site/*` route, and we would like to take it:

- `GET /api/site/lock` returning `{ ok: true, data: { enabled: boolean, message: string|null } }`. That is
  the shape of `site_settings.value` today.
- Cached like `/api/site/trust` (public, edge-cached), with a **short** `s-maxage` (60s suggested). A lock
  should land in about a minute.
- Purge it on the admin write (`js/admin/pages/site-lock.js` upserts `site_settings` directly, so the
  purge needs a hook on your side, or the admin write moves to an API route that purges).
- Please keep it fail-open on error, as the current read is: a Supabase outage must not lock the site.

When the route exists, we switch `site-guard.js` to it and drop the Supabase read.

— frontend
