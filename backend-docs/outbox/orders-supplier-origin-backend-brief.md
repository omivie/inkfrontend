# Backend brief — Order line items: `origin` + `suppliers[]`

**Audience:** backend dev + backend CLI Claude (the `ink-backend-zaeq` service / Supabase).
**Status:** Frontend is LIVE and fail-soft — it already renders two new columns
("Supplier" and "Origin") in the admin order-detail modal. Until you ship the two fields
below, both columns render a muted em-dash ("—") for every line. Nothing is broken; the
UI is simply waiting for data. This brief is the contract.

---

## 1. What the frontend now expects

The admin order-detail modal (Orders page) line-items table gained two columns, visible
to **all admins** (not owner-gated — unlike Cost/Profit, which stay owner-only):

- **Supplier** — who we sourced the line from.
- **Origin** — how the line's pack was produced (single / assembled by us / pre-boxed pack).

Both are driven entirely by two NEW per-line-item fields you must add to the order-detail
payload. The frontend does **no** business logic — it renders exactly what you send.

### Endpoint to extend
`GET /api/admin/orders/{id}` → the `order.items[]` array (each element is one order line).
This is the payload consumed by `AdminAPI.getOrder()` (`inkcartridges/js/admin/api.js:291`,
returns `resp.data.order ?? resp.data`). The list endpoint (`GET /api/admin/orders`) does
**not** need these fields — the columns only appear in the single-order detail view.

---

## 2. The two new fields (exact contract)

Add to each element of `order.items[]`:

```jsonc
{
  // ...existing line fields (sku, product_name, qty, sell_price, supplier_cost_snapshot, ...)

  // (A) origin — how THIS line's pack was produced.
  //     One of exactly these three string literals. Absent/unknown/any other value
  //     => frontend shows a LOUD em-dash (never a silent "single" default).
  "origin": "single" | "in_house_pack" | "supplier_pack",

  // (B) suppliers — where the line was sourced.
  //     single        => 1 entry  (the supplier of the single cartridge)
  //     supplier_pack => 1 entry  (the ONE supplier the pre-boxed pack is bought from)
  //     in_house_pack => N entries, ONE PER CONSTITUENT single we assembled
  //     Absent OR [] => frontend shows em-dash (loud fail-soft), never blank.
  "suppliers": [
    { "name": "Ink Depot NZ",     "sku": "G935C", "color": "Cyan" },
    { "name": "Ink Depot NZ",     "sku": "G935M", "color": "Magenta" },
    { "name": "Cartridge World AU","sku": "G935Y", "color": "Yellow" }
  ]
}
```

### Field rules
| Field | Type | Required | Notes |
|---|---|---|---|
| `origin` | string enum | recommended | `single` \| `in_house_pack` \| `supplier_pack`. Anything else → em-dash. |
| `suppliers` | array | recommended | Empty/absent → em-dash. |
| `suppliers[].name` | string | **required per entry** | The only field the display needs. Entries with no `name` are dropped by the FE. |
| `suppliers[].sku` | string | optional | Constituent SKU. Powers the tooltip. Mainly meaningful for `in_house_pack`; may be null. |
| `suppliers[].color` | string | optional | Constituent colour (e.g. "Cyan"). Tooltip prefers `color`, falls back to `sku`. |

### How the frontend renders it (so you know what the data drives)
- **Supplier cell:** de-duplicates `suppliers[].name` and shows the DISTINCT names joined
  with ", " (e.g. the example above renders **"Ink Depot NZ, Cartridge World AU"** — two
  names, not three). A hover tooltip lists every constituent as `color||sku → name`
  (e.g. `Cyan → Ink Depot NZ`, `Magenta → Ink Depot NZ`, `Yellow → Cartridge World AU`).
  So: send one entry PER CONSTITUENT (do not pre-dedupe) — the FE dedupes for display but
  the per-constituent detail is what makes the tooltip useful.
- **Origin badge:** `single` → grey "Single"; `in_house_pack` → cyan "Assembled";
  `supplier_pack` → yellow "Pre-boxed".

---

## 3. How to DERIVE the two fields (backend business logic)

### 3a. `origin`
Resolve on the backend from two inputs and send the ANSWER (never send `pack_type`; the FE
must not compute origin):

