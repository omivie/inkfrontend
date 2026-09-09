# Order number format change — FE response (Sep 2026)

**Replies to:** `order-number-format-change-FE-handoff-sep2026.md` (backend `b836690`, migration 157)
**Measured:** 2026-09-01, live production, unauthenticated against `api.inkcartridges.co.nz`
**FE side:** ERR-198 · `npm run probe:order-number` · `tests/order-number-format-sep2026.test.js`

---

## TL;DR

Thank you for reading our bundles before writing — that saved real time, and §3 is
accurate as far as it goes. We did the two checks you asked for (§4.1, §4.2) and
both turned up something. We also found four defects your §3 could not have seen,
one of which can attach a refund to the wrong order.

**The headline is not a disagreement about facts, it is about what the change
actually was.** You looked for *parsing* assumptions — a `\d{14}` regex, a
`parseInt`, a length check — and there are none. We confirmed that independently.
But the migration didn't change how an order number parses. It removed a property
nobody had written down: **order numbers were fixed width**, and therefore

  1. no order number could be a prefix of another, and
  2. the first eight characters were disposable.

Five call sites were resting on those two facts. **Not one of them mentions a
length**, so no search for a length would ever have found them.

| § | Your claim | Measured |
|---|---|---|
| TL;DR | "No code changes required" | **No.** 5 defects, 1 of them on the refund path. 14 files changed. |
| §3 | `js/api.js` — "No `order_number` handling at all" | **No.** It builds 5 order URLs; 3 interpolated **un-encoded**, and its JSDoc advertised a fictional format twice. |
| §3 | `js/order-confirmation-page.js`, `order-receipt.js` — "nothing to change" | Correct for the confirmation page. `order-receipt.js` prints the order number **through its own label** for every legacy order (§A). |
| §3 | "no localStorage key built from an order number" | **Confirmed.** All keys are constants; the number is a value compared with `===`. |
| §4.1 | Admin modal — "should only ever look better" | Correct about the modal. The **dashboard** mangles the number in 5 places, and the **refund lookup** can bind to the wrong order (§B, §C). |
| §4.2 | "sorting by order number string stops being correct above 99/day" | **Confirmed, and it is already latent** — the admin "Order #" column advertises a sort the backend performs on `created_at`. Kept and documented. |
| §5 | GA4 `transaction_id` — no action | **Confirmed.** Values stay unique, never reused. |
| §6 | the accepted grammar | **Wider than stated** — see §E. Your `\d{8}\d{2,6}` is right; the legacy rule is `ORD-{alnum}-{4..16 hex}`, not the fixed shape our own comments assumed. |

Everything below is reproducible with public URLs and no credentials.

---

## A. The one we'd fix first if you only read one section

`GET /api/orders/:orderNumber` validates **before** it authenticates, which makes
the grammar observable with no login at all — 400 means the shape was rejected,
401 means it was accepted and auth then ran. That is how everything here was
measured:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://ink-backend-zaeq.onrender.com/api/orders/2026090101   # 401 — accepted
curl -s -o /dev/null -w '%{http_code}\n' https://ink-backend-zaeq.onrender.com/api/orders/202609011    # 400 — rejected
```

**Not a request, just a heads-up:** this ordering is convenient for us and is also
a small enumeration surface — an unauthenticated caller can distinguish "valid
shape" from "invalid shape" for free. It leaks nothing about which orders *exist*
(both are 401 either way), so we are not asking you to change it; we are telling
you we depend on it, so you know before you move it.

---

## B. §4.1 — the admin surface you couldn't see. Two findings.

### B1. The refund lookup can attach a refund to the wrong order

`js/admin/pages/refunds.js` searched for an order and took the first row:

```js
const result = await AdminAPI.getOrders({ search: val }, 1, 1);   // page size 1
if (orders.length) { foundOrder = orders[0]; }                    // no equality check
```

`?search=` is a case-insensitive substring `ILIKE` (your `src/routes/admin.js:311`,
and we re-confirmed it with `probe:orders-search`). Under the old fixed-width
scheme that was safe by construction: **no 14-character number can be a prefix of
another 14-character number**, so a search for a whole order number returned that
order or nothing.

It is no longer safe. `2026090110` (order 10) is a strict prefix of `20260901100`
(order 100), so one query legitimately matches both — and with `limit: 1` the
exact row can be excluded from the response entirely. The refund is then created
against whichever row the backend happened to return first.

Reachable only above 99 orders in a day, so at ~4/day this is a guard rail rather
than a live incident — **which is exactly why you widened the validator to a range
instead of a fixed width.** We have put the same guard rail on our side: a shared
`OrderNumber.pickExact()` matches whole normalised strings and returns `null` on a
near-miss, and the refund box now names the candidates and refuses to bind rather
than guessing.

The same shape was in `pages/orders.js`:

```js
if (match) openOrderModal(match);
else if (rows.length === 1) openOrderModal(rows[0]);   // "only one row, must be it"
```

which is how a `#orders?focus=` deep link from Tracking Requests could open an
order nobody asked for. Also fixed.

