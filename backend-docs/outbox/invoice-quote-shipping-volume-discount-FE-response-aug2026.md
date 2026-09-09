# Invoice quote — shipping dropdown + volume discount — frontend response (Aug 2026)

**From:** frontend · **Date:** 2026-08-17 · **Re:** `invoice-quote-shipping-volume-discount-aug2026.md`
**Tracking:** ERR-167 (resolved, adjacent) · BF-043 (backend, not blocking)
**Status: shipped. Both changes are live in the invoice editor, verified against your deploy in a
real browser, and all 9 of your QA items pass against production.**

Thank you — this was a good brief. One endpoint answering both problems was the right call, and
`resolved:false` instead of a 400 on a half-typed code is the detail that makes it usable: the
editor re-quotes on every keystroke, and a 400 there would have meant an error toast while the
operator is still typing the SKU.

Three things below are worth your time: §3 (a scope correction — the brief's "never overwrite a
hand-edited price" is bigger than a per-line flag), §5 (we print the discount on the customer's
invoice, which needs three columns from you), and §6 (two small findings about the API surface).

---

## 1. Your QA checklist — all pass, live

Automated as `npm run probe:invoice-quote` (script: `scripts/probe-invoice-quote.mjs`). Read-only,
no write path, no baseline file, credentials from the gitignored `.env`. Run against
`api.inkcartridges.co.nz` on 2026-08-17 as the owner account:

```
Invoice-quote contract probe
  API   https://api.inkcartridges.co.nz/api/admin/invoices/quote
  MODE  read-only — this script has no write path and no baseline file

  ✓ 1. a valid line resolves and is priced      GLC73BK qty 7 · retail 65.49 incl · 56.95 ex
  ✓ 2. a bulk quantity earns a volume discount  −6% (ceiling 6%) → 53.53 ex · line saves 23.94
  ✓ 2b. effective_percent ≤ discount_percent
  ✓ 3. qty 2 is below the entry rung            volume:null, as expected for a sub-$100 band
  ✓ 4. free shipping over the threshold         goods 430.92 incl · threshold 100 · suggested free · 8 options
  ✓ 4b. pickup is always offered
  ✓ 5. freight_excl_gst is ex-GST and lands back on the fee   auckland:urban: 6.09 ex → 7 incl
  ✓ 6. no free shipping under the threshold     goods 5.78 incl · suggested north-island:urban
  ✓ 6b. the delivery hint steers suggested_key  → auckland:rural
  ✓ 7. an unknown code is a soft 200            resolved:false reason:code_not_found
  ✓ 8. positions index the request 1:1          blank line kept its slot with reason:no_code
  ✓ 8b. a typed price on a description-only line reaches the goods total   goods 551.7 incl
  ✓ 9. the quote carries no supplier cost

✓ 13/13 checks passed — the invoice editor's assumptions hold.
```

Your `GLC73BK` worked example reproduces exactly: `retail_incl_gst 65.49`, `unit_excl_gst 56.95`,
`discount_percent 6`, `unit_excl_gst 53.53`, `line_saving_excl_gst 23.94`.

**One number in the brief is stale, harmlessly.** The `auckland:urban` example shows
`fee_incl_gst: 5.99 / freight_excl_gst: 5.21`; live it is `7.00 / 6.09`, and the fee moves with
parcel weight (the same option was `6.09` at 0.7 kg and `10.43` at 1.5 kg). Expected — the brief said
figures move. Recording it only so nobody later reads 5.21 as a regression. The probe asserts the
*shape* and prints the numbers rather than pinning them, so it does not fail when you re-band a tier.

The probe checks two things your list did not, both of which the editor depends on:

- **`freight_excl_gst` really is ex-GST** (`fee_incl_gst ÷ 1.15`, within a cent). The invoice's
  freight field is ex-GST and the fill-from-order path divides an order's `shipping_fee` by 1.15
  because *that* one is incl-GST. If these two ever swapped basis, every invoice would over-charge
  freight by 15% silently. Now asserted.
- **`position` indexes the request 1:1 including blanks.** We map answers back onto rows by position,
  so a dropped blank line would put every badge below it on the wrong row.

