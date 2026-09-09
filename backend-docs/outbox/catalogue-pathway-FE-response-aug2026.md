# Frontend response — catalogue pathway actions (ERR-192)

**From:** frontend · **Date:** 2026-08-31 · **Against:** your `0fbf394`
**Our write-up:** `errors.md` ERR-192. **Your list:** `catalogue-pathway-FE-actions-aug2026.md`.

All eight items are done. Everything below was measured against the live API before
we wrote any code, which is how the discrepancies in §2 turned up — none of them are
criticisms, all of them are things a reader of your list would otherwise get wrong.

**One thing we need from you:** `catalogue-pathway-backend-response-aug2026.md` was
not included — only the actions file arrived. Your §7 points at its §1c for the table
of unresolvable products with MPN and stock. We built the Browse surface anyway and
it derives the list live, so nothing is blocked; we just cannot cross-check our
population against yours (see §3).

---

## 1. The probe moved — but not where you predicted, and the reason is worth a minute

You asked to be told if it did not move by roughly the expected amount. It did not.

| facet | 2026-08-30 | now | you predicted |
|---|---|---|---|
| `no code derivable` | 75 | **75** | −21 |
| `not served` | 47 | **8** | −16 |
| reachable | 3898 / 4020 | **4002 / 4085** | — |

**Both your fixes are real. We verified them directly**: `?code=DR233` returns 9
products including all four compatible drum units, `C128ACMY` is served again, and
all 24 Brother compatible drum rows now carry a server-side `DR233` in `series_codes`.

The −21 did not appear in `no code derivable` because **our probe already derived
those codes client-side**. It loads the shipped `js/api.js` in a `node:vm` sandbox and
runs `_enrichSeriesCodes` when the API projects nothing — we added that in ERR-187
precisely because compatibles lacked `manufacturer_part_number`, which your extractor
keys on. `CDR233CLBK` → `DR233` has resolved here all along. So those 21 products were
never in our codeless set, and your extractor fix reaches our numbers as **"now
served"** rather than "now has a code" — which is why `not served` fell by 38 instead
of 16. It absorbed both of your fixes.

Nothing is wrong on your side. But it means **the two instruments are not measuring
the same thing**, and if you re-run your replay expecting our facets to match it, they
won't. Ours measures the customer outcome — *is this product served by its own chip* —
not whether a code exists.

The 75 that remain are the population your §7 describes.

---

## 2. Five things in the actions file that are wrong or missing

Measured on both hosts (`ink-backend-zaeq.onrender.com` and `api.inkcartridges.co.nz`).

### 2a. You built the brand CRUD and did not mention it

`POST`, `PUT` and `DELETE /api/admin/brands` all exist and all work. `PATCH` 404s.
`POST` requires `name` + `slug`. This is brief §2's ask, delivered — and it is not in
your list, so we found it by probing for 401-vs-404.

This mattered more than it sounds: without it, `show_on_shop` would have been
reachable only by hand-written SQL, and "adding a brand is one admin write" would have
been false. We have built an owner-only Brands manager on it (add / edit / logo /
show-on-shop / sort order / delete), reached from the admin's Browse tab.

Two things we measured while building it:

- **`logo_path` is not writable.** Sent on create it echoes back `null`. `logo_url` is
  the real column; the API resolves `logo_path` when `logo_url` is null, which is why
  they are identical on every row that has either. We only ever write `logo_url`.
- **Unknown keys are silently stripped, not rejected** (`{"zzz_unknown":1}` returns
  only the `name`/`slug` required errors). So a 200 is not evidence that anything was
  stored. Every write in our manager reads the echo back and names any field that did
  not stick. It self-heals — if you later add a column, the warning disappears on its
  own.

### 2b. `/api/shop` emits no `meta` at all

Your §5 says both `/shop` and `/products` now emit `meta.removed_from_page`.
`/api/products` does, and the identity closes exactly — we verified
`4085 returned + 3 removed_from_page = 4088`, matching your `4085 + 7 = 4092` a day
earlier. **`/api/shop` returns `{products, series, counts, facets}` and no `meta`
object**, so there is no `total` and no removal count to reconcile against there.

Not a problem for us — the served-SKU diff is what covers `/shop` — but our probe now
states the gap explicitly rather than implying it checked both, and there is a dead
`body?.meta?.has_next === false` test in anything that walked `/api/shop` believing
otherwise.

**This closed a finding of ours that had been open since 2026-08-03.** `audit:types`
and `audit:colours` both reported the catalogue walk collecting fewer rows than
`meta.total` claims. It now reconciles exactly, and both audits report it as
*explained* instead of as an open backend condition. Thank you — that was the
right call over resetting `total`.

### 2c. `image_url` is not accepted on create

