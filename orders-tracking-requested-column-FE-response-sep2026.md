# Orders "Tracking requested" column — FE response (Sep 2026)

**Status: shipped.** The chip renders in the Invoice sent cell per your §2 contract, the column
header is now **Invoice / tracking**, and page 1 matches your §3 worked example exactly. Verified
in the running admin against live data, not just in tests.

**Your hand-off was accurate — every claim in it held when measured.** That is worth saying
plainly, because the last two were not: `orders-invoice-sent-column-FE-handoff-sep2026.md` opened
with "Shipped in `GET /api/admin/orders`" nine hours before it was, and
`order-number-format-change-FE-handoff-sep2026.md` opened with "no code changes required" when
five call sites needed changing. This one I re-measured out of habit and found nothing wrong with
it. Thank you — it saved a day.

Four things below are worth your time. Two are asks (§1 the dismiss endpoint, which you offered;
§2 a real filter param). Two are findings you may not know about (§3 the two endpoints disagree
about their own field list; §4 nothing has ever exercised half of this feature).

Measured 2026-09-03 against backend commit `90ca2496`, `db: connected`.

---

## 1. Yes please to the dismiss endpoint

You offered it and the owner wants it:

```
POST /api/admin/orders/:orderId/tracking-request/dismiss
status enum gains 'dismissed'   (migration to widen the CHECK constraint)
```

`20260714000001` is live proof of the gap — cancelled 14 July with an open request, **51 days and
counting**, and nothing in the system can ever clear it because nothing will ever ship, so no
email will ever fire.

**The frontend is already shaped for it.** `TRACK_STATE.DISMISSED` exists and renders today; the
reader accepts `state: 'dismissed'` right now and paints a muted "Tracking dismissed" chip. That
was deliberate: without it, the day your migration lands, every dismissed row would hit the
unrecognised-state branch and splash **"Tracking unknown"** across the Orders page — a frontend
error message appearing as the *result* of a backend fix. So you can ship the migration before I
ship anything and nothing breaks in between.

What I need from the endpoint, in preference order:

- The updated `tracking_request` object in the response, so the row can repaint from your answer
  rather than my assumption. A bare `{ok:true}` works but forces a full list refetch.
- `dismissed_at` on the object would be nice; I currently fall back to `requested_at` for the date.
- A refusal code for "there is no open request" (a double-click, or two operators on one order).
  I will treat any 4xx as "already resolved, refresh" if you would rather not add one.

Until then the display side is handled: the chip is muted on `status: 'cancelled'` per your Rule 4,
and its tooltip says in as many words that the request cannot clear itself and that there is no
dismiss action yet. **Muted, not hidden** — the customer really did ask, and hiding a fact because
it has become inconvenient is not something the frontend gets to do.

---

## 2. `?tracking_request=` and four siblings are decoys — please make one real, or 400 them

Every filter param I could think of is **accepted and ignored**:

| Param | Real value | `zzznope` | Verdict |
|---|---|---|---|
| `?tracking_request=requested` | full 50-row page | full 50-row page | decoy |
| `?tracking_requested=true` | full 50-row page | full 50-row page | decoy |
| `?has_tracking_request=true` | full 50-row page | full 50-row page | decoy |
| `?tracking_state=requested` | full 50-row page | full 50-row page | decoy |
| `?tracking=requested` | full 50-row page | full 50-row page | decoy |
| `?status=cancelled` *(control)* | **16 rows, all cancelled** | — | really filters |

The control matters: it proves the endpoint *can* filter, so the five above are genuinely being
dropped rather than the whole mechanism being off.

This is the same family as `?channel=` on this endpoint and `?user_id=` / `?search=` on the
business-accounts one. It is worse than a 400, because the page looks filtered, rows come back,
and every row is wrong. **A 400 on an unrecognised param would have saved three separate
investigations this year.**

Concretely: **`?tracking_request=requested|sent|any` would let the Orders page offer a "waiting for
tracking" filter.** Without it I have deliberately shipped none — a client-side filter would see
20 of 154 rows while looking like a full filter, which is the exact shape of bug the decoys cause.
Seven customers are waiting and six of them are not on page 1.

---

## 3. Your two endpoints disagree about their own field list, in opposite directions

Not a bug report, but it caught me out and it will catch the next person:

| Field | `GET /api/admin/orders` | `GET /api/admin/orders/:id` |
|---|---|---|
| `tracking_request` | ✅ 154/154 rows | ✅ present |
| `invoice_sent` | ✅ 154/154 rows | ❌ **absent** |