---

## 2. What shipped

Two surfaces, because bulk buying does not only happen on invoices.

**Freight dropdown** (`/admin#invoices` editor). A `<select>` beside the existing freight input,
populated from `shipping.options`, preselecting `suggested_key`, labelling each option with its
ex-GST fee, and showing `parcel ≈ 0.7 kg`. Picking one writes `freight_excl_gst` into the existing
field. The input stays typeable; typing flips the dropdown to a `Custom — typed above` state.

**Volume autofill** (invoice editor **and** the Quick Order register). `volume` present → the line's
price becomes `volume.unit_excl_gst` and gets a badge
`Volume −6% (was $56.95) · customer saves $23.94`. `volume: null` → plain `unit_excl_gst`, no badge.
Quick Order shares the line grid and converts into an invoice, so a walk-in buying seven of
something now gets the same ladder as the website; it has no freight field, so it reads only the
per-line half of the response.

**Nothing about saving an invoice changed.** No new payload key for the shipping choice, no
migration, `POST/PUT /api/admin/invoices` byte-identical. The chosen option is *derived* from the
stored freight value rather than stored, deliberately: `buildPayload`'s key set is also walked by the
paid-toggle's full-record PUT and diffed by our drift guard, so adding a key there has consequences
well outside this feature.

That derivation is ambiguous exactly once — `pickup` and `free` both cost $0 — and a stored zero
resolves to `free` when the order qualifies, `pickup` otherwise.

**The `free`-disappears case is loud**, as you asked. Dropping the goods total under $100 with `free`
selected falls back to `suggested_key`, writes the real fee, and raises:

> Free shipping no longer applies — this order is under $100. Freight set to Courier — North Island (Urban).

The reverse (free *becomes* available while a courier option is selected) is only ever offered as a
button, never applied. The operator may be charging freight on purpose, and silently zeroing their
number to be helpful is how you lose their trust in every other autofill on the page.

---

## 3. Scope correction: "never overwrite a hand-edited price" is bigger than it looks

The brief says to track per-line whether the operator manually edited the price. Correct, and we do —
`priceSource: 'auto' | 'manual'`, mirroring the `costSource` idiom already on those lines.

But **three other kinds of price arrive already decided**, and a flag that only watches the keyboard
would have re-priced all of them:

| Source | Why it must be `manual` |
|---|---|
| A **saved invoice**, reopened | It has already been issued. Re-pricing it from today's ladder rewrites what a customer was invoiced. |
| **Fill from an existing order** | Those prices are what the customer actually paid. The invoice would then disagree with the order it was made from. |
| **Quick Order → invoice** conversion | The counter already quoted that price to someone standing there. |

All three load as `manual`, so the ladder can only ever *offer* — the line grows an
`Apply volume price $53.53 (−6%)` button instead. That is the only path by which an authored price
is ever replaced, and it takes an explicit click.

Worth flagging because it is invisible from the backend: the same endpoint, the same response, three
places where applying it automatically would have quietly falsified a document.

---

## 4. `effective_percent`, always

The brief mentions showing `effective_percent` when `floored: true`. We show it **unconditionally** —
it is identical when unfloored and honest when not, so there is no case where reading
`discount_percent` is right. This matches the standing rule for every B2B surface and is asserted by
a test that fails if either editor so much as references the ceiling.

Two related details the brief did not cover, both already load-bearing on the storefront:

- **A rung that floored all the way back to retail gets no badge at all.** `−0%` beside the full
  price is worse than silence.
- **Fractional percents survive.** `0.5%` renders as `0.5%`, and anything under `0.05%` renders as
  `<0.1%` rather than rounding to `0%` or to an empty string — an empty string is falsy and makes the
  badge vanish entirely. Our formatter is a deliberate port of the storefront's, and a test executes
  **both** over the same inputs and fails if they ever disagree.

---

## 5. We print the discount on the customer's invoice — and need three columns (BF-043)

Owner's call: the bulk discount is not just an operator affordance, it goes on the document. Two
additions, both in the live preview and the PDF:

- a sub-line under the description — `Bulk price — 6% off at 7+`
- one line under the total — `You saved $23.94 on this order by buying in bulk.`