### B2. The dashboard mangles every order number it prints

`js/admin/pages/dashboard.js` rendered `String(n).slice(-8)` in five places. That
was deliberate and correct: it dropped the redundant 8-character date prefix and
kept the whole counter — `20260829000004` → `29000004`.

On a 10-character number the same slice eats the **century**:

```
2026090101   → 26090101     looks like a date, matches no order
20260901100  → 60901100     an 11-char number mangles differently again
```

Neither can be pasted into the order search. The new numbers are *shorter* than the
old ones, so the truncation now buys nothing at all — they print whole, with a CSS
ellipsis as the only concession to narrow cards, so the DOM keeps a copyable value.

**Your §4.1 instinct was right — "4 characters shorter should only ever look
better" — but it was reasoning about a heading with a fixed width. The failure mode
was code that had been *shortening* the number on purpose.**

The modal heading itself is fine, as you predicted: `.admin-product-modal__title`
is `max-width: 220px` with an ellipsis, which held ~24 characters and holds them
still. The Orders table's `Order #` column carries `cell-mono` and no width, and
that table never opts into `--colsized`, so mixed 10/11/14/29-character values
ragged-edge but never clip.

---

## C. §4.2 — sorting. Confirmed, and it was already latent.

Our public lists sort on `created_at` exactly as you found (`js/account.js:1172`,
`:1433`). Nothing to change there.

The admin is more interesting. The `Order #` column is `sortable: true`, and
`js/admin/api.js` maps that key to the backend's `newest`/`oldest` — i.e. to
`created_at`. That mapping was only ever *equivalent* because a zero-padded
`YYYYMMDD######` sorts lexicographically the same way it sorts chronologically.
With unpadded sequences that equivalence is gone, and the 128 legacy `ORD-…` rows
never had it.

The behaviour is correct and stays — date is what an operator wants from that
column. What we changed is that the reason is now **written down in both files**,
because the next person to see a column keyed `order_number` sorting by date will
otherwise "fix" it. A test pins that no comparator on `order_number` exists
anywhere in the tree.

---

## D. What §3 could not see: HTML, JSDoc, and a PDF

You read the deployed JS bundles, so these were out of frame.

### D1. The site was advertising five order-number formats that have never existed

| Where | Example shown | Status |
|---|---|---|
| `html/track-order.html:176` | `e.g. ORD-ABC123-XYZ` | never minted; **not even a valid legacy form** |
| `html/account/track-order.html:272` | `e.g. ORD-ABC123-XYZ` | same |
| `html/contact.html:258` | `e.g. ORD-1042` | never existed in any era |
| `html/account/order-detail.html:259` | `<h1>Order #INK-78542</h1>` | hardcoded; **only ever visible when the order fails to load** |
| `js/api.js:2841`, `:2959` | `"ORD-ABC123-XYZ"` | JSDoc |

The `<h1>` is the one worth pausing on: it is replaced at runtime, so a customer
only ever sees it when the lookup failed — i.e. precisely when they are already
confused about their order number. All five now come from one constant, and a test
asserts every order-number example in the shipped tree passes our validator, so the
copy cannot rot back.

### D2. The customer receipt PDF prints the order number through its own label

`js/order-receipt.js` seated the meta label column at a hardcoded `pageW - M - 110`
— a constant reserving space for text, which is the same defect we logged as
ERR-196 in the *invoice* builder and fixed there with `doc.getTextWidth()`.

Measured against the Adobe standard-14 Times metrics jsPDF actually draws with, at
11 pt bold:

| Value | Width | vs the 110 pt pin |
|---|---|---|
| `2026090101` | 55.0 pt | clear |
| `20260901100` | 60.5 pt | clear |
| `20260829000004` | 77.0 pt | clear |
| `ORD-MMQXBRYO-6E93` | **124.7 pt** | **overlaps by 14.7 pt** |
| `ORD-MP7GA80N-C3DD9FA2EC39F1DE` | **198.6 pt** | **overlaps by 88.6 pt** |

So every receipt downloaded for a pre-2026-05-18 order printed its order number
straight through the words `ORDER NUMBER`. **Your change did not cause this and
does not fix it** — we found it because the change made us measure the widest
value this document prints, which is the order number. It is now measured rather
than guessed.

### D3. Three un-encoded order numbers in API paths

`api.js` `getOrder`, `cancel` and `capture-paypal` interpolated the order number
into the path raw, while `getOrderTracking` and `createReturnRequest` next to them
used `encodeURIComponent`. Harmless for all four current shapes; now consistent.

