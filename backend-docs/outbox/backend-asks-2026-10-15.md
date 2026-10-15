# Backend asks — everything the frontend still needs (2026-10-15, filed 2026-10-16)

**From:** frontend · **To:** backend dev · **API:** `https://api.inkcartridges.co.nz` (Render Singapore)

This is the one outgoing file. Every open request from the frontend is a numbered section below.
Each section says what we measured, what we are asking for, what the frontend does in the meantime,
and how we will check your change. The ERR numbers point at `errors.md` in this repo, which you can read.

**How to reply:** answer by section number (a document in `backend-docs/inbox/` or a message is fine).
When a section is answered and we have checked it against the live API, we delete it from this file.

| § | Ask | Priority | ERR |
|---|---|---|---|
| 1 | BF-102: `/api/shop` code-tile counts must match the `?code=` listing | Medium | ERR-337 |
| 2 | Rename stored product names to the descriptive title format | High (Google Shopping) | ERR-341, ERR-335 |
| 3 | Admin Pricing page: manual-price flag, bulk endpoint, filter rules | High (owner) | ERR-336 |
| 4 | Pack contents: quantity and page yield per constituent | Medium | ERR-340 |
| 5 | Admin products: sort keys for the net margin we display | Low | ERR-311 |
| 6 | Quote PDF: two defects and a design brief | Medium | ERR-316 |
| 7 | Three confirmations from the 7 Oct round | Low | ERR-312, ERR-313, ERR-319 |
| 8 | Loyalty points: redeem up to the whole order incl. shipping; $0 orders skip payment | High (owner) | ERR-345 |

---

## §1 — BF-102: `/api/shop` series counts disagree with the `?code=` listing (ERR-337)

**What we measured (live, 2026-10-15, read-only GETs).** On `/shop?brand=…&category=…` the number on each
product-code tile is your `GET /api/shop?brand&category` `series[].count`, shown as-is. Clicking the tile calls
`GET /api/shop?brand&category&code=X`. The two use different rules for rows of the other category: toners carry
their drum's code in `series_codes`, drums carry their toners' codes, and `series` counts some of those cross-type
rows while the `?code=` listing drops all of them.

| page | tile | your `count` | `?code=` returns |
|---|---|---|---|
| Brother toner | DR2415 | 5 | 4 |
| Brother toner | DR2530 | 2 | **0** (empty page) |
| Brother toner | DR3605 | 7 | 5 |
| Brother drums | TN2415 | 4 | 1 |
| Brother drums | TN2445 | 2 | **0** |
| Brother drums | TN2449 | 4 | 1 |

It is not a consistent rule either: DR2415 counted the compatible drum (it carries TN codes) but not the genuine
drum (it carries only `DR2415`).

A second case: on the drums listing, `?code=C544` returns the C540 drum and waste toner, which are tagged only
`["C540"]`. A count cannot see that fold. Also affected: Lexmark C780, E360, E450, E460, X264, X463, X950, OKI B401, B411.

**Owner decision.** A drum that pairs with a toner shows with that toner, and the toner shows with the drum.

**Ask.**
1. Build `series[].count` with the same predicate as the `?code=` listing, so the tile number always equals what the click returns.
2. For `category=toner` and `category=consumable` (drums), include the other of the two in both the count and the listing (toner ⇄ drums), matching the owner decision.
3. Tag folded rows with every code they are listed under (e.g. the C540 drum also carries `C544`), or stop folding in the listing.

**Frontend meanwhile.** `shop-page.js` recounts toner/drum tiles from the listing rows (`_recountChipsFromListing`)
and fans the click out over both categories. This costs extra paged reads per page view. When the walk fails we fall
back to your counts and log it. Every tile whose count moved is logged (`DR2415 series=5 rows=6`).

**How we verify.** `npm run probe:chip-counts` (read-only, paced) across 9 brands × ink/toner/drums/label.
When your counts match, the recount logs nothing and we delete it.

---

## §2 — Rename stored product names to the descriptive title format (ERR-341; supersedes the ERR-335 "KCMY-Pack" ask)

**Why.** Customers misread "4-Pack" / "3-Pack" as four or three of the same cartridge. The owner chose a descriptive
title in the style of Smart Ink's, for example:

- `Brother LC432XL Compatible Ink Cartridges – 4 Colour Set BK, C, M, Y – High Yield`
- `HP 126A Compatible Toner Cartridge – Cyan (~1,000 pages)`