Never a subtracting totals row: the unit prices already carry the discount, so a "less bulk discount"
line would take it off twice. And the items table stays at **four columns** — a fifth is how our
supplier cost would one day reach a customer, and a test enforces that.

**The gap.** Those facts have nowhere to live. We send `volume_discount_percent`,
`volume_saving_excl_gst` and `volume_quantity` per line item; with no columns they are ignored and
never come back, so **reopening a saved invoice loses the note**.

The customer's copy is safe meanwhile — `syncStoredPdf()` uploads the rendered PDF at save, so what
they received always carried it. But we will **not** paper over the reload case by re-deriving from
today's ladder. The ladder moves; an invoice from last month must print the discount it actually
gave. Absence renders as "we don't know what discount this invoice gave", never as "it gave none".

**The ask (BF-043, not blocking):** three nullable columns on `invoice_line_items` —
`volume_discount_percent numeric`, `volume_saving_excl_gst numeric`, `volume_quantity int` — stored
from the payload as-is and echoed back on read. No computation, no validation; we only ever write
figures your quote route returned. Our reader is already tolerant
(`l.volume_discount_percent ?? l.volumePercent ?? null`), so shipping it needs **no frontend change
at all**.

---

## 6. Two findings on the API surface

Neither is a bug in your work; both shaped how we integrated.

**a. `API.request()` discards a caller's abort signal.** Our shared client builds its own
`AbortController` for the timeout and spreads it over `fetchOptions`, so `signal` never survives.
We therefore discard stale in-flight quotes with a sequence guard instead of aborting them. Fine —
but it means a debounced editor cannot cancel requests, so at 400 ms we are strictly additive against
your 60/min budget. Comfortably inside it; noting it in case you ever tighten the limit.

**b. A POST is never retried by our client.** 429 and transient 5xx are replayed only for idempotent
GETs. Your endpoint is read-only but is a POST, so a rate limit surfaces immediately. Handled: we
keep the last good quote and the row says *"Rate limit reached — courier rates will refresh
shortly."* No stale-but-silent state — an empty dropdown would read as "there are no shipping
options", which is the failure shape we spend the most effort avoiding.

---

## 7. Also fixed here: ERR-167

Found while mapping the editor, in the product picker used on every invoice line.

`js/security.js` declares `const Security = {…}` and **never assigns `window.Security`**. A top-level
`const` in a classic script is a global *lexical* binding, not a window property — so
`window.Security` is `undefined` everywhere, and twelve escaping helpers written as

```js
const escH = (s) => (window.Security?.escapeHtml ? Security.escapeHtml(String(s ?? '')) : String(s ?? ''));
```

had taken the fallback branch since the day they were written. In `product-search.js` that fallback
returned the string **completely unescaped**, and its output goes straight into `innerHTML` as the
product name — catalogue data, editable in the admin and populated from supplier imports.

All twelve now call `Security` directly with no fallback, pinned by
`tests/security-escaping-guards-aug2026.test.js` (verified to fail when the old guard is put back).
Nothing for you to do; recorded because the same shape can exist server-side.

---

## 8. Where it lives

| | |
|---|---|
| Decision logic (pure, DOM-free) | `js/admin/utils/invoice-quote.js` |
| API method | `AdminAPI.quoteInvoice()` in `js/admin/api.js` |
| Invoice editor | `js/admin/pages/invoices.js` |
| Quick Order | `js/admin/pages/quick-order.js` |
| Document projection + savings total | `js/admin/utils/invoice-math.js` |
| Tests | `tests/admin-invoice-quote-aug2026.test.js` (69) |
| Live probe | `npm run probe:invoice-quote` |

`npm test` — **3,920 tests, 0 failures** (3,843 before).

The last section of the test file is an enrolment gate. When the public volume ladder shipped it went
missing twice — once at a whitelist parser, once at a call site nobody remembered to enrol — so every
place that writes a line price is now asserted to declare whose price it is and to re-quote, and both
ends of the Quick Order → Invoice bridge are asserted to carry the discount fields. A future
fill-from-X path cannot silently go back to flat retail.
