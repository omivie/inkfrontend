# Backend response to the four frontend replies (2026-09-25)

**Answers:**
- `bundle-response-FE-reply-sep2026.md` (ERR-286, BF-070)
- `page-load-latency-FE-response-sep2026.md` (ERR-282..285, BF-069)
- `tier-multiplier-approval-FE-response-sep2026.md` (ERR-281, BF-068)
- `mobile-atc-dead-zone-FE-response-sep2026.md` (ERR-280)

Everything below marked **shipped** is in the commit that carries this document. It reaches production when Render deploys that commit, so check `/health` for the commit before you re-run a probe.

---

## 1. One reversal first: the Dymo `ZDY` rows

**Please do not treat "the nine Dymo names: go" as done. We have not applied it, and it would have made things worse.**

Our 2026-09-21 answer said these nine rows were real Dymo parts behind the supplier's `ZDY` prefix, so `source='genuine'` was right and only the name leaked. **That was wrong.** Today we read the supplier's own feed file (`feed-files/genuine/DSNZ.txt`), and every one of the nine is described as compatible stock:

```
"DCS0720500","Compat Dymo Blk on Clr",           … "ZDYA45010"
"DCS0722400","Compat Dymo Label 36mm x 89mm",    … "ZDY99012"
"DCS0722480","Compat Dymo LeverArch 59 x 190",   … "ZDY99019"
```

So your original report was right: these are compatible labels sold on pages that say "Dymo Genuine". Stripping `ZDY` from the names would have made a compatible label read as "Dymo Genuine 99019", which is a cleaner false claim, not a fix. The operator's hand rename of `GZDY99012` to "Compatible tape for Dymo…" was the only correct label of the nine.

**Root cause (shipped).** The genuine importer already skips DSNZ rows whose description starts `Compat`, but only on its XLSX path. The feed has been arriving as `DSNZ.txt` (the CSV path), which had no such skip. Most of DSNZ's 246 compatible rows are still turned away there, because their brand column says "White Box" and fails the brand allow-list. These nine say "Dymo", so they got in. The skip now runs on both paths.

**Done: the owner retired all nine (2026-09-25).** They are `is_active=false`, so they drop out of listings, search and the Merchant feed as caches expire. The name fix has been deleted from the repair script, and a test stops it from coming back.

## 2. BF-070 (bundle reply §3)

| Item | Status | Detail |
|---|---|---|
| (a) `/api/ribbons` past-the-end `total: null` | **Shipped** | Past the end, the route now runs the same filters as a head-count, so the total is real. `/api/printers/browse` had the same gap and is fixed too. `/shop` still reports `null` past the end, because its normal pages return no total either. |
| (b) `GET /api/admin/export/products` | **Retired** | `type=products` is now a 400. Your in-browser export is the right tool for that job. Two defects in the same handler are also fixed. First, the `X-Export-Truncated` header was compared against the requested `.limit()` (10,000 or 50,000), but PostgREST returns at most 1,000 rows, so the header could never fire. It now compares against 1,000. Second, the ribbons export's `brands=` filter used a plain embed, which filters nothing. It is now `!inner`. That param takes brand **names**. |
| (c) `brand` on `/api/admin/products` | **Shipped** | The param takes a slug or a brand id. Anything else, including a comma list, is `400 UNKNOWN_BRAND`, never the whole catalogue. |
| (d) `/image-audit/list?status=watermark_hold` | **Shipped** | Added to the enum. |
| (e) BF-027 three rows | **Shipped, and it was wider than 3** | See below. |
| (f) `G71C0Z50CMY`, `GC950X73GCMY` as `single` | **No change, on purpose** | See below. |
| (g) `/api/admin/invoices` | **Shipped** | `linked=true\|false` is added, and the route is now `strictQuery`. **Every other unknown param now returns 400.** Check that nothing on your side sends one, such as a cache-buster. |
| (h) Ask 6 `import-status` empty | **Shipped** | The route queried `script_name IN ('genuine.js','compatible.js')`, but the importers log `genuine` and `compatible`, so it never matched. Each feed now returns its last 5 runs, with `dry_run` included. `latest` is the latest run of **any** status. Read its `status` field: the genuine feed has had failed runs, the most recent on 2026-09-23. |
| (i) The two supplier-list POSTs | **Confirmed, no change** | `POST /api/admin/feed-files/product-list` and `POST /api/admin/import/supplier-price-list` both accept an owner session (`verifyCronOrOwner`). The catalogue feed slots, `feed-files/genuine` and `feed-files/compatible`, still require `CRON_SECRET` in production. A 403 on those two is deliberate. |
| (k) `/api/shop?brand=` | Noted | We will change it when we need to. |

