# FE response to `FE-open-items-checklist-sep2026.md`

**Date:** 2026-09-09 · **From:** frontend · **Re:** all nine items, re-verified

Thanks for the checklist — the §5 CORS fix and the `/api/products/popular`
endpoint were both exactly as described, and the `for-use-in` migration is
clean (§4 below, with numbers).

Before the item-by-item: we re-measured all nine against production rather than
taking the doc's word for it, and **four are already shipped**. Two more are
being done by another workstream. Nothing here is a complaint — §1, §6 and §9
were all closed *after* the dates your source docs carry, so the checklist was
reading its own stale state. But please don't re-open them.

| § | Your status | Measured 2026-09-09 | Now |
|---|---|---|---|
| 1 | SQL footgun in FE repo | Fixed 2026-09-08, see below | ✅ done before you asked |
| 2 | `delivery_type` no default | Real. Your suggested fix would not have worked | 🔧 in progress |
| 3 | Landing pages render 0 prices | Confirmed | 🔧 in progress |
| 4 | PDP reads the column with anon key | Confirmed | ✅ **done, see §4 — you can run mig 132** |
| 5 | `X-Session-Id` unblocked | Confirmed, and verified properly | 🔧 in progress |
| 6 | `element` truncated at 80 | It has been **200** since ERR-204 | ✅ already done |
| 7 | 21 duplicate printer URLs | We measure **15**, and half of this is yours | 🔧 **needs you** |
| 8 | Purge the CDN after §7 | Premise doesn't hold — nothing is cached | ℹ️ no-op |
| 9 | Two admin dashboards unbuilt | Both shipped 2026-09-03 | ✅ already done |

---

## §4 — `for-use-in` cutover is DONE. **You can run migration 132.**

The PDP no longer reads `products.compatible_devices_html`. The Supabase enrich
select is now `id,description_html,related_product_skus`, and the machine list
comes from `GET /api/products/:sku/for-use-in`.

Verified in a real browser, not by grep — 0 requests naming
`compatible_devices_html`, 1 call to the endpoint, and the block paints at
536×196px with the right content.

**Every list survives.** All 91 products carrying a non-null column were
compared old-source vs new-source, paced under the limiter:

```
91 rows with a non-null compatible_devices_html
  87  byte-identical to the endpoint
   4  differ ONLY by your sanitiser (<br> → <br />, &nbsp; → space, trailing trim)
   0  missing
```

Reproduce with `npm run probe:for-use-in`. Its §2 is the gate: it prints
`mig 132 is safe to run` only when the comparison is **complete**, and it
switches to a weaker coverage-floor mode automatically once the column is gone,
saying so on every run.

### One thing to know about your rate limiter

Our first pass at this comparison reported **"43 of 91 lists missing"** and we
nearly sent you that as a data-loss alarm. It was wrong. `forUseInLimiter` is
40/min/IP, and a **429 body has no `for_use_in_html` key**, so a reader doing
`resp.data.for_use_in_html ?? null` scores a refusal as an absence. Re-run
paced: 0 missing.

Not asking you to change it — the endpoint is edge-cached (`s-maxage=300,
stale-while-revalidate=600`, `cf-cache-status: HIT`) and a 45-request burst
against one SKU never reached your origin, so real traffic never sees the limit.
But **if any tool of yours walks many distinct SKUs, it will hit this**, and the
failure mode is a silent false negative rather than an error. Worth a note in
the endpoint docs.

---

## §7 — 15 pairs, not 21. And the half that matters is yours.

### Your source doc was never delivered

The checklist points at `duplicate-printer-urls-FE-handoff-sep2026.md` §3 for
the table of 21 pairs and §4 for "one caveat worth reading before you choose
which side wins". **That file does not exist on our side.** So we derived the
pairs from the live sitemap instead.

### What we measured

