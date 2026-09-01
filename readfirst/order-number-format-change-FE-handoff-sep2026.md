# Order number format change — FE hand-off (Sep 2026)

**Backend commit:** `b836690` · migration 157 · deployed and verified live
**Effective:** 2026-09-01, immediately — the very next order placed carries the new format
**Change:** `20260829000004` → `2026090101`

---

## TL;DR for the FE

**No code changes required.** I read your deployed bundles before writing this
(§3) and found nothing that assumes the old format. There is **one thing to be
aware of** and **two surfaces I could not see**.

| # | Item | Owner | Priority |
|---|---|---|---|
| 1 | GA4 `purchase.transaction_id` values change shape — no action, just don't be surprised (§5) | FE | FYI |
| 2 | Admin SPA order modal — the one surface I can't inspect without logging in (§4.1) | FE | **Please check** |
| 3 | Anywhere you sort a list *by order number string* rather than by date (§4.2) | FE | **Please check** |

Nothing in the API contract changed. No new fields, no removed fields, no
renamed fields, no shape changes. `order_number` is still a string on every
endpoint that returned one before.

---

## 1. What changed

Order numbers were `YYYYMMDD` + a zero-padded 6-digit counter. They are now
`YYYYMMDD` + that day's sequence, with no decorative padding:

| | Format | Example | Length |
|---|---|---|---|
| Before | `YYYYMMDD` + 6 digits | `20260829000004` | 14 |
| **Now** | `YYYYMMDD` + 2 digits | `2026090101` | **10** |

The sequence resets daily on the **Pacific/Auckland** date and counts up:
`2026090101`, `2026090102`, … `2026090129`.

**Past 99 orders in one day the sequence widens to three digits** —
`20260901100`, not a truncated 2-digit value. So treat the length as
**10 or 11 characters**, never exactly 10. (At current volume — around four
orders a day — this is a guard rail rather than a live path, but it is the
reason the backend's own validation accepts a range instead of a fixed width.)

---

## 2. What did NOT change

- **The API contract.** Same endpoints, same field name (`order_number`), same
  type (string). `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:orderNumber`,
  `GET /api/orders/track/:orderNumber`, `POST /api/orders/track-request`,
  `POST /api/orders/track-lookup` all behave exactly as before.
- **Historical order numbers.** The 128 existing orders keep the numbers they
  have. They are printed on invoices and receipts already sitting in customers'
  inboxes and they ride in Stripe/PayPal metadata, so renaming them would break
  those references.
- **Uniqueness.** Still `UNIQUE` in the database. A new number can never collide
  with an old one — they are different lengths.

**Consequence:** any order list renders three shapes side by side. All three are
valid and all three still resolve on every lookup endpoint:

```
2026090101              current   (10 chars, migration 157+)
20260901100             current   (11 chars, >99 orders in one day)
20260829000004          interim   (14 chars, migrations 069–156)
ORD-MMQXBRYO-6E93       legacy    (pre-2026-05-18)
ORD-MP7GA80N-C3DD9FA2EC39F1DE
```

Treat the order number as an **opaque string**. Don't parse it as a number,
don't slice a date out of it, don't assume a width.

---

## 3. What I already verified in your deployed code

So you don't repeat the work. All read from `www.inkcartridges.co.nz` on
2026-09-01:

| File | Finding | Verdict |
|---|---|---|
| `js/track-order-page.js` | Reads `?order=` and prefills the input; **no client-side format validation** | ✅ works as-is |
| `js/api.js`, `js/main.js`, `js/utils.js` | No `order_number` handling at all | ✅ nothing to change |
| `js/account.js:1172`, `:1433` | Order lists sort on `new Date(created_at)` | ✅ correct, see §4.2 |
| `js/order-confirmation-page.js`, `js/order-receipt.js`, `js/checkout-page.js` | No length checks, no `{14}` regex, no `parseInt` on the order number | ✅ nothing to change |
| all of the above | No `localStorage` key built from an order number | ✅ nothing to migrate |

The backend side is pinned by `__tests__/order-number-format.test.js`, which
asserts all four shapes above validate and that malformed ones (`20260901`,
`202609011`) still 400.

---

## 4. The two things I could not check

### 4.1 The admin SPA order modal — please confirm

This is the surface in the original screenshot (`/admin#orders`, the order
detail modal with the order number as its heading). Its scripts load after
login, so I can't read them from outside.

What to look for:

- Any regex or length check on the order number (searching for `{14}` or a
  `.length === 14` is enough).
- Fixed-width layout that assumed 14 characters — the heading is now 4 characters
  shorter, which should only ever look better, but a hardcoded width would show it.
- The order search box is fine either way: the backend does a substring `ILIKE`
  (`src/routes/admin.js:311`), so partial numbers still match.

### 4.2 Sorting by order number string

Your public order lists already sort by `created_at`, which is correct and needs
no change. Flagging this only so it doesn't get "optimised" later:

**Sorting order numbers as strings is chronologically correct today, and stops
being correct above 99 orders in a day.**

```
'2026090199' > '20260901100'   // true — but order 99 came BEFORE order 100
```

The fixed 8-character date prefix keeps different days in the right order, but
once the sequence widens the same-day comparison goes wrong. **Sort on
`created_at`.**

---

## 5. GA4 note (informational)

`js/order-confirmation-page.js:140` sends the order number as the GA4 purchase
`transaction_id`. That keeps working — the values are still unique and are never
reused, so there is no dedup risk and no double-counting.

The only visible effect is in reporting: transaction IDs recorded from
2026-09-01 onward are 10 characters where earlier ones are 14. If anyone has a
saved GA4 segment or a spreadsheet formula that filters transaction IDs by
length or by a `2026%` pattern, it will need widening.

---

## 6. Values to test with

Valid — every one of these should be accepted and looked up normally:

```
2026090101        first order of 2026-09-01
2026090129        29th order of the day
20260901100       100th order of the day (the widened form)
20260829000004    a real existing order in the interim format
ORD-MMQXBRYO-6E93 a real existing legacy order
```

Invalid — the backend returns `400 VALIDATION_FAILED` with
`"Order number must be YYYYMMDD + sequence (e.g. 2026090101) or ORD-{id}-{hex}"`:

```
20260901          date prefix with no sequence
202609011         date prefix with a single digit
```

Spot-checked live against `api.inkcartridges.co.nz` after deploy: the three
valid numeric forms pass validation (then 401 on auth, as expected for an
unauthenticated lookup), and `202609011` returns 400.

---

## Backend refs

- `sql/migrations/157_short_daily_order_numbers.sql` — the whole change; only the
  rendering inside `next_order_number()` moved. The per-day counter table, the
  atomic upsert and the Auckland day boundary are untouched from migration 069.
- `src/validators/schemas.js` — `orderNumberParamSchema` + `trackRequestSchema`,
  widened from a fixed `\d{14}` to `\d{8}\d{2,6}`.
- `__tests__/order-number-format.test.js` — pins all four accepted shapes.
- `docs/storefront/guest-order-email-link-jul2026.md` — updated; its prefill
  guidance is unchanged and still correct.