So neither endpoint is a safe proxy for the other, and the frontend cannot pick one and be done.
The order modal now decides the *invoice* regime from the **list row** (the detail payload would
read as "the backend has never heard of this field") while reading the *tracking* answer from the
**detail payload** first. That works, but it is two opposite special cases in one function.

If `invoice_sent` on the detail endpoint is cheap, it would collapse both. If it is deliberate,
no action needed — I would just like it written down somewhere, because "the detail endpoint is
the fuller one" is the natural assumption and it is false here.

---

## 4. Nothing has ever exercised half of this feature

`GET /api/admin/tracking-requests?status=fulfilled` returns **zero rows. Ever.** All 7 live
requests are `pending` with `request_count: 1`.

That means these have never once run in production, on either side:

- your `fulfillPendingTrackingRequests` helper, on any of the five send paths
- `state: "sent"` — the chip's answered branch
- `sent_at` non-null under an open request — your Rule 2 re-ask case
- `request_count > 1`

Which also means **the two paths you fixed in this change (Update Status → shipped, and Shipping
panel without "send email") have never demonstrably cleared a request either** — there was never
a fulfilled row before your fix, and there still is not. That is not a criticism; it is the
reason I would not treat "it clears now" as verified until one actually does.

I have pinned all four branches with unit tests and flagged them in the source as unproven, and
`npm run probe:tracking-requested` reprints the caveat on every run until a fulfilled row exists.
This repo has been bitten by exactly this before: the Invoices `×N` indicator was live for eight
months and had **never once rendered** (ERR-180).

**The first time you clear a request in production, that probe will go quiet by itself.** If you
want to nudge it, clearing `2026090203` would do it — that customer asked on 2 September and is
the only one whose request is not already weeks old.

One more thing worth knowing: **`order_tracking_requests` answers `200` with an empty array over
PostgREST** (RLS enabled, no permissive policies — correct, and I am not asking you to change it).
Anything that reads that table to check this feature will conclude "no tracking requests exist"
and certify a broken column green. My probe measures that trap deliberately and then reconciles
against `/api/admin/tracking-requests` instead.

---

## 5. Two docs in this repo were describing the old fulfilment rule

Both corrected, mentioning here in case the same sentence exists on your side:

- `inkcartridges/sql/order_tracking_requests.sql` said fulfilment happens *"when an admin sets a
  tracking number on the order"*. Per your §4 it is now gated on **an email actually going out** —
  flipping an order to `shipped` with no tracking number emails nothing and correctly leaves the
  request open.
- The Tracking Requests page told operators the request *"clears itself"*, unconditionally. Now
  qualified, with the cancelled-order case named.

---

## 6. What shipped, and how to re-check it

Page 1, live, against your §3 table:

| Order # | Status | Before | Now |
|---|---|---|---|
| 2026090205 | paid | `—` | `—` |
| 2026090204 | paid | `—` | `—` |
| **2026090203** | paid | `—` | **`Tracking requested` · 2 Sept** |
| 2026090202 | paid | `—` | `—` |
| INV-3278 | paid (invoice) | `1 Sept` | `1 Sept` (unchanged) |

And the six on later pages, with the age your Rule 3 asked for:

| Order # | Status | Waiting |
|---|---|---|
| 20260623000001 | paid | **72 days** |
| 20260714000001 | **cancelled** | 51 days — muted, unclearable |
| 20260716000001 | paid | 48 days |
| 20260731000001 | paid | 33 days |
| 20260813000002 | paid | 21 days |
| 20260814000001 | paid | 20 days |

**On your §2 "precedence in the cell" recommendation — I stacked instead.** Your ladder has the
tracking chip outrank and hide `invoice_sent`. On an invoice-claimed order whose customer also
asked for tracking, that would silently drop the send date with no indication it existed. Both
facts are true and one does not cancel the other, so the chip renders above the invoice answer and
neither is suppressed. Rows carrying only one of the two look exactly as they did before. No live
row currently has both — the overlap is structurally rare, not impossible.

Re-check any of it with **`npm run probe:tracking-requested`** (read-only, GET-only besides the
sign-in, no recording mode). It is green today: 14 hard checks, `REGIME: SERVER`, 7/7 reconciled
against your queue endpoint in both directions.

Pinned by `tests/orders-tracking-requested-column-sep2026.test.js` (86 assertions, five positive
controls that run deliberately-broken builds of the real module and must fail). Written up in full
as ERR-201.
