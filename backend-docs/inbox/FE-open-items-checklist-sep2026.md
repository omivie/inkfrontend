# Frontend open items — consolidated checklist (2026-09-09)

Everything below was **verified against production on 2026-09-09**, not read off
an old hand-off. Items already done are listed too, in §6, so nobody re-does work
that has shipped.

Six things are open. Two are security, two are revenue, two are data quality.

| # | Item | Type | Priority |
|---|---|---|---|
| 1 | `sql/analytics_function_grants.sql` sits in the FE repo | 🔴 Security | **Do first** |
| 2 | `delivery_type` radios have no default | 💰 Revenue | **Highest value** |
| 3 | `/ink-cartridges` renders 0 prices | 💰 Revenue | High |
| 4 | PDP reads `compatible_devices_html` with the anon key | 🔴 Security | Medium-high |
| 5 | `X-Session-Id` header not sent | 📊 Data | Medium (now unblocked) |
| 6 | `element` truncated at 80 chars | 📊 Data | Low |
| 7 | 21 duplicate printer URLs, both twins in the sitemap | 🔍 SEO | High |
| 8 | CDN cache purge after the canonical change | 🔍 SEO | With §7 |
| 9 | Two admin dashboards not yet built | 🛠 Build | Backlog |

---

## 1. 🔴 Delete or neuter `sql/analytics_function_grants.sql`

**File:** `inkcartridges/sql/analytics_function_grants.sql` (frontend repo)

It ships with a "paste into the SQL Editor and Run" instruction and its own header
calls it "the durable fix". It has not been run. If anyone runs it:

```sql
grant execute on all functions in schema public to authenticated, service_role;
```

`all functions in schema public` now includes migration 165's contract-pricing
functions, which were written after this script:

| Function | What a signed-in customer could do |
|---|---|
| `set_business_contract_price(...)` | Set any price on **any product for any business account**, including their own. Price goods at $0.01. |
| `remove_business_contract_price(...)` | Delete another account's negotiated pricing. |

**Action:** delete the file, or replace its body with a comment explaining why it
must never be run. The `42501` outage it was written for (ERR-029) is already
fixed properly on the backend — per-function grants, migrations 166/167/168.

Full context: `security-hardening-sep2026-round2-FE-handoff.md` §1.

---

## 2. 💰 Give `delivery_type` a default — the highest-value change available

**Verified in the live DOM at `/checkout`, 2026-09-09:**

```html
<input type="radio" name="delivery_type" value="urban" class="delivery-type-option__radio" required>
<input type="radio" name="delivery_type" value="rural" class="delivery-type-option__radio" required>
```

**Neither carries `checked`. Both are `required`.**

So the form cannot submit until the shopper picks one, and HTML5 constraint
validation on an unchecked radio group reports against an element that may be off
screen. On a phone the shopper taps Continue and nothing visibly happens.

### The fix

```html
<input type="radio" name="delivery_type" value="urban" ... checked>
```

### Why defaulting is safe

The backend already treats the field as optional with the same default:

```js
// src/validators/schemas.js
delivery_type: Joi.string().valid('urban', 'rural').default('urban'),
```

The FE's hard `required` is stricter than the API needs, for no gain.

If you would rather not default a price-affecting field (rural is $14 vs $7 in
Auckland), the alternative is to keep it required but guarantee the validation
message is **scrolled into view and visible** on tap. Either closes the dead end;
defaulting is the smaller change.

### Why this is worth doing this week

Your checkout layout fix worked — mobile shoppers now reach checkout, and on
2026-09-08 at 23:09 NZT one **completed a purchase** (`Linux; Android 10`), the
first mobile completion ever recorded against a prior 0-of-36 over 120 days.

So this radio is friction, not a wall. But it is friction on the step where money
changes hands, on ~64% of the market. Mobile is currently **excluded at -100% in
every Google Ads campaign** because it could not convert; it goes back on once
mobile completions are consistent.

---

## 3. 💰 Render the popular-products row on the three landing pages

**Verified on production 2026-09-09, after full SPA render:**

```
/ink-cartridges
  h1      "Shop Ink Cartridges & Toner NZ"
  h2      "Choose a brand to see ink cartridges"
  prices  0
```

`buy ink cartridges` is **53% of all Google Ads spend** and lands here. A visitor
who has already decided to buy arrives at a menu, and needs four clicks to see a
single price.

### The endpoint is live and idle

Re-verified 2026-09-09 — all three categories return 200 with real products:

```
GET /api/products/popular?category=ink&limit=4
  CLC531XLBK   $33.49    CCLI521KCMY   $25.99
  C564BK       $12.49    CLC431XLKCMY  $139.49

GET /api/products/popular?category=toner&limit=4
  CTN2445BK    $46.99    CTN258XLBK    $67.49
  CTN1070BK    $24.49    GTK5494BK     $150.79

GET /api/products/popular?category=ribbons&limit=4   -> 4 products
```

