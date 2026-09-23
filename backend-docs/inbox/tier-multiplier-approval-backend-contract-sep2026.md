# Margin tier multipliers — admin editing, live metrics, approval gate

**Backend contract for the frontend, September 2026.**

Backend: `src/routes/adminPricingControl.js`, `src/services/pricingTierService.js`,
`src/services/marginSimulatorService.js`, `src/utils/pricing.js`.
Database: migration 187 (`pricing_tier_proposals` + `approve_pricing_tier_proposal()`).

---

## 1. What this feature is

Retail prices are computed from the supplier cost by a **tiered multiplier**:

```
retail = cost × tierMultiplier × 1.15 (GST) → attractive-ending snap → floors
```

The multiplier depends on the product's `source` (`genuine` or `compatible`) and
on which **cost band** the cost falls into — 18 genuine bands (`<=10`, `10-15`,
… `1000+`) and 14 compatible bands (`<=5`, `5-8`, … `200+`) — and, optionally,
on the product's **brand**.

Resolution order for one product, resolved in the backend and never in the
frontend:

```
brand's own band  →  catalogue-wide band  →  the band shipped in code
```

A brand ladder overrides only the bands it names; everything else falls through
to the catalogue table.

The **cost boundaries themselves are editable too** (`bands`, §3.3). They are
catalogue-wide: a brand sets its multiplier *inside* the bands, never its own
boundaries — two brands disagreeing about what "45-60" means would make every
per-band metric meaningless. A band's key is **derived** from its boundaries in
the shipped grammar (`<=20`, `20-60`, `60+`), never supplied by the caller, so
two bands can never claim the same key.

Three things are new:

1. **An admin can edit those multipliers, and the edit now reaches real prices.**
   Until this release the admin panel wrote `pricing_config.tier_overrides` and
   the pricing engine ignored it: every live price came from the hardcoded
   ladder. The panel showed a change that no shelf price ever received. The
   approved override table is now the live ladder.
2. **Nothing applies until it is approved.** A multiplier edit creates a
   *proposal*. A proposal moves no price. A separate approve call is the only
   thing in the system that writes the live ladder.
3. **Impact metrics are available on every keystroke.** A simulate endpoint
   returns catalogue-wide and per-band margin figures for a proposed table, so
   the panel can show the effect of a multiplier before it is filed, and again
   before it is approved.

---

## 2. The flow the panel implements

```
 ┌── GET  /admin/pricing/tier-multipliers          load ladder + any open proposal
 │
 ├── POST /admin/pricing/simulate                  on every edit (debounced) → metrics
 │
 ├── PUT  /admin/pricing/tier-multipliers          "Propose"  → 202, applied:false
 │
 ├── GET  /admin/pricing/tier-multipliers/proposals/:id      review screen (fresh impact)
 │
 ├── POST .../proposals/:id/approve  {confirm:true}          → 202, applied:true + reprice job
 │      └── GET /admin/pricing/reprice-jobs/:jobId           poll until completed
 │
 └── POST .../proposals/:id/reject   {confirm:true}          → 200, applied:false
```

Every endpoint requires an authenticated **`super_admin`**. All of them use the
house envelope: `{ok: true, data, meta?}` on success, `{ok: false, error: {code,
message, details?}}` on failure.

Rate limits: `/admin/pricing/*` is 60/min (keyed by IP — the limiter runs before
auth, so admins behind one office IP share it); `POST /admin/pricing/simulate`
is 60/min (different router); `GET /admin/pricing/reprice-jobs/:id` is 120/min,
because it is the one endpoint polled on a timer.

---

## 3. Endpoints

### 3.1 `GET /api/admin/pricing/tier-multipliers`

The panel's single read on open.

