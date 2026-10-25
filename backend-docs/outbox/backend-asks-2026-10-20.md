# Frontend asks — 20 October 2026

**From:** frontend · **Date:** 20 October 2026 (NZDT)

Two asks. §1: the owner wants your view on low-ticket product margins, and wants you to apply the option you think is best.
§2: two dashboard endpoints bound the same date range in different timezones (ERR-367).
Added 24 Oct: §3 answers your receipt-rolls handoff (live, please set `landingPath`); §4 is three small follow-ups from it.
Every figure below was measured on 20 Oct with read-only GETs (`/api/admin/orders/:id`, `/api/admin/products`).
Nothing was written.

---

## §1 Low-ticket products: $1.61 net on a $14.95 order. What is the best fix?

### The order that prompted it

Order **2026101404** (14 Oct, website, Stripe, 1 line). The admin Orders column shows **$1.61 net, 12.4%**.
We re-ran it through the same profit code, and the figure is correct to the cent:

| Item | incl GST | ex GST |
|---|---|---|
| 1× `651.01` Epson LQ2550 Compatible FN Black Printer Ribbon, sell price | $7.95 | $6.91 |
| `supplier_cost_snapshot` | $5.29 | $4.60 |
| **Product gross profit** | | **$2.31 (33.5%)** |
| Delivery charged to customer (`shipping_fee`) | $7.00 | $6.09 |
| Supplier freight (`supplier_freight`, Augmento, `goods_under_free_threshold`, 0.3 kg, auckland) | −$7.00 | −$6.09 |
| Stripe fee (2.65% + $0.30 on $14.95) | −$0.80 | −$0.70 |
| **Net profit** | | **$1.61** |

Delivery nets to $0. The Stripe fee takes 30% of the product's $2.31, mostly the fixed $0.30. The percentage margin
looks normal, but the dollar profit is too small to carry a card fee.

### The product today (unchanged since the order)

`GET /api/admin/products` row for `651.01` (id `86920bc2-2df0-4ba6-81a0-c50254da447e`):

```
retail_price 7.95 · cost_price 4.60 · price_source "ribbon" · price_rule_id null
has_manual_price false · manual_overrides {} · gross_margin_pct 33.46
net_margin_incl_fixed_pct 27.04 · profit_incl_fixed_ex_gst 1.87 · supplier "unknown"
```

So the next order of this ribbon will make the same ~$1.61.

Side note: the product row says `supplier: "unknown"`, but the order's freight consignment resolved to Augmento with
`supplier_basis: "default"`. Please check that this is intended.

### It is not just this one product

Over all 4,121 admin products, **54 have gross profit under $3.00 ex GST** (`retail_price / 1.15 − cost_price`),
counting `ADMIN-INK-001`. By `product_type / source / price_source`:

| Group | Count |
|---|---|
| ink_cartridge / compatible / default | 22 |
| ink_cartridge / compatible / manual | 9 |
| printer_ribbon / compatible / manual | 8 |
| printer_ribbon / compatible / ribbon | 5 |
| ink_bottle / compatible / manual | 2 |
| photo_paper / genuine / default | 2 |
| printer_ribbon / genuine / manual, printer_ribbon / genuine / ribbon, correction_tape / compatible / manual, correction_tape / compatible / ribbon, fax_film_refill / genuine / manual, ink_cartridge / genuine / default | 1 each |

The lowest ribbons (retail incl GST, cost ex GST, gross profit ex GST, `price_source`):

| SKU | Retail | Cost | Gross $ | Source |
|---|---|---|---|---|
| 637.01 | 6.95 | 4.05 | 1.99 | ribbon |
| C-OKI-720-RIB-BK | 6.95 | 3.74 | 2.30 | manual |
| 621.01 | 7.95 | 4.60 | 2.31 | ribbon |
| 651.01 | 7.95 | 4.60 | 2.31 | ribbon |
| 691.01 | 7.95 | 4.50 | 2.41 | manual |
| 659.01 | 7.95 | 4.50 | 2.41 | ribbon |
| 690.01 | 7.95 | 4.40 | 2.51 | ribbon |
| 657.01 / 657.02 | 6.95 | 3.50 | 2.54 | manual |
| C-OKI-IO182-RIB-BK | 7.95 | 4.21 | 2.70 | manual |
| G-CAN-MPRIBBON-RIB-BKRD | 7.95 | 4.16 | 2.75 | ribbon |
| 72680.01 / 72680.02 | 8.95 | 5.00 | 2.78 | manual |
| 72554.09 | 8.95 | 4.90 | 2.88 | manual |

### What we are asking

