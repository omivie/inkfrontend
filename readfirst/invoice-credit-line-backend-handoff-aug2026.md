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

**`POST /api/admin/invoices` enforces the identical rule** — confirmed by write
on 2026-08-28, same 400 and same `details[0]`. A control run proved it is the
SIGN and nothing else: the byte-identical payload with `+40` in place of `-40`
created invoice **#3276**, which was then deleted (`DELETE` → 200
`{deleted:true}`, subsequent `GET` → 404). So the editor is complete and the
only thing between the owner and a credit line is this validator.

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
5. **Keep `supplier_cost_excl_gst: 0` round-tripping as `0`, not `null`.**
   Already correct today — the control invoice stored and returned `0` with
   `cost_source: "auto"`. Recorded because it matters: the frontend sends a known
   `0` for a credit line (no goods behind it, so the cost is known, not unknown —
   `lineSupplierCost` in `js/admin/utils/invoice-math.js`), and if that ever came
   back as `null`, `documentDrift()` would see the round-trip disagree and the
   **Paid toggle would refuse to work on every invoice with a credit line**,
   blaming `line_items`. Nothing to do — just don't normalise it away.

## What ships regardless

The frontend is live now and degrades honestly:

- a negative price is typeable, styled as a credit, and printed on the document;
- the credit line's cost is a known `$0`, so the internal margin still computes;
- the freight row says the free-shipping goods total excludes credit lines;
- the save refusal reaches the operator as a plain-English message naming BF-050,
  not as `"line_items[1].unit_cost_excl_gst" must be greater than or equal to 0`.

Lift the rule and the feature switches on with no frontend change.

Delete this file once consumed — see `project_backend_handoff_folder_may2026`.
