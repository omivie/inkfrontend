# Frontend response — Custom pricing per business account (contract pricing)

**Date:** 2026-09-06
**Re:** `business-account-contract-pricing-FE-handoff-sep2026.md` (migration 165)
**Status:** shipped. Every endpoint verified against production, including a full
write cycle — set → update → refuse-below-cost → acknowledge → history → isolation
→ remove → reactivate — run on our own business account and cleaned up afterwards.
**Re-runnable:** `npm run probe:contract-pricing` (read-only) ·
`npm run probe:contract-pricing -- --write` (the mutation cycle). **85/85 today.**

Thank you — this is a genuinely well-shaped hand-off. §4.6's null table, the
`break_even_price` / `floor_price` pair arriving *with the search row*, and the
warning that `contract_prices_consulted` does not mean a line was priced each
saved us a bug we would otherwise have shipped. Three corrections below, all
small, and one of them is ours as much as yours.

---

## 1. We had to prove the shapes ourselves, because production had none

On the day this shipped, `custom_price_count` was **0** on both business
accounts and `custom-prices` and `price-history` both answered `items: []`. So
the §4.3 row, the §4.6 history row, the per-line `contract` block and the §8
cart figures were all unprovable by reading — a read-only probe could confirm the
endpoints existed and answered empty, and nothing else.

So the probe has a `--write` mode. It is opt-in, prints its mode before any work,
records nothing to disk, cleans up in a `finally`, **verifies the cleanup**, and
reddens its exit code if that verification fails (with the account id, the
product id and a copy-pasteable `curl`). Everything below marked *measured* came
from it.

Two things it deliberately does **not** touch: the §8 cart effect, which would
mean mutating a real customer's cart, and anything on the `Jackson` account.

---

## 2. Three corrections to the hand-off

### 2a. `limit` and `status` are stricter than documented — and this cost us a real bug

```
GET /api/admin/business/accounts?limit=200        -> 400  "limit" must be less than or equal to 100
GET /api/admin/business/accounts?limit=101        -> 400  (same)
GET /api/admin/business/accounts?status=approved  -> 400  must be one of [active, suspended, closed]
```

Both are **hard 400s, not clamps**. §4.1 says "`limit` (25, max 100)", which
reads as a ceiling that will be applied for you.

That matters more than a doc nit, because of what it did to us. We had written
`listBusinessAccounts()` back in August, *ready* for the day this endpoint
shipped — and it asked for `?limit=200`. Our shared client returns a
`VALIDATION_FAILED` 400 as an **envelope rather than throwing**, so the response
fell through to the device-local fallback: byte-for-byte the same value it had
returned for the whole month the endpoint was a 404. No error, no toast, nothing
on screen. It also filtered your rows for `status === 'approved'` — the
vocabulary `/api/business/status` answers on the storefront, which this route
rejects. Two independent bugs, both of which looked exactly like "the endpoint
isn't live yet".

Ours to fix and fixed (ERR-221). Mentioned only because **a doc that says "max
100" and an API that 400s on 101 are different promises**, and one line in §4.1
would have caught it.

### 2b. `application_id` is on the account object and is not documented

Every row from §4.1 and §4.2 carries it. Harmless — we do not read it — but it
should be in the doc, since it is the one field that links an account back to the
application queue.

### 2c. §8's "no FE change required" is false for this frontend

> *"It keeps its name and position, so the existing tile renders the right number
> with **no FE change required**."*

That assumes we call `GET /api/business/reorder-items`. **We don't.** Our
Business Centre reorder tiles have always called `GET /api/business/top-products`,
which deliberately carries **no price at all** — a figure from an order placed in
March is not today's price, so the field was left off and we fetched the price
separately from `/api/business/pricing`.

So the tiles would have gone on showing a public ladder rung rather than the
account's own price, indefinitely, and nothing would have said so.

We have switched to `/api/business/reorder-items`, which is the better source —
`price` is what this account actually pays and it removes our second round trip.
**But we could not verify it end-to-end**, and that is worth stating plainly:

- Neither business account has order history, so the endpoint returns `[]` in
  production. Your §9 concedes the same.
- The hand-off documents only the **price** keys. The tile also renders `sku`,
  `name`, `product_url`, `quantity_ordered`, `order_count` and `in_stock`/
  `purchasable`. We have assumed those carry over from `/top-products` and coded
  defensively — a row without a `sku` is logged and skipped rather than rendered
  as a dead card — but we are guessing.

**Two asks:**
1. Confirm those six non-price fields on `reorder-items`.
2. Does it carry a **product id**? `/top-products` does not, which is why the
   tile has to resolve the SKU against the catalogue before it can add to cart.
   If `reorder-items` has one, that lookup can go.

---

## 3. What we measured, and what it settled

### `unit_excl_gst` and `unit_price_excl_gst` agree — so we kept one endpoint

§6.2 introduces `POST /api/admin/quick-orders/quote` with a pre-resolved
`unit_price_excl_gst`, and warns that "two same-shaped price fields, one qty-1
and one final, is the pair that gets picked wrong".

**We agree with the warning and drew the opposite conclusion from it.** Both our
editors share one function (`utils/invoice-quote.js`) that already resolves
between the contract price and a deeper rung. Adopting a second line shape
*inside that shared function* would create exactly the pair you are warning
about — and naively, it would have silently disabled Quick Order's autofill
altogether, since `unit_excl_gst` would be null and our target-selection returns
early on a null.

So **both editors stay on `POST /api/admin/invoices/quote`**, and we verified the
one fact that decision rests on. With a contract price live, at quantity 1:

```
invoices/quote      lines[0].unit_excl_gst        = 5.90
quick-orders/quote  lines[0].unit_price_excl_gst  = 5.90
```

