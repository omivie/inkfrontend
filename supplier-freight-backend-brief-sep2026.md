# Supplier freight on order profit — backend brief (ERR-241, Sep 2026)

**Status: the frontend has shipped its half.** The order modal and the Orders list now
deduct supplier freight, and every figure they print for it is an **estimate** because the
backend does not send one. This brief is the three things that would remove the estimate and
make the Dashboard agree with the modal.

---

## 1. What changed on the frontend, and why

The customer's free-shipping threshold is **$100 on the sell price**. The supplier's
free-freight threshold is **$100 on the goods cost, ex-GST**. Two independent tests on two
different numbers, and an order sits on both sides of them routinely.

Order `2026090902` is the proof: sold for $134.49 (customer shipped free) on goods that cost
$76.00 ex-GST. Augmento billed us the delivery. Nothing in the system recorded it, and the
modal reported a **$37.09 take-home at 31.7% margin**. With the freight in, that is
**$31.00 at 26.5%** — a 5.2-point margin error on a routine order.

Owner-confirmed terms (2026-09-09):

| supplier | terms |
|---|---|
| **DSNZ** | bills us freight on **every** purchase order |
| **Augmento** | free at or above **$100 ex-GST**; billed below it |

The rule is applied per supplier, not per order, because it is a per-supplier purchase order.
Live measurement over 60 orders / 86 lines: **49 of 63 supplier POs (78%) are under $100
ex-GST**, and **zero lines name more than one supplier**, so attribution is unambiguous.

## 2. Ask one — send the zone rate unconditionally *(removes every estimate)*

`order.shipping_absorbed` today conflates two different facts:

```jsonc
{ "applies": false }                       // ← all we get on an Augmento-only order
{ "applies": true, "basis": "zone_rate", "zone": "north-island",
  "delivery_type": "urban", "parcel_weight_kg": 0.6,
  "amount_incl_gst": 12, "gst_component": 1.57, "amount_ex_gst": 10.43 }
```

**Please split "what would this parcel cost to send" from "does someone else pay for it".**
Keep `applies` exactly as it is, but populate `amount_incl_gst`, `gst_component`, `zone`,
`delivery_type` and `parcel_weight_kg` on **every** order, including when `applies` is false.

Why this is the highest-value item: the frontend cannot derive the rate. We checked —
**`products` carries no weight column, order items carry none, and `delivery_type` appears
only inside `shipping_absorbed`, i.e. only once you have already decided the cost.** So the
shipped fallback is the **lightest band of the zone ladder**, which is a floor:

> a measured south-island 0.5 kg parcel was charged **$12**; our floor for that zone says
> **$7**. Every freight figure we print is understated for anything heavier than 0.5 kg, and
> we label it "estimated" on screen because of it.

You already compute the correct number 23 times out of 60. We only need it the other 37.

## 3. Ask two — apply the rule server-side *(makes the dashboards agree)*

The order modal and the Orders list compute profit in the frontend and now include freight.
The **Dashboard** and **Financial Health P&L** read `gross_profit`, `net_profit` and
`margin_pct` straight from your RPCs, which do not. Those two surfaces now knowingly
disagree with the modal on the six affected orders in the last sixty, and the divergence
grows with volume.

`trend-math.js` cannot paper over it: it builds COGS from **list** rows, and the list carries
no `suppliers[]`, no `supplier_cost_snapshot` and no `shipping_absorbed` (ERR-039 / ERR-203).
It has no way to know a freight charge exists. We have documented the gap rather than
guessing at it.

Convention to match, so the two sides land on the same number — it is the one the whole admin
already uses (`profitability.js`):

- freight is a **GST-inclusive** cost; deduct it **ex-GST** from profit;
- its GST is a reclaimable input credit and nets at the GST-remitted line;
- it is **not** part of `supplier_cost` — that figure is what the goods cost, and the Orders
  list column pins itself to it. Freight is its own outflow.

## 4. Ask three — confirm the DSNZ/Augmento asymmetry is intended

The frontend charges only the consignments you have **not** already accounted for, and that
rests on one measured fact:

- `shipping_absorbed.applies === true` on **23 of 60** orders;
- **23 of 23** of those contain a DSNZ line;
- **6 of 6** Augmento-only free-shipping orders are `{applies:false}`, with no amount at all.

So we treat your absorbed row as covering the always-pays supplier's consignment and charge
the rest. **If that correlation is an accident of the current implementation rather than a
rule, tell us** — the day `shipping_absorbed` starts appearing on Augmento-only orders, we
would double-charge them. `npm run probe:supplier-freight` §2 re-measures the split on every
run and fails loudly if it ever breaks, but a sentence from you is better than a tripwire.

## 5. How to verify a change on your side

`npm run probe:supplier-freight` (read-only, no recording flag) prints every decision the
shipped resolver makes against live data. After ask one lands, the run should report
**`freight applied: N (0 estimated)`** — the count of estimates going to zero is the signal
that the backend figure is being used. §1 also re-fetches `/api/settings` and fails if the
transcribed zone ladder has drifted from the real one.

Current baseline (2026-09-09, 60 orders): `freight applied: 6 (6 estimated) | no freight
owed: 51 | owed-but-unpriced: 3`.

The three "owed-but-unpriced" orders (`INV-3273`, `20260817000002`, `20260814000002`) each
have a line naming **no supplier at all**, so no rule can be applied. Their take-home is
still shown, marked as a ceiling ("at most") rather than blanked — but a supplier name on
those lines would remove the qualifier.
