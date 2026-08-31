# Backend brief — adding products: the catalogue pathway (Aug 2026)

**From:** frontend · **Date:** 2026-08-30 · **Tracking:** ERR-187
**Status: frontend is DONE and live.** Nothing below blocks it. Every item is a
gap the frontend is currently working around, in the open, with the workaround
visible to the operator.

There are two ways a product gets into the catalogue. §1 is about proving the
automatic one works. §2–§7 are the asks. §8 is the acceptance test.

Read §1 and §3 first if you read nothing else.

---

## 0. What already exists

- **Automatic:** the supplier feed creates products; `#sync-report` (Feed Sync)
  and `#pending-changes` surface ADD / UPDATE / DEACTIVATE proposals for review.
  This works. What has never existed is any check that a product the feed
  created actually became *reachable*.
- **Manual:** one create form, `POST /api/admin/products`, reached from a
  `+ Add Product` button. It captured ~15 of ~25 editable fields and opened with
  an empty brand dropdown and an empty type dropdown.
- **As of this change:** the manual path starts from a **Browse** tab on
  `/admin#products` that walks the customer's own drill-down — brand → category
  → code → products — and opens the create form pre-filled from wherever the
  operator is standing. The Products table and the editor are unchanged.

**One thing to understand before the asks make sense.** Three of those four
levels are not records. A category is a fixed map over the `product_type` enum;
a **code is not stored anywhere** — it is derived from sku/name at query time,
with `product_codes` as an override layer. A code with zero products cannot
exist. So the pathway is a navigator that pre-fills a form, not a hierarchy of
creates, and "add a brand / add a type / add a code" are three genuinely
different problems, which is what §2, §3 and §7 are about.

---

## 1. The automatic path must be provably correct

A product can be created with a `201`, pass review, and still be invisible to
every customer. Nothing errors. The only symptom is a cartridge nobody finds.

**A product is reachable only if ALL of these hold:**

| # | Facet | Failure mode |
|---|---|---|
| 1 | `is_active` is true | deliberate when set by hand; a bug when the feed does it |
| 2 | `brand_id` is set | with no brand there is no route at all |
| 3 | the brand renders on /shop | see §2 — a brand can exist and still have no tile |
| 4 | `product_type` is set, and is a member of a /shop category | an unmapped type has no category to drill under |
| 5 | a code is derivable from the SKU/name, or supplied in `series_codes`, or overridden in `product_codes` | no code ⇒ no chip ⇒ no route |
| 6 | **the chip actually serves it** | the subtle one — see below |

Facet 6 is the one worth reading twice. A product can carry a code, and a chip
with that exact name can exist, and clicking that chip still does not return the
product. Live example, measured 2026-08-30:

```
GET /api/products?search=GLC38CMY
  → series_codes: ["LC38"], product_type: ink_cartridge, brand: brother

GET /api/shop?brand=brother&category=ink        → series includes {"code":"LC38"}
GET /api/shop?brand=brother&category=ink&code=LC38
  → CLC38BK, CLC38C, CLC38M, CLC38Y, CIB3867CMY, CLC38KCMY
     …and NOT GLC38CMY
```

So "has a code that matches a chip" and "a customer can reach it" are different
claims. Only the second one matters.

### Run this

```bash
npm run probe:catalogue-pathway            # or -- --json
```

Read-only. No credentials, no write path, no baseline file, no `--record`. It
walks the public catalogue, walks what `/shop` actually serves for every
brand+category, and diffs. Exit `0` clean · `1` real findings · `2` could not
look (an unreachable API or a partial sweep is never reported as a pass).

### What it reports today — 2026-08-30, 4,020 active products

```
  ✗  75 × no code derivable from the SKU
  ✗  47 × in the catalogue, but /shop does not serve it
  i  38 ribbons with no code assigned (owner-manual, by design — not a bug)
  i  41 paper products not code-checked (/shop has no code level for paper)

  3898/4020 active products are reachable by walking /shop or /ribbons.
```

**122 products, ~3%, that a customer cannot navigate to.** They are findable by
search and on their own product pages, so this is not invisible inventory — but
nobody browsing will ever meet them.

Two clusters worth your attention:

