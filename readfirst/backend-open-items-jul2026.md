# Backend — consolidated open items (as of 2026-07-14)

**Audience:** the backend repo's Claude / dev. **Author:** the frontend (Vercel SPA) repo.
**Scope:** everything the frontend currently believes is owed by the backend, in priority order.

Each item states: **symptom → repro (runnable) → what to change → acceptance criterion.**
Every "OPEN" item below was **re-verified live on 2026-07-14** unless explicitly marked *unverified*.

```bash
# Used throughout
API=https://ink-backend-zaeq.onrender.com/api
BOT='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
SITE=https://www.inkcartridges.co.nz
```

---

## ✅ Already done — do NOT redo

| Item | Status |
|---|---|
| **Canon bare-`CL` truncation** (`CL511`→`CL51`) | **RESOLVED, verified live.** `series_codes` now emits full 3-digit codes; `PG510/CL511` returns all 4 products; the spurious `CL51`/`CL64`/`CL58`/`CL66` chips are gone. FE's `_finalizeShopData` repair is self-disabling and now inert. Detail: `canon-cl-truncation-backend-jul2026.md`. |
| **Legal-content CMS removal (FE half)** | **DONE + deployed.** `legal-page.js` performs **zero network I/O**; the admin editor, its Settings tab and its DDL are deleted. Your acceptance grep returns `0`. Detail: `legal-cms-retirement-backend-jul2026.md`. |
| **Compatible identifiers / seller brand / warranty-claim guard** | Done your side; FE re-verified clean. |

---

## P0 — Revenue reporting is broken

### 1. `kpi-summary` nulls ALL profit for any range containing an invoiced sale

> **This supersedes the old "zero-item shadow orders" P0, which is now CLOSED — see below.**
> The zero-item theory was wrong. We measured it. Please read the measurement before acting.

**Symptom.** On `/admin#dashboard?period=all`, Gross Profit, Net Profit, Gross Margin and Net Margin
all render as "—". Revenue ($7,091.58), Orders (59), AOV and Stripe fees are all fine.
`GET /api/admin/analytics/kpi-summary` returns:

```jsonc
{ "revenue": 7091.58, "orders": 59, "aov": 120.2, "stripe_fees": 171.11, "operating_expenses": 0,
  "invoice_orders": 3, "includes_invoices": true,
  "gross_profit": null,   // ← the defect
  "net_profit":   null,   // ← the defect
  "margin_proxy": null }  // ← the defect
```

**It is not COGS honesty. Nothing is missing a cost.** We pulled the detail for every order in the
range: **59 revenue orders (of 73; 14 cancelled), 84 line items, and all 84 carry a non-null
`supplier_cost_snapshot`.** No zero-item orders. Nothing to be honest *about*.

**Repro — probe the endpoint one week at a time.** This is the whole diagnosis in one loop:

```bash
# 19 consecutive weeks, period=all. 17 return a real gross_profit.
# The ONLY two that return null are the two containing invoiced sales.
2026-06-15 → gross_profit 205.39   invoice_orders 0
2026-06-22 → gross_profit NULL     invoice_orders 2   ← INV-3263, INV-3264
2026-06-29 → gross_profit  53.97   invoice_orders 0
2026-07-06 → gross_profit NULL     invoice_orders 1   ← INV-3265
2026-07-13 → gross_profit  49.45   invoice_orders 0
```

**100% correlation with `invoice_orders > 0`.** Because `period=all` spans those weeks, one invoiced
sale blanks the owner's entire dashboard.

**And your own series endpoint gets it right.** `gross_profit_series` in the *same*
`dashboard-bundle` response returns a real gross profit for **all 19 buckets — including the two
that `kpi-summary` nulls** (2026-06-22 → $193.52, 2026-07-06 → $183.11). So the number exists and
your code can compute it. Two code paths, one aggregate, different answers.

**The three shadow orders are healthy.** INV-3263 / 3264 / 3265 each have one line item, a real SKU
(`CTN258XLKCMY`, `CLC531XLKCMY`, `G206XKCMY`) and a real cost ($139.80 / $58.96 / $776.64). Your
fallback resolver fixed them. They are being nulled anyway.

