# Frontend reply: your response to our four replies (2026-09-28)

**Answers:** `fe-replies-round-backend-response-sep2026.md` (dated 2026-09-25, filed as `backend-docs/inbox/`).
**FE refs:** ERR-291 (this round), ERR-281/286 (earlier rounds). **New asks:** BF-079, BF-080, BF-081.

We measured every claim in production before building on it, on 2026-09-28 against backend `a1c9c67`. You redeployed to `8d1b6f8` mid-session, and we re-ran everything against that build. All of it held. The measurements are re-runnable:

- `npm run probe:bundle-response`: READ-ONLY, GETs plus the admin sign-in.
- `npm run probe:tier-approval`: READ-ONLY, GETs plus `POST /simulate`. It never proposes, approves or queues a reprice.

---

## 1. Dymo `ZDY` reversal: accepted, and thank you for catching it

Nothing on our side acted on "Dymo names: go". No code, test or probe pins the nine rows. We have recorded the reversal against our bundle reply, so nobody re-reads the old decision as open. Retiring the rows was the right call.

## 2. BF-070: what we measured and built

| Item | Measured 2026-09-28 | What the frontend did |
|---|---|---|
| (a) `/api/ribbons` past the end | `total: 109` | Nothing needed. `ribbons-page.js` already renders a real total. The probe now FAILS if `null` comes back. |
| (b) `/export/products` retired | `400` | Nothing calls it; the CSV/Excel/PDF exports are built client-side. The probe asserts the 400. |
| (c) `brand` = slug or id | `hp` 870 = `<hp uuid>` 870 of 4,115; `HP`, `hp,canon` → `400 UNKNOWN_BRAND` | Products sends the dropdown's UUID; our slug mapping is deleted. The export fan-out sends one **id** per pass, and refuses a brand it cannot resolve by name instead of sending it for a 400. **Product Review was sending brand NAMES** and would now 400. It sends slugs. |
| (d) `status=watermark_hold` | `200`, 736 rows | "Watermark hold" is a Status choice on the image audit. |
| (e) yield tier | 0 rows where our detector reads higher than you, net of `G288BXLCMY` (was 3) | **We removed our `max(backend, detected)` merge.** The one remaining raise was `G288BXLCMY`, and your explanation shows it was wrong. The exemption is in the probe. §6 now compares our DETECTOR (field stripped) to your tier and FAILS on any new disagreement, so a regression in your rules reaches us as a red line, not a merged row. |
| (f) the two kits as `single` | — | Agreed. Our Pack filter already counts them as singles. |
| (g) invoices `linked`, `strictQuery` | `linked=true` 0 + `false` 21 = 21; `zz=1` → 400; `sort=total/invoice_number/issue_date` → 200 | Our 20×100 client-side page walk is deleted. The Portal filter sends `linked=` and paginates normally. We send no cache-buster: our request layer never adds query params. A test enumerates every param and sort the list can send against the set measured above. |
| (h) import-status | 5 `recent_runs` per feed, `dry_run` on each | Shown on **Site Health → Infra**, with the whole 5-run window, not just `latest`. See BF-080. |
| (i) the two supplier-list POSTs | — | Noted. The owner's first use is the test. We never call the two catalogue feed slots. |
| (k) `/api/shop?brand=` | — | Noted. |

**One thing we found in our own code while verifying (c):** the image-audit brand dropdown has sent a brand **UUID** since April. `/image-audit/list` and `/image-audit/stats` resolve `brand` by slug only: a UUID or a name answers `404 "Brand not found"`. The page read that 404 as an empty list and showed "🎉 All clean". It sends the slug now, and a failed read is an error card. See BF-081 for the parity question.

## 3. Owner decisions (bundle §4): acknowledged

`GCE980A` as `waste_toner` with a pinned colour, the 13 printer slugs, and `G41XBK` → "Lexmark Genuine 500ZBK Drum Unit": nothing in our code or tests pins any of these rows. Our colour-vocabulary baseline lists `GCE980A` as "reported to backend", and that entry is now answered. `CBCI6KCMY`/`CBCI3KCMY`: waiting with you.

## 4. Page-load latency

- **BF-069: closed.** `GET /api/site/lock` measured: `{ok:true,data:{enabled:false,message:null}}`, `Cache-Control: public, max-age=0, s-maxage=60`, MISS → HIT on `api.inkcartridges.co.nz`. `site-guard.js` reads it (commit `eae0781`) with `credentials: 'omit'`, so every visitor shares one cache entry, and every failure fails open. The admin Site Lock page now tells the owner that a change takes about a minute to reach shoppers. That is the answer to "no purge, on purpose", and we agree with it.
- **BF-064: accepted as not built.** The oversell argument (`create_order_atomic` re-checks under a row lock) is the one that matters. We will come back with a measurement if we see it, not a mechanism.
- **ERR-283:** agreed, no change.

