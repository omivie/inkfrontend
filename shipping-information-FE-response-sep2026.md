# Shipping Information + NZ Couriers — FE response (Sep 2026)

**Status: shipped.** The Shipping Information section is live in the order detail modal with its own
Save and its own "Send to customer", NZ Couriers is fully expressible, and the customer's
`/track-order` page now says "Ticket number" and shows the ticket product code. Verified in the
running admin against live data, not just in tests.

**First: thank you for a hand-off that was accurate.** I measured every claim in it against
production before writing a line — the registry, both read paths, the merge semantics, the customer
endpoints — and all of it was there, exactly as described. That is not the recent norm here
(ERR-195, ERR-198, ERR-199 were each hand-offs whose opening claim was false), and it saved a day.

Three things below are worth your time: **one row of your §6 error table does not match production**,
**`email.send_count` is a floor and the frontend now says so**, and **there is a live customer with a
tracking link that cannot resolve** — which is data, not code, and I have not touched it.

---

## 1. §6: a bad `tracking_url` is `VALIDATION_FAILED`, not `INVALID_TRACKING_URL`

Your table lists `INVALID_TRACKING_URL`. Production rejects the URL in the schema layer first, so
the handler's own check is never reached:

```
PUT /api/admin/orders/:id/shipping   { "tracking_url": "http://insecure.example/track" }
→ 400
{ "code": "VALIDATION_FAILED",
  "message": "Validation failed",
  "details": [ { "field": "tracking_url",
                 "message": "\"tracking_url\" must be a valid uri with a scheme matching the https pattern" } ] }
```

Same for a garbage string and for `ftp://`. Measured 2026-09-01, bracketed by a read before and
after — the order was byte-identical, so this really is a pre-write rejection.

**No action needed from you.** The frontend reads `details[].field` **as well as** the documented
codes, so either answer marks the right input. I mention it because a FE that keyed only on the
documented code — the obvious reading — would have left the field unmarked and shown the operator
the raw Joi sentence, which quotes the wire field name at a human.

If you would like the codes to match the doc, the fix is on your side (a `.messages()` override or
an explicit pre-check); if you would rather the doc match the code, §6's row 4 should read
`VALIDATION_FAILED` + `details[0].field === 'tracking_url'`. **Either is fine — the FE handles both
and will keep handling both.**

Two smaller notes on the same table:
- `UNKNOWN_CARRIER`, `CONFLICTING_TRACKING_NUMBER` and `TICKET_PRODUCT_CODE_REQUIRED` all return
  exactly as documented. Confirmed live.
- An empty body returns `VALIDATION_FAILED` with `details[0].field === ""` (`"value" must have at
  least 1 key`). The FE never sends one — `buildPayload()` returns `{}` for an untouched form and
  the Save button says "Nothing changed" without spending a request — but the empty `field` is
  correctly ignored rather than being used to mark an input.

---

## 2. `email.send_count` is a **floor**, and 4 of 13 shipped orders prove it

| Order | Shipped | `send_count` | `last_status` |
|---|---|---|---|
| `20260730000001` | 2026-07-30 | **0** | `null` |
| `20260729000002` | 2026-07-29 | **0** | `null` |
| `ORD-MOQBMOJI-C81B80725C40AC00` | 2026-05-09 | **0** | `null` |
| `ORD-MO1UG5EZ-5AE7` | 2026-04-20 | **0** | `null` |

All four are `shipped`, and dispatch emails the customer automatically — so a shipping email
certainly went out and simply predates the send log.

Written the obvious way (`send_count > 0 ? "sent" : "never sent"`) every one of these renders
**"never sent"**, and an operator who believes it sends the customer a second copy. We shipped
exactly that bug one page over on the Invoices `×N` indicator (ERR-180), so the frontend now uses
four distinct states with four distinct sentences, and `send_count: 0` **on a shipped order** reads:

> **No recorded sends** — This order shipped before its sends were logged, so the customer may
> already have had these details. Sending will email them again.

**One request, and it is small:** if `order_shipping_emails` (or whatever backs `send_count`) has a
row for these and it is simply not being counted, that is worth a look. If it genuinely has no rows
before ~August, nothing is needed — the wording above is correct and permanent. **A flag on the
email object saying "the log begins at T" would let the frontend distinguish "before logging" from
"logged, and genuinely zero"** rather than inferring it from `is_shipped`. Nice to have, not a
blocker.

---

## 3. `GET /orders/:id` returning `email: null` is doing real work — please keep it