```jsonc
{
  "ok": true,
  "data": {
    "defaults": {                      // the ladder shipped in code
      "genuine":    { "<=10": 1.47, "10-15": 1.44, "…": 0 },
      "compatible": { "<=5": 1.87, "5-8": 1.80, "…": 0 },
      "ribbon":     { "<6": 1.50, "…": 0 }      // display only — see §6
    },
    "overrides": {                     // APPROVED overrides only ({} when none)
      "genuine": { "45-60": 1.42 }
    },
    "effective": {                     // defaults + approved overrides — what prices use
      "genuine":    { "<=10": 1.47, "45-60": 1.42, "…": 0 },
      "compatible": { "…": 0 },
      "ribbon":     { "…": 0 }
    },
    "bands": {                         // the cost boundaries in force, with effective multipliers
      "genuine":    [ { "maxCost": 10, "key": "<=10", "mult": 1.47 }, "…" ],
      "compatible": [ { "maxCost": 5,  "key": "<=5",  "mult": 1.87 }, "…" ]
    },
    "bands_are_custom": { "genuine": false, "compatible": false },
    "global_offset": 0,                // catalogue-wide multiplier offset, ±0.05
    "pending_proposal": null,          // or a proposal object (§3.6)
    "updated_by": "uuid-of-last-approver",
    "updated_at": "2026-09-22T02:10:00.000Z"
  }
}
```

Render the editable table from **`effective`**. Show `defaults[band]` beside it
when `overrides[source][band]` exists, so an operator can see what they have
moved away from, and offer a "reset to default" that proposes the default value.

If `pending_proposal` is non-null, the panel is in **review state**: show the
pending table and the approve/reject actions, not a second edit form. A new edit
while one is pending is allowed, but it *supersedes* the open proposal (§3.3).

### 3.2 `POST /api/admin/pricing/simulate`

The metrics call. Read-only, writes nothing, safe to call on a debounced edit.
It is also what the FE should use for the "what does this multiplier do" panel
before anything is proposed.

**Request**

```jsonc
{
  "scope": {
    "source": "genuine",              // optional: genuine | compatible
    "brand_slug": "brother",          // optional
    "product_ids": ["uuid", "…"],     // optional, max 2000
    "include_overrides": false        // include rows frozen by manual_retail_price
  },
  "proposed_tiers": {                 // FULL or partial table; omitted bands keep their current value
    "genuine": { "45-60": 1.42 },
    "brands": {                       // optional, keyed by brand_id
      "33333333-3333-3333-3333-333333333333": {
        "slug": "brother", "name": "Brother",
        "genuine": { "45-60": 1.48 }
      }
    },
    "bands": {                        // optional: preview moved boundaries
      "genuine": [
        { "max_cost": 20, "mult": 1.55 },
        { "max_cost": 60, "mult": 1.40 },
        { "max_cost": null, "mult": 1.25 }
      ]
    }
  },
  "global_offset": 0.01,              // optional, ±0.05 — stacks on every multiplier; default 0
  "preview_limit": 25                 // how many sample rows to return (1–5000, default 500)
}
```

**Response**

```jsonc
{
  "ok": true,
  "data": {
    "affected": 3252,                 // SKUs the proposed table would price
    "aggregate": {
      "avg_retail_change_pct": 1.84,
      "total_skus_with_increase": 412,
      "total_skus_with_decrease": 0,
      "total_skus_unchanged": 2840,
      "avg_net_margin_before": 27.41, // percent, after Stripe fees
      "avg_net_margin_after": 28.90,
      "net_profit_per_unit_before": 41233.55,   // see §5 — NOT revenue
      "net_profit_per_unit_after": 43120.10,
      "net_profit_per_unit_delta": 1886.55,
      "catalogue_value_before": 511230.44,
      "catalogue_value_after": 519884.10,
      "below_survival_floor_before": 0,
      "below_survival_floor_after": 0
    },
    "by_tier": [                      // one row per (source, band) that has products
      {
        "source": "genuine",
        "tier": "45-60",
        "max_cost": 60,
        "current_multiplier": 1.385,  // what is LIVE right now
        "proposed_multiplier": 1.42,
        "products": 188,
        "products_increasing": 188,
        "blocked_by_no_decrease": 0,
        "avg_net_margin_before_pct": 26.10,
        "avg_net_margin_after_pct": 28.35,
        "avg_retail_change_pct": 2.53,
        "net_profit_per_unit_delta": 402.18
      }
    ],
    "global_offset_applied": 0.01,    // echoes the offset the figures were computed with
    "by_brand": [                     // only brands the proposal gives their own ladder
      {
        "brand_id": "33333333-3333-3333-3333-333333333333",
        "slug": "brother", "name": "Brother",
        "products": 214,
        "products_increasing": 214,
        "blocked_by_no_decrease": 0,
        "avg_net_margin_before_pct": 26.80,
        "avg_net_margin_after_pct": 30.10,
        "avg_retail_change_pct": 3.90,
        "net_profit_per_unit_delta": 611.02
      }
    ],
    "no_decrease_ratchet": {          // READ THIS — §4
      "enforced": true,
      "blocked_skus": 0,
      "will_change_skus": 412,
      "note": "Automated repricing never lowers a live price. …"
    },
    "sample": [
      {
        "id": "uuid", "sku": "GTN251BK", "name": "…", "brand": "Brother",
        "source": "genuine", "tier": "45-60",
        "cost_price": 52.10,
        "current_retail": 77.79, "new_retail": 79.99,
        "delta_retail": 2.20, "delta_profit_per_unit": 1.86,
        "current_net_margin_pct": 26.10, "new_net_margin_pct": 28.35,
        "gross_markup_before_pct": 29.80, "gross_markup_after_pct": 33.50,
        "brand_id": "33333333-3333-3333-3333-333333333333",
        "priced_by_brand_ladder": true,
        "blocked_by_no_decrease": false
      }
    ],
    "generated_at": "2026-09-22T02:10:00.000Z"
  }
}
```

