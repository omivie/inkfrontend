# Invoice CREDIT LINES — lift `unit_cost_excl_gst >= 0` (Aug 2026)

**Owner-facing feature, frontend is DONE and live.** One backend rule blocks it.

## What the operator wants

Invoice a customer who already paid for the first cartridge and is getting the
second at a discount, with the discount as **its own row on the document**:

```
Ink Cartridge                     1     $99.00
Already paid — invoice 3271       1    -$40.00
                        Sub Total       $59.00
                        GST              $8.85
                        Total           $67.85
```

Not a quietly reduced price on the goods line — the customer has to be able to
see what came off and why.

## The rule that blocks it

`unit_cost_excl_gst` is validated as **`must be greater than or equal to 0`**.

Measured on `POST /api/admin/invoices/quote` (`npm run probe:invoice-quote` §6d,
2026-08-28), which returns **400** and refuses the WHOLE request over one
negative line:

```json
{"ok":false,"error":{"code":"VALIDATION_FAILED","message":"Validation failed",
 "details":[{"field":"line_items.1.unit_cost_excl_gst",
  "message":"\"line_items[1].unit_cost_excl_gst\" must be greater than or equal to 0"}]}}
```

`POST` / `PUT /api/admin/invoices` was **not** probed — that needs a write, and
the owner chose not to create a test invoice. If it shares the schema (likely),
Save fails the same way.

## Asks

1. **Allow a negative `unit_cost_excl_gst` on a line item**, in the invoice
   create/update schema and on `/quote`. Quantity stays `>= 1`; only the price
   may be negative.
2. **Do not floor it to 0 on the way in.** Silently clamping is worse than
   refusing: the frontend renders the customer's PDF and uploads it
   (`POST /:id/pdf`), so a clamped record would leave the document showing a
   credit the stored invoice does not have. Refuse loudly or store it faithfully.
3. **Guard the document, not the line.** The sensible invariant is that the
   invoice **TOTAL** must be `>= 0` — an invoice that owes the customer money is
   a credit note. The frontend already enforces exactly this before it sends
   (`validateInvoice`), and a $0 total is deliberately legal.
4. **On `/quote`, let a negative line reduce `goods_total_incl_gst`.** That is
   what decides free shipping. Until then the frontend omits credit lines from
   the quote body and warns the operator on screen that the threshold ignores
   them — a real wrong-decision risk we are papering over, not fixing.
5. **`supplier_cost_excl_gst: 0` must round-trip as `0`, not `null`.** The
   frontend sends a known `0` for a credit line (there are no goods behind it, so
   the cost is known, not unknown — see `lineSupplierCost` in
   `js/admin/utils/invoice-math.js`). If the server answers `null`,
   `documentDrift()` sees the round-trip disagree and the **Paid toggle refuses
   to work on every invoice that has a credit line**, blaming `line_items`.

## What ships regardless

The frontend is live now and degrades honestly:

- a negative price is typeable, styled as a credit, and printed on the document;
- the credit line's cost is a known `$0`, so the internal margin still computes;
- the freight row says the free-shipping goods total excludes credit lines;
- if the save path does reject it, the operator gets a plain-English message
  naming BF-050 instead of a raw Joi string.

Delete this file once consumed — see `project_backend_handoff_folder_may2026`.
