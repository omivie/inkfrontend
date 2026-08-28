# Invoice CUSTOM ITEMS — store `product_ref` on a line item (Aug 2026)

**Owner-facing feature, frontend is DONE and live.** One nullable column would
finish it.

## The ask

Add a nullable text column `product_ref` to the invoice line item, **stored and
echoed back** on `GET/POST/PUT /api/admin/invoices`.

That is the whole request. It is opaque to you: **never resolve it, never
validate it, never match it against `products`.**

## Why it is a new column and not `product_code`

The owner wants to invoice non-catalogue items — a refurbished unit, a machine
sourced in for one customer, a service — with **their own reference printed in
the Product Code column** of the customer's invoice.

The obvious move, letting them type it into `product_code`, is the one thing we
must not do. You match line items by SKU when you materialise the shadow order,
so a non-SKU drops the line and leaves a paid order with no line items — ERR-071,
invoices #3263/#3264 — and the save is correctly rejected today with
`400 VALIDATION_FAILED` + `details.unresolved`. **Please keep that validator
exactly as it is.**

So the frontend splits the two jobs that box was doing:

| field | meaning | reaches your SKU matcher |
|---|---|---|
| `product_code` | which catalogue product this is — a real `products.sku`, or `''` | yes, unchanged |
| `product_ref` | what the customer sees in the code column — free text, ours | **no, ever** |

A custom line ships `product_code: ''` — the same empty code freight lines have
used since ERR-071 — so nothing new can reach the matcher. `product_ref` is
purely a string we hand you and would like back.

## Shape

```json
{ "product_code": "",
  "product_ref": "REFURB-01",
  "description": "Refurbished drum unit",
  "quantity": 1,
  "unit_cost_excl_gst": 180,
  "supplier_cost_excl_gst": 120,
  "cost_source": "manual" }
```

- Nullable. `null` and `""` both mean "no reference" — an ordinary catalogue line
  sends `null`.
- No length or character rules beyond sane column limits; it is a human label.
- Echo it on read. That is what the frontend uses to restore the line as a custom
  item when the invoice is reopened.

## What happens until then

**Confirmed by write, 2026-08-28.** A test invoice with
`product_code: ''` + `product_ref: 'REFURB-01'` **saved fine (201)** — the line,
its description and its supplier cost all stored — and read back with the ref
**dropped**: the echoed keys were `product_code, description, quantity,
unit_cost_excl_gst, line_total_excl_gst, supplier_cost_excl_gst, cost_source`.
Then deleted (`DELETE` → 200 `{deleted:true}`, `GET` → 404). So the custom-item
feature works end to end today; only the reference fails to persist.

The frontend sends it now and **measures whether it came back** rather than
assuming (`refEchoMissing` in `js/admin/pages/invoices.js`). While the key is
absent from the echo, the operator is told — in the save toast, and as a standing
note in the editor on the paths that keep it open:

> Your refs print on this invoice and on the PDF the customer receives, but the
> invoice service isn't storing them yet (BF-051) — reopen this invoice and that
> column will be blank.

The customer's document is unaffected in the meantime: the frontend renders the
PDF and uploads it (`POST /:id/pdf`), so what they receive always carries the
reference. Only reopening the invoice in the admin loses it.

**The check is by key PRESENCE, not truthiness** — a present-but-`null`
`product_ref` reads as "the column exists and is empty", which is correct and
raises nothing. So the day this ships the warning stops appearing on its own,
with no frontend change and nothing to remember to remove.

Delete this file once consumed — see `project_backend_handoff_folder_may2026`.