1. **Your view.** You own the pricing tiers and the fixed-cost model (`net_margin_incl_fixed_pct`). How do you think
   low-ticket items should be priced? Should the pricing tiers have a minimum dollar profit per unit, and if so, how much?
2. **Apply the option you think is best.** Options we can see (pick one, combine them, or suggest something better):
   - (a) A **minimum gross profit in dollars** per unit on the `ribbon` and `default` tiers, for example "at least
     $X ex GST after the Stripe fee", with the price rounded to the usual .95 ending.
   - (b) **Raise the `ribbon` tier** markup for low-cost ribbons only. For example, $9.95 on `651.01` gives about
     $4.05 ex GST gross profit.
   - (c) A **small-order fee** or minimum order value at checkout. This changes the storefront and checkout, so
     please tell us first and we will build the frontend side.
3. **Constraints:**
   - Do **not** overwrite `manual` prices. Those are owner-locked. List the manual rows that your rule would have
     changed, and the owner will decide.
   - Run a dry run first (`POST /pricing/bulk` with `dry_run`, or a rule preview), and include the before/after
     list in your reply: SKU, old price, new price, new gross $.
4. **Reply with:** what you chose and why, what changed (count and list), and any new field or rule the admin
   Pricing page needs to show.

---

## §2 `kpi-summary` and `dashboard-bundle` series read `date_from`/`date_to` in different timezones (ERR-367)

**Measured 2026-10-20 (read-only GETs).** Order **2026102001** ($32.99) was created at `2026-10-19T19:20Z`, which is
NZ 20 Oct 08:20.

With `date_from=2026-03-14&date_to=2026-10-19`:

| Endpoint | Includes 2026102001? | Figure |
|---|---|---|
| `kpi-summary` | **yes** (bounds by UTC date) | `net_profit` −996.76 |
| `dashboard-bundle` `net_profit_series` | **no** | Σ −1,002.86 (month) / −1,002.87 (week); Oct bucket revenue 4,918.09 |

With `date_to=2026-10-20`, the Oct bucket revenue is 4,951.08 and both endpoints read −996.76. The $6.10 gap is that
order's net profit. The admin dashboard's drift guard prints it.

**Ask:** bound both endpoints on **Pacific/Auckland calendar days**, the same as order numbers and the series buckets.
Then an order placed between 00:00 and 13:00 NZ time cannot be counted by one endpoint and not the other.
The frontend now sends NZ dates (ERR-367). That hides the gap for "today", but not for custom ranges.

---

## §3 Receipt rolls are live, including `/receipt-rolls`. Please set the taxonomy `landingPath` (ERR-368)

This answers `receipt-rolls-FE-handoff-oct2026.md` (23 Oct). It shipped in commit `8d1c694c` and was measured live on 24 Oct with
`npm run probe:receipt-rolls` (read-only): 0 findings.

| Check from your "Done when" | Live result |
|---|---|
| `curl -sI https://www.inkcartridges.co.nz/shop?category=receipt` | `HTTP/2 200` |
| `/receipt-rolls`, `/shop?brand=okin&category=receipt` | 200, and the listing shows all 19 rolls in your order (bond, carbonless, thermal). There is no brand picker and no chip row. |
| Aliases `receipt-rolls`, `receipt-roll`, `receipt_roll` | 301 → `/shop?category=receipt` |
| Googlebot on all three URLs | `/api/prerender/category/receipt`. The SPA prints the same `<title>` and h1. |
| CTR80X80P5 | No Genuine/Compatible badge, no disclaimer, no printers block. It does show a spec row (80 mm wide · 80 mm diameter · Thermal paper · 60 gsm · BPA free · 5 rolls per pack). |
| CCR76X76P5 | Neutral placeholder image, not the colour tile |

One click from the nav: the footer Shop column now has "Receipt Rolls", and `/shop` has a "View All Receipt Rolls" tile.
There is no Okin brand tile or brand link anywhere.

**Ask:** set the receipt category's `landingPath` to `/receipt-rolls`. The SPA's canonical reads `categories[].path` from
`/api/site/nav`, so the canonical, nav link and sitemap move together with no frontend change.
Today it is `/shop?category=receipt` with `landing: false`. Both URLs stay 200 after the switch.

## §4 Three follow-ups from the receipt-rolls work

1. **The API rejects the aliases.** The handoff says the backend accepts `receipt-rolls` / `receipt-roll` / `receipt_roll`. On 24 Oct,
   `GET /api/products?category=receipt-rolls` and `GET /api/shop?brand=okin&category=receipt_roll` both returned
   `422 VALIDATION_FAILED` ("category must be one of …"). The frontend now 301s them to `receipt` before any fetch, so nothing is
   broken. Please confirm whether the aliases are meant for the API or only for your www redirect rules.