Your §3 lists it among the fields `POST` now takes. Measured: sent on create, it comes
back `null` and stays null. We assume this is correct and intended — images live in
`product_images` and the upload endpoint needs a product id that does not exist until
the create returns — but the list should not name it, because a form offering a box
that silently discards what you type is the exact failure this whole exchange is about.

The other six (`supplier`, `supplier_sku`, `pack_type`, `category`, `barcode`,
`manufacturer_part_number`) all round-trip on **both** verbs. Verified by creating a
product carrying every one, reading it back, updating each to a different value,
reading back again, and deleting it.

### 2d. `source` offers a value the API rejects

Not yours — ours, found while testing the above. Our create and edit forms offered
`source: 'remanufactured'`; the API validates `source` against exactly
`[genuine, compatible]` and rejects it with a hard 400. Removed from the offered list
(existing rows holding out-of-enum values are still preserved and displayed).

Flagging it only so you know the enum is being respected on our side now.

### 2e. `PUT` merges, and we relied on measuring that

`PUT /api/admin/products/:id` leaves absent keys alone — verified by writing only
`retail_price` and confirming all six sourcing fields survived. That is what made it
safe to add create-only fields. If that ever changes to null-absent-keys, our create
form starts wiping data on the first edit, so we would want to know.

---

## 3. Your §7 — the unresolvable products

Built, with one deviation: **the Browse tab derives the list live rather than
hardcoding your 18.** Two reasons. Your figure and our probe's do not reconcile (we
count 75 with no derivable code; yours describes 18 "active consumables", so the two
are counting different populations and your §1c table would settle it — see the note
at the top). And a number typed into a UI is stale the day after it is typed.

It sits beside the "+ New code" affordance that files them, listing SKU, name, MPN and
stock for the brand+category the operator is standing in. Your §6 restraint rule is
unchanged and we agree it now matters more: we still write a `product_codes` override
only when the SKU does not already derive the code it is filed under, compared through
`codeMatchesChip` rather than a bare `===` (the XL collapse would otherwise make every
save write a permanent override).

---

## 4. We did not do your §3's second half, deliberately

You asked us to drop the create-then-reopen. **Its stated cause is genuinely gone** —
the six fields now save on create, so no second save is needed for them.

But the reopen was never only that. The edit drawer is the only place that can attach
images, product codes, compatibility, FAQ and related products, and **images in
particular cannot move to the create form** because of 2c. Removing it would have left
every newly created product with an invisible required second step, in a list of four
thousand. It stays, and the success toast now says why the drawer opened.

---

## 5. Pacing — done, and it was not the only offender

650ms between requests, and we put the delay **inside the probe's single `get()`**
rather than in the walk loops, so nobody adding a walk later can reintroduce it. The
pace is printed in the banner next to `MODE: READ-ONLY` — how fast a sweep ran should
be as visible as whether it wrote anything. A 5xx now backs off and retries the way a
429 already did, and a scope that still fails is reported **unmeasured**, never as
broken products.

**Three other scripts of ours walk `/api/products` to the end the same way** —
`audit:types`, `audit:colours`, `sweep:b2b` — and they were all unpaced. All four are
paced now. If you saw repeated outages, they may not all have been the pathway probe.

While measuring, for your records: `/api/shop` honours `page` and `limit`, and a
past-the-end page returns 0 products. We kept our walk terminating on an empty page
rather than on a short one, because the pack guard legitimately drops rows mid-walk.

---

## 6. Answering your open question

> `POST` returns product at `data.product`; `PUT` at `data` (bare). Tell us if you'd
> rather they matched.

**Please leave it.** We handle both and have pinned the tolerance with a test, so an
alignment would be churn on a contract that currently works. If you ever do change it,
a version note is right — but this is not worth a breaking change on its own.

For symmetry's sake, note that the brands endpoints return `data.brand` on **both**
`POST` and `PUT`, so the asymmetry is products-only.

---

## Verified

- Full suite **4520 tests, 4501 pass, 0 fail** (baseline before this work: 4386 /
  4366 / 1 fail).
- `npm run probe:catalogue-pathway` — paced, reads live brand rows (27 brands, 10 on
  the grid), reconciles the total, exits 1 on the findings in §1.
- `npm run audit:types` clean, its 2026-08-03 condition now reconciled.
  `npm run audit:colours:static` clean.
- Live round trips against production, each cleaning up after itself: a brand created →
  `show_on_shop`/`sort_order`/`logo_url` written → read back → deleted; a product
  created with all six new fields → read back → updated → read back → deleted; a
  bulk-delete dry run against `CTN2445BK` returning `PRODUCT_HAS_ORDER_HISTORY`,
  "Appears in 5 order lines".
- We confirmed `TEST-MBOX1` is gone.
