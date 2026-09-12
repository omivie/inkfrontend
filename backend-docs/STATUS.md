# Backend correspondence — status index

Audited **2026-09-09**, re-audited **2026-09-12**. One row per document. `sent/` is evidence-backed; `outbox/` means
*no reply on record*, which is **not** the same as undelivered — see `README.md`.

Do not re-derive this audit. If you deliver something, move the file and change its row.

**A row records the OUTCOME, not just the location.** Where our document *disputes* the
incoming one it answers, the row says so — an "answered" row that hides a contradiction is
how someone ends up implementing a fix we already measured as a no-op.

**And it records the TENSE.** A row can go stale between being written and being read: the
code a dispute rests on gets fixed, and the dispute — still phrased in the present — outlives
the thing it disputed. A reader who then greps for the broken line finds nothing and concludes
the row was wrong, when it was simply *finished*. So date a claim, or write it in the past
tense and name the fix. This is not hypothetical: it happened to the one dispute recorded
below, within a day of it being filed.

---

## `sent/` — proven received (15)

The backend read these. Evidence is a backend-authored document that postdates ours and
either names it or cites a `BF-`/`ERR-` number that originates in it.

| Doc | Written | Evidence |
|---|---|---|
| `public-volume-pricing-backend-brief-aug2026.md` | 2026-08-08 | named in `public-volume-pricing-backend-response-aug2026.md` |
| `public-volume-pricing-FE-response-aug2026.md` | 2026-08-09 | named in `public-volume-pricing-backend-reply-round2-aug2026.md` |
| `catalogue-pathway-backend-brief-aug2026.md` | 2026-08-30 | named in `search-value-pack-ranking-backend-response-sep2026.md`; ERR-187 in `catalogue-pathway-FE-actions-aug2026.md` |
| `search-value-pack-ranking-backend-brief-sep2026.md` | 2026-09-06 | named + BF-057 in `search-value-pack-ranking-backend-response-sep2026.md` |
| `add-to-cart-tracking-FE-response-sep2026.md` | 2026-09-06 | BF-060 **originates here**; cited in `fe-verification-and-remaining-gaps-sep2026.md` (09-08) and `FE-open-items-checklist-sep2026.md` (09-09) |
| `data-tracking-capture-FE-response-aug2026.md` | 2026-09-01 | ERR-194 cited in both 09-08 and 09-09 incoming docs |
| `gst-basis-backend-brief-jul2026.md` | 2026-07-29 | **moderate only** — ERR-113 in `order-profit-net-of-discount-aug2026.md`; ERR-113 sits in the ambiguous-numbering range, so this is weaker than the six above |

### The 2026-09-09/10 batch — all eight proven received on 2026-09-12

`inbox/fe-verification-round-backend-response-sep2026.md` is the delivery record for
every one of these. It answers them **section by section**, cites their ERR numbers,
and ships code against them. Two of these rows previously read "never delivered";
they were wrong, and this is what that looked like from the inside — *no delivery
record exists ⇒ UNANSWERED, not undelivered.*

| Doc | Written | Evidence |
|---|---|---|
| `BACKEND-ASKS-INDEX-sep2026.md` | 2026-09-09 | its 🔴 item 0 (ERR-232) is answered at length in §1; item 1 (the mig-132 green light) in §2 |
| `printer-canonicals-backend-brief-sep2026.md` | 2026-09-09 | named in §3; our 15-pair table used **verbatim** as their curated map |
| `fe-backend-asks-sep2026.md` | 2026-09-09 | §7 answers BF-021; §8 answers the ERR-237 `?sid=` question |
| `analytics-dashboards-FE-response-sep2026.md` | 2026-09-03 | **the "evidence it was NOT read" row is superseded** — §4 concedes the 80-char truncation point and §5 ships all four asks |
| `security-hardening-round2-FE-response-sep2026.md` | 2026-09-09 | §1's ACL table and migration 173 answer it directly |
| `admin-only-test-product-backend-brief-sep2026.md` | 2026-09-09 | answered by `inbox/admin-only-test-product-FE-handoff-sep2026.md` (see ERR-246) |
| `supplier-freight-backend-brief-sep2026.md` | 2026-09-09 | answered by `inbox/supplier-freight-backend-response-sep2026.md` + `inbox/supplier-freight-FE-handoff-sep2026.md`, both 2026-09-10. **All three asks delivered.** Implemented 2026-09-12 (ERR-255); replied in `outbox/supplier-freight-FE-response-sep2026.md`, which **declines their §6** |
| `mobile-ux-and-remaining-gaps-FE-response-sep2026.md` | 2026-09-09 | delivered with the batch; **its dispute stands unaddressed** — see below |