2. **Bot pages link to an Okin brand page that does not exist.** The product prerender for a roll (CTR80X80P5) has a breadcrumb
   "Okin" → `/shop?brand=okin` and "See all Okin products →". It also has "Receipt Rolls" →
   `/shop?brand=okin&category=receipt`. `/api/prerender/brand/okin` returns **404**. On the storefront, `/shop?brand=okin` is a
   brand page with nothing to show, because the handoff keeps Okin out of the brand nav. Could the roll prerender link "Receipt Rolls"
   to the category URL and drop the Okin links? The SPA already does this: it shows "Okin" as plain text in the breadcrumb, and
   "Receipt Rolls" links to `/shop?category=receipt`. Bot and human then match. In the meantime, the edge sends bots on
   `?brand=okin&category=receipt` to your category prerender.
3. **The bot footer has no Receipt Rolls link.** The human footer's Shop column now lists Receipt Rolls; your prerender footer
   (Ink · Toner · Drum Units · Ribbons) does not. This is the safe direction for a cloaking review, but please add it so both
   footers list the same five categories.

## §5 FE-MASTER-CHECKLIST (22 Oct): shipped, measured, and five things for you (ERR-369..372)

Everything below is live on www since 2026-10-25 (commits 22ebff43, b9297737, 9fa29dd5 and the ERR-372 commit).
Each item's measurements are in `errors.md` under its ERR number.

1. **Item 46 — please make the bot prerender match.** Printer pages (`/shop?brand=…&printer_slug=…`) now list, inside
   each source section (Compatible above Genuine): buyable first, then cartridges before drums/parts, then cheapest
   first, ties in your order. Please order `/api/prerender/printer/…` the same way so bot and human pages match.
   Out-of-stock cards still show "Contact us", not Add (the owner's contact-button rule).
2. **Item 37 — the search redirect is ready and waiting for your flags.** On 2026-10-25 `/api/search/smart` sent neither
   `matched_printer.exact` nor `exact_product`. Example: "brother mfc-j4340dw" matched `brother-mfc-j4340dw-xl`. The FE
   redirects ONLY on `exact === true` or an `exact_product.url` on our own `/products/<slug>/<sku>` path, page 1 only.
   Nothing changes until you ship them.
3. **Item 43 — the beacon formats.**
   - `grid_ready` element = `grid_ready <ms since navigation start>`, once per page load.
   - `client_error` element = `<surface> <METHOD> <path+query> <status|timeout|network>`, ≤512 characters. Surfaces:
     `shop-drilldown`, `search-dropdown`, `pdp`, `cart-pricing`, `ribbons-<surface>`. Example:
     `shop-drilldown GET /api/products/printer/hp-deskjet-2820e 503`.
   - **A grid Add click = `add_to_cart:<product uuid>`.** The PDP keeps `add_to_cart`, with the SKU in the path. If your
     funnel counts `element = 'add_to_cart'` exactly, please switch it to a prefix match.
   - Browsers with `navigator.webdriver` or `localStorage.ic_internal = '1'` send no beacons.
   - We confirmed the enum without writing a row, by omitting required fields. We did write two labelled rows earlier
     (`path=/__fe_probe`, session `fe-probe-enum-20261024`); please delete them if they matter.
4. **Not done, and why.**
   - **26b:** it asked us to drop DELIVERY/RETURNS on desktop because they "repeat the service row under Add". The owner
     removed that row on 13 Oct (ERR-329), so those rows are now the PDP's only delivery and returns facts. Please confirm
     you still want them gone.
   - **22:** already true on 25 Oct (GLC233BK image at y 255).
   - **41:** `docs/seo/guides-content-plan-oct2026.md` is not in our repo. Please send it.
   - **32 fixes 3–6:** `docs/storefront/mobile-speed-FE-handoff-oct2026.md` is not in our repo either. Please send it.
5. **Measured differences from the checklist.**
   - **27a:** the guarantee is at `data.warranty.compatible_label` on `/api/site/trust`, not `trust_signals.warranty`; we
     read both.
   - **24:** a 64px bar still covered the first-row Add at 1280x551, so the bar is 45px on a mouse, and the chrome above the
     grid was tightened on short laptops.
   - **26a:** the 3+ price sits on the Availability row, 7px under the price (centres 33px apart, not ≤30). On the price row
     it wrapped and pushed Add down 26px.
   - **25:** Filter & Sort is inline, not sticky. Any fixed overlay fails your own 300px-step sweep.
   - Every item 24/25 done-when passes locally. Live before the deploy failed 3 of 4 phone sweeps.
