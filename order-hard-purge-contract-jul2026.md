# Order delete contract + owner hard purge — as implemented

**Date**: 2026-07-30 · **FE ref**: ERR-132 · **Closes**: BF-010
**Backend handoff consumed**: `~/Downloads/order-delete-not-deletable-fix-jul2026.md` (2026-07-30)
**Original FE request**: `~/Downloads/order-hard-purge-request-jul2026.md` (2026-07-27)

> The handoff points at `docs/admin/order-hard-purge-backend-response-jul2026.md` for the full
> request/response contract. **That document was never delivered** and this repo has no `docs/`
> directory. Everything below is either quoted from the handoff itself or verified by us against
> the live API. §5 lists what we could not confirm and the defensive branch each gap produced.

---

## 1. The per-row deletability signal

`GET /api/admin/orders` returns three additive fields on every row, computed server-side from the
caller's role **and** the order:

```jsonc
{
  // ...existing order fields...
  "status": "paid",
  "deletable": true,                 // may THIS admin delete this order at all?
  "delete_method": "purge",          // "purge" | "delete" | null
  "delete_blocked_reason": null      // null | "invoice_link" | "not_cancelled"
}
```

| Caller | Order | `deletable` | `delete_method` | `delete_blocked_reason` |
|---|---|---|---|---|
| `super_admin` (owner) | any status, not invoice-linked | `true` | `"purge"` | `null` |
| `super_admin` | invoice / quick-order linked | `false` | `null` | `"invoice_link"` |
| `order_manager` | `cancelled` | `true` | `"delete"` | `null` |
| `order_manager` | any other status | `false` | `null` | `"not_cancelled"` |

`invoice_link` is a **best-effort hint** read off columns on the order row. The purge endpoint is
the authority and may additionally refuse — that arrives in `failed[]`, not as a change to the hint.

## 2. The two doors

| Method | Route | Semantics |
|---|---|---|
| `"purge"` | `POST /api/admin/orders/purge` body `{ "order_ids": [...] }` | `super_admin` only. Bypasses the status guard. Snapshots each order into `admin_audit_log` before the physical delete. Cascades to line items, invoice links, loyalty ledger, tracking and refunds. Invoice-linked orders are refused **whole**, never partially deleted. |
| `"delete"` | `DELETE /api/admin/orders/:id` | Unchanged cancelled-only path. `204`, or `ORDER_NOT_CANCELLED` / `ORDER_NOT_FOUND`. |

**The purge returns `200` even on partial failure.** The body carries `data.deleted` and
`data.failed[]` (`{id, code, message}`, e.g. `ORDER_HAS_INVOICE_LINK`). A resolved response is
therefore never an error — branch on `failed[].code`.

## 3. What we verified ourselves

| Check | Result | Date |
|---|---|---|
| `POST /api/admin/orders/purge` unauthenticated | `401 {"code":"UNAUTHORIZED"}` | 2026-07-30 |
| `POST /api/admin/orders/<bogus-path>` unauthenticated (control) | `404 {"code":"NOT_FOUND"}` | 2026-07-30 |
| Authed `GET /api/admin/orders` as owner — do the three fields exist? | **Yes — 20/20 rows.** 18 carry `delete_method:"purge"` (15 of them non-`cancelled`); 2 are `deletable:false` / `invoice_link` (`INV-3266`, `INV-3267`) | 2026-07-30 |
| Authed `GET /api/admin/orders/:id` — does the DETAIL payload echo them? | **No.** All three are `undefined` on the detail payload while the same order's list row has them | 2026-07-30 |

401-not-404 against a 404-returning sibling proves the route is **deployed and mounted**. The
authed reads confirm the row contract is live, and confirm that it exists on the **list endpoint
only** — which is what makes `resolveDeleteRight` load-bearing rather than defensive (§5 Q3).

## 4. How the frontend consumes it

One vocabulary: **`inkcartridges/js/admin/utils/order-deletability.js`**. Pure, DOM-free, no
imports, so it is unit-tested directly under `node --test`.

- `orderDeleteRight(order)` → `{deletable, method, reason, copy, hint, source}`. Fail-closed by
  construction: a payload that disagrees with itself resolves to **blocked, with the server's own
  reason**; an unknown `delete_method` blocks rather than being routed anywhere.