**(e) The yield tier.** Two new rules:

- `PG660XLHY` (glued `XLHY`) now reads as XL.
- Lexmark `…H[KCMY]0` now reads as XL. A Lexmark MPN is platform + **capacity** + **colour** + region, so `C333HY0` means "High-yield Yellow". It is not an `HY` token.

Your detector found only the yellows, because it keys on the letters `HY`. Their cyan, magenta and black siblings (`74C6HC0`, `C333HK0` and so on) were also STD. We replayed the new rules over all 4,069 active products: **46 changed** (45 Lexmark singles and the Canon row), and none lost.

`G288BXLCMY` stays STD, and we are not going to raise it. Please exempt it in your probe. The supplier's description is "Epson 288 **B**XL CMY **STD** PACK", and the MPN is C13T306696. That reads as a 288XL **black** plus **standard** C/M/Y, a mixed-capacity pack. No single tier is true for it, and three of its four cartridges are standard. That also means the name "CMY 3-Pack" is probably wrong, since the pack likely holds four cartridges. That is a supplier/owner question, so we have not changed the name.

**(f) The two kits.** Each is one OEM part number in one box: `71C0Z50` is Lexmark's "CMY 150K Imaging Kit", and `C950X73G` is a "CMY Photo Kit". In our model, `pack_type` means a bundle of separately sold parts. Marking these as packs would send them through the pack guards, which look for constituent singles these kits do not have. They are `single` for the same reason a tri-colour cartridge is. Your Pack filter counting them as singles is correct.

## 3. Owner decisions (bundle §4)

- **Dymo:** see §1. We did not apply the rename; the nine rows are retired.
- **`GCE980A`: done.** The colour is null, and the row is now `waste_toner`, named "HP Genuine CE980A Waste Toner Unit". Both fields are pinned so the import cannot revert them, and the old slug 301s to the new one. We also fixed the root cause of the colour: the importer read "HP **Color LJ** Toner Kit" (Color LaserJet, the printer family) as a tri-colour hue.
- **`CBCI6KCMY` / `CBCI3KCMY`:** agreed, we are waiting for the feed.
- **The 13 malformed printer slugs: done (2026-09-25). No active printer row has a malformed slug any more.**
  - **Retired, with a `printer_slug_redirects` hop to the existing page for the same machine:** `brother-label-printer-(vc-500w)`, `fuji-xerox-wc3550@-a`, `hp-2700/2700e`, `hp-laserjet\mfp6801`, the four `lexmark-ms/mx-*10` rows (each to `lexmark-ms*10`) and `oki-ml-182/390/…` (to `oki-ml182`).
  - **Retired with no hop, because they are not printers:** `whether-you’re-labeling-files`, `oki-$100works` and `nakajima-x-600'` (a ribbon-length fragment, "16 in. x 600'").
  - **Renamed:** `canon-laserclass-4000/4500` → `canon-laserclass-4000-4500`.
  - **Links carried over:** only where the fit is certain. The CZ-1003 roll went to the VC-500W page, and genuine HP 67 went to `hp-deskjet-2700`. The HP 138A/X and Lexmark `G41XBK` links were NOT carried over. The supplier's own printer lists for those parts disagree with each other, and `G41XBK` is misnamed: its MPN `50F0Z0E` is a Lexmark MS/MX imaging unit, not a "41X Toner Cartridge". **Fixed 2026-09-26:** the row is now "Lexmark Genuine 500ZBK Drum Unit 500Z Black", typed `drum_unit`, with both fields pinned and a 301 from the old slug. It is the same imaging unit as `G500ZBK` (part 50F0Z00), and it now shares the 500Z series chip with it. The SKU still reads `G41XBK`, because a SKU rename is its own migration.

## 4. Page-load latency

**BF-069: shipped.** `GET /api/site/lock` returns `{ ok: true, data: { enabled: boolean, message: string|null } }`. An empty message is `null`.

- The cache header is `Cache-Control: public, max-age=0, s-maxage=60`, and the path is already covered by the `/api/site` Cache Rule.
- **There is no purge, on purpose.** The admin panel writes `site_settings` directly, so there is no backend write to hook. The 60 s edge TTL is the bound, so a lock lands within about a minute, which is what you asked for. If you later move the admin write behind an API route, we can add a purge then.
- **It fails open.** On a read error it returns `enabled: false` with `Cache-Control: no-store`, so the error answer is never cached over a real lock.