**Still disputed, and NOT resolved by their reply.** Our mobile-UX response
contradicted two of the three fixes in `inbox/fe-verification-and-remaining-gaps-sep2026.md`.
The verification round does not mention it. The dispute is therefore still open
and the inbox document still must not be implemented as written — the reasoning
is in the note further down this file, in the past tense, naming the code that
replaced it (ERR-235).

---

## 📬 ANSWERED — the 2026-09-10 round came back (2026-09-12)

**The seven "never delivered" documents below were read.** Three backend documents arrived on
2026-09-10 and are now in `inbox/`:

| Incoming | Answers | Our reply |
|---|---|---|
| `fe-backend-asks-action-list-sep2026.md` | the six FE asks, as an action list | `outbox/fe-backend-asks-action-list-FE-response-sep2026.md` |
| `fe-backend-asks-backend-response-sep2026.md` | the full reasoning behind the action list | (same reply — it is one round) |
| `fe-verification-round-backend-response-sep2026.md` | printer canonicals, analytics, ERR-232 | (same reply, plus ERR-247/249) |

**⚠️ THE TWO INCOMING DOCUMENTS CONTRADICT EACH OTHER, AND THE WRONG ONE LOOKS SAFE.**
`fe-verification-round-backend-response-sep2026.md` §6 says *"You can drop your client-side
mapping whenever suits"* for `/api/products/popular`. `fe-backend-asks-action-list-sep2026.md`
§4 says the opposite and is right: `consumable` is now **accepted** and resolves to **no
filter**, so dropping the map puts ink and toner on a drums shelf with a 200 and no error.
Measured 2026-09-12 by reading `product_type` on the returned rows. The action list is the
later document and supersedes. **Do not implement §6 of the verification-round document.**

Three further statements in the incoming round did not survive measurement, and the reply
carries all three with their evidence: the detail read-back path is `data.order.delivery_type`
and not `data.delivery_type`; the search rate limits are per endpoint (30/30/120/120) and not
one 30/min limiter across the prefix; and `delivery_type` being *live* is not it being
*populated* (null on 166 of 167).

---

## `outbox/` — written, no reply on record (33)

### ⏳ Never delivered — written after the last incoming doc (2)

The 2026-09-09/10 batch that used to sit here was **all delivered and answered** —
those eight rows moved to `sent/` on 2026-09-12. What remains is the reply to the
document that proved it.

| Doc | Carries |
|---|---|
| `fe-verification-round-FE-response-sep2026.md` | answers `inbox/fe-verification-round-backend-response-sep2026.md` section by section. Accepts their §1 ask (the dashboard is off the analytics RPCs entirely), **declines half of §6 with the measurement**, and carries two 🔴 items of our own: the migration-132 fallout in our admin (ours, not theirs) and **BF-062** — no admin route can write a machine list, while the product PUT answers 200 for the field and discards it |
| `supplier-freight-FE-response-sep2026.md` | answers BOTH 2026-09-10 supplier-freight documents. **Confirms their whole model** and re-measures it (the `shipping_absorbed` ⊆ `supplier_freight` containment, 115 order-samples, 0 counter-examples). **DECLINES their §6** — the Stripe-fee ÷1.15 reconciles to the cent but proves what the backend does, not what Stripe charges; the owner ruled to check a real payout first, so the ~$0.48/order divergence is documented rather than closed. Carries **two data asks**: one order where THEIR goods cost is the more complete one (ours understates a live column), and one where `goods_cost_ex_gst` is `0` on a populated line — harmless on `always_billed`, a wrong billing decision the day it lands on Augmento. **§8 addendum 2026-09-12** (commit `0e9ab7a`): the two AGGREGATE surfaces — the P&L had no freight row at all, so $502.64 sat between Opex and Net and the table did not foot to its own bottom line — plus a re-run at 60 orders (`58 (0 estimated)`), which found a SECOND instance of the empty-`suppliers[]` case, and one piece of feedback: `supplier_freight` and `supplier_freight_incl_gst` differ by 15% and only by a suffix |