`by_tier` is the row that answers "what did I just change?", because the panel
edits one band at a time. `aggregate` answers "what did I do to the catalogue?".

When simulating a **global offset** change, pass `global_offset`. It is added to
every tier multiplier, exactly as the live engine does it. Leave it out and the
simulation answers a question about the tiers alone — an offset-only proposal
simulated without it reports "no change" for a change that moves every price.

The catalogue snapshot behind this is cached for 60 seconds per scope, so
consecutive edits are cheap. Debounce at ~300 ms anyway; do not fire per
keystroke.

### 3.3 `PUT /api/admin/pricing/tier-multipliers` — propose

**This no longer applies anything.** It used to write the ladder and start a
catalogue reprice on the spot.

**Request** — a *partial* edit: send only the bands being changed. At least one
of `genuine`, `compatible`, `global_offset` is required.

```jsonc
{
  "genuine":    { "45-60": 1.42 },
  "compatible": { "12-18": 1.72 },
  "brands": [                       // optional, max 50 entries
    { "brand_slug": "brother", "genuine": { "45-60": 1.48 } },
    { "brand_id": "3333…", "compatible": { "12-18": 1.80 } },
    { "brand_slug": "hp", "clear": true }     // drop HP's ladder entirely
  ],
  "bands": {                        // optional: move the cost boundaries
    "genuine": [
      { "max_cost": 20,   "mult": 1.55 },
      { "max_cost": 60,   "mult": 1.40 },
      { "max_cost": null, "mult": 1.25 }    // last band MUST be open-ended
    ]
  },
  "global_offset": 0.01,            // optional; omit to leave the offset alone
  "notes": "Recover margin on mid-cost genuine toner"
}
```

**Cost bands.** Send the whole ladder for a source, 2–40 entries, boundaries
strictly ascending, every `mult` between 1.05 and 5, and the **last entry
open-ended** (`max_cost: null`) so every cost lands in a band. A ladder that
breaks any of those is a **400 `INVALID_BAND_LADDER`** — the backend refuses the
whole array rather than repairing part of it, because a half-accepted ladder
prices some costs at the operator's intent and the rest at the shipped one with
nothing saying which.

Band keys are derived server-side, so **moving a boundary renames its band**.
Multipliers (catalogue or per-brand) still keyed to a band that no longer exists
are a **400 `UNKNOWN_TIER_BAND`** listing each one and the bands the new ladder
does have. Re-enter those multipliers against the new bands, or clear the brand
ladders that used the old ones. Multiplier keys must also match the ladder
grammar (`<=10`, `10-15`, `1000+`) or the request is a 400 naming the key.

**Brand entries.** Name a brand by `brand_slug` or `brand_id`; the backend
resolves the slug and stores the **id**, so a later brand rename cannot orphan
the ladder. An entry must carry at least one of `genuine`, `compatible` or
`clear` — a bare `{brand_slug}` is a 400. A brand that does not resolve is a
**400 `UNKNOWN_BRAND`** listing the offending values, never a silently dropped
edit.

Brand edits merge the same way band edits do: a second proposal touching the
same brand adds to its table. **`clear: true` is the only way to remove a brand
ladder** — an empty band map in a partial edit is indistinguishable from "leave
it alone".