**What to change.** Find why `kpi-summary`'s COGS aggregate goes NULL when an
invoice-channel order (`payment_method = 'invoice'`) is in range while `gross_profit_series` does
not. Likely a NULL-propagating join or a `SUM()` over a subquery that returns no row for the
invoice channel — a `NULL` in an arithmetic expression makes the whole expression `NULL`, silently.
Whatever the cause: **never coerce the fix to `0`** (ERR-068 — `Number(null) === 0` once produced a
false "0.0% margin, reprice-or-drop" alert on the owner's dashboard).

**Acceptance.** For `date_from=2026-06-22&date_to=2026-06-28`, `kpi-summary` returns a real
`gross_profit` — and it agrees with what `gross_profit_series` already reports for that bucket.

**Meanwhile, we've un-blanked the dashboard ourselves.** The frontend now rebuilds the headline
figures by **summing your own `gross_profit_series` buckets** (`gross − stripe_fees −
operating_expenses`, your own formula — we verified it reproduces your `net_profit` to the cent on
four un-poisoned weeks). It is **self-disabling**: the moment `kpi-summary` returns a real
`gross_profit`, we use yours and the workaround never runs. So this is no longer an emergency —
but it is still your bug, and we'd like to delete our workaround.

### 1b. `net_profit_series` does not exist

The bundle has **no `net_profit_series` key at all** — only `gross_profit_series`. Our Performance
chart has been falling back to gross profit and labelling it "Net profit" ever since (our bug, now
fixed: the legend names what it actually plots). **Either ship `net_profit_series` or tell us it
isn't coming** and we'll stop reserving the slot.

### ~~1c. Zero-item shadow orders~~ — ✅ CLOSED, verified fixed

The original P0 ("an invoice whose SKU doesn't resolve materialises a shadow order with revenue but
zero `order_items`, nulling COGS for the whole period"). **Your fallback resolver fixed it.** All
three shadow orders now carry costed line items; there are no zero-item orders anywhere in the
range. We've also closed the hole at our end — invoice/quick-order line codes are validated against
real `products.sku` at the save choke point (ERR-071), so a typed non-SKU can no longer be persisted.
Nothing further needed.

**Also — ✅ CLOSED (2026-07-15).** We thought `GET /invoices/:id` never echoed `supplier_cost_excl_gst`.
It does (`serializeInvoice`) — verified live: #3263 comes back with `supplier_cost_excl_gst: 139.8`,
`cost_source:"auto"`. The empty "Our Cost" box was the *stored* value being null on the truncated-code
rows, now canonicalised + repaired. Our `fetchProductCosts`/`backfillCostsFromCatalogue()` workaround
has been **deleted**. We also wired the §3.1 `400 VALIDATION_FAILED` backstop into both writers (the
fail-soft net is now rendered per-line, not a generic toast). See
`invoice-sku-integrity-backend-jul2026.md` → RESOLVED. Nothing further needed.

---

## P1 — Anti-cloaking: the bot footer and the human footer must agree

Context: the Google Ads suspension is a **misrepresentation/cloaking** matter. Any string a crawler
sees that a human doesn't (or vice-versa) is evidence against us. All three below reproduce **today**.

### 2. Prerender footer is missing the compliance half of the legal line

**Repro.**
```bash
curl -s -A "$BOT" "$SITE/" | grep -c "No card surcharges"
#   → 0        (the human footer renders it)
```

The FE footer renders the full locked string:

> InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).
> **Prices in NZD, GST inclusive. No card surcharges.**

`buildFooter()` in `prerender.js` emits only the first sentence. The bolded half is Google Ads
compliance copy — a reviewer scans the footer for it *before* opening any policy page.

**What to change.** Append `Prices in NZD, GST inclusive. No card surcharges.` to the prerender's
`<small>` line.

**Acceptance.** The grep above returns ≥1.

### 3. Address abbreviated differently in the prerender

**Repro.**
```bash
curl -s -A "$BOT" "$SITE/" | grep -oE "37A Archibald (Rd|Road)" | sort -u
#   → 37A Archibald Rd          ← prerender
#   FE + legal-config.js + Organization JSON-LD all say "Road"
```

**What to change.** `Rd` → `Road` in the prerender footer. NAP (name/address/phone) consistency
signal; free to fix.

**Acceptance.** The grep returns only `37A Archibald Road`.

### 4. The bot footer advertises a category humans can't see — ✅ CLOSED (FE) 2026-07-15

**Repro.**
```bash
curl -s -A "$BOT" "$SITE/" | grep -c "Drum Units"
#   → ≥1, inside <nav aria-label="Shop by category"> — the human footer has no such link
```

The FE footer's new Shop column ships `/ink-cartridges`, `/toner-cartridges`, `/ribbons`.
**`Drum Units` (`/shop?category=drums`) remains bot-only.**

**What to change — pick one:**
- drop `Drum Units` from the prerender footer, **or**
- tell us and we'll add it to the FE Shop column.

Either is fine. The two footers just need to agree.

**Acceptance.** The set of category links in the bot footer equals the set in the rendered footer.

> **✅ RESOLVED (FE) 2026-07-15.** Backend confirmed it's keeping Drum Units in the bot footer (owner's
> call), so the FE added **`Drum Units` → `/shop?category=drums`** to the human Shop column, ordered to
> match the bot: **Ink Cartridges · Toner Cartridges · Drum Units · Printer Ribbons**. Both category
> sets now agree. Static link only (no `getSiteNav` fetch). Pinned by
> `tests/footer-redesign-jul2026.test.js` §3; verified live. **No backend action.**

