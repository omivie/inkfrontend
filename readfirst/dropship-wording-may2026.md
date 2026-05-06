# Dropship wording rollout — May 2026

**Status:** shipped
**Effective:** 2026-05-06
**Owner:** Vieland Walker
**Pinned by:** `tests/dropship-wording-may2026.test.js` + `tests/legal-pages.test.js` §10

---

## Why this exists

InkCartridges.co.nz operates from a **small Auckland office** at
37A Archibald Road, Kelston. We do **not** hold stock; every order is
picked, packed, and dispatched directly by one of our New Zealand
wholesale supplier partners through the same NZ Post / Aramex networks
any local retailer uses ("dropshipping").

Until May 2026, customer-facing copy told a different story:

- "from a warehouse in Kelston, Auckland" (about page hero)
- "Most stocked SKUs ship from our Auckland warehouse" (terms, FAQ,
  shipping)
- "drop empties off at the warehouse" (about page recycling section)
- `<strong>Address:</strong>` label on the footer + about hero meta

That copy mis-stated where stock physically sits and what the property
is. Beyond the trust cost, two compliance regimes care:

1. **Fair Trading Act 1986 §13** prohibits false or misleading
   representations about the place from which goods are supplied.
2. **Google Ads "Misrepresentation" policy** independently disqualifies
   ads whose landing pages mis-describe the seller's fulfilment model.

This rollout reframes the copy to the actual operation and pins it with
tests so the regression cannot be reintroduced.

## What changed

### Wording rules (now invariant)

| Old wording                                 | New wording                                              |
|---------------------------------------------|----------------------------------------------------------|
| `warehouse` (any case)                      | `office` (location), `supplier partner` (fulfilment)     |
| `Address:` label (footer + hero meta)       | `Office:`                                                |
| "Most SKUs ship from our Auckland warehouse"| "Every order is dispatched directly by one of our NZ wholesale supplier partners" |
| "drop empties off at the warehouse"         | "send empties back via pre-paid envelope, or call ahead to drop off at the office" |

### Files touched

| File | Change |
|------|--------|
| `inkcartridges/html/about.html`     | Hero copy, "Address:" → "Office:", values copy, §3 "How we work" rewrite, recycling drop-off rewrite, §6 retitled "Call or write" |
| `inkcartridges/html/shipping.html`  | Lead, §3 handling-time bullet, §4 "How orders are fulfilled — supplier-direct dispatch" rewrite, §5 split-shipment rewrite |
| `inkcartridges/html/terms.html`     | §1 "operating from an office at...", §5 stock paragraph rewritten |
| `inkcartridges/html/returns.html`   | §3 change-of-mind landing point, §9 returns-address blurb |
| `inkcartridges/html/faq.html`       | "Where do orders ship from? Do you dropship?" entry — full rewrite |
| `inkcartridges/html/contact.html`   | Contact card label `Address` → `Office`, walk-in hint, footnote, map aria |
| `inkcartridges/js/footer.js`        | Contact column `<strong>Address:</strong>` → `<strong>Office:</strong>` |
| `inkcartridges/js/legal-config.js`  | `supplierFulfillment` string rewritten warehouse-free |
| All seven legal/info HTML pages     | `?v=legal-may2026` → `?v=dropship-may2026` for `footer.js` and `legal-config.js` |
| `tests/legal-pages.test.js`         | New §10 with 6 assertions |
| `tests/dropship-wording-may2026.test.js` | New file, 15 assertions |

### Files NOT touched (and why)

- **JSON-LD `LocalBusiness` / `Organization` schema** in `index.html`,
  `html/index.html`, and `footer.js` keeps the street address. Schema
  doesn't claim "warehouse" anywhere; the office address is the legal
  business address and Google Merchant Center expects it.
- **`<noscript>` footer fallback** on every page keeps the address —
  it is just an address, no warehouse claim.
- **`legal-page.js`** — bindings are unchanged; only the strings
  rendered through them changed.
- **All 24 `account/*.html` pages and product / cart / checkout pages**
  — none of them carried warehouse copy or an `Address:` label.

## Invariants the test suite enforces

`tests/dropship-wording-may2026.test.js` (15 tests):

1. Zero `warehouse` tokens (case-insensitive) in any of:
   `about.html`, `contact.html`, `faq.html`, `terms.html`,
   `privacy.html`, `returns.html`, `shipping.html`.
2. Zero `warehouse` tokens in `footer.js`.
3. `LegalConfig.supplierFulfillment` string is warehouse-free and
   non-empty.
4. `footer.js` renders `<strong>Office:</strong>` and not
   `<strong>Address:</strong>`.
5. `about.html` renders `<strong>Office:</strong>` in the hero meta.
6. `contact.html` contact-card label is `Office`, not `Address`.
7. No policy/about page renders a bare `<strong>Address:</strong>`
   label.
8. `shipping.html#dropship` section exists, names the supplier-direct
   model, and renders the `data-legal-bind="supplier-fulfillment"`
   binding.
9. `shipping.html` keeps the "Dispatched by supplier" stock-block label.
10. `about.html#how-we-work` discloses the dropshipping model and
    names supplier partners.
11. `faq.html` includes the "Where do orders ship from? Do you
    dropship?" question and links to `/shipping#dropship`.
12. `contact.html` and `about.html` still render the office street
    address (37A Archibald Road, Kelston, Auckland 0602).
13. `LegalConfig.address.street` and `.suburb` are unchanged.
14. Every footer-linked page references `footer.js?v=dropship-may2026`.
15. Every footer-linked page references
    `legal-config.js?v=dropship-may2026`.

`tests/legal-pages.test.js` §10 (6 tests) — duplicated higher-level
coverage so a future engineer reading the canonical legal-pages test
file will hit the same guards.

## Adjacent edits to watch when changing this

- If you ever start holding stock at a real warehouse, do **not**
  monkey-patch the wording — bring the copy back through the policy
  pages with full redo and update both test files.
- The office geo coordinates in `LegalConfig.geo` (-36.9020, 174.6555)
  drive the OpenStreetMap embed on /about and /contact. The map is
  labelled "office" not "warehouse" — keep the aria-label aligned.
- `LegalConfig.supplierFulfillment` is rendered into `/shipping` via
  `data-legal-bind="supplier-fulfillment"`. If that binding is renamed
  in `legal-page.js`, update the §10 / §3 assertions accordingly.
- `vercel.json` / `serve.json` rewrites for the legal slugs are not
  affected by this rollout.