`sitemap-printers.xml`, 2026-09-09: 4,088 printer URLs (4,107 by the time we
re-ran). Grouping rule: **same `brand`, slugs identical after stripping every
non-alphanumeric character**. That yields **15 groups, 30 URLs**. Each was then
checked against `/api/products/printer/:slug`: every pair is two distinct
`printer_models` rows returning **identical product sets** — your union fix
working, and the confirmation that they are true duplicates.

We did try fuzzier matching to reach 21 and stopped, because it is dangerous:
edit-distance ≤2 produces **17,686 "pairs"**, and `brother-dcp-130c` /
`brother-dcp-135c` are one character apart and are *different printers*. A
canonical between two real printers doesn't consolidate a duplicate, it deletes
a working page. **If your 21 includes six we can't see, please send the list** —
we'll take it, but we won't guess at it.

### The 15, with the winner we chose

You said the choice was ours, so: the manufacturer's own spelling. The two Fuji
Xerox names were checked against FUJIFILM's own support site.

| Winner (canonical) | Loser (points at winner) |
|---|---|
| `brother-hl-l3230cdw` | `brother-hll-3230cdw` |
| `epson-ecotank-et-2850` | `epson-ec-otank-et-2850` |
| `fuji-xerox-apeosport-vii-c3321` | `fuji-xerox-apeosport---vii-c3321` |
| `fuji-xerox-apeosport-vii-c4421` | `fuji-xerox-apeosport---vii-c4421` |
| `fuji-xerox-docuprint-c1190-fs` | `fuji-xerox-docuprint-c1190fs` |
| `fuji-xerox-docuprint-cm505-da` | `fuji-xerox-docuprint-cm505da` |
| `hp-laserjet-enterprise-m651` | `hp-laser-jet-enterprise-m651` |
| `hp-smart-tank-300` | `hp-smarttank-300` |
| `hp-smart-tank-400` | `hp-smarttank-400` |
| `hp-smart-tank-6000` | `hp-smarttank-6000` |
| `hp-smart-tank-7000` | `hp-smarttank-7000` |
| `hp-smart-tank-7300` | `hp-smarttank-7300` |
| `hp-smart-tank-7600` | `hp-smarttank-7600` |
| `oki-mc362dn` | `oki-mc-362dn` |
| `oki-ml182` | `oki-ml-182` |

### 🔴 The frontend cannot finish this, and you need to know why

**Googlebot does not read our SPA on these URLs.** `middleware.js` prerenders
`/shop?brand=…&printer_slug=…` to `/api/prerender/…`, so the
`<link rel="canonical">` a crawler sees is **written by you**. Measured today:

```
$ curl -A "…Googlebot/2.1…" "https://www.inkcartridges.co.nz/shop?brand=hp&printer_slug=hp-smarttank-7300"
  21,740 bytes, server-rendered
  <link rel="canonical" href="https://www.inkcartridges.co.nz/shop?brand=hp&printer_slug=hp-smarttank-7300">
                                                                              ↑ self-referential: the duplicate

$ curl -A "…Chrome…"  (same URL)
  37,934 bytes, SPA shell
  <link id="canonical-url" rel="canonical" href="https://www.inkcartridges.co.nz/shop">
```

So a canonical set in `shop-page.js` is invisible to the crawler here. **Two
asks:**

1. **The prerenderer should emit the winner's URL as the canonical** for both
   spellings, using the table above.
2. **`sitemap-printers.xml` should list winners only.** Right now both twins are
   submitted as separate pages with identical content, which is what created the
   problem when the union fix made the empty twin qualify for
   `product_compatibility!inner`.

### What we HAVE shipped

The half we own, which is a real signal on its own:

- `PrinterSlug` (`inkcartridges/js/utils.js`) — one owner, no second copy.
- `buildPrinterUrl()` routes every slug through it, so **every internal link the
  site emits now names the winner** — shop cards, saved printers, the ink finder,
  the matched-printer handoff.
- The SPA canonical names the winner too, so the two paths can't contradict.
- Fixed a related gap: a bare `?printer_slug=` with no `brand=` used to
  canonical to itself, even though `middleware.js` gates the printer prerender on
  `brandSlug && printerSlug`. It now carries the brand.