**Format.** `<Brand> <Code> <Genuine|Compatible> <Type>[s] – <Colour | 4 Colour Set BK, C, M, Y | 3 Colour Set C, M, Y> – <High Yield | Extra High Yield>`,
plus ` (~N pages)` on singles only. A pack's single `page_yield` hides the per-colour yields, so packs never show pages.
Tier: XL ⇒ High Yield, XXL ⇒ Extra High Yield, STD ⇒ nothing. The code keeps its tier (`125A`, not `125`).

**What the frontend does now.** `ProductName.build` in `js/utils.js` composes this title on screen from your fields.
Measured with `npm run probe:product-titles` (read-only, all 4,117 live rows): **3,345 composed**. The rest keep their
stored name: label_tape 258, no_code 179 (HP ml-volume inks like "70 130ml", "Photo Value Pack", imaging kits),
printer_ribbon 81, fuser_kit 58, photo_paper 55, waste_toner 42, pack_contents_unknown 28, typewriter_ribbon 22,
color_mismatch 16, belt_unit 11, maintenance_box 9, correction_tape 6, fax_film 5, fax_film_refill 2.

The screen fix does not reach `<title>`, og/JSON-LD, Merchant Center, slugs or emails. Those read the stored name or
`seo.title`, so the gain on Google Shopping needs this rename.

**Ask.**
1. Rename stored `products.name` to the format above. The spec is the CSV from `npm run probe:product-titles`:
   use `shown_title` where `status = COMPOSED`.
2. The KEPT rows (the ~770 above) need names from the owner; do not invent them.
3. Fix the data bugs the probe found: 16 `color_mismatch` rows (e.g. "67XXL … Tri-Colour" stored with `color` "Red").
4. Add 301 redirects for any slug that changes.
5. Update the supplier importers so new rows arrive in this format.
6. Set `seo.title` to match.

**When shipped.** We delete `ProductName.build` and `packRename` and show your name verbatim.

---

## §3 — Admin Pricing page (ERR-336)

The owner wants to control every price from `/admin#pricing` instead of asking the backend. Phase 1 is live: price
grid with filters, select-all-matching, bulk **Set exact price** (writes `manual_retail_price`, one PUT per product,
capped at 200 per run) and bulk **Clear manual price**. The rules engine (the old Site Health → Pricing tab,
approval-gated, migration 187) is mounted unchanged. Controls that need you are visible but disabled with
"Needs backend — asked in backend-docs/outbox/backend-asks-2026-10-15.md".

**Rules the owner set.** Precedence: manual price > most specific rule > broad rule. Margin is typed as GROSS on the
price ex GST. Rules may now lower prices. Every change shows a preview and then one confirm.

**Asks.**
1. **Manual-price flag.** The admin API strips `manual_retail_price` from every read, so the page cannot show which
   products are locked ("Price set by" reads "unknown"). Return `has_manual_price` (bool) and `price_source`
   (`manual` | `rule:<id>` | `ladder`) on `GET /api/admin/products` rows. The value itself can stay hidden.
2. **List params** on `GET /api/admin/products`: price range (`min_price`/`max_price`), `has_manual=true|false`, and
   `ids_only=true` (all matching ids, no paging) so "select all N matching" does not need N/100 reads.
3. **Bulk endpoint** `POST /api/admin/pricing/bulk`: input `{ ids | filter, action: set_exact | adjust_pct | adjust_amount | set_margin | clear_manual, value, lock: bool, dry_run: bool }`.
   You do the maths. `dry_run` returns the per-row before/after for our preview; the real call applies it in one
   transaction and returns per-row results. This replaces our sequential PUT loop and the 200 cap.
4. **Filter rules CRUD**: a saved "margin for this filter" rule (brand, source, product_type, category, cost band)
   with precedence most-specific-wins below manual. Endpoints to list, create, update, delete.
5. **`allow_decrease`**: the never-down ratchet stops rules from lowering prices. The owner wants rules to lower
   prices too. Add a per-rule (or global) `allow_decrease` flag.
6. **Simulate for filter rules**, like the existing tier-multiplier proposal simulate, so the confirm dialog can show
   how many prices go up, go down, and the min/max change.
7. **Reprice on clear**: clearing `manual_retail_price` should reprice that product by the rules at once (today the
   page has to offer a separate "Run reprice").
8. **Packs**: say how pack prices follow rules (own cost, or derived from singles), so a bulk change on singles does not
   leave packs priced above the sum of their singles.

**Also, please check:** `margin_pct` does not match `(price/1.15 − cost)/(price/1.15)` on two rows we checked:
C02BK ($9.99 / cost $5.41: formula 37.7%, returned 35.1%) and G-OKI-720-RIB-BK (22.2% vs 19.5%). Tell us the formula,
or fix the column. The column header carries a caveat until then.