**Read this before touching `/api/products/popular` mappings.** Their §6 invites us
to drop the client-side category map. `consumable` means **"Drums & Supplies"** to
us and **"all consumable types"** to them; taking the invitation swaps the shelf
contents with a 200 and no error anywhere. Measured 2026-09-12. The map stays.

**Disputed, and still unresolved as of 2026-09-12** — `sent/mobile-ux-and-remaining-gaps-FE-response-sep2026.md`
contradicted two of the three fixes `inbox/fe-verification-and-remaining-gaps-sep2026.md`
proposes. It was delivered with the 09-09/10 batch and the backend's verification round
does not mention it, so the dispute stands. Do not implement that inbox document as written:

- Its `<input value="urban" checked>` **would have been a no-op when it was written** — at that
  point `init()` un-checked every `delivery_type` radio on load (`forEach(r => r.checked = false)`),
  to defeat autofill, so the attribute was true in the file and false in the browser. **A source
  grep would have certified it as shipped.** Fixed since, by ERR-235, and not by adding the
  attribute: `_normaliseDeliveryType()` (`checkout-page.js:778`) sets the default in the one place
  that also owns the clearing. Grepping for `r.checked = false` today finds nothing — *that is the
  fix, not a contradiction*.
- Its stated failure mechanism **does not exist**: the checkout form carries `novalidate`
  (`checkout.html:97`) and `reportValidity()` is called nowhere in `checkout-page.js`, so there is
  no HTML5 validation bubble to be rendered off-screen. The observation ("nothing visibly happens")
  is right, the cause is not — a custom gate runs instead, and it is visible.

Verified in this repo on 2026-09-09 and re-verified 2026-09-10, not taken from the response
document. The response document was itself re-tensed in `e9d1ddc` after the first of these two
claims went stale between its writing and its filing — it now carries the past tense and points
at the code that exists.

### No reply on record (27)

Available to the backend in this repo; nothing on record says they read it. **Every one of
these still held at least one open ask when audited** — verified against live code for the
three oldest, spot-checked for the rest.

| Doc | Written | Note |
|---|---|---|
| `orders-supplier-origin-backend-brief.md` | 2026-07-24 | **still live**: `suppliers[]` shipped, `origin` did not — `sourcing.js:18` still renders the em-dash fallback |
| `page-copy-editor-backend-brief.md` | 2026-07-27 | **still live**: endpoint 404s; `page-copy.js:926` still shows "Publishing is not available" |
| `catalog-edge-caching-backend-brief-jul2026.md` | 2026-07-28 | **still live**: BF-011…BF-020, none marked resolved |
| `related-products-backend-brief-jul2026.md` | 2026-07-30 | BF-027, BF-028 |
| `order-hard-purge-contract-jul2026.md` | 2026-07-30 | BF-010 resolved; **BF-024 still open** |
| `ribbon-compat-search-FE-response-jul2026.md` | 2026-07-30 | BF-019 |
| `business-account-volume-pricing-FE-response-jul2026.md` | 2026-07-31 | |
| `business-centre-FE-response-aug2026.md` | 2026-08-03 | §1 declared blocked on the backend |
| `tri-colour-catalogue-BACKEND-tasks-aug2026.md` | 2026-08-03 | §3 is eleven data defects addressed to the backend CLI agent |
| `ribbon-typeahead-FE-response-aug2026.md` | 2026-08-04 | BF-031 + three July asks |
| `business-one-click-upgrade-FE-response-aug2026.md` | 2026-08-09 | **BF-021** — `PATCH` missing from CORS, re-raised ever since |
| `public-volume-pricing-FE-response-round2-aug2026.md` | 2026-08-12 | BF-014, BF-019, BF-039, BF-040 |
| `maintenance-box-FE-response-aug2026.md` | 2026-08-14 | BF-041, BF-042 |
| `invoice-quote-shipping-volume-discount-FE-response-aug2026.md` | 2026-08-17 | BF-043 |
| `order-profit-net-of-discount-FE-response-aug2026.md` | 2026-08-17 | BF-044 |
| `catalogue-pathway-FE-response-aug2026.md` | 2026-08-31 | asks for `catalogue-pathway-backend-response-aug2026.md`, never delivered |
| `supplier-price-comparison-FE-response-aug2026.md` | 2026-08-31 | §5 blocks a feature the backend asked for |
| `lookalike-duplicate-rows-FE-response-sep2026.md` | 2026-09-01 | |
| `order-number-format-change-FE-response-sep2026.md` | 2026-09-01 | |
| `ribbon-brand-pages-FE-response-aug2026.md` | 2026-09-01 | |
| `orders-invoice-sent-column-FE-response-sep2026.md` | 2026-09-01 | |
| `shipping-information-FE-response-sep2026.md` | 2026-09-01 | |
| `security-hardening-FE-response-sep2026.md` | 2026-09-03 | |
| `orders-tracking-requested-column-FE-response-sep2026.md` | 2026-09-09 | pinned by `tests/orders-tracking-requested-column-sep2026.test.js` |
| `admin-products-fallback-FE-response-sep2026.md` | 2026-09-06 | BF-044 phase 2 |
| `business-account-contract-pricing-FE-response-sep2026.md` | 2026-09-06 | |
| `lexmark-chip-grouping-FE-response-sep2026.md` | 2026-09-06 | |
| `order-pathway-3-step-backend-brief-sep2026.md` | 2026-09-06 | ERR-213 — the stepper labels live on the backend |
| `search-value-pack-ranking-FE-response-sep2026.md` | 2026-09-07 | answers their response; one action declined with the measurement |