- `npm run probe:printer-canonicals` re-derives the pairs from **your live
  sitemap** on every run and fails if a 16th appears that our table doesn't
  cover — the spellings come from a supplier feed nobody here controls, so this
  is the only thing that will catch drift. Its §4 reports your half and is
  currently 0/4; it says explicitly that this is yours, not a failure of ours.

Accepting a loser slug keeps working and always will — both rows return the same
products, so this only changes which URL we *advertise*.

---

## §8 — the purge is a no-op today

The checklist says `s-maxage=86400` pins the SPA shell for 24 hours. Measured:

```
/shop?brand=…&printer_slug=…   cache-control: public, s-maxage=3600, max-age=3600,
                                              stale-while-revalidate=86400
                                cf-cache-status: DYNAMIC
sitemap-printers.xml            cache-control: public, max-age=3600, s-maxage=86400
                                cf-cache-status: DYNAMIC
```

`DYNAMIC` on both means **Cloudflare is not serving either from cache** — no
Cache Rule matches them. There is nothing to purge and no 24-hour blackout to
work around, so the §7 canonical change will be visible as soon as it deploys.
The `s-maxage=86400` on the sitemap is advisory and currently unused.

If a Cache Rule is ever added for `/shop`, this becomes real again — our probe
reports `cf-cache-status` so we'll see it change.

---

## §1, §6, §9 — please mark these closed

**§1 — the SQL file.** Fixed 2026-09-08 as our ERR-229, *before* this checklist.
It is worth knowing what we found, because it was worse than the footgun you
described: `inkcartridges/` is the published web root, so **all five `.sql` files
were live on the site** (`200`, `application/x-sql`) — including the one with the
blanket grant and a written recipe for minting an `authenticated` JWT from the
anon key. Now: files moved to repo-root `sql/`, the grant narrowed to your six
analytics functions by name and signature, sections 2 and 3 (ALTER DEFAULT
PRIVILEGES + the wide event trigger) deleted, an edge-middleware denylist 404s
`/sql/*` and `/scripts/*`, and `npm run probe:public-surface` checks the live
site. The file's header now says re-running your migration 163 is the fix if the
`42501` recurs.

**§6 — `element` truncation.** Already 200, since ERR-204 (2026-09-03).
`ELEMENT_MAX_CHARS = 200` in `traffic-tracker.js`, pinned by
`tests/traffic-element-truncation-sep2026.test.js`. **Your side still advertises
the old number**: `meta.coverage.clicks` reports an 80-char truncation. That's
where the checklist's figure came from — worth correcting so it doesn't send
someone back here a third time.

**§9 — the two dashboards.** Both shipped 2026-09-03 and rendering live data:
Catalogue Engagement at `#catalog-engagement`, Acquisition at
`#analytics?tab=acquisition`, both reading `meta.sources` for the
not-connected-vs-zero distinction as you specified. Our four outstanding asks on
those are in `analytics-dashboards-FE-response-sep2026.md` and are all backend
side — the rate limiter advertising 30 but 429ing at 21, the
`offshore_bounce_views_excluded` key missing from `/catalog/brands`, `paid_*`
emitting `0` rather than `null` on `/acquisition/search-terms`, and the four
decoy params on `/catalog/products` (`product_type`, `sort`, `offset`, `search`)
that are accepted and ignored, so there is no pagination.

---

## One small thing on `/api/products/popular`

It hard-400s on `consumable` and `label_tape`, which are two of our own internal
category ids. Not a bug on your side — `drums` and `paper` are the right names —
but a 400 on a category we do stock is the ERR-215 shape (an absent or rejected
key hiding a stocked category), so we map ours before calling. Flagging in case
you'd rather accept the aliases.

---

## Verification

```
npm run probe:for-use-in            # §4 — the mig-132 gate, and the rate-limit trap
npm run probe:printer-canonicals    # §7 — drift detector + your half's status
npm test                            # the full suite
```

Logged our side as **ERR-243** (for-use-in cutover) and **ERR-242** (duplicate
printer URLs).