- **Legacy fallback.** A row carrying no contract fields (backend rollback, or a row cached before
  the deploy) resolves through the pre-purge cancelled-only rule. That path can **never** yield
  `purge` — the frontend must not infer a role, and `delete` on a cancelled order is honoured for
  every admin role. A row with no status at all blocks as `fe_unresolved`, not `not_cancelled`.
- `normalisePurgeResult(requestedIds, payload)` → `{deleted, failed, unaccounted, unexpected}`.
  **An id the server did not mention is never a success.** It surfaces to the admin as "outcome
  unknown", a bucket distinct from both deleted and failed.
- `deletePlanCopy(groups)` owns the confirm-dialog wording, so the honesty of the purge warning
  (irreversible · cascade · audit-log snapshot · "the invoice-link check is only a hint") is
  unit-testable rather than editable in passing.

`pages/orders.js` reads that vocabulary from **both** the bulk bar and the single-order modal. The
modal resolves its right with `resolveDeleteRight(fullOrder, listRow, order)` because the contract
is only promised on the **list** endpoint — gating on the detail payload alone would legacy-resolve
a paid order to blocked and the owner would find no delete button at all.

`AdminAPI.purgeOrders(ids)` dedupes, chunks at 25, sends chunks sequentially, and throws **only
when nothing was accomplished** — once a chunk has returned, a later failure degrades into
`failed[]` entries rather than discarding the record of what was already irreversibly purged.

Pinned by **`tests/admin-order-delete-gating.test.js`** (66 tests: the four contract rows verbatim,
the loud-unknown battery, the legacy fallback, purge-response normalisation, and the source
invariants).

## 5. Open questions — each one is a defensive branch we would like to delete

Tracked as **BF-024**.

| # | Question | What we did instead |
|---|---|---|
| 1 | Is there a **maximum `order_ids` length** per purge call? | Chunk at 25, sequentially. Selection survives pagination so it is unbounded, and each purge writes audit rows against the 60/min limiter. Tell us the real cap and we will raise it. |
| 2 | Is `data.deleted` an **array of ids** or a **count**? | Both handled. A count is only trusted when `deleted + failed.length === requested.length`; otherwise the remainder is reported as unknown rather than guessed at. |
| 3 | ~~Does **`GET /api/admin/orders/:id`** echo the three fields?~~ **ANSWERED — measured 2026-07-30: no.** All three are `undefined` on the detail payload. | `resolveDeleteRight(fullOrder, listRow, order)` is therefore **load-bearing, not defensive**: gating the order-detail modal on the detail payload alone would legacy-resolve every `paid`/`shipped` order to blocked and the owner would find no delete button at all. **Please echo them on the detail endpoint too** — the modal is the surface an operator reaches for a single order, and it should not depend on the list having been read first. |
| 4 | Is the **`admin_audit_log` snapshot retrievable** by the owner, and for how long? | The confirm dialog states that a snapshot is written before removal. It does not promise the owner can read it back, because we cannot verify that. If there is a retrieval route, the dialog can say so and the purge stops being a one-way door in the operator's mental model. |
| 5 | Is the **full refusal-code set** documented anywhere? | We map `ORDER_HAS_INVOICE_LINK`, `ORDER_NOT_CANCELLED`, `ORDER_NOT_FOUND`, `FORBIDDEN`, `UNAUTHORIZED`, `RATE_LIMITED`. Any other code surfaces as `` `${code} — ${message}` `` — reportable, never silently generic. |

## 6. Related frontend fix shipped alongside

`AdminAPI` rebuilt every non-ok `{ok:false, …}` envelope as a bare `new Error(resp.error)` at **35
call sites**, discarding the machine-readable `code`. `js/api.js` attaches `e.code` on its throw
path and returns an `{ok:false, code}` envelope for 401/403/404/429/5xx — but the wrapper threw it
away, which is how "there is no `err.code`, so prose-matching is the only option" became folklore
(it was written into BF-010 and into a test comment before anyone checked). All 35 sites now use
one module-level `errorFromEnvelope(resp, fallback)`. The message is unchanged at every site, so no
caller behaviour moved; there is simply now a `.code` to branch on. See `errors.md` ERR-132.
