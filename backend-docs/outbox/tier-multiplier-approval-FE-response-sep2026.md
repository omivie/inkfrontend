# Tier multiplier approval gate: frontend shipped, and three things in the numbers (BF-068)

**Answers:** `tier-multiplier-approval-backend-contract-sep2026.md` (migration 187)
**FE ref:** ERR-281 · **Date:** 2026-09-23 · **Probe:** `npm run probe:tier-approval` (read-only)

---

## 1. What shipped

The contract is implemented as written, in Site Health → Pricing (`js/admin/pages/cc2-pricing.js`),
with the request logic in `js/admin/utils/tierProposal.js`:

- **Edit.** The ladder table is built from `bands` and joined to `by_tier` on (source, tier).
  - Brand selector: edits go into `brands[]` by `brand_id`, inherited bands are shown as inherited,
    and `clear: true` removes a ladder.
  - Cost-band editor: sends the whole `bands[source]` and previews the renamed keys.
  - Global offset.
  - Simulate runs on every edit, debounced to 300 ms.
- **Propose** sends only the changed bands, confirms before superseding a pending proposal, and says
  "awaiting approval", never "saved".
- **Review** re-reads the proposal, disables Approve on `stale`, and shows the diff and fresh impact.
- **Approve** re-reads the proposal before opening its dialog, and `confirm:true` exists at one
  call site.
- **Reprice.** The job is polled every 5 s for at most 10 min. `enqueue_failed` shows "the ladder is
  live, no reprice started" with a retry. `data.packs.action_required` is shown verbatim as a
  checklist item. After a page refresh, polling resumes from `reprice_job_id`.
- **History** lists every proposal with its stored impact.

**Verified on production** with the owner's permission, 2026-09-23:
1. Proposed compatible `200+` 1.24 → 1.25 through the panel (proposal `d7cfd137-e48a-45de-a64f-f5a37e0a22d2`).
2. The PUT returned 202, and the review showed `stale: false`.
3. We rejected it. Its status is `rejected`, `overrides` is still `{}`, and no job was created.

**We did not approve anything**, so the approve → reprice → poll path has only been exercised
against fakes. The first real approval will be its live test.

Your contract matched production field for field. One addition we noticed: `effective` also carries
`bands` and `brands`, which the §3.1 example does not show.

---

## 2. BF-068: three things we measured, one ask each

All three measured on 2026-09-23. `npm run probe:tier-approval` reports each one as a note, so you
can re-check them after a fix.

### 2.1 The aggregate counts rows held by the ratchet as price cuts

Simulating compatible `12-18` at 1.60 (live 1.69):

```
sample row C12XBK   current_retail 68.79   new_retail 62.49   blocked_by_no_decrease: true
aggregate.total_skus_with_decrease = 175   ==   no_decrease_ratchet.blocked_skus = 175
```

So `avg_net_margin_after`, `net_profit_per_unit_after/delta`, `catalogue_value_after`,
`avg_retail_change_pct` and `total_skus_with_decrease` all price the 175 blocked rows at the lower
table price. The live engine will keep them at their current price. §4.2 asks us not to show a
decrease the system will not deliver, and these aggregate fields do show one.

**Ask:** either compute the `*_after` fields at `max(engine, current)`, or add clamped twins
(`*_after_delivered`). For now the panel keeps the fields as they are and says under them that the
delivered figures will be higher.

### 2.2 Drift is inside every impact figure, including the approval snapshot

A simulate with **no change** (`proposed_tiers: {}`) over the whole catalogue:

```
will_change_skus 57 · blocked_skus 190 · net_profit_per_unit_delta −614.13
```

Approval reprices the whole catalogue, so those 57 rises happen whatever the proposal changes. The
impact you store on the proposal (and `at_approval`) mixes them with the edit. In the audit trail,
"why did prices move on the 22nd" would then point at a proposal that did not cause most of the
movement. Our live test shows the extreme case: a band with **zero products** carried a stored
impact of 57 SKUs changing.

The panel runs a second, no-change simulate and prints "this edit alone" next to the drift.

**Ask:** return the baseline alongside the proposal figures (e.g. `baseline: {will_change_skus,
net_profit_per_unit_delta, …}`) in the simulate response and in the stored snapshot. That saves one
of the two simulate calls on every edit, which matters under the shared 60/min limit.

### 2.3 Simulate accepts input that PUT refuses

```
POST /simulate {proposed_tiers:{genuine:{"<=100":1.4}}}                → 200, no change
POST /simulate {proposed_tiers:{brands:{"x":{slug:"brother",…}}}}      → 200, by_brand: []
PUT  /tier-multipliers with the same key                                → 400 (per §3.3)
```

A mistyped band therefore previews as "no effect". The panel validates keys and brand ids before
simulating, but the two endpoints should agree.

**Ask:** use the same Joi rules for `proposed_tiers` in simulate as for the PUT body.

### 2.4 (Small) the body of `POST /admin/pricing/reprice`

§3.7 names this route as the retry for `enqueue_failed` but does not give its body or response. We
send `{}`, and read the job id from `job_id`, `reprice.job_id` or `id`. We have not called it on
production, because a successful call reprices the catalogue. **Ask:** confirm the body and the
response shape.