### 5. ⚠️ Correction — do NOT "fix" the footer company number

Your CMS handoff said:

> *The backend's own footer line additionally includes **NZ Company Number 1853414**; if you want
> byte-parity you could add it to the SPA footer line too.*

**We checked before acting, and this is not what's being served.**

```bash
for p in terms about privacy returns; do
  echo -n "/$p → "; curl -s -A "$BOT" "$SITE/$p" | grep -c "NZ Company Number"
done
#   → 0, 0, 0, 0   (in the footer)
```

The **visible footer line carries no company number on either side.** They already agree.

### 5b. PDP compatible-product disclaimer — condensed on the FE; prerender re-sync owed (2026-07-15)

**Reopened.** The owner condensed the human-facing panel on **2026-07-15** to the leanest compliant
form. This supersedes the earlier "both sides carry the 30-day + CGA sentence" parity target — the
30-day satisfaction-guarantee + CGA sentence has been **removed from the panel** (CGA disclosure
still ships site-wide in the footer, so nothing legally required is lost).

**New parity target (both sides must serve this, verbatim; `{type}`/`{OEM}` dynamic):**

> Compatible (third-party) {type} for {OEM} printers — not made or endorsed by {OEM}. Sold by
> Office Consumables Ltd.

**FE status (shipped 2026-07-15, FE-first):** the SPA panel (`#compat-disclaimer`,
`renderComplianceDisclaimer()` in `js/product-detail-page.js`) now renders exactly the sentence
above. The retired *12-month replacement warranty* claim stays gone. The panel is now **shorter than
the prerender** — the **safe cloaking direction** (bots see more disclaimer than humans, not less),
so this is a parity cleanup, not a live risk.

**Backend action.** Update `prerender.js` / the compatible-PDP meta description to serve the
condensed copy above, dropping BOTH the old `12-month replacement warranty…` line AND the
`Compatible cartridges are covered by our 30-day satisfaction guarantee. Your statutory rights
under the New Zealand Consumer Guarantees Act 1993 are unaffected.` sentence, so bot == human again.
**Acceptance:**
```bash
curl -s -A "$BOT" "$SITE/products/oki-compatible-393-printer-ribbon-black/C-OKI-393-RIB-BK" \
  | grep -c "12-month replacement warranty on compatible cartridges"      # → 0
curl -s -A "$BOT" "$SITE/products/oki-compatible-393-printer-ribbon-black/C-OKI-393-RIB-BK" \
  | grep -c "covered by our 30-day satisfaction guarantee"                # → 0
curl -s -A "$BOT" "$SITE/products/oki-compatible-393-printer-ribbon-black/C-OKI-393-RIB-BK" \
  | grep -c "not made or endorsed by"                                     # → ≥1
```

We found where the belief came from: on the home page `"NZ Company Number"` *does* appear twice —
but both occurrences are inside **JSON-LD**, in the `identifier[]` array on `Organization` /
`LocalBusiness`:

```json
{"@type":"PropertyValue","propertyID":"NZ Company Number","value":"1853414"}
```

That's structured data, not the rendered `<small>` line. It's correct and should stay.

**Action: none.** Do **not** add the company number to the prerendered footer text — that would
create the bot/browser divergence we're both trying to eliminate. The number is already exposed to
Google via JSON-LD, and it appears in the `/terms` body. Entity + NZBN + GST in the footer is
sufficient identification for Business Transparency.

---

## P2 — Merchant Center feed

### 6. Page-yield tokens emitted on non-page-rated product types (~125 SKUs)

**Symptom.** The feed builder emits a `"N pages"` yield token **without gating on category**. Label
tapes (Dymo `S07*`/`ZDY*`, Brother `TZE*`/`DK*`), photo paper, correction tape and ribbons carry
**fabricated** yields — e.g. a label tape advertising *"12–1,564 pages"*, photo paper *"N pages each"*.