**BF-064: not built, and here is why.** The only stock writes during the day come from paid orders. Imports and admin edits already clear the caches and purge the edge. After an order, search can show a stale `in_stock` for at most `s-maxage` 300 + `stale-while-revalidate` 600, about 15 minutes. That cannot oversell: `create_order_atomic()` re-checks stock under a row lock at checkout. Compatible stock is always 100, so this only affects genuine rows whose last unit just sold. We agree the answer is never to remove the cache. If you measure this actually happening, we will add a search-prefix purge on the order path.

**ERR-283:** `/api/admin/verify` from the www origin with `credentials: 'include'` already works: CORS runs with `credentials: true` and echoes the allowed origin, and www is an allowed origin (every storefront API call already depends on that). No change needed.

## 5. Tier multiplier approval (BF-068)

- **2.1: shipped.** `aggregate.delivered` holds the twins of every `*_after` figure, with the ratchet applied: `avg_retail_change_pct`, `avg_net_margin_after`, `net_profit_per_unit_after`, `net_profit_per_unit_delta`, `catalogue_value_after` and `below_survival_floor_after`. The plain `*_after` fields keep their table-price meaning, so nothing you already render changes.
- **2.2: shipped.** Every impact now carries two more blocks:
  - `baseline`: `{ global_offset, total_skus_with_increase, total_skus_with_decrease, will_change_skus, blocked_skus, net_profit_per_unit_delta, net_profit_per_unit_delta_delivered }`. This is the same scan priced at the live ladder and offset.
  - `edit_only`: `{ skus_priced_differently, net_profit_per_unit_delta_delivered }`. This is the proposal net of the drift, and it is your "this edit alone" figure, computed server-side.

  Both blocks appear in the simulate response, the stored proposal snapshot and the approval snapshot. Snapshots stored before this deploy do not have them, so treat the blocks as optional. You can drop your second no-change simulate.
- **2.3: shipped.** Simulate now runs the same checks as the PUT and returns the same error codes: `UNKNOWN_TIER_BAND`, `INVALID_BAND_LADDER`, and `UNKNOWN_BRAND` for a brand id that does not exist. `proposed_tiers.brands` must be keyed by brand id; a non-id key is a 400, where before it was silently dropped. **One behaviour change:** an omitted `global_offset` used to mean 0 and now means the offset in force. Today both are 0, but on a catalogue running at +0.02, the old default would have previewed a store-wide cut.
- **2.4: do not use `POST /admin/pricing/reprice` as the retry.** That route is synchronous, stops at 2,000 rows (it returns `capped: true`) and returns no job id. With `{}`, you would have repriced about the first 2,000 products and had nothing to poll. Its body is `{ scope?, dry_run? }`, and it responds with `{ dry_run, matched, updated, would_change, unchanged, skipped_frozen, skipped_ineligible, capped, sample }`.
  **Shipped instead:** `POST /admin/pricing/reprice-jobs` with body `{ proposal_id? }` returns `202 { job_id, status }`. It queues the same full-catalogue background job that approval queues, and attaches it to the proposal when you pass `proposal_id`. Poll `GET /admin/pricing/reprice-jobs/:jobId` as before. The `enqueue_failed` message now names this route.
- `effective` carrying `bands` and `brands`: correct, and deliberate.

## 6. Mobile Add-to-Cart

- **The two scripts are in the backend repo (`ink_backend`), not yours.** Our handoff should have said so. `scripts/verify-mobile-cta-occlusion.js` is ours. The `networkidle` / 60000 ms error came from its earlier version, which now waits for `domcontentloaded`. `scripts/ads/pause-mobile-until-checkout-fixed.js` was deleted on 2026-09-23, when the owner ruled out device exclusion.
- **There is nothing to lift.** Mobile and tablet have been serving since 2026-09-23. We checked today: the live Search campaign has no device bid adjustment.
- **§8 applied to us, and it is fixed.** Both of our browser scripts that load production pages, `verify-mobile-cta-occlusion.js` and `benchmark-competitor-frontends.js`, ran with analytics live. So every run fired `view_item` into GA4 and the UET conversion. Both now block the collect and conversion endpoints: GA4, Google Ads, UET, Clarity, Meta, and our own `/api/analytics/*`. They still load the tag libraries, so page-weight figures stay comparable. The blocking lives in `scripts/lib/blockAnalyticsBeacons.js`.
- 390x664 vs 390x844: agreed. We made the same mistake on 2026-09-21, and our probe already uses the device registry.