Confirmed on order `20260829000001`: `shipping_information.email` is `null` on the order detail and
`send_count: 1` on `/orders/:id/shipping`. Your §3a says this is deliberate (it skips the extra
query) and that is exactly right, so the panel paints instantly from the detail payload and opens
saying **"Send history not loaded"** — which claims nothing — then upgrades when `/shipping`
answers.

**Please do not "fix" this by back-filling `email` on the detail endpoint without saying so.** The
value of `null` here is that it is honestly distinguishable from a real object. If it ever does
start carrying one, the FE treats a present object as authoritative and the second fetch becomes
redundant rather than wrong — the probe reports it as a note if it changes.

---

## 4. A live customer has a tracking link that can never resolve (data, not code)

Order `20260809000002` has a full URL in `tracking_number`:

```
tracking_number: "https://www.nzpost.co.nz/tools/tracking?trackid=00894210392912038227"
tracking_url:    "https://www.nzpost.co.nz/tools/tracking/item/https%3A%2F%2Fwww.nzpost.co.nz%2F…"
```

That derived link 301s to `?trackid=https%3A%2F%2F…`, which will never match a parcel. It has been
in that customer's order page and their shipping email since 10 August.

**I am not asking you to reject this.** A tracking reference has no universal grammar and a
server-side rule would eventually refuse a legitimate carrier's format. The frontend now warns the
operator on input — naming the Tracking URL field as the right home for a link — and **saves
anyway**, because a rule we invented must never refuse a save you would have accepted.

Fixing the existing row means retyping a real customer's tracking reference, which is the owner's
call, not a deploy. `npm run probe:shipping-info` reports any row in this shape on every run.

---

## 5. What the frontend now does, so you can hold us to it

- **The carrier list is never hard-coded.** Both the new section *and* the Update Status modal fill
  their `<select>` from `GET /api/admin/shipping/carriers`. Update Status previously hand-wrote five
  options and could not express NZ Couriers or Post Haste at all — that is gone, and a test greps
  every source file to make sure no carrier name is ever used in a comparison, a `case`, or an
  `includes()`. **Adding a carrier stays a one-file change on your side.**
- **Relabel, don't branch.** `tracking_number_label` is rendered verbatim in the admin and on
  `/track-order`. The generic fallback fires only when neither the response nor the registry
  supplies a label, and warns when a carrier is set and one was owed.
- **Every per-carrier behaviour reads a flag you sent**: `requires_product_code` shows and requires
  the ticket code; `builds_tracking_url: false` (DHL, Other) makes the URL field visibly the only
  way that customer gets a link; `supports_live_tracking: false` greys the live-tracking affordance
  *with the reason on screen* rather than hiding it.
- **Merge semantics are honoured exactly**: omitted keeps, `""` clears, and only genuinely changed
  fields are sent — so a partial save stays partial and cannot revert a concurrent change.
- **`ticket_number` is never sent.** One spelling cannot conflict with itself, so
  `CONFLICTING_TRACKING_NUMBER` is unreachable from this UI by construction (the probe still proves
  you return it).
- **`mark_shipped: true` is announced.** The checkbox label says it emails the customer, and the
  toast reports `reason: "auto_on_ship"` back, so nobody sends an email they didn't know about.
- **A repeat send is a deliberate act** — a confirm dialog quoting the recorded count and last send
  time, and a warning if there are unsaved edits, since the send uses what is *saved*.
- **The Update Status modal now ships through `PUT /orders/:id/shipping`** with `mark_shipped: true`
  rather than the legacy status endpoint. Its dropdown holds registry codes now, and only the
  shipping endpoint documents accepting a code; it is also the only one that knows
  `ticket_product_code`. Behaviour is otherwise identical (same state machine, same single dispatch
  email). **If the legacy `PUT /api/admin/orders/:id` does canonicalise a carrier code, tell us and
  we'll simplify — we assumed it does not rather than guessing.**

---

## 6. The live probe

`npm run probe:shipping-info` — **read-only**, prints its mode before doing anything, no `--record`
mode, exit `0/1/2`. It checks the registry's shape, every shipped order's block, the send-count
floor, the detail-vs-dedicated `email` disagreement, dirty tracking numbers, and the error contract.

It proves the error contract **without writing**: each deliberately-rejected PUT is bracketed by a
read of the order before and after, and the run fails if any of them ever changes a byte. It never
sends `send_email` or `mark_shipped` and never calls `.../shipping/send-email`, because those email
a real customer.

Current run: **13 hard checks passing**, 3 notes (the send-count floor, the dirty row in §4, and
`tracking_url_source: "operator"` having no live rows yet).
