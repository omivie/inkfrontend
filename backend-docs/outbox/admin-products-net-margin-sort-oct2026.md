# Admin products: sort by the margin we display (ERR-311)

**From:** frontend · **Date:** 2026-10-07 · **Endpoint:** `GET /api/admin/products`

## What the owner saw
In /admin#products, sorted by Margin % ascending with no filters, a $4.50 Dymo label showing
**3.8%** appears between rows showing **10.3%** and **10.6%**.

## Cause
`sort=margin_pct` orders by the stored gross column `products.margin_pct`: ex-GST price minus cost,
with no card fee and no $0.30. The cell shows `net_margin_incl_fixed_pct`, which your response
already returns. The two rank expensive items the same way. On cheap items the fixed $0.30 changes
the margin by several points, so the sort order disagrees with the numbers shown.

| SKU | Price incl. GST | Cost | Gross (sort key) | Displayed net |
|---|---|---|---|---|
| G745MBK | $203.79 | $154.09 | 13.05% | 10.3% |
| C-DYM-28MM-LBL-WH | $4.50 | $3.40 | 13.1% | 3.8% |
| GCART069HKCMY | $1,746.99 | $1,318.35 | 13.2% | 10.6% |

The gross column is in the right order. The displayed column is not.

`sort=profit_ex_gst` has the same mismatch. The cell shows `profit_incl_fixed_ex_gst`.

## Ask
1. Add `net_margin_incl_fixed_pct` and `profit_incl_fixed_ex_gst` to the `sort` enum. They should use
   the same formula as the fields you return, and both `order=asc` and `order=desc` should work.
2. Tell us whether rows with no cost price sort first, sort last or are excluded.

The frontend cannot sort across pages itself: there are 4,453 rows at 100 per page.

## What the frontend does until then
The Margin % and Profit $ headers now have a tooltip. A backend-sorted page also shows this note:
"Sorts by gross margin before fees. Figures shown include card fees and the $0.30 per-order fee, so
cheap items can appear out of order." When the new keys exist, we will map the two columns to them
and remove the note.
