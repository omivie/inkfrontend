# Lexmark / OKI chip grouping — FE response (Sep 2026)

Reply to `lexmark-chip-grouping-FE-handoff-sep2026.md`. Internal ref: **ERR-216**.

**Thanks — the collapse itself is clean and it verified end to end.** Chip counts, the
`series_codes` rewrite, the redirects and the caching all check out exactly as written.

Two things need correcting, and there *was* frontend work — not because the backend did
anything wrong, but because this frontend has a client-side chip path the hand-off didn't
know about.

---

## 1. `/api/products/series` is not our chip source

> §1: *"The chip grid renders whatever `/api/products/series` returns."*

That endpoint has **zero callers** in this frontend. `api.js` has a `getProductSeries()`
wrapper nothing calls. Our chips come from **`/api/shop` → `data.series[]`**, and when that
request fails we fall back to building chips **client-side** from `product.series_codes`.

Not a request — just so the next hand-off aims at the right surface.

## 2. The client-side path was rejecting your codes — 162 of them, on nine brands

Our fallback extractor ran every backend `series_codes` value through a per-brand SKU/name
regex before accepting it. That regex is a *parser*, and we were using it as a *validator*,
so anything not shaped like a SKU was silently dropped. Measured across every distinct
`series_codes` value live on 2026-09-06:

| brand | distinct codes | rejected | mutated |
|---|---|---|---|
| brother | 147 | 21 | 0 |
| canon | 101 | 18 | 0 |
| epson | 35 | 3 | 3 |
| hp | 124 | 23 | 2 |
| **lexmark** | 37 | **37** | 0 |
| oki | 69 | 12 | 0 |
| samsung | 23 | 6 | 0 |
| kyocera | 77 | 0 | 0 |
| fuji-xerox | 100 | 42 | 2 |
| | **713** | **162** | **7** |

**This predates your change** — it was already dropping 125 codes on eight other brands. The
stems made Lexmark's share total, and therefore visible. Two of the seven mutations were
destructive on your data: Epson `S015336` **and** `S015337` both collapsed to `S01533`.

Fixed on our side: `series_codes` is now taken as given (case/whitespace canonicalisation
only), and the SKU-derived fallback is gated to products that arrive with no codes at all.

**Blast radius while it was broken:** only the degraded path, so nothing customer-visible has
happened — `/api/shop` hasn't failed since you deployed on 09-03. Had it failed, Lexmark would
have rendered an **empty chip grid** under "No products found" copy.

---

## 3. §3 doesn't hold: old `?code=` links resolve to *subsets*

> §3: *"all of these resolve to the same grid"*

They resolve, which is the important part. But not to the same grid:

```
?code=20N3HK0   ->  3 products
?code=20N3H     ->  6 products
?code=20N30     -> 18 products
?code=20N3      -> 18 products
?code=20        -> 18 products      <- what the chip grid now offers
```

So a bookmark on `20N3HK0` landed on 3 of the platform's 18 products, with the breadcrumb and
`<title>` reading `20N3HK0` — a code that appears nowhere in the grid on screen.

**We did not add a client-side mapping.** We took your point in §3 seriously: reimplementing
the collapse would drift from `src/utils/lexmarkSeries.js` and would get the refusal cases
wrong. Instead we read the stem **you already stamped on the rows you returned** — if none of
the returned products carries the requested code, and they all share exactly one
`series_codes` value, we adopt that value for the URL and labels. It owns no mapping, and it
self-disables on every brand you didn't touch, and on OKI `?code=711` (whose rows still carry
`711` alongside `C710`).

**If you'd rather own this too**, a backend 301 from retired `?code=` values to the stem would
let us delete our adoption step entirely. Happy either way — say the word.

---

## 4. Four things worth knowing at your end

1. **`?code=200` and the `100` / `150` / `170` chips are not in the live Lexmark list.** §1
   names `41, 100, 150, 170, 200, 503, 708, 808` as short marketing numbers keeping their own
   chip. Live, we see `41`, `503`, `708`, `808` — but no `100`, `150`, `170` or `200`, and
   `/api/shop?brand=lexmark&category=ink` returns **zero series**. `150`/`170` we can explain
   (those rows became `71C0Z10` / `71C0W00` under §4b, so they now sit under `71`). `200` we
   can't — and it's the one §3 calls out as a refusal case that must never return CS431 toner.
   Worth confirming it's deliberate.

2. **One OKI product carries a duplicated code.** `?code=332DN` returns rows whose
   `series_codes` is `['C332', '332DN', 'MC363', 'MC363']` — `MC363` twice in one array.
   Harmless for us (we de-dupe), but it will inflate any count derived by array length.

3. **There is no field carrying a product's *printed* code.** §2 says, rightly, not to derive
   a display label from `series_codes`. We agree — but we tested the obvious alternative and
   it's worse. `manufacturer_part_number` is often an internal or OEM number rather than what's
   on the box:

   ```
   series_codes[0]     MPN            what the box says
   41                  50F0Z0E        41X
   5950                43865727       5950
   B401                IOB401         B401
   ```

   …and only 160 of 198 Lexmark genuines have an MPN at all. So we've left the PDP breadcrumb
   on `series_codes` for now, knowingly. **A `display_code` field would settle it properly**
   — that's the ask, if you're taking requests.

4. **`_enrichSeriesCodes` leaks printer models into codes.** Our compatible-product derivation
   turns SKU `C20N3HK0BK` into `["20N3HK0", "CS431"]` — a retired MPN plus a printer model.
   Ours to fix, not yours; flagged only because it feeds the admin's code suggestions. Tracked
   separately (ERR-135 family).

---

## 5. Everything else verified true

- **§1** Lexmark 83 chips, OKI 70 — confirmed live.
- **§2** `series_codes` carries the stem on every row — confirmed; our family grouping
  (`ProductSort.familyKey`) groups by equality and needed no change.
- **§4** All four SKU renames 301 correctly (`G150KBK` → `G71C0Z10BK`, etc.) and `fetch`
  follows them, so product pages resolve. The value-pack names read correctly
  (`GC540H1CMY` → *"Lexmark Genuine C540CMY … C540 CMY 3-Pack"*). We grepped the whole repo
  for `G150K`, `G170K`, `G28KBK`, `71C0Z`, `81C1XK`, `540CMY` — **zero hits**, including in
  git history. No hard-coded SKUs anywhere.
- **§5** No purge needed, and no cache-version bump was warranted on our side either: our chip
  cache is in-memory only, so it dies on reload.
- **§6** No coverage loss expected — our `?code=` pages already emit `noindex, follow`
  whenever brand + category + code are all present, which is the only shape we ever link.

**Risks we investigated and measured to zero** (recording them so nobody re-opens them):
the `limit: 200` cap is unreachable (largest family in the whole catalogue is **32**, Canon
`PGI680/CLI681`); our truncated-chip repair can't misfire on these brands (it needs a `/` pair
chip and neither brand has one); and the `product_codes` override layer holds **zero** Lexmark
rows, so no duplicate MPN tiles.

---

**Ours to run:** `npm run probe:chip-grouping` — read-only, 24 live checks, no write path. It
loads our shipped extractor rather than re-implementing it, so it will catch the next
vocabulary change on either side.
