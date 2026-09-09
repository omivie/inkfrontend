# `cost_price` on `authenticated` landed, and it took the Products list's fast leg with it

**From**: frontend · **Date**: 2026-09-06 · **Ref**: ERR-220, BF-044 (phase 2), ERR-170, ERR-193
**Probe**: `npm run probe:admin-products` — read-only, no recording mode, mode printed every run.

Not a complaint about the revoke. It is right and it should stay. This is the notification that
nobody sent, plus two things we need and one we fixed ourselves.

---

## 1. What we measured

Signed in as the owner (`authenticated`, super_admin), against live:

```
GET /rest/v1/products?select=<the 31 columns pages/products.js ships>
  -> 403  42501 permission denied for table products

bisecting those 31 columns, one request each
  -> cost_price, and only cost_price
```

BF-044 phase 2 — *"all three columns, from `anon` now and from `authenticated` at phase 2"* — has
landed. Nothing in our repo was told, and the Products page's own diagnostic (`DebugLog.warn`) is a
no-op off localhost, so the failure has been invisible: the operator saw a toast reading *"fell back
to the backend"* and no reason, and we only found it because the owner sent a screenshot of a
different symptom.

**The blast radius, stated so nobody has to guess it:** what breaks is a read that goes **directly**
to PostgREST — anon key or a signed-in JWT — naming a privileged column. That is the ERR-193 shape
exactly (one refused direct read blanked 63 ribbon brand pages for 44 hours with no alert). What
does **not** break is anything through `/api/…`; you hold service-role credentials and still serve
`cost_price` to `super_admin` on both list and detail. We re-measured the Orders supplier-cost column
while writing this — 67/67 detail items intact.

## 2. What it had been doing to the Products list

The Supabase leg is refused, so the page has been taking its backend fallback **on every load**, not
occasionally. Everything that leg cannot carry has therefore been permanently missing, silently:

- **Four filters dropped.** `source`, `product_type`, `has_images`, `stock_status` — all four
  supported by `GET /api/admin/products`, all four honoured by you on 100/100 rows when we asked
  properly. The owner's screenshot is the Source dropdown reading **Genuine** over a full page of
  **Compatible** rows. That one is ours; the fallback rebuilt its filter object and read five keys.
  Fixed, and now held by an enrolment test that reads the param list out of our API client.
- **Pack, Supplier and the "All Ribbons" grouped type** are unavailable for as long as the fast leg
  is down. We now name them on screen instead of returning unfiltered rows under an active filter.

## 3. Two things we need from you

### 🔵 BF-044 (a) — now urgent, and the cheaper half is enough

The original ask stands: **pack type / colour, supplier, and product-type-*group* filters on
`GET /api/admin/products`, plus `supplier` + `supplier_sku` on the response.** It was "nice to have,
unblocks phase 2" in August. It is now the only thing that restores three filters the owner uses.

If (a) is expensive, **(b) a narrow owner-only `GET /api/admin/products/costs?ids=…`** still works
and is unchanged from the original brief.

### 🔵 BF-045 (new) — `GET /api/admin/products` returns no pagination block

The envelope is `{ products: [...] }` and nothing else. No `pagination`, no `total`, no count header.

That is not cosmetic. Our page substituted `rows.length` for the missing total, so the footer read
**"1–100 of 100"** for a catalogue of **3,398**, `Math.ceil(100/100)` gave one page, and **Next was
disabled**. The rows were always there — `?page=2` starts at a different SKU — but **3,298 products
were unreachable from the admin Products list**. We have fixed our half (an unknown total now renders
as *"1–100 of many"* with Next alive), but "many" is the best we can honestly print until you send a
count. Every other admin list endpoint we consume returns `pagination.total`; this one is the
exception.

## 4. What we shipped, so you know what you are changing

- One `backendProductFilters()` shared by the planned backend leg, the fallback and the PDF export
  (the PDF had drifted the same way — a "Genuine" export was the whole catalogue).
- Losses named per filter instead of *"results may match slightly differently"*.
- `paginationFrom()` + a table footer that says "of many" rather than inventing a total.
- `productOrigin()` now distinguishes an **absent** `supplier_sku` from a **null** one. Worth knowing
  on your side too: your list returns `pack_type` on 100/100 rows and `supplier_sku` on 0/100, and we
  were reading absence as "no supplier code for this pack" — 27 of the first 100 rows wore a
  confident **Assembled** badge derived from a field that response never carried. If BF-044(a) adds
  `supplier_sku`, that inference becomes real data instead of an inference.

## 5. How to check us

`npm run probe:admin-products` names the failing column, verifies you honour each forwarded filter,
and gates on what our page *does* with a missing total and a missing supplier field — not merely on
the gaps themselves. It exits 2, never 1, when it cannot run: *"we could not look"* must never read
as *"we looked and it was fine"*.