---

## E. §6 — the grammar is wider than the hand-off says, in one place

Your numeric rule is exactly right, and we bounded it:

```
9 digits   202609011        → 400
10 digits  2026090112       → 401     ← the new format
14 digits  20260901123456   → 401     ← the interim format
15 digits  202609011234567  → 400
```

Two things worth adding to your doc:

**The date prefix is not semantically validated.** `20261301100` (month 13) and
`9999999999` both pass. That is fine — we treat the number as opaque and never
slice a date out of it — but it means "starts with a valid `YYYYMMDD`" is not a
property anyone should rely on.

**The legacy rule is a range, not a pair of fixed shapes.** Measured:

```
ORD-AAAAAAAA-AAA                  → 400   (3-char hex run)
ORD-AAAAAAAA-AAAA                 → 401
ORD-AAAAAAAA-AAAAA                → 401   (5 — accepted)
ORD-AAAAAAAA-AAAAAAAAAAAAAAAA     → 401   (16)
ORD-AAAAAAAA-AAAAAAAAAAAAAAAAA    → 400   (17)
ORD-A-AAAA                        → 401   (no 8-char minimum on the id run)
ord-mmqxbryo-6e93                 → 400   (case-sensitive)
```

i.e. `ORD-[A-Z0-9]+-[0-9A-F]{4,16}`, uppercase only.

**A caution, because we got this wrong first.** Our opening sweep probed the hex
run with `ORD-MMQXBRYO-6E93X` and `ORD-MMQXBRYO-GGGG`, got 400s, and concluded the
rule was "4 or 16 characters only". It is nothing of the kind — `X` and `G` are
not hex digits, so those strings were rejected on *characters* and the length
question was never actually asked. A validator built on that first answer would
have refused perfectly good legacy orders. **A measurement taken with a bad control
is not a measurement**, and it is the reason `npm run probe:order-number` now
re-runs this sweep against the live API and fails if our copy of your rule ever
drifts from it.

**One practical consequence for customers:** the lookup is case-sensitive, so a
legacy number that came back lowercased out of a mail client is a hard 400 and the
customer is told their order does not exist. We now uppercase and trim before
sending (and strip a leading `#`, since we print order numbers as `#2026090101`
everywhere, so people paste the hash back). If you would rather normalise
server-side too, that would make the rescue belt-and-braces — but it is handled and
we are not blocked on it.

---

## F. One claim in our own code that turned out to be about yours

`js/order-detail-page.js` has carried this comment since July:

> Fallback: backend detail endpoint rejects legacy order numbers whose characters
> don't match its stricter regex (e.g. `ORD-...I-...`).

Re-measured: `ORD-IAAAAAAA-AAAA` and the `L`/`O`/`U` variants all validate. Either
that was wrong when written or you have since fixed it. Either way we have
corrected the comment rather than deleting the fallback — removing a fallback is a
behaviour change, not cleanup, and it costs one request only on a path that has
already failed.

**No action for you** unless that rings a bell as a regression.

---

## G. What the frontend now does about this class of defect (ERR-198)

One vocabulary, `OrderNumber`, in `js/utils.js` — a classic script, so the
storefront and the admin SPA share the same rules rather than each growing their
own:

- `normalise` — trim, strip a leading `#`, uppercase (a rescue, never a gate)
- `isValid` — a mirror of your grammar, pinned to the live API by the probe
- `equals` / `pickExact` — whole-string only; a prefix is never a match
- `forDisplay` — the whole number, always
- `era` — `daily` / `interim` / `legacy`, diagnostics only
- **deliberately no comparator** — `'2026090199' > '20260901100'` is true but order
  99 came first, so lists sort on `created_at` and a test enforces it

`isValid` is used for *diagnosis and copy only*, never to block a submission: the
server owns its grammar, and a client validator that drifts from it fails closed
and silent on a real customer holding a real order number. Track Order still sends
whatever is typed and surfaces your `VALIDATION_FAILED` verbatim.

**Enrolment lives in a test, not a comment.** We have twice had a feature quietly
fall off a surface because "every page calls X" was a list nobody maintained, so
the suite asserts each order-number surface routes through `OrderNumber`.

Full suite 4836 / 0.

---

## H. Small things, no reply needed

- Four dead deep-links emitted an order number into a query param nothing reads:
  `dashboard.js` used `orders?order=` and `orders?search=` while `orders.js` reads
  only `focus` and `q`, and `coupons.js` linked to `#orders/<uuid>`, which matches
  no SPA route. Three now use `focus=`; the coupon cell renders text, because a
  coupon-usage row carries only a UUID and the orders list cannot be searched by
  one.
- `emailed_at`-style note for your files: `?search=` still cannot match an email
  address (ERR-173), and our placeholder still does not promise it.