**How we verify.** Read-only Playwright on `/admin#pricing` with writes aborted at the network layer, then one owner-approved
real change. We never send a real bulk write from a probe.

---

## §4 — Pack contents: quantity and page yield per constituent (ERR-340)

**What we measured (live, read-only).** The product page now shows "Pack contents & page yields" under the printer list,
e.g. `1 x Black (LC432XLBK): up to 3,000 pages`.

- `GET /api/products/:sku/constituents` returns `{ pack_sku, pack_type, constituents: [{ sku, name, color, is_active, in_stock }], is_complete }`.
  It has **no yield and no quantity**.
- Twin packs list one constituent (G45BK-2PK lists G45BK once).
- Some value packs return `constituents: []` with `is_complete: true` (GPG645VPVP, G804VPVP). Those contradict each other.
- Single `page_yield` is patchy: every LC432XL and T273 single is blank. Others are free text: "up to 550",
  "250 ISO/IEC 24711", "1,600", "Up to 600". Pack `page_yield` is null or text like "2 x 500 A4".

**Frontend meanwhile.** One extra `GET /api/products/:sku` per constituent to read its yield, and the twin-pack count
from `pack_savings_vs_singles.cartridge_count` or the "N-Pack" name. A KCMY pack page costs 5 reads, and our own
probe tripped `RATE_LIMITED` after ~25 GETs. A line with no published yield shows no number; we never guess one.

**Ask.**
1. Add `quantity` (int) and `page_yield` (int, pages) to each `constituents[]` row.
2. For GPG645VPVP, G804VPVP and any like them: fill the rows, or return `is_complete: false`.
3. Fill blank `page_yield` on singles (all LC432XL and T273 seen), and store it as one number.

**When shipped.** We delete the per-constituent reads and the twin-count bridge.

---

## §5 — Admin products: sort by the margin we display (ERR-311)

**What the owner saw.** `/admin#products`, Margin % ascending, no filters: a $4.50 Dymo label showing **3.8%** sits
between rows showing 10.3% and 10.6%.

**Cause.** `sort=margin_pct` orders by the stored gross `products.margin_pct` (ex-GST price minus cost, no card fee,
no $0.30). The cell shows `net_margin_incl_fixed_pct`, which you already return. On cheap items the fixed $0.30 moves
the margin several points, so the order disagrees with the numbers.

| SKU | Price incl. GST | Cost | Gross (sort key) | Displayed net |
|---|---|---|---|---|
| G745MBK | $203.79 | $154.09 | 13.05% | 10.3% |
| C-DYM-28MM-LBL-WH | $4.50 | $3.40 | 13.1% | 3.8% |
| GCART069HKCMY | $1,746.99 | $1,318.35 | 13.2% | 10.6% |

`sort=profit_ex_gst` has the same problem; the cell shows `profit_incl_fixed_ex_gst`.

**Ask.**
1. Add `net_margin_incl_fixed_pct` and `profit_incl_fixed_ex_gst` to the `sort` enum, same formula as the returned
   fields, both `order=asc` and `order=desc`.
2. Tell us whether rows with no cost price sort first, last, or are excluded.

We cannot sort across pages ourselves (4,453 rows at 100 per page). Until then a note under the table says the sort
is gross. When the keys exist we map the columns to them and remove the note.

---

## §6 — Quote PDF (`GET /api/cart/quote.pdf`): two defects and a design brief (ERR-316)

**What we measured (2026-10-13, two real downloads).** Both were 200, `%PDF-`, 1 page A4, filename
`inkcartridges-quote-Q-261012-<id>.pdf`. Company and reference printed. **Every figure matched `GET /api/cart`.**

**Defects.**
- **Q1 — Garbled line description.** The PDF reads `HP Genuine 711 80mlBK Ink Cartridge 711 80ml Black`: the name is
  joined to another field with no separator. Print the product's display name once (the `name` the cart API returns).
- **Q2 — Date is UTC.** Generated at 00:33 NZDT on 13 October 2026, dated "12th October 2026"; the number
  `Q-261012-…` carries the UTC date too. Date it in `Pacific/Auckland`, and keep the number consistent with the printed date.

**Q3 — Design ("look more professional", owner).** A4, 20 mm margins, one font family, two weights. Top to bottom:
1. **Header.** Logo left (`https://api.inkcartridges.co.nz/logo.png`, 40 mm wide). Right: **QUOTE** in 22 pt, then
   Quote number, Date (NZ), **Valid until** (date + 14 days, or your policy).
2. **From / Prepared for.** Left: Office Consumables Ltd, address, phone, email, GST 94-509-459, NZBN 9429033934204.
   Right: Company, Attention, Reference — only the lines that were supplied.
