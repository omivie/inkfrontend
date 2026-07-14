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

### 1. Zero-item shadow orders null out ALL profit

**Symptom.** When an invoice line's SKU doesn't resolve, the shadow order is created with
**revenue but zero `order_items`**. COGS then computes as `null` for the **entire period**, so the
owner sees **no gross or net profit at all** — not a wrong number, an absent one. One bad invoice
poisons every dashboard aggregate.

**Why it's P0.** It is silent, it is total, and it scales: a single unresolvable line takes out the
whole month.

**What to change.** A shadow order must never be created with an empty item set. Pick one and be
explicit about it:
- **(a) Reject** the invoice→order sync when a line's SKU can't be resolved, and surface the error
  (preferred — the FE already has a guard that forces the owner to pick a real SKU at save time, so
  new invoices shouldn't produce these).
- **(b) Create** the shadow order but mark it explicitly cost-unknown, and make the COGS aggregation
  **skip** rather than **null** the period.

Whatever you choose: **an unknown cost must never propagate as `null` across unrelated orders**, and
it must never be coerced to `0` (see ERR-068 — `Number(null) === 0` produced a false "0.0% margin,
reprice-or-drop" alert on the owner's dashboard).

**Acceptance.** With at least one unresolvable-SKU invoice in the period, `/api/admin/analytics/*`
still returns a real gross/net profit for every *other* order in that period.

**Also:** `GET /invoices/:id` snapshots `products.cost_price` into the shadow order but **never
echoes `supplier_cost_excl_gst` back**, so the FE re-derives it on open (`backfillCostsFromCatalogue()`).
Echoing it would let us delete that workaround. Nice-to-have, not blocking.

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

### 4. The bot footer advertises a category humans can't see

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
| 1 | Zero-item shadow orders null all profit | **P0** | from log (unverified — needs admin data) |
| 2 | Prerender footer missing "No card surcharges" | P1 | ✅ reproduces |
| 3 | Prerender address `Rd` → `Road` | P1 | ✅ reproduces |
| 4 | Bot-only `Drum Units` footer link | P1 | ✅ reproduces |
| 5 | Footer company number — **no action; correction** | P1 | ✅ confirmed non-issue |
| 6 | Feed: page-yield on non-page-rated types (~125) | P2 | from log |
| 7 | Prerender category canonical → `/ink` | P3 | from log |
| 8 | Cloudflare purge | P3 | from log |
| 9 | `/genuine-vs-compatible` must stay crawlable | P3 | ✅ live, leave alone |
| 10 | `DROP TABLE legal_content_overrides` | housekeeping | ✅ safe to proceed |

**Companion docs in this folder:** `legal-cms-retirement-backend-jul2026.md` (§3 has the full footer
company-number evidence), `footer-redesign-backend-jul2026.md` (items 2–4 in context),
`canon-cl-truncation-backend-jul2026.md` (resolved; kept as the historical record).
