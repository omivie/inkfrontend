# Orders page — "Invoice sent" only for invoice-claimed orders (Sep 2026)

**FE action required.** The backend now tells you, per order row, whether the
"Invoice sent" column applies at all. The column must be **blank (em-dash) on
every Website and Quick Order row**, and show the real send history only on rows
claimed from an **Invoice**.

Shipped in `GET /api/admin/orders`. Nothing else on the page changes.

---

## 1. Why

Today the column renders `Not recorded` on every website checkout. That's noise:
a storefront order is never "invoiced" by an operator — the customer is emailed
their receipt automatically by the payment webhook. A permanent `Not recorded`
on 13 of 15 rows reads as 13 outstanding tasks that do not exist.

Worse, it was **wrong in the one place it mattered**. The column was built from
`order_events` notes that only the admin Orders page writes, so the two genuine
invoice rows on page 1 (`INV-3277`, `INV-3276`) showed `Not recorded` — even
though both invoices *had* been emailed (1 Sep 12:55 and 31 Aug 17:21 NZT). Those
sends happened from the **Invoices** page, which logs to `standalone_invoice_emails`
(mig 120), a table the Orders page never read.

So the column was blank where the answer was "not applicable", and blank where
the answer was "yes, sent". Both halves are now fixed server-side.

---

## 2. Contract

Each element of `data[]` in `GET /api/admin/orders` gains **three** fields:

```jsonc
{
  // ...existing order fields (order_number, status, total, profit, deletable, ...)

  "channel": "web" | "invoice" | "quick_order",   // NEW — was stripped before
  "invoice_id": "7b6ec9fe-…" | null,              // NEW — source standalone invoice
  "invoice_sent": null | {
    "sent_at":    "2026-09-01T00:55:49.304Z" | null,
    "sent_count": 2,
    "source":     "send_log" | "legacy_stamp" | null
  }
}
```

### `invoice_sent` — the only field the column should read

| Value | Meaning | Render |
|---|---|---|
| `null` | **Not applicable.** Website checkout or quick order. | `—` |
| `{ sent_at: null, … }` | Applicable, invoice **never emailed**. | `Not sent` |
| `{ sent_at: "…", sent_count: 2, source: "send_log" }` | Sent, with full history. | `1 Sep ×2` |
| `{ sent_at: "…", sent_count: 0, source: "legacy_stamp" }` | Sent **before** the send log existed (pre-mig-120). Exact count unknown. | `27 Jul` — **no `×N`** |

**`null` and `{sent_at: null}` are different and must render differently.** `null`
means the question doesn't apply to this row; `{sent_at: null}` means it applies
and the answer is "not yet" — that one *is* an actionable outstanding send.

**Never render `×N` when `sent_count` is `0`.** A zero count with a date means the
count is genuinely unknown (legacy stamp), not that it was sent zero times.

### Rules

1. **Gate on `invoice_sent !== null`, not on `channel`.** The backend already
   applied the channel rule; re-deriving it in the FE just creates a second
   place to get it wrong.
2. **Never infer the channel from the order number.** `INV-3277` looks like an
   invoice because it is one, but `channel` is the authority — a web order whose
   number happens to start `INV-` must still show `—`. Use `channel` for the
   **Channel badge** too, replacing any prefix-sniffing.
3. **Treat an unknown `channel` value as Website** for badge purposes (em-dash for
   the send column follows automatically, since `invoice_sent` will be `null`).
4. `source` is diagnostic. Use it only to decide whether to append `×N`; don't
   surface the string.

---

## 3. Retire the `order_events` note scraping

The FE currently writes an `order_events` note on each send —

> `[invoice-sent] Invoice email sent from the admin Orders page.`

— and reads those notes back to build the column. **Stop reading them.** They are
an incomplete record by construction: they capture only sends triggered from the
Orders page and miss every send made from the Invoices page (which is where
invoices are actually emailed).

Keep *writing* the note if you still want the audit trail in the order timeline —
it's harmless — but it must no longer feed this column.

Existing notes stay in the database. On website rows they now render as `—`
regardless, which is the intended outcome: those notes recorded resends of the
**order receipt**, not an operator invoice.

---

## 4. Worked example — page 1 of the current Orders list

Replayed against live data, this is the before/after for the exact page in the
report screenshot:

| Order # | Channel | Before | After |
|---|---|---|---|
| 20260829000004 | Website | `Not recorded` | `—` |
| 20260829000003 | Website (cancelled) | `—` | `—` |
| 20260829000002 | Website | `Not recorded` | `—` |
| **INV-3277** | **Invoice** | `Not recorded` | **`1 Sep`** |
| **INV-3276** | **Invoice** | `Not recorded` | **`31 Aug`** |
| 20260827000003 | Website | `28 Aug ×2` | `—` |
| …10 more website rows | Website | `Not recorded` | `—` |

`20260827000003` losing its `28 Aug ×2` is correct: that was two resends of the
customer's **order receipt** from the Orders page, not an invoice being issued.

---

## 5. Backend notes (no FE action)

- **Source of truth:** `standalone_invoice_emails` (mig 120, one row per send),
  falling back to `standalone_invoices.emailed_at` for invoices emailed before
  that log existed. Read via the shared `src/utils/invoiceSendLog.js` — the same
  helper backs the Invoices page's own **Sent** column, so the two pages can no
  longer disagree.
- **Cost:** batched — two queries per page total, and **zero** when a page holds
  no invoice rows. No N+1, no change to list latency on storefront-only pages.
- **Fail-soft:** if the send-log read errors, invoice rows degrade to
  `{sent_at: null, sent_count: 0, source: null}` (renders `Not sent`); the order
  list itself never fails. Web rows are unaffected — they never hit the lookup.
- **Shaping logic:** `src/utils/orderInvoiceSent.js` (pure), pinned by
  `__tests__/order-invoice-sent.test.js`.
- `channel` / `invoice_id` were previously fetched but stripped from the response
  (they fed the delete-permission hint only). `quick_order_id` stays internal.