Band keys are validated against the real ladder. A key that is not a band
(`"<=100"` when the band is `"80-100"`) is a **400**, not a silent no-op.
Multipliers must be between **1.05 and 5**. `global_offset` must be within
**±0.05**.

**Response — 202**

```jsonc
{
  "ok": true,
  "data": {
    "applied": false,
    "status": "pending_approval",
    "defaults": { "…": 0 },
    "live_overrides": { "…": 0 },          // still in force
    "proposed_effective": { "…": 0 },      // the full ladder if approved
    "proposal": { "…": 0 },                // §3.6
    "impact": { "…": 0 },                  // same shape as §3.2 data
    "message": "Change proposed. No price moves until this proposal is approved."
  }
}
```

The UI must not say "saved" or "updated" here. Say **proposed / awaiting
approval**, and route the user to the review screen.

### 3.4 `PUT /api/admin/pricing/global-offset` — propose (offset only)

Same gate, same response shape (`applied:false`, `status:"pending_approval"`).
Body: `{offset: 0.01, notes?: "…"}`, `offset` within ±0.05. It exists because
the offset is the same lever under another name; it is not a shortcut past
approval.

### 3.5 `GET /api/admin/pricing/tier-multipliers/proposals`

Query: `status` (`pending|approved|rejected|superseded`, optional), `limit`
(1–100, default 20). Returns `data: [proposal, …]` newest first — the audit
trail of who proposed what, who approved it, and the impact they were shown.

### 3.6 `GET /api/admin/pricing/tier-multipliers/proposals/:proposalId`

The review screen's read. For a **pending** proposal the impact is recomputed
now, because supplier costs move between filing and approval; for a settled one
the stored snapshot is returned.

```jsonc
{
  "ok": true,
  "data": {
    "proposal": {
      "id": "uuid",
      "status": "pending",                 // pending | approved | rejected | superseded
      "proposed_overrides": { "genuine": { "45-60": 1.42 } },
      "base_overrides":     { },           // the live table when it was filed
      "proposed_global_offset": null,      // null = does not touch the offset
      "base_global_offset": 0,
      "impact": { "…": 0 },                // snapshot taken at filing (+ at_approval once approved)
      "notes": "Recover margin on mid-cost genuine toner",
      "created_by": "uuid", "created_at": "2026-09-22T02:10:00.000Z",
      "reviewed_by": null, "reviewed_at": null, "review_notes": null,
      "applied_at": null, "reprice_job_id": null
    },
    "impact": { "…": 0 },                  // freshly measured for a pending proposal
    "proposed_effective": { "…": 0 },
    "live_overrides": { },
    "stale": false                         // true → approving will be refused, §3.7
  }
}
```

When `stale` is `true`, somebody changed the live ladder after this proposal was
filed. Disable the approve button and tell the operator to re-propose; the
approve call will refuse it anyway.

### 3.7 `POST /api/admin/pricing/tier-multipliers/proposals/:proposalId/approve`

**The only call in the system that changes live prices.**

Body: `{"confirm": true, "notes": "optional"}`. `confirm:true` is **required** —
approval starts a catalogue reprice, and a reprice is not reversible with a
second click (see §4).

**Response — 202**

```jsonc
{
  "ok": true,
  "data": {
    "applied": true,
    "proposal": { "…": 0, "status": "approved", "applied_at": "…", "reprice_job_id": "uuid" },
    "effective": { "…": 0 },               // the ladder now in force
    "impact": { "…": 0 },                  // measured at approval, stored on the row
    "reprice": {
      "status": "queued",                  // queued | enqueue_failed | skipped
      "job_id": "uuid",
      "message": "Approved. Full catalogue repricing is running in the background…"
    },
    "packs": {                             // see §6.1
      "repriced": false,
      "action_required": "Re-anchor packs after the reprice completes: node scripts/repair-pack-prices.js --apply",
      "note": "Auto-generated packs are excluded from automated repricing…"
    }
  }
}
```

Errors:

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `confirm` missing or not `true` |
| 404 | `NOT_FOUND` | no proposal with that id |
| 409 | `PROPOSAL_STALE` | the live ladder changed after the proposal was filed |
| 409 | `PROPOSAL_NOT_PENDING` | already approved, rejected or superseded |
| 500 | `INTERNAL_ERROR` | unexpected |