- **No brand required** — this is the one catalogue endpoint that does not need it.
- Ordered by real sales (`get_top_products`, units, 180 days), topped up from the
  catalogue so the row is never empty.
- **In-stock and has-image only**, so every card is buyable.
- Shaped through the standard §7.1 pipeline — same fields as `/api/shop`,
  `quantity_breaks` included, `cost_price` stripped. The existing card component
  should drop straight in.

### What to do

On `/ink-cartridges`, `/toner-cartridges` and `/ribbons`, fetch and render the row
**above** the brand chooser. Keep the brand grid underneath — it is genuinely
useful for a 4,000-SKU catalogue. The change is that a visitor who already knows
they want ink can buy without first choosing a brand, a category and a series code.

```js
const r = await fetch(`${API}/api/products/popular?category=ink&limit=8`);
const { data: { products } } = await r.json();
```

### Verify

```js
(document.body.innerText.match(/\$\d+\.\d{2}/g) || []).length   // currently 0, want > 0
```

---

## 4. 🔴 Move the "FOR USE IN" list onto the backend endpoint

**Verified on production 2026-09-09.** Loading a PDP still fires this, with the
public anon key:

```
GET https://<project>.supabase.co/rest/v1/products
      ?sku=eq.CTN258XLBK
      &select=id,description_html,compatible_devices_html,related_product_skus
      &limit=1
```

`compatible_devices_html` is the admin-authored machine list. Read this way it is
**bulk-dumpable** — drop the `sku=eq.` filter and every list comes back in one
request, with a key that ships in the page.

### The replacement

```
GET /api/products/:sku/for-use-in
```

One product per request, rate-limited 40/min/IP (`forUseInLimiter`). The data now
lives in `product_compat_devices` (migration 131) — RLS on, no anon or
authenticated grants, service-role only.

`products.compatible_devices_html` still exists and is dual-written by the admin
editor **purely so the storefront keeps working until you cut over**. Migration
132 drops the column once you have.

**Action:** switch the PDP to the endpoint, then tell us — we run mig 132 and the
column stops being readable at all.

Full context: `ribbon-for-use-in-FE-handoff-aug2026.md` Part B.

---

## 5. 📊 Send `X-Session-Id` — the backend blocker is now removed

Your note in `api.js` was correct, and the bug was ours:

> *"the header is still absent from `Access-Control-Allow-Headers` (BF-054) … a
> BROWSER refuses to send the request at all"*

**Fixed and live.** Verified against production 2026-09-09:

```
$ curl -i -X OPTIONS https://api.inkcartridges.co.nz/api/search/smart?q=test \
    -H "Origin: https://www.inkcartridges.co.nz" \
    -H "Access-Control-Request-Headers: X-Session-Id,X-Visitor-Id"

HTTP/2 204
access-control-allow-headers: Content-Type,Authorization,X-Requested-With,
  X-Request-Id,X-Guest-Session,X-Attribution-Source,X-Session-Id,X-Visitor-Id
```

Backend commit `393ae6c`, pinned by `__tests__/cors-analytics-identity-headers.test.js`.

### Why it still matters

Your `?sid=` workaround on cart POSTs is working — server-side `add_to_cart` rows
carry session ids. But it cannot extend to edge-cached catalogue GETs without
poisoning the cache key, which you correctly refused to do. So search is still
100% anonymous:

| | rows (last 5 days) | with `session_id` |
|---|---|---|
| `search_analytics` | 915 | **0** |

That is why `/dashboard/search/top-converting` still ships `orders: null`.

### The change

One line in the shared fetch wrapper, on every `/api/` call:

```js
headers['X-Session-Id'] = sessionId;   // the same id the traffic beacon mints
headers['X-Visitor-Id'] = visitorId;
```

Constraints (server-side `ID_RE`): `[A-Za-z0-9_.:-]`, 1–128 chars. A malformed id
is **rejected whole, not truncated** — a mangled id groups with nothing and looks
like real data. Do not mint a second id scheme; reuse the beacon's.

---

## 6. 📊 Raise the `element` truncation from 80 to 200 characters

The storefront truncates the click-tracking `element` string at exactly 80
characters (481 rows sit at 80, none above). Joi allows 512 and the column is
unlimited `text`, so the cap is yours alone.

Past 80 chars the SKU segment is cut mid-token. Backend resolution degrades
exact SKU → exact slug → **unique** slug prefix and recovers 66% (489/744); an
ambiguous prefix is refused rather than guessed, because a wrong attribution is
worse than none.

**Action:** raise the truncation to 200. No backend change needed — the remaining
34% starts resolving on its own.

---

## 7. 🔍 Add canonical tags to 21 duplicate printer URL pairs

**Verified open on 2026-09-09.** Both twins of every pair are in the live sitemap
right now, being submitted to Google as separate pages with identical content:

```
$ curl -s https://api.inkcartridges.co.nz/sitemap-printers.xml | grep 3230cdw
<loc>https://www.inkcartridges.co.nz/shop?brand=brother&printer_slug=brother-hl-l3230cdw</loc>
<loc>https://www.inkcartridges.co.nz/shop?brand=brother&printer_slug=brother-hll-3230cdw</loc>
```

### How this happened

`printer_models` holds the same physical printer under more than one row because
the supplier feeds spell it differently. Each row only ever carried its own slice
of the cartridges, so one URL looked healthy and its twin looked like an
unsupported printer:

```
"Brother MFC-J4355DW"      30 cartridges     "Brother MFC J4355DW"      0 cartridges
"Epson WORKFORCE WF 2530"  22 cartridges     "Epson WorkForce WF 2530"  0 cartridges
```

The backend unioned the link sets — 763 links across 120 groups — so customers now
get the full list whichever spelling they land on. **That fix created the SEO
problem.** Previously the empty twin was excluded from the sitemap automatically,
because `sitemap-printers.xml` selects on `product_compatibility!inner` and it had
no links. Now it has links, so it qualifies.

### What to do

Pick one URL per pair and point the other's `<link rel="canonical">` at it. The
backend has deliberately **not** merged the rows or issued redirects — merging
changes URLs, which is an SEO decision rather than a data one, and it is yours.

The full table of 21 pairs, with live product counts on each side, is in
`duplicate-printer-urls-FE-handoff-sep2026.md` §3, along with one caveat worth
reading in §4 before you choose which side wins.

---

## 8. 🔍 Purge the CDN cache once §7 ships

`s-maxage=86400` pins the SPA shell for 24 hours, so a canonical change is
invisible to crawlers for a day unless the cache is purged.

Purge `/shop`, `/printers/*` and the sitemap paths. Details in
`duplicate-printer-urls-FE-handoff-sep2026.md` §2, and the same doc's §3 covers
re-submitting the sitemap afterwards.

I could not verify this one from outside — it depends on your Cloudflare state.

---

## 9. 🛠 Two admin dashboards are specced but not built

These are feature work rather than defects, so they sit below everything above.
Both sets of endpoints are **live in production and returning real data**.

| Job | What it shows | Contract |
|---|---|---|
| Catalogue engagement | Which brands and cartridges customers actually view and click | `analytics-dashboards-FE-handoff-sep2026.md` §Job 2 |
| Acquisition dashboards | Landing pages, channels, and search terms — SEO beside Ads | same doc, §Job 3 |

One caveat on the acquisition panels: the **SEO and Ads halves have no data yet**
(`search_console_daily` and `google_ads_keyword_daily` are both empty — no
credentials). The cron runs daily and will populate them the moment credentials
land, and every response carries `meta.sources` so the UI can distinguish "not
connected" from "zero clicks". Build against that flag rather than assuming empty
means broken.

---

## 10. ✅ Verified DONE — do not redo these

Checked on production 2026-09-09.

| Item | Evidence |
|---|---|
| **Google Ads add-to-cart tag** | Fired for the **first time in account history** — 2 conversions on 09-07, after ~6 months and 771 ad clicks of nothing |
| **Mobile checkout layout** | Email input `1,621px → 542px`; desktop unchanged at 329px |
| **Horizontal overflow** | `body.scrollWidth` 379 against a 390 viewport — **resolved** (was 406) |
| **Signup modal blocking `/ink-cartridges`** | No blocking overlay found at 390×844 |
| **Consent banner** | Correctly touches only `analytics_storage`; leaves `ad_storage` alone, so Ads conversions are unaffected |
| **Order-number format** | Nothing in the deployed bundles assumed the old 14-char shape |

### Credit where it is due

The `gtag.js` add-to-cart implementation is better than the hand-off asked for:

- It uses the server's `quantity_added`, closing the BF-060 triple-value bug.
- It keeps the client-side derivation as a **live fallback**, clamped to the
  requested quantity — so a response missing the delta errs in the *safe*
  direction, never the expensive one.
- It checks the **type** of `price_snapshot` before coercing, so a missing price
  fires a conversion with no value rather than a confident `$0.00`.
- Placing it in `gtag.js` (38 of 43 pages, HEAD script) rather than a new file
  correctly sidesteps the ERR-194 enrolment trap.

---

## Suggested order

1. **§1** — delete the SQL file. Two minutes, removes a footgun.
2. **§2** — `checked` on the urban radio. One attribute, unblocks 64% of the market.
3. **§3** — popular row. Biggest traffic-quality win; endpoint is waiting.
4. **§4** — `for-use-in` cutover, so we can drop the anon-readable column.
5. **§7 + §8** — canonical tags, then purge the CDN. Do them together; a canonical
   behind a 24-hour cache is not live.
6. **§5** — session header.
7. **§6** — truncation bump.
8. **§9** — the two admin dashboards, when there is room.

Questions on any of these: the per-item source docs are in the same folder and
each carries the original measurements.