---

## `inbox/` — from the backend (7)

| Doc | Note |
|---|---|
| `order-profit-net-of-discount-aug2026.md` | backend-authored (`**From:** backend`), was sitting at the repo root; **byte-identical** to the `~/Downloads` copy |
| `fe-verification-and-remaining-gaps-sep2026.md` | 2026-09-08. **Two of its three fixes are disputed** — see the outbox note above before implementing any of it |
| `FE-open-items-checklist-sep2026.md` | 2026-09-09. Answered by `outbox/printer-canonicals-backend-brief-sep2026.md`; four of its nine items were already shipped when it was written |
| `admin-only-test-product-FE-handoff-sep2026.md` | 2026-09-09. Answers `outbox/admin-only-test-product-backend-brief-sep2026.md`. A **design reply, not a delivery** — nothing in it had shipped when it was filed, verified 2026-09-12. Answered by `outbox/admin-only-test-product-FE-response-sep2026.md`; **its §2 recommendation was declined on a measurement** |
| `security-hardening-sep2026-round2-FE-handoff.md` | 2026-09-08. Answered by `sent/security-hardening-round2-FE-response-sep2026.md`. **This is the document that proves the backend dev can read this repo** — it cites `tests/security-hardening-sep2026.test.js:234` |
| `fe-verification-round-backend-response-sep2026.md` | 2026-09-10. **The delivery record for the whole 09-09/10 batch** — answers eight of our documents section by section. Ships their §1–§7; holds the `authenticated` grant (migration 172) and asks us never to apply it. Answered by `outbox/fe-verification-round-FE-response-sep2026.md`. Six of its seven sections were verified against production and hold; the two corrections are recorded there |

| `supplier-freight-FE-handoff-sep2026.md` | 2026-09-10. The wiring checklist for `supplier_freight`. **Its §1 is the load-bearing part** — delete the FE estimator BEFORE reading the new field, because running both double-charges. Implemented 2026-09-12 (ERR-255). **Its §6 was declined**; everything else shipped |
| `supplier-freight-backend-response-sep2026.md` | 2026-09-10. The reasoning and measurements behind the checklist above, and the delivery record for `sent/supplier-freight-backend-brief-sep2026.md`. **Every measurable claim in it was re-verified against the live API and held** — the `delivery_type_basis` and `supplier_basis` spreads reproduce exactly. Two corrections are in our reply: its §2 envelope sample shows the wrong `supplier_basis` for `2026090902`, and its §6 reconciliation proves what the BACKEND does, not what Stripe charges |

The historical inbox is `readfirst/` at the repo root — frozen, test-pinned, not moved.

---

## Deliberately left at the repo root

| File | Why |
|---|---|
| `errors.md` | pinned by `tests/err-numbering-jul2026.test.js:38` |
| `ADMIN_CENTRE_AUDIT.md` | internal documentation, not correspondence |