If `reprice.status` is `enqueue_failed`, the ladder **is** live but no reprice
started: surface that clearly and offer a retry via `POST /admin/pricing/reprice`.

### 3.8 `POST /api/admin/pricing/tier-multipliers/proposals/:proposalId/reject`

Body: `{"confirm": true, "notes": "optional"}`. Returns 200 with
`{applied:false, proposal:{…, status:"rejected"}}`, or 409 `PROPOSAL_NOT_PENDING`.

### 3.9 `GET /api/admin/pricing/reprice-jobs/:jobId`

Poll after an approval — this is how the panel knows the storefront has caught up.

```jsonc
{
  "ok": true,
  "data": {
    "id": "uuid",
    "status": "pending",                   // pending | running | completed | failed
    "trigger": "tier_multipliers",
    "counts": { "matched": 3252, "updated": 412, "unchanged": 2840,
                "skipped_frozen": 18, "skipped_ineligible": 0 },
    "error": null,
    "created_at": "…", "started_at": "…", "finished_at": null
  }
}
```

Poll every ~5 s, and stop at `completed` / `failed` or after ~10 minutes. A
full-catalogue reprice normally finishes within a couple of minutes.

---

## 4. Two rules the UI must communicate honestly

### 4.1 Approving is not instant on the storefront, and it is not reversible with a second click

Approval makes the ladder live immediately. It does **not** immediately change
what a shopper sees: the storefront reads `products.retail_price`, and the
background reprice job is what writes those. "Live on the site" = when the
reprice job reports `completed`.

Rolling back a reprice is not a button. Automated repricing cannot lower a price
(next rule), so undoing an increase means setting `manual_retail_price` per
product. Treat approve as a commit: show the impact figures and the affected SKU
count in the confirmation dialog.

### 4.2 Lowering a multiplier does not lower live prices

A standing operator directive: **automated repricing never lowers a live
price.** The engine clamps its answer to `max(engine price, current retail)`.

So a multiplier reduction is a no-op on existing products — it only affects rows
whose cost changes later, and new products.

The simulator tells you exactly how much of a proposal this affects:

- `no_decrease_ratchet.enforced` — always `true` in production.
- `no_decrease_ratchet.blocked_skus` — rows priced lower by this table, which
  will keep their current price.
- `no_decrease_ratchet.will_change_skus` — rows that will actually move.
- per row: `sample[].blocked_by_no_decrease`; per band:
  `by_tier[].blocked_by_no_decrease`.