3. **Line table.** Code · Description · Qty · Unit price (incl. GST) · Amount. Header row fill `#F5F5F5`, hairline rules,
   amounts right-aligned with tabular figures. Volume-priced lines show the struck retail and the price charged
   (same figures as `volume_figures` in `GET /api/cart`).
4. **Totals**, right-aligned, ~80 mm: Subtotal, Volume discount (if any), Coupon (if any), Shipping (zone wording as now),
   **Total NZD (incl. GST)** bold 13 pt over a 1 pt rule, then "Includes GST of $x".
5. **Terms** heading over your current sentences. The reward-points sentence only for a signed-in shopper, not on guest quotes.
6. **How to pay / order** (optional): cart link, and bank account for direct credit with the quote number as reference.
   Leave out if direct credit is not accepted.
7. **Footer** on every page: company name · GST number · website · "Page x of y".

Colours: text `#111`, muted `#666`, accent `#267FB5` for the title and rules. No background images.

**Frontend.** The button on /cart and /checkout now opens a small form (company, attention, PO reference) and downloads
on submit; same endpoint and query. If you change the filename, keep `Content-Disposition` CORS-exposed; we read the
filename from it.

**How we verify.** Repeat the two downloads; check one description per line, an NZ date, a "Valid until" date, and that
the figures still equal `GET /api/cart`.

---

## §7 — Three confirmations from the 7 Oct round (ERR-312, ERR-313, ERR-319)

No code needed unless an answer is "no".
1. **`evidence.spend` units** on `/api/admin/ads/negative-suggestions`: NZD or micros? We print it exactly as sent until you say.
2. **`GET /api/cart` `items[].product.stock_quantity` is a contract.** The compatible "Add" goes straight to the cart by
   `compatible_alternatives[].id`, which carries no stock. Our quantity cap (`Cart.maxQuantityFor`) reads stock from the
   cart reload after every add. Please do not drop that field.
3. **Dispatch cutoff 12pm in emails.** On 2026-10-15 we measured trust, PDP `delivery_estimate`, `/api/cart` and the
   prerender meta all saying 12:00/12pm. We did not check the email templates. Please confirm order-confirmation and
   shipping emails say 12pm, not 2pm.

---

## §8 — Loyalty points: redeem up to the whole order, shipping included; $0 orders skip payment (ERR-345)

**Owner decision.** Customers can redeem as many points as they have, up to the full order total including shipping.
An order fully paid by points goes through at $0 with no card or PayPal step.

**Where the cap is today (measured in code).** The frontend sets no limit. The input max and the Max button read
`loyalty.max_redeemable_points` from the cart response verbatim (`cart-page.js` `renderCartLoyaltyControl`,
`checkout-page.js` `setupLoyaltyHandler`). `POST /api/cart/loyalty` re-validates and refuses with
`EXCEEDS_CART_SUBTOTAL`. So redemption stops at the goods subtotal and can never cover shipping. The frontend never
computes prices, so this is yours to change.

**Already shipped on our side.** Both loyalty error mappers accept a new code `EXCEEDS_ORDER_TOTAL`
("That's more than your order total."); `EXCEEDS_CART_SUBTOTAL` still works. Once you raise
`max_redeemable_points`, the input and Max button follow with no frontend change.

**Ask.**
1. Compute `max_redeemable_points` against the order total INCLUDING shipping (after coupon and B2B discounts),
   divided by `redemption_rate`, rounded down to the 100-point step, capped at the balance.
2. Validate `POST /api/cart/loyalty` against the same total; return `EXCEEDS_ORDER_TOTAL` when over.
3. Judge the free-shipping threshold on the goods subtotal BEFORE points, so applying points can never add a shipping
   charge. Please confirm the current basis.
4. **$0 orders.** Stripe and PayPal cannot charge $0. Add a no-payment place-order path (a new endpoint, or
   `payment_method: "points"` on `POST /api/orders`) that succeeds only when the server total is exactly 0 and refuses
   otherwise. **Send us the endpoint name and the response shape.**
5. Confirm whether the points-paid part of an order earns points (today earn is on goods excluding shipping).

**Blocked on item 4.** When `summary.total === 0`, our single Pay now button must call your no-payment path and hide
the wallet and card UI. We will not build that until the contract exists.

---

*Older `errors.md` entries whose headers still say "open (backend)" — ERR-114, 161, 170, 175, 232, 242, 246 — were not
carried into the 2026-10-15 audit and have not been re-checked against the live API. They are not asks. If you want
to close any of them, ask us first and we will re-measure.*