1. **`no code derivable` (75).** Mostly Dymo genuine label tape (`G18443BK`,
   `G18444BK`, `G1805435BK` …) and a few one-offs like `GPRINKBBK`. The
   extractor's SKU rule keys on the compatible `C` prefix, and a genuine SKU
   like `G18443BK` gives it nothing; the name ("Dymo Genuine 18443 9mm x 5.5m
   Label Tape Black on White") has no `for <Brand> <CODE>` phrase either. These
   need either `manufacturer_part_number` populated so your server-side
   extractor can read them, or `series_codes` supplied directly.
2. **`not served` (47).** Products carrying a valid code whose chip does not
   return them — the `GLC38CMY` shape above. Several are genuine value packs
   (`GLC38CMY`, `GLC40CMY`, `G432KCMY`). Worth checking whether the series
   query drops `pack_type` rows the way `/api/shop?source=compatible` does (the
   PGI650 case documented at `js/api.js:934`).

**The probe is the contract.** Anything it reports is data the backend owns. The
frontend cannot fix any of it — it can only measure it and say so.

### One thing to fix on your side regardless

```
walked to has_next=false and collected 4020 products,
but meta.total claims 4027 — 7 rows are counted and never served.
```

`npm run audit:types` has reported the same gap since 2026-08-03. A product
living only in that gap cannot be checked by anything. Both tools now say so
explicitly rather than implying a complete sweep.

---

## 2. `brands` — there is no way to add one, and adding one is three edits

**Ask: `POST` / `PUT` / `DELETE /api/admin/brands`.**

There is no brand-create path anywhere in the frontend. No `POST
/api/admin/brands`, no `from('brands').insert()`. Brands can only be *selected*.
If a supplier line arrives from a manufacturer we do not already stock, the
owner cannot add it.

**And an endpoint alone would not finish the job.** `/shop` does not render
what `/api/brands` returns — it filters that list against a hardcoded array:

```js
// js/shop-page.js, inside renderBrands()
const preferredOrder = ['brother','canon','epson','hp','samsung',
                        'lexmark','oki','fuji-xerox','kyocera','dymo'];
const inkBrands = sorted.filter(b => preferredOrder.includes(b.slug));
```

A brand absent from that array appears in search, in the admin and on its own
product pages, and **renders no tile on /shop**, with no error anywhere. Logos
come from a second hardcoded map (`brandInfo`, same file).

**There are 17 such brands live right now** — Olivetti, Olympia, Star, Amano,
IBM, Citizen, NEC, NCR, Panasonic, Printronix, Seiko, Seikosha, Sharp,
Triumph-Adler, Universal, Fujitsu, Nakajima. Most are ribbon/typewriter brands
reached through `/ribbons`, so most are fine — but the frontend could not tell
which until now. The Browse tab lists them under
*"17 brands not on /shop"* with the reason, so the state is at least visible.

**Ask: three columns on `brands` so the grid comes from data.**

| column | type | meaning |
|---|---|---|
| `show_on_shop` | bool, default false | render a tile in the /shop brand grid |
| `sort_order` | int | tile order — currently the hardcoded array's order |
| `logo_url` | text, nullable | replaces the `brandInfo` map |

With those three, both hardcoded arrays are deleted and adding a brand becomes
one write. Until then it is a code change in `js/shop-page.js`, and the brief
for whoever does it is: **edit both arrays, or the brand is invisible.**

---

## 3. `DELETE /api/admin/products/:id` does not exist

**ERR-166 / BF-041, open since 2026-08-14. Unchanged.**

```
DELETE /api/admin/products/:id
  → 404 {"ok":false,"error":{"code":"NOT_FOUND","message":"Endpoint not found"}}
```

Note the message: not "product not found" — **"Endpoint not found"**. The route
is not registered. Four alternatives were probed live and all 404
(`DELETE /api/admin/product/:id`, `POST /api/admin/products/:id/delete`,
`DELETE /api/admin/products?id=`, `DELETE /api/admin/products/sku/:sku`).

The admin still ships a bulk Delete button whose confirm says *"This will
permanently delete N products. This action cannot be undone."* Every call
rejects and the toast reports `0 deleted, N failed`. There is no single-row
delete anywhere.

This brief is about making it easy to *add* products. Adding without removing is
half a lifecycle, and the residue is real: `TEST-MBOX1` /
`7f88d112-f0ad-4966-88b0-fdc6d66ae674` has been undeletable since August,
deactivated and renamed `ZZ DO NOT USE`.

---

## 4. `compare_at_price` vs `compare_price`

The product write payload sends **`compare_at_price`**
(`js/admin/pages/products.js`, both create and update). Every direct-PostgREST
read selects **`compare_price`**, and that is the column name in the table.

One of the two is wrong, and if the API is silently dropping an unrecognised key
then the compare price has never saved through the REST path. Please confirm
which name the API expects and whether it round-trips; the frontend will match
whichever you name.

---

## 5. Create should accept what update accepts

`POST /api/admin/products` does not carry `supplier`, `supplier_sku`,
`pack_type` or `category`, all of which `PUT` accepts and all of which exist on
the table. The create form works around this by immediately reopening the record
in the edit drawer so the operator can fill in the rest — a second save for
every new product.

Accepting the same field set on create removes that.

---

## 6. `product_codes` — no change requested, just a note

The frontend now writes a `product_codes` override when, and only when, a
product's own SKU does not already derive the code it was filed under. It never
writes one otherwise, because a product with any row in that table has its
derived `series_codes` ignored permanently — so seeding it would take it out of
the automatic system for good, and a later import that corrected its derivation
would no longer reach it.

The RLS policies from migration 104 are working. Nothing needed here.

---

## 7. Changing the `product_type` enum — the checklist

When a new type is added (as `maintenance_box` was, migration 136), the handoff
said "~2 small changes, one `<option>`". The frontend was carrying **six**
independent type vocabularies and the value was missing from all of them.
Nothing threw: a filter for a nonexistent type returns zero rows, a membership
test returns false, a label map returns `undefined`. It was found by a person
noticing, months later.

So: **tell us the value, and run `npm run audit:types` before and after.** It is
a read-only live oracle that fails in both directions — offered-but-empty and
live-but-unoffered.

The six, for reference:

1. `js/admin/utils/product-types.js` — `PRODUCT_TYPE_OPTIONS` (the editor menu)
2. same file — `PRODUCT_TYPE_LABELS`
3. same file — `TYPE_FILTER_OPTIONS` / `TYPE_FILTER_GROUPS`
4. `js/api.js` — `_CATEGORY_PRODUCT_TYPES`
5. `js/shop-page.js` — `CONSUMABLE_PRODUCT_TYPES`
6. `js/admin/utils/product-codes.js` — `PRODUCT_TYPE_TO_SHOP_CATEGORY`

A type missing from #6 has no /shop category, which fails facet 4 in §1 — so an
enum addition that skips it produces exactly the invisible products this brief
is about.

---

## 8. Acceptance test

```bash
# 1. The reachability contract. Exit 0 = every active product is reachable.
#    Exit 2 = something could not be read; that is NOT a pass.
npm run probe:catalogue-pathway ; echo "exit: $?"

# 2. The type vocabulary, both directions.
npm run audit:types ; echo "exit: $?"

# 3. Brand create — currently 404s. Should be 201, and the row should come back
#    from /api/brands.
curl -s -X POST "$API/api/admin/products/../admin/brands" \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"name":"Test Brand","slug":"test-brand","show_on_shop":false}' | jq .

# 4. Product delete — currently 404 "Endpoint not found" (§3).
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE \
     "$API/api/admin/products/7f88d112-f0ad-4966-88b0-fdc6d66ae674" \
     -H "Authorization: Bearer $TOKEN"

# 5. compare price round-trip (§4). Write one name, read back, see which sticks.
curl -s -X PUT "$API/api/admin/products/$ID" \
     -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"compare_at_price": 99.99}' | jq '.data.product | {compare_at_price, compare_price}'
```

---

## 9. Two conventions this repo asks of any reply

1. **Never cite a `sql/migrations/` path.** That directory does not exist in the
   frontend repo — migrations live in yours. A patch referencing `138_*.sql`
   sent a reader looking for a file they cannot open (ERR-186). Describe the
   change; the migration number is an explanation, not evidence.
2. **A citation is not a measurement.** A previous patch's proof invoice was
   real but predated the fix, so it evidenced the old path, not the new one.
   Removing a guard needs the same quality of proof as installing one. Every
   number in this document was measured on 2026-08-30 against
   `https://ink-backend-zaeq.onrender.com`, and the command that produces each
   is written next to it.

---

## Where the frontend side lives

| file | what |
|---|---|
| `inkcartridges/js/admin/pages/catalogue-browse.js` | the Browse tab — the four-level walk |
| `inkcartridges/js/admin/utils/catalogue-pathway.js` | shared, DOM-free: category↔type, code derivation, the reachability facets |
| `inkcartridges/js/admin/pages/products.js` | the Browse tab wiring + the pre-filled create form |
| `scripts/probe-catalogue-pathway.mjs` | the §1 probe |
| `tests/catalogue-pathway-aug2026.test.js` | 41 tests |
| `errors.md` → ERR-187 | the write-up, including the four false-positive classes this probe had to be corrected through before its numbers could be trusted |