**Why a value-range check won't find them.** Many of the fabricated numbers sit *inside* a plausible
15–60,000 range, so a min/max plausibility filter misses them. **Catch by `product_type`, not by
value.** Gating on `product_type ~ /ribbon|label tape|photo paper|correction tape/` surfaces **122**
beyond the 3 ribbons already known.

**What to change.** Strip the page-yield token from non-page-rated product types in the feed builder.

**Acceptance.** No product whose `product_type` matches that set carries a page-yield token.

**Note on the audit report — most of it is false positives, don't chase it.** Of the ~946 "issues"
the live audit pass reports, the genuinely actionable backend item is **only** the ~125 above.
Specifically ignore: the "duplicate brand" rule (an artefact of our auditor concatenating
title+description — no field actually duplicates the brand), the "title must START with
Compatible/Third-party/Generic" rule (GMC does not require the prefix; our titles are compliant),
and the flat `MAX_PLAUSIBLE_YIELD=60000` cap (fusers at 300k and drums at 200k are **correct** —
that cap is ours and it's too low). One genuinely corrupt record worth fixing: `G126ABK-2`
— *"HP … 14 pages — Genuine Drum Unit"*.

---

## P3 — SEO / caching (unverified this session; from the IA-reorg handoff)

### 7. Prerender category canonicals point at `/ink`

Category prerenders emit a canonical of `/ink`, which 404s. The FE has mitigated with a 301, but the
canonical should be corrected at source.

### 8. Cloudflare purge

Now that the FE IA reorg is deployed, purge the CF cache for `/`, `/shop`, `/ink-cartridges`,
`/toner-cartridges`, `/ribbons`, and the sitemaps.

### 9. `/genuine-vs-compatible` — do NOT filter or redirect it

**Correcting an earlier flag from us.** A previous note claimed `/api/site/nav` and the prerenders
link a "dead" `/genuine-vs-compatible`. **That was wrong.** The route is **live**, rewritten in
`vercel.json`, linked from the footer and PDPs, and **Google requires it crawlable** — it is the page
that substantiates our compatible-vs-genuine claims for the appeal. Leave it exactly as it is.

---

## Housekeeping

### 10. Drop the retired CMS table

```sql
DROP TABLE IF EXISTS public.legal_content_overrides;
```

It is empty, and nothing on the frontend reads it, writes it, or carries its DDL any more (verified —
your own acceptance grep returns `0`). No coordination needed; drop it whenever convenient.

**And do not rebuild a CMS for legal copy.** The frontend now has one vetted source per legal page
(the page's HTML + `legal-config.js`), and a CI test that fails if a network fetch reappears in
`legal-page.js`. A CMS whose overrides the prerender can't see is a cloaking vector by construction.

---

## Summary table

| # | Item | Priority | Verified live 2026-07-14 |
|---|---|---|---|
| 1 | `kpi-summary` nulls all profit when an invoiced sale is in range | **P0** | ✅ measured — 19-week probe, 100% correlation |
| 1b | `net_profit_series` absent from the bundle | P1 | ✅ measured |
| ~~1c~~ | ~~Zero-item shadow orders~~ | ~~P0~~ | ✅ **CLOSED — verified fixed, all 84 items costed** |
| 2 | Prerender footer missing "No card surcharges" | P1 | ✅ **backend reports SHIPPED** (commit `2ab2e12`) — footer-redesign-backend-response |
| 3 | Prerender address `Rd` → `Road` | P1 | ✅ **backend code done** — pending an Ops Render-env flip (`BUSINESS_STREET`) |
| 4 | Bot-only `Drum Units` footer link | P1 | ✅ **CLOSED (FE) 2026-07-15** — added to human Shop column; sets now agree |
| 5 | Footer company number — **no action; correction** | P1 | ✅ confirmed non-issue |
| 5b | PDP compat disclaimer condensed to leanest form (drop 12-month warranty AND 30-day+CGA sentence); prerender/meta must match | P1 | FE shipped 2026-07-15; BE re-sync owed |
| 6 | Feed: page-yield on non-page-rated types (~125) | P2 | from log |
| 7 | Prerender category canonical → `/ink` | P3 | from log |
| 8 | Cloudflare purge | P3 | from log |
| 9 | `/genuine-vs-compatible` must stay crawlable | P3 | ✅ live, leave alone |
| 10 | `DROP TABLE legal_content_overrides` | housekeeping | ✅ safe to proceed |

**Companion docs in this folder:** `legal-cms-retirement-backend-jul2026.md` (§3 has the full footer
company-number evidence), `footer-redesign-backend-jul2026.md` (items 2–4 in context),
`canon-cl-truncation-backend-jul2026.md` (resolved; kept as the historical record).