## 5. Tier multiplier approval (BF-068): closed

All four items were measured against production before we built on them:

- **2.1 / 2.2.** On a compatible band cut, `delivered` and the two blocks were present, and `baseline` + `edit_only` = `delivered` to the cent (166.76 + (−15.66) = 151.10). The table figure said **−$609.92** and the shelf figure said **+$151.10**: opposite signs. The panel now leads with the shelf figure and prints the table figure beside it. It runs **one** simulate per preview; our second no-change simulate and the client-side subtraction are deleted. A snapshot without the blocks is labelled "Not split" / "table price", never back-filled with zero.
- **2.3.** `UNKNOWN_TIER_BAND`, `INVALID_BAND_LADDER`, `UNKNOWN_BRAND` and a slug-keyed brand (`VALIDATION_FAILED`) are all 400. The probe asserts each one.
  - **The `global_offset` default change would have bitten us.** We sent the field only when it was non-zero, so "propose 0 against a live +0.02" would have previewed at +0.02. We always send it now.
- **2.4.** Retry now calls `POST /admin/pricing/reprice-jobs {proposal_id}` and polls the returned `job_id`. The proposal id is carried from approval, and from the resume-after-refresh path, to the retry. We had never called `/pricing/reprice` live, and now nothing can.

## 6. Mobile ATC: acknowledged

We have noted that both scripts are yours. Our errors log had carried "reverse the ads stop-loss" as an open item, and it now says the stop-loss was deleted on 2026-09-23 with nothing to reverse. We also appreciate that both of your browser scripts now block beacons.

---

## New asks

### BF-079: `/api/products` drops two value packs from their page after the slice, at `limit` ≥ 100

Measured 2026-09-28, public API, no auth:

```
/api/products?limit=200  pages 9 and 13 return 199 rows; all 21 pages = 4,112 rows, meta.total = 4,114
/api/products?limit=100  pages 17 and 26 return 99 rows
/api/products?limit=10   pages 161–180 and 241–260 return 10 rows each; both SKUs present
```

The two rows are **`G252VPVP`** ("Epson Genuine 252 Ink Cartridge HY 4-Pack") and **`G728300MLCMY`** ("HP Genuine 728 300ml CMY 3-Pack"), both `pack_type: value_pack`. Our guess is that something filters or collapses rows after `range()`. A value-pack guard that looks for constituents on the same page would fit, because a larger page makes the check pass or fail differently. That is only a guess about the mechanism. What we measured is that both rows are present at limit=10 and missing at limit=100/200, while the total still counts them. Any client that pages the catalogue at 200 misses both packs, with no signal. Our probe now fails on `rows ≠ meta.total`.

### BF-080: the genuine feed failed 2 of its last 5 nights, with `errors: 0` both times

From `/supplier/import-status` (UTC, as the API returns them):

```
genuine  started 2026-09-23T14:00:06Z  failed  finished 2026-09-23T14:45:04Z  (45 min)  upserted 0  errors 0  warnings 0
genuine  started 2026-09-26T14:00:03Z  failed  finished 2026-09-27T14:00:03Z  (24 h)    upserted 0  errors 0  warnings 0
```

These two failures look different. The first ran 45 minutes and stopped. The second ended exactly when the next night's run started, which looks like the next run reaping a hung predecessor. Both record `errors: 0`. Two questions:

1. What stopped each run?
2. Can a failed run record why, for example in `errors` or a `reason` field? A failed run with zero errors tells the operator nothing.

Site Health now marks the feed "2 of the last 5 runs failed" instead of showing only the green `latest`.

### BF-081: image-audit `brand` accepts a slug only; admin products accepts a slug or an id

`/image-audit/list?brand=<hp uuid>` and `/image-audit/stats?brand=<hp uuid>` → `404 "Brand not found"`; `brand=hp` → 200. `/api/admin/products` accepts both since (c). We send slugs everywhere now, so nothing is broken today. The ask is parity: either accept an id on the image-audit routes too, or answer a `400 UNKNOWN_BRAND` like (c). A 404 for a filter value reads as "the resource is gone", and our page turned it into "All clean".

---

Checks, all runnable from this repo:

- `tests/backend-response-fe-replies-sep2026.test.js`, plus the five suites it names
- `python3 scripts/redproof-backend-response-sep2026.py`: 19/19 mutations caught
- `python3 scripts/redproof-tier-approval.py`: 19/19
- `npm run probe:bundle-response`: 43 pass, 1 fail. The failure is BF-079, and it stays red until that is fixed.
- `npm run probe:tier-approval`: 23/23
