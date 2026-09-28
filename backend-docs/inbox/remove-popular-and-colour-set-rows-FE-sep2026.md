# Remove the "Popular … right now" and "Full colour sets" rows — FE, 2026-09-28

**From:** backend, on the owner's instruction · **Priority:** P1, next deploy

## The decision

The owner, 2026-09-28: "these two rows are no longer needed since users have
different printers requiring different cartridges. Please remove this logic
across all pages."

A best-seller or colour-set row shows cartridges for printers the visitor does
not own. Visitors need the cartridges for **their** printer, which the product
list, the printer finder and the "Fits …" lines already give them. Removing
the rows also moves the product list up the page. Paid Search visitors land on
`/ink-cartridges` and `/toner-cartridges`, so there they reach real products
sooner.

## Remove both rows, and the code that loads them, everywhere

Checked live on 2026-09-28. Every page below shows one or both rows:

| Page | Row headings shown today |
|---|---|
| `/ink-cartridges` | "Popular ink cartridges right now", "Full colour sets" |
| `/toner-cartridges` | "Popular toner right now", "Full colour sets" |
| `/shop` (no filter) | "Popular right now", "Full colour sets" |
| `/shop?brand=…` | "Popular right now", "Full colour sets" |
| `/shop?brand=…&code=…` | "Popular right now", "Full colour sets" |
| `/shop?category=…` (e.g. drums) | "Popular drums & supplies right now", "Full colour sets" |
| `/shop?brand=…&printer_slug=…` (printer pages) | "Popular right now", "Full colour sets" |
| `/ribbons` | "Popular ribbons right now" |
| `/search?q=…` with no results | "Popular right now", "Full colour sets" |

Not affected: the home page, product pages and the cart show neither row.

Please remove the row components and their data calls. Hiding them with CSS
still costs every page load the extra requests.

## Keep these

- **`/value-packs`**, including its "Full colour sets" heading. It is a page of
  its own, not a row: it is a Google Ads sitelink destination and is in the
  sitemap. Removing it would get the sitelink disapproved.
- **The "Full-set value pack" badge** on pack cards inside normal product
  lists.
- **The pack offer on a product page** (`pack_suggestion`) and **"Switch to the
  set" in the cart** (`items[].pack_suggestion_for_line`). Both offer the set
  for the cartridge the shopper already chose, so they follow the owner's rule.
  If the owner wants these gone too, we will tell you separately.

## Already done on the backend (live after today's deploy)

- **Search with no results:** `data.recovery.rails[]` no longer contains
  `kind: "popular"`. Only the printer-based rails remain: `compat-printers` and
  `by-printer`. If neither applies, `recovery` is absent. Please show your
  normal "no results" message and the contact / printer-finder help in that
  case.
- **Crawler home page** (`/api/prerender/home`): the "Popular Ink Cartridges &
  Toner in New Zealand" grid is gone. The visible home page never had it, so
  crawlers were shown content that shoppers do not see.
- **Nothing else needed changing.** The crawler HTML for category, brand, series
  and printer pages lists the page's own products only; it never had either
  row.

`GET /api/products/popular` and `GET /api/search/popular` still exist so that
nothing breaks mid-deploy. Once your deploy stops calling them, tell us and we
will delete them.

## Acceptance

On every URL in the table, at desktop 1440x900 and phone 390x664:

- no `h2` / `h3` matching "Popular" or "Full colour sets";
- no request to `/api/products/popular` or `/api/search/popular`, and no
  `pack=value_pack` request made just to fill a row;
- directly under the page title and filters comes the page's own product list,
  or the printer finder on printer pages.

`/value-packs` still loads with its heading and pack list.

We will re-check each URL on production after your deploy.
