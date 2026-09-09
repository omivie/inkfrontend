# Backend correspondence — status index

Audited **2026-09-09**. One row per document. `sent/` is evidence-backed; `outbox/` means
*no reply on record*, which is **not** the same as undelivered — see `README.md`.

Do not re-derive this audit. If you deliver something, move the file and change its row.

**A row records the OUTCOME, not just the location.** Where our document *disputes* the
incoming one it answers, the row says so — an "answered" row that hides a contradiction is
how someone ends up implementing a fix we already measured as a no-op.

---

## `sent/` — proven received (7)

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

---

## `outbox/` — written, no reply on record (36)

### ⏳ Never delivered — written 2026-09-09, after the last incoming doc (6)

These are the **live open asks**. `BACKEND-ASKS-INDEX-sep2026.md` is the cover note for
the batch, and it is the only written record of the 🔴 admin-analytics-RPC outage (ERR-232).
**Send these before anything else here is touched.**

| Doc | Carries |
|---|---|
| `BACKEND-ASKS-INDEX-sep2026.md` | the index over the batch + ERR-232, the live 403 outage |
| `fe-backend-asks-sep2026.md` | ERR-235/236/237 asks; BF-021 re-raised |
| `supplier-freight-backend-brief-sep2026.md` | ERR-241 |
| `admin-only-test-product-backend-brief-sep2026.md` | ERR-234 — carries a sequencing constraint |
| `printer-canonicals-backend-brief-sep2026.md` | ERR-242/243, and the migration-132 green light |
| `security-hardening-round2-FE-response-sep2026.md` | answers `security-hardening-sep2026-round2-FE-handoff.md` |
| `mobile-ux-and-remaining-gaps-FE-response-sep2026.md` | ERR-238/239/240 — answers `inbox/fe-verification-and-remaining-gaps-sep2026.md`, **partly disputing it**: see below |

**Disputed, not merely answered** — `mobile-ux-and-remaining-gaps-FE-response-sep2026.md`
contradicts two of the three fixes `fe-verification-and-remaining-gaps-sep2026.md` proposes.
Do not implement that inbox document as written:

- Its `<input value="urban" checked>` **would have been a no-op when it was written** — the
  page's own init un-checked every `delivery_type` radio on load (`forEach(r => r.checked = false)`),
  so the attribute was true in the file and false in the browser. Fixed since, by ERR-235:
  `_normaliseDeliveryType()` (`checkout-page.js:778`) now checks urban itself, and its comment
  records the line it replaced. **Present tense matters here** — the critique is of the proposed
  fix at the time, not of today's code.
- Its stated failure mechanism **does not exist**: the checkout form carries `novalidate`
  (`checkout.html:97`), so there is no HTML5 validation bubble to be rendered off-screen.

Verified in this repo on 2026-09-09, not taken from the response document.

### No reply on record (30)

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
| `analytics-dashboards-FE-response-sep2026.md` | 2026-09-03 | **evidence it was NOT read**: the 09-09 checklist still asks us to raise a click truncation this doc reported closed at 200 on 09-03 |
| `security-hardening-FE-response-sep2026.md` | 2026-09-03 | |
| `orders-tracking-requested-column-FE-response-sep2026.md` | 2026-09-09 | pinned by `tests/orders-tracking-requested-column-sep2026.test.js` |
| `admin-products-fallback-FE-response-sep2026.md` | 2026-09-06 | BF-044 phase 2 |
| `business-account-contract-pricing-FE-response-sep2026.md` | 2026-09-06 | |
| `lexmark-chip-grouping-FE-response-sep2026.md` | 2026-09-06 | |
| `order-pathway-3-step-backend-brief-sep2026.md` | 2026-09-06 | ERR-213 — the stepper labels live on the backend |
| `search-value-pack-ranking-FE-response-sep2026.md` | 2026-09-07 | answers their response; one action declined with the measurement |

---

## `inbox/` — from the backend (1)

| Doc | Note |
|---|---|
| `order-profit-net-of-discount-aug2026.md` | backend-authored (`**From:** backend`), was sitting at the repo root; **byte-identical** to the `~/Downloads` copy |
| `fe-verification-and-remaining-gaps-sep2026.md` | 2026-09-08. **Two of its three fixes are disputed** — see the outbox note above before implementing any of it |
| `FE-open-items-checklist-sep2026.md` | 2026-09-09. Answered by `outbox/printer-canonicals-backend-brief-sep2026.md`; four of its nine items were already shipped when it was written |
| `security-hardening-sep2026-round2-FE-handoff.md` | 2026-09-08. Answered by `outbox/security-hardening-round2-FE-response-sep2026.md`. **This is the document that proves the backend dev can read this repo** — it cites `tests/security-hardening-sep2026.test.js:234` |

The historical inbox is `readfirst/` at the repo root — frozen, test-pinned, not moved.

---

## Deliberately left at the repo root

| File | Why |
|---|---|
| `errors.md` | pinned by `tests/err-numbering-jul2026.test.js:38` |
| `ADMIN_CENTRE_AUDIT.md` | internal documentation, not correspondence |
