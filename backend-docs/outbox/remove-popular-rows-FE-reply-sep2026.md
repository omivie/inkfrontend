# Popular and colour-set rows removed: FE reply, 2026-09-28

**To:** backend · **Answers:** `inbox/remove-popular-and-colour-set-rows-FE-sep2026.md` · **FE ref:** ERR-290

## Done

Both rows, their markup and the code that loads them are **deleted, not hidden**, on every page in your table.
The endpoints are free to delete once this deploy is live (see the last section).

We measured with `npm run probe:popular-rows-removed`. It runs your acceptance list on every URL in your
table at 1440x900 and 390x664.

| | production, before our deploy | our build, localhost:3000 |
|---|---|---|
| result | 35 pass, **46 fail** | **81 pass, 0 fail** |
| `h2`/`h3` matching "Popular" or "Full colour sets" | on all 9 URLs | none |
| `/api/products/popular` requests | `/ink-cartridges`, `/toner-cartridges`, `/ribbons` | none |
| `pack=value_pack` requests | none outside `/value-packs` | none outside `/value-packs` |
| `/value-packs` (the control) | heading, 24 packs, its own `pack=value_pack` request | unchanged |

The probe checks `/value-packs` first. If it cannot see that page's own `pack=value_pack` request, the
probe stops, because its request detector would then be blind.

**Deployed as `bd26709` on 2026-09-28. The same probe against production now reads 81 pass, 0 fail**
(no 429s, and the `/value-packs` control passed). Please run your own re-check.

## Why you saw the rows on brand, printer and search pages

A shopper only ever saw them on `/ink-cartridges`, `/toner-cartridges` and `/ribbons`. But one HTML
file serves every `/shop…` URL, the two landings and `/search`, and it carried both rows as hidden
sections. So a DOM check finds the headings on every one of those URLs. We removed the markup itself,
so your check and ours now agree.

## One caller your list did not include

Your list says the home page is not affected. The home page script (`js/landing.js`) still had a
function that called `GET /api/products/popular?limit=8` for a "featured products" grid. It never ran,
because no page ships the element it fills. It would have become a call to a deleted route as soon as
anyone added that element. It is deleted.

We have never called `GET /api/search/popular`.

## Search with no results

We never rendered `kind: "popular"`, and now ignore any rail kind we do not know. When `recovery` is
absent the page shows:

- the "No results for …" message;
- the brand grid;
- a new "Still can't find it?" link to the printer finder;
- the page's existing help box with phone and email (it was already under every search page).

We also renamed one of our own headings. The offline fallback rail was titled "Browse popular
categories", which would have matched your "Popular" check without being a best-seller row. It is now
"Browse by category".

## Kept, as you asked

These stay, and a test fails if any of them goes:

- `/value-packs` and its "Full colour sets" heading;
- the "Full-set value pack" badge on cards;
- the PDP pack offer (`pack_suggestion`);
- the cart's "Switch to the set" (`items[].pack_suggestion_for_line`).

We also kept the printer page's "Colour Pack Bundles" (`GET /api/printers/:slug/color-packs`). It shows
the packs for that printer only, so it follows the owner's rule. It did not render on the printer page
we measured, and the probe warns if it ever sits above the product list. If the owner wants it gone too,
tell us.

## You can delete both endpoints

Once this deploy is live, no frontend code calls `GET /api/products/popular` or `GET /api/search/popular`.
A test (`tests/popular-rows-removed-sep2026.test.js` §2) fails if a storefront script calls either again.
