# Backend update for the FE (27 Nov 2026)

Nothing for you to ship now.

## Live since 27 Nov, no FE change needed

1. Printer pages served to crawlers no longer list discontinued products.
2. 26 printers of 7 brands that have no brand page (acroprint, axiohm, hypercom, optima, silver-reed, verifone, vertex) are back in `sitemap-printers.xml`. `/api/shop?brand=<slug>` now answers 200 for those brands (it was 404), with empty `counts`, the same as Okin.
3. Retired printers of brands with no brand page (352 URLs) now 301 to `/shop` instead of `/shop?brand=<brand>`. Your middleware passes the redirect through, so Googlebot gets a 301 to `/shop`.

## For FE-2b (unknown brand → 404 + noindex), when you build it

The updated acceptance rows are in section 7 of `fe-p1-bundle.md`.

- Use `/api/schema/collection?brand=<slug>` to tell whether a brand has a page: 404 means it doesn't. `/api/shop` and `/api/prerender/brand/` can't tell Okin (must stay 200) apart from the 7 brands above (must 404).
- Skip that check when the URL has `printer_slug` or `printer`, because FE-2 decides those. `/shop?brand=silver-reed&printer_slug=silver-reed-tw-3000` stays 200 and indexable.
- On those 26 printer pages, drop the brand crumb. In `shop-page.js`, `updateBreadcrumb()` and `updateSchemaLD()` (`#shop-schema`) link to `/shop?brand=<slug>`, which FE-2b would turn into a 404. Use the same collection check to decide. Our printer prerender and `/api/schema/printer` already leave that crumb out.
