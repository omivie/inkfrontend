# Backend response — the four open asks (16 Sep 2026)

Reply to the FE note that the four items below were "still open, but correctly
so". Three were real and are now fixed; one was already true and is confirmed.
One of the four turned out to be **misattributed to the wrong route**, and the
real defect was wider than reported.

| # | Ask | Verdict | Status |
|---|---|---|---|
| 1 | BF-062 — no admin route can write a machine list; the product PUT 200s and discards it | **Confirmed, wrong route named** | Fixed |
| 2 | Partial-PUT defaulting — any partial save publishes a product | **Confirmed** | Fixed |
| 3 | `slug_redirects` rename for `printronix-103.23.` | **Confirmed, but do NOT rename** | Resolved differently |
| 4 | Is an empty `suppliers` table intended? | **Yes — intended** | Confirmed, no change |

---

## 1. BF-062 — the machine list (fixed, and it was never specific to that field)

**One admin route could already write it.** `PUT /api/admin/products/:productId`
(by UUID) has accepted `compatible_devices_html` and written it to the private
`product_compat_devices` table since 6 Aug 2026. If you need to unblock right
now, that endpoint works today.

**The route you were calling is a different one, and it discarded far more than
the machine list.** `PUT /api/admin/products/by-sku/:sku` validated against a
schema that declared **three fields** — `retail_price`, `stock_quantity`,
`is_active`. Our `validate()` middleware runs Joi with `stripUnknown: true` and
then **replaces `req.body` with Joi's output**, so every other field was deleted
before the handler ran. The handler then wrote the three it knew about and
returned `200`. Name, description, colour, weight, MPN, barcode, SEO fields,
supplier, category — all of them, not just `compatible_devices_html`.

`POST /api/admin/products` (create) had the same hole on two fields: its schema
omitted `compatible_devices_html` **and** `description_html`, so a create
carrying them returned `201` with both silently stripped.

### What changed

- `PUT /admin/products/by-sku/:sku` now takes the **same body** as the by-id
  route, and additionally writes the machine list and `compatible_printer_ids`.
  It still requires at least one field. Its response shape is unchanged
  (`in_stock`, `stock_status`, `is_low_stock` are still there).
- `POST /admin/products` now accepts and writes `description_html` and
  `compatible_devices_html`.
- Both routes echo `compatible_devices_html` back in the response. It is not a
  `products` column (migration 132 dropped that mirror), so a re-fetch cannot
  carry it — without the echo you could not distinguish a successful write from
  the silent strip.
- The field mapping now lives in **one** shared module
  (`src/utils/productUpdateFields.js`) used by both update routes. Two copies
  are what let them drift from 30 fields to 3 in the first place.

### Behaviour worth knowing

- The list is sanitised with a **wider** tag allow-list than descriptions —
  `<div>`, `<b>`, `<span>`, `<br>` survive. The description sanitiser would
  strip them and collapse the list into one run-on paragraph.
- Sending `compatible_devices_html: ""` **clears** the list. Omitting the field
  leaves it untouched.
- If the list fails to save, the route returns **500 with a retry message**,
  even though the product row itself saved. A silent success there would put
  the storefront's `/api/products/:sku/for-use-in` endpoint out of sync with
  what the admin just typed.

---

## 2. Partial-PUT defaulting (fixed — this was the dangerous one)

Confirmed exactly as described, and the mechanism is worth stating because it
will recur otherwise.

`validate()` does not merge Joi's output over `req.body` — it **replaces** it.
So a Joi `.default()` on an *update* schema is not a fallback for a missing
value; it is a value the caller never sent, applied to a row that already has
one. `fullProductUpdateSchema` carried three:

```
is_active:           default(true)
track_inventory:     default(true)
low_stock_threshold: default(5)
```

Measured before the fix — a rename-only PUT:

```
PUT /api/admin/products/:id   { "name": "Renamed product" }
  → req.body after validate():
    { name: "Renamed product", is_active: true, track_inventory: true, low_stock_threshold: 5 }
```

The handler writes every key that is `!== undefined`, so **renaming a product
published it**, silently reverting a deliberate deactivation — and reset its
stock threshold and inventory tracking at the same time.

Now:

```
  → req.body after validate():
    { name: "Renamed product" }
```

`createProductSchema` **keeps** its defaults — there is no prior row to preserve
there, and its `is_active` default is `false`, which is the safe direction (a
new product starts unlisted).

