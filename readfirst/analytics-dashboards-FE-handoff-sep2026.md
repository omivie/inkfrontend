# Frontend brief — analytics dashboards (Sep 2026)

Three jobs, smallest first. All endpoints are **live in production now** and
returning real data.

Base URL: `https://api.inkcartridges.co.nz`
Auth: admin bearer token, same as every other `/api/admin/*` call.
Envelope: `{ ok, data, meta }` — rows in `data`, everything else in `meta`.

---

## Job 1 — One-line fix, do this first

**The storefront truncates the click-tracking `element` value at 80 characters.**
Find it in the tracking snippet that posts to `POST /api/analytics/traffic-event`
— it's the code building `element` as `link:{href}` / `btn:{label}`.

**Change 80 → 200.**

Why it matters: a product link is recorded as `link:/products/{slug}/{SKU}`, and
80 characters cuts the SKU off mid-token. The backend recovers what it can
(exact SKU → exact slug → unique slug prefix) but that only rescues 66% of
clicks. The rest are unattributable. The API accepts up to 512 and the database
column is unlimited, so 200 is safe and closes the gap immediately.

Nothing else changes. No backend work needed.

---

## Job 2 — Catalogue engagement panels (new)

Two endpoints. Both take optional `from` / `to` as `YYYY-MM-DD`; omit them and
you get the last 30 days, so a chart can call them with no arguments on first
paint.

### `GET /api/admin/analytics/catalog/products`

Most-viewed and most-clicked cartridges.

| query param | type | default |
|---|---|---|
| `from`, `to` | `YYYY-MM-DD` | last 30 days |
| `source` | `genuine` \| `compatible` | both |
| `brand_id` | uuid | all |
| `limit` | 1–500 | 50 |
| `include_offshore_bounces` | boolean | `false` (see "Scraper filter") |

```jsonc
{
  "ok": true,
  "data": [{
    "product_id": "681e1a82-…",
    "sku": "GMC853KCMY",
    "name": "OKI Genuine MC853KCMY Toner Cartridge MC853 KCMY 4-Pack (7,000 pages)",
    "source": "genuine",              // genuine | compatible
    "product_type": "toner_cartridge",
    "retail_price": 1370.99,
    "brand": "OKI",
    "brand_slug": "oki",
    "views": 13,
    "unique_viewers": 6,
    "clicks": 6,
    "unique_clickers": 3,
    "engagement": 19,                 // views + clicks — the sort key
    "units_sold": 1,
    "revenue": 1192.17,
    "view_to_sale_rate": 0.0769       // null when views = 0, NOT 0
  }],
  "meta": {
    "range": { "from": "2026-08-04", "to": "2026-09-03" },
    "filters": { "source": "all", "brand_id": null },
    "ranked_by": "engagement (views + clicks)",
    "total_products_engaged": 509,    // count BEFORE limit — use for "50 of 509"
    "totals": { "views": 767, "clicks": 423, "units_sold": 184 },
    "offshore_bounce_views_excluded": 73,
    "coverage": { "views": "…", "clicks": "…", "bots": "…" }
  }
}
```

### `GET /api/admin/analytics/catalog/brands`

| query param | type | default |
|---|---|---|
| `from`, `to` | `YYYY-MM-DD` | last 30 days |
| `limit` | 1–200 | 50 |
| `include_offshore_bounces` | boolean | `false` |

```jsonc
{
  "ok": true,
  "data": [{
    "brand_id": "284261c0-…",
    "brand": "Brother",
    "brand_slug": "brother",
    "brand_page_views": 524,   // /shop?brand=brother
    "hub_visitors": 220,
    "product_views": 263,      // views of Brother cartridges
    "product_viewers": 199,
    "product_clicks": 157,
    "engagement": 944,         // the three summed — sort key only
    "units_sold": 85,
    "revenue": 6667.34
  }],
  "meta": {
    "range": {},
    "ranked_by": "engagement (brand page views + product views + product clicks)",
    "total_brands_engaged": 21,
    "unmatched_brand_slugs": [],
    "coverage": {}
  }
}
```

### Rendering rules that matter

- **`view_to_sale_rate: null` is not zero.** Null means nothing was viewed, so
  the rate is unknown. Render it as an em-dash. Rendering null as `0%` tells the
  operator a product is failing to convert when nothing is actually known.
- **Keep `brand_page_views` and `product_views` as separate columns.** They mean
  different things — browsing a brand hub vs examining that brand's cartridges.
  Canon draws nearly as many hub visits as Epson (293 vs 301) but under half the
  product views; OKI is the reverse. `engagement` exists to sort by, not to
  display on its own.
- **Show `meta.offshore_bounce_views_excluded` somewhere.** See below.
- **`unmatched_brand_slugs` should normally be empty.** Anything in it is a brand
  slug the storefront links to that has no brand record — a dead link. Surface
  it as a warning rather than swallowing it.
- **`total_products_engaged` is the pre-limit count** — use it for "showing 50 of
  509", don't infer totals from `data.length`.

### Scraper filter — why some numbers are lower than raw

Default-on, and worth understanding before someone "fixes" it.

The first version of this leaderboard had a scraper at #1: one SKU, 42 views
from 42 rotating IPs, a single identical user-agent, 98% non-NZ, one pageview
each, over three days, zero sales. The crawler check at collection time can't
see it — the user-agent claims to be ordinary Chrome.

So the filter is behavioural: **an offshore session that viewed exactly one page
is not a customer.** It removes ~8.7% of views and **keeps 100% of New Zealand
traffic** — no domestic visitor is ever filtered.

`?include_offshore_bounces=true` returns the unfiltered view if someone wants to
audit it. `meta.offshore_bounce_views_excluded` reports the count either way —
please surface it, because a filter the operator can't see is one they'll
eventually be misled by.

### Coverage caveat to display

`meta.coverage` ships on every response. Worth showing near the table:

- **Views are complete** — rank on these.
- **Clicks are ~66% complete** until Job 1 ships — treat as directional.
- **Bots excluded** on two levels.

---

## Job 3 — Acquisition dashboards (endpoints already existed, data is new)

Search Console was connected on 3 Sep, so these now return real SEO numbers for
the first time: 16,525 distinct queries across 1,944 pages, backfilled to June.

- `GET /api/admin/analytics/acquisition/summary` — channel totals + source status
- `GET /api/admin/analytics/acquisition/landing-pages` — incoming URLs ranked
- `GET /api/admin/analytics/acquisition/search-terms` — organic queries
- `GET /api/admin/analytics/acquisition/timeseries` — for graphing

### Two rules here

**1. `null` and `0` mean different things in the SEO/Ads columns.**
`null` = that source isn't connected. `0` = connected and genuinely zero. Render
them differently, or an unconnected integration reads as "no traffic".
`meta.sources` tells you which is which. Right now: Search Console connected,
Google Ads not (awaiting API access from Google).

**2. Never sum the SEO/Ads columns down the landing-pages table.**
First-party rows are split by channel, but Google's figures are per-URL — it has
no idea which channel we classified a session into. The same path under Direct,
Paid and Organic carries the *same* `seo_impressions` on all three rows:

```
/    Direct   354 sessions   seo_impressions 4218
/    Paid     108 sessions   seo_impressions 4218   ← the same 4218, not another
/    Organic   40 sessions   seo_impressions 4218
```

Summing reports 12,654 against a true 4,218. Show the SEO block only on the
first row of each path group, or collapse by path before totalling.

---

## Reference docs (backend repo)

- `docs/admin/catalog-engagement-backend-contract-sep2026.md`
- `docs/admin/acquisition-analytics-backend-contract-aug2026.md`