1. **Is the line a pack at all?** Use the product's `pack_type` enum
   (`single` / `value_pack` / `multipack` / `KCMY` / `CMY`) — matches the FE's
   `ProductColors.PACK_VALUES`. `pack_type === 'single'` (or a non-pack) → `origin: "single"`.
2. **If it IS a pack: did WE assemble it, or is it bought pre-boxed?** This is a NEW
   distinction that does not exist in the data model yet. You need a per-pack sourcing flag
   — e.g. a boolean/enum on the pack product (or the pack definition) such as
   `pack_sourcing: 'assembled' | 'prebought'`, or equivalently "does this pack SKU have a
   supplier of its own, or is it only defined by constituent singles?".
   - Assembled from constituent singles → `origin: "in_house_pack"`.
   - Bought pre-boxed as one unit from one supplier → `origin: "supplier_pack"`.

   The pack-health system already models a pack as a parent SKU with constituent singles
   (`/api/admin/packs/:sku/health` → `constituents[]`; FE `bundleLogic.js` /
   `cc2-packs.js`). A pack with a real constituent tree that we regenerate via
   `scripts/genuine.js` / `scripts/compatible.js` is `in_house_pack`. A pack we buy as a
   sealed box (no constituent assembly on our side) is `supplier_pack`. If you have no way
   to tell them apart yet, add the sourcing flag; do NOT guess — an unknown pack should be
   left as `origin` absent (FE shows em-dash) rather than mislabelled.

### 3b. `suppliers[]`
- **`single` / `supplier_pack`:** one entry = the supplier we buy that SKU from. Source it
  the same way you already know `supplier_cost_snapshot`'s supplier (the suppliers entity is
  already accessible via RPC `get_suppliers`; there is a `supplier_filter` / supplier
  analytics layer, so the product→supplier link exists on the backend).
- **`in_house_pack`:** one entry per constituent single, each with that constituent's
  supplier `name` (+ its `sku` and `color`). Reuse the pack-health `constituents[]`
  resolution and join each constituent SKU to its supplier. Order by colour (K, C, M, Y)
  for a tidy tooltip if convenient.

### Snapshot vs live (important for historical orders)
`supplier_cost_snapshot` is a point-in-time snapshot captured at sale time. Ideally capture
the supplier NAME at sale time too (a `supplier_name_snapshot` on the order line, or a
`suppliers` snapshot array), so a supplier the order was ACTUALLY bought from still shows
correctly even if the product's current supplier changes later. If snapshotting the
supplier is out of scope for now, resolving from the product's CURRENT supplier is an
acceptable v1 — just be aware it can drift for old orders.

---

## 4. Non-negotiables / conventions

- **This brief adds supplier IDENTITY only.** It does NOT touch `supplier_cost_snapshot`,
  `sell_price`, GST handling, or any profit/COGS convention. Do not change cost fields.
- **Fail-soft is loud.** Absent `origin` → em-dash (not "single"). Absent/empty
  `suppliers` → em-dash (not blank). Never emit a placeholder that reads as a real answer.
- **Frontend never computes business logic.** Send resolved `origin` + resolved
  `suppliers[]`; do not expect the FE to infer origin from `pack_type` or to resolve
  constituents.
- Keep `suppliers[]` shape consistent with the existing pack-health `constituents[]`
  (`{ color, sku, ... }`) so you can reuse that resolver.

---

## 5. Acceptance test

After deploying, open the admin order-detail modal for:
1. A single-cartridge order → Supplier shows one name; Origin badge "Single".
2. An order with a CMY/KCMY/value-pack line we assemble → Supplier shows the distinct
   constituent supplier names joined with ", "; hover shows `colour → supplier` per
   constituent; Origin badge "Assembled".
3. An order with a pre-boxed pack line → Supplier shows the one pack supplier; Origin badge
   "Pre-boxed".
4. Any older order where you have not populated the fields → both cells show "—" (proves
   the fail-soft path and that nothing else regressed).

---

## Reference files (frontend, for context — do not edit)
- `inkcartridges/js/admin/pages/orders.js` — `originBadge()`, `supplierCell()` helpers and
  the line-items table (`buildOrderModalContent`). This is what consumes your fields.
- `inkcartridges/js/admin/api.js:291` — `getOrder()` (payload entry point).
- `inkcartridges/js/admin/pages/cc2-packs.js` + `utils/bundleLogic.js` — existing pack /
  constituent model to reuse for `in_house_pack` supplier resolution.