Pinned by `__tests__/product-update-no-defaults.test.js`, including a test that
asserts **no key anywhere in the update schema carries a default**, so the next
one added fails CI rather than publishing products.

---

## 3. `printronix-103.23` — confirmed, but the rename is the wrong fix

You were right that the canonical pointed at a URL that returned nothing, and
right about the cause: the route's slug gate rejected the `.`. Two things
follow, and neither is the rename you asked for.

### The gate was the bug, and it was much wider than Printronix

`/^[a-z0-9][a-z0-9_-]*$/` gated `/api/products/printer/:printerSlug`,
`/api/printers/:printerSlug/products` and the printer sitemap. Measured live,
it was 400ing **33 active printer rows that carry real compatibility links** —
not one. Among them:

```
hp-designjet-z9+-24in        11 links
hp-designjet-z9+-44in        11
hp-designjet-z9+dr-44in      11
hp-colour-laserjet-m880z+     8
hp-color-laserjet-m855x+      4
hp-laserjet-m806x+nfc         2
epson-300+                    1     ← LQ-300+
nec-p6+ / nec-p7+             1 each
universal-81001.01 / .02      1 each
```

Every one of those is a real, distinct printer. `+` is the character the
duplicate-printer canonical rule **deliberately preserves** (§9.3) precisely
because `epson-300` and `epson-300+` are different machines — so we keep both
rows, and then refused to serve either URL.

**Printer slugs now admit `.` and `+`.** That unblocks 20 of the 33. Product and
brand slugs keep the strict gate — verified live, zero active product or brand
slug contains either character, so nothing widened for them.

What stays rejected is the safety story, not fussiness: the products route feeds
a slug-derived value into a PostgREST `.or()` filter string on its fuzzy
fallback, where `,` `(` `)` are syntax break-outs. `.` and `+` are inert there.
Refusals are pinned in `__tests__/printer-slug-gate.test.js`.

### The Printronix rows themselves were retired today, not renamed

Separately from this work, both rows were deactivated on 2026-09-16 after an
audit found **neither was a printer**: `103.23` is the part number of
Printronix's own ribbon, and both rows held nothing but Epson 103 EcoTank ink
that had arrived through a bare-number collision. Both are now inactive with
zero links (artifact: `deactivate-printronix-junk-printers-2026-09-16.json`).

So please **do not** add the Printronix pair to `PrinterSlug` on your side — the
earlier request to do so is withdrawn. The canonical table is back to your
original 15 and there is no page to redirect.

### Still open — 13 malformed slugs we are NOT fixing in this change

These remain 400 because they carry `/ $ @ \ ' ’ ( )`, which need a slug
**repair plus a `printer_slug_redirects` hop**, not a wider gate:

```
hp-2700/2700e (3)          oki-ml-182/390/420/720/721/790/791 (2)
lexmark-ms/mx-310…610 (1 each)   canon-laserclass-4000/4500 (1)
hp-laserjet\mfp6801 (2)    brother-label-printer-(vc-500w) (1)
fuji-xerox-wc3550@-a (1)   nakajima-x-600' (1)
whether-you’re-labeling-files (3)   oki-$100works (1)
```

The last two are junk rows of the same class as the Printronix pair. The rest
are real printers with malformed slugs. Flagged for a follow-up, deliberately
not bundled here — a printer-slug rename changes live URLs, and a junk-printer
sweep is already running in that area.

---

## 4. Empty `suppliers` table — intended

Confirmed empty (0 rows), and that is correct. Nothing reads it. The table is
vestigial.

`GET /api/admin/suppliers` does not read it either — it derives the supplier
list by grouping **`supplier_offers`** (1,162 rows) by `supplier_name`, joined
to `supplier_contacts` (2 rows) for the email. That is the intended source: a
supplier exists, for our purposes, when it has quoted us a price.

If you are seeing an empty suppliers list in the admin UI, it is not this table
— check the `/api/admin/suppliers` response directly.

---

## Tests

```
__tests__/product-update-fields.test.js        15 tests  (BF-062, both routes + the shared mapper)
__tests__/product-update-no-defaults.test.js   10 tests  (partial-PUT defaulting)
__tests__/printer-slug-gate.test.js            35 tests  (accepts . and +, refuses the injection chars)
```