Identical. That check is in the probe, and if it ever stops holding, Quick Order
moves to your endpoint. **`/api/admin/quick-orders/quote` is therefore currently
unused by us** — flagging it so it isn't assumed live.

### An unknown `customer_id` is indistinguishable from a retail customer

```
customer_id: <a business customer>   -> consulted: true
customer_id: <a retail customer>     -> consulted: false, all account fields null
customer_id: 00000000-0000-…-0000    -> consulted: false, all account fields null   (200, not 404)
(neither identifier)                 -> consulted: false, all account fields null
```

The last three are the same response. So our chip says **"No business account"** —
a statement about what we found — and never "list pricing confirmed", which would
claim a lookup we cannot prove happened.

Not a defect, and we are not asking you to 404 on it. But if a future version
could echo back an `identifier_resolved: false`, we could tell an operator their
customer pick failed instead of quietly pricing at list.

### `set` is observable exactly once per (account, product)

A removal soft-deletes, so every *later* first-write on the same pair reports
`reactivated`. Our probe's second run failed on this and was right to. Both
actions carry `previous_price: null`, which is the property that actually
matters, so that is what we assert. Worth adding to the §4.6 table — as written
it reads as though `set` is reachable whenever there is no current price.

### Everything else in §4–§7 matched exactly

The 409 `PRICE_BELOW_COST` with `details.requires` and `details.evaluation`; the
refusal changing nothing (we re-read the stored price to check, rather than
trusting it); cross-account isolation; the catalogue's `list_price` unchanged
after a write; `DELETE` answering 404 on a double-click; and `DELETE` accepting
the optional `{notes}` body, which we send when the operator gives a reason.

We also confirmed `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`, so
PUT and DELETE are reachable from the browser. **PATCH is still absent** — the
BF-021 wall — which is why `PATCH /api/admin/business/accounts/:id` (credit limit,
status) still cannot be called from the admin UI. Unchanged by this work, and
still the one thing blocking account management. If PATCH could join that list,
or the same operation were offered as a PUT, that surface would light up
immediately.

---

## 4. What shipped

**Admin** — the **Business** page now lists real accounts (searchable, filterable
by your three statuses, badged with `custom_price_count`). Opening one gives a
drawer with **Contract pricing**, **Details** and **Price history**, all
addressable: `#business?account=<uuid>&tab=pricing`.

The pricing panel type-aheads against `product-search`, and because every hit
carries `break_even_price` and `floor_price`, **the price box grades as the
operator types with no round trip** — amber below the floor, red below
break-even, a distinct note for `above_list` explaining that the account is
charged the *list* price until list rises above it. That last one surprised us,
and an operator who did not know it would think the save had failed.

On a 409 we show your `message` verbatim (it carries the break-even figure) plus
`evaluation.net_margin_percent`, and re-send the identical body with
`acknowledge_below_cost: true`. `evaluation.warnings[]` is printed verbatim on a
successful save.

**A note on where your `evaluation` ends up**, because it nearly cost us the
dialog: our shared client special-cases a 409 and hands the caller
`{ok:false, error:<the message STRING>, code, data:<raw body>}`. The structured
error object survives only at `resp.data.error.details`. Our generic error
builder reads `resp.error.details` and `resp.details`, finds neither, and returns
`details: null`. Entirely our plumbing, not yours — recorded here because the
symptom is a confirmation dialog that asks "are you sure?" and quotes no figures,
which looks like a design choice rather than a bug.

**Cost visibility** — the whole surface is `super_admin`-gated in the UI as well
as on the server, both by the route manifest and by an in-page check, because
these responses carry `cost_price` and `net_margin_percent`.

**Operator editors** — both send an identifier (`customer_id` preferred,
`business_account_id` when the invoice is explicitly linked; exactly one, never
both) and show a contract chip per line plus one sentence about the account.
A **suspended or closed** account gets a loud warning that its contract prices
are *recorded but not being charged* — thank you for surfacing
`business_account_status` at all; without it, list pricing on a contract customer
would read as a broken feature.

A contract price **never fills the three `volume_*` keys**, exactly as you asked.
Those keys are persisted into our saved records and printed on the customer's
invoice PDF, so a negotiated rate filed as a volume discount would both name a
rung that does not exist and disclose the customer's own rate on a document they
may forward. For the same reason a contract line prints **nothing** on the PDF:
the ladder is public, a negotiated price is not.

**Storefront** — the cart names a contract saving for what it is, reading your
`volume_discount.source`. `contract_pricing.discount_amount` is treated strictly
as a **subset** of `volume_discount.discount_amount` and the two are never added;
your explicit warning about that is the single most valuable line in §8. The PDP
shows the account's price inside the volume-pricing section only —
`#product-price` and its `itemprop="price"` content attribute stay at public list
forever, since that markup is crawled anonymously and feeds Merchant Center.

Pinned by 99 new tests across four files, plus the probe.

---

## 5. Small things, no action needed

- §4.7's optional `{notes}` body on DELETE works; the doc might say so more
  firmly, since a DELETE with a body is unusual enough that we tested it before
  trusting it.
- `?search=` on §4.1 genuinely filters. Worth saying out loud, because
  `/api/admin/business/applications` accepts `search=` and `user_id=` and
  **silently ignores both**, returning the whole table — so we do not assume a
  filter works on a sibling route any more (ERR-151).
- "No bulk import" is fine for now. If a customer ever arrives with a 200-line
  price list we will come back about the CSV, and we would rather have it as an
  endpoint than build a 200-request loop.

Nice work. The guard rails arriving with the search row is what makes this
pleasant to operate rather than merely possible.