**Required UI behaviour:** when `blocked_skus > 0`, show a warning next to the
proposal ("N of M products are priced lower by this table and will keep their
current price — deliberate reductions must be set per product"). Do not render a
decrease as a green "price drop" the system will not deliver.

---

## 5. What the numbers mean (and what to call them)

| Field | Meaning | Do not label it |
|---|---|---|
| `avg_net_margin_before/after` | Mean net margin % after Stripe fees, across matched SKUs | gross margin |
| `net_profit_per_unit_before/after/delta` | Sum of per-unit net profit over the matched SKUs — one unit of each | revenue, monthly profit, forecast |
| `catalogue_value_before/after` | Sum of retail prices, GST inclusive | inventory value, revenue |
| `avg_retail_change_pct` | Mean per-SKU price change % | margin change |
| `below_survival_floor_after` | Rows under 5% net margin after Stripe with this table | out of stock, loss |
| `affected` | SKUs this table would price | catalogue size |

There is **no sales-volume weighting anywhere in this response.** These are
per-unit figures over the catalogue, not a revenue or profit forecast. A tile
labelled "projected monthly profit" would be inventing a number the backend did
not compute.

All percentages are already multiplied by 100 (`28.90` = 28.90%). All money is
NZD, GST-inclusive where it is a retail figure, and rounded to cents.

---

## 6. Scope — what these multipliers do and do not price

Priced by this ladder: **active genuine and compatible single cartridges with a
known cost.**

Excluded, by design, and invisible in every number above:

- **Value packs and multipacks** — priced from their constituent singles minus a
  source discount. Repricing them through the singles ladder inflates the
  displayed saving. They move when their constituents move.
- **Ribbons** — separate pricing table and endings.
- **Rows with `manual_retail_price` set** — an explicit operator price, returned
  verbatim by the engine. Include them in a simulation with
  `scope.include_overrides: true` if you want to see what they *would* be.
- **Cost boundaries are catalogue-wide.** A brand ladder sets multipliers inside
  the shared bands. There is no per-brand boundary set, by design.
- **The `ribbon` block in `defaults`/`effective`** is display only. Editing it is
  not supported by the proposal endpoints and the request schema rejects it.
- **Inactive and zero-cost products.**

### 6.1 Packs need a second, manual step after a tier change

Value packs and multipacks are priced as `constituent singles total × (1 − source
discount)`, computed when the pack is generated. A tier change moves the
singles; it does **not** move the packs, and no cron re-anchors them — the daily
`audit-pack-price-drift` job only *reports* the drift.

So after an approval, packs sit on yesterday's anchor until an operator runs
`node scripts/repair-pack-prices.js --apply`. The approve response says so in
`data.packs`. Surface it as a follow-up task in the UI (a checklist item after
the reprice job completes), not as an error.

Floors that still apply after the multiplier, so an edit can move a price less
than the multiplier suggests: a minimum retail ($5.49 compatible / $5.99
genuine), a per-band gross-markup floor, an absolute survival floor (5% net
after fees), and for genuine items over the $100 free-shipping threshold an
absorbed-courier allowance. The simulator applies all of these, so its
`new_retail` is the real answer — never recompute a price in the frontend.

---

## 7. Suggested panel layout

0. **Brand selector** — "All brands" (the catalogue table) or one brand. When a
   brand is selected, edits go into `brands[]` and the table shows that brand's
   effective multiplier with the catalogue value beside it, so an inherited band
   is visibly inherited. `by_brand` in the simulate response is the summary row
   for that brand; `sample[].priced_by_brand_ladder` says which rows its ladder
   actually reached.
1. **Ladder table** — one row per band, per source, built from `bands` (which
   carries the boundaries and the effective multiplier together). Editing a
   boundary sends the whole `bands[source]` array back; editing a multiplier
   alone can still go through `genuine`/`compatible`. Columns: band, cost range,
   current multiplier (editable), default, products in band, avg net margin now,
   avg net margin after, price change %. Rows come from `effective` +
   `by_tier` (join on `source` + `tier`).
2. **Live metrics strip** — from `aggregate`: SKUs affected, SKUs increasing,
   average margin before → after, net profit per unit delta, and the
   `blocked_by_no_decrease` warning when non-zero.
3. **Sample table** — `sample` rows, so the operator can see actual SKUs and
   prices before committing. Ask for `preview_limit: 25` on edits and a larger
   limit only when the user opens the full list.
4. **Propose button** → `PUT`, then switch the panel into review state.
5. **Review card** — proposed vs live ladder diff, fresh impact, notes field,
   Approve (needs `confirm:true`) and Reject.
6. **Post-approval** — poll the reprice job, show progress, and refresh the
   ladder read when it completes.

State to keep in the panel: the pending proposal id, the last simulate result,
and the running reprice job id (so a page refresh mid-reprice can resume
polling — it comes back on `proposal.reprice_job_id`).

---

## 8. Practical notes

- **Partial edits.** `PUT` merges onto the live table. To reset a band to its
  shipped default, propose the value from `defaults`; there is no "delete
  override" verb.
- **One pending proposal at a time**, enforced in the database. Filing a second
  supersedes the first (status `superseded`); the panel should confirm that
  before sending if a pending proposal exists.
- **Concurrency.** Two admins editing at once: the second approval gets 409
  `PROPOSAL_STALE`. Always re-read the proposal before showing the approve
  dialog, and honour the `stale` flag.
- **Audit.** Every propose / approve / reject writes an admin audit-log row and
  keeps the impact snapshot on the proposal, so "why did prices move on the
  22nd" is answerable from the proposal history alone.
- **Cache.** After a reprice completes, catalogue caches are cleared server-side
  and a Cloudflare purge fires. A hard refresh of admin product lists is enough;
  no client action is needed.
- **Pre-flight (operator, not FE).** `node scripts/audit-tier-bump-competitor-safety.js
  --proposal <id>` prices a *pending* proposal against live competitor data and
  reports any SKU that would end up above the cheapest fresh competitor. Worth
  running before approving a large increase.
