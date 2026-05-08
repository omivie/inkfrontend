# Retail wording rollout — May 2026 (supersedes dropship-wording-may2026.md)

**Status:** shipped
**Effective:** 2026-05-08
**Owner:** Vieland Walker
**Pinned by:** `tests/retail-wording-may2026.test.js` + `tests/legal-pages.test.js` §10

---

## Why this exists

The site was previously framed around an explicit dropship disclosure
("we don't hold stock — every order is dispatched directly by one of our
New Zealand wholesale supplier partners…"). In May 2026 we removed that
disclosure: the customer-facing site now reads as a normal NZ retailer.
Orders ship from New Zealand on the NZ Post and Aramex courier networks,
and the site does not name who physically holds or dispatches the
cartridge.

This is a deliberate business positioning change, not an accident or a
policy gap. The narrow lane the site has to stay inside is:

1. **No dropship admissions.** No "supplier partner", "wholesale
   supplier", "dispatched directly by", "supplier-direct", "we don't
   hold stock", "dropship*".
2. **No false warehouse claims.** No "warehouse", "our warehouse",
   "from our warehouse" — we operate from a small Auckland office and
   making a positive false claim of a warehouse would breach Fair
   Trading Act §13 and Google Ads Misrepresentation policy.
3. **Office stays.** "Office" / "Auckland office" is true and remains
   the only neutral location label.
4. **Address stays.** 37A Archibald Road, Kelston is still rendered on
   contact + about (Merchant Center + LocalBusiness JSON-LD requirement).

Removing a disclosure is not the same as making a false claim. The
forbidden-token list above keeps the site silent about fulfilment
mechanics rather than asserting an alternative model.

---

## What changed (compared to the May 2026 dropship contract)

| Surface                                      | Before (dropship)                                                                         | After (retail)                                                  |
|----------------------------------------------|--------------------------------------------------------------------------------------------|------------------------------------------------------------------|
| `about.html` hero meta                       | "dispatched directly by our New Zealand wholesale supplier partners"                       | "shipped from New Zealand on the NZ Post and Aramex courier networks" |
| `about.html` value card "100% NZ owned"      | "our supplier partners — all here in New Zealand"                                          | "our payments — all here in New Zealand"                         |
| `about.html` value card "Same-day dispatch"  | "our supplier partner has it picked, packed, and on a courier"                             | "your cartridge is on a courier that afternoon"                 |
| `about.html` §3 "How we work"                | Full dropship disclosure paragraph, link to `/shipping#dropship`                           | Neutral courier copy, link to `/shipping`                        |
| `shipping.html` lead                         | "dispatched by our New Zealand wholesale supplier partners on our behalf"                  | "what to expect once your order is on its way"                   |
| `shipping.html` §4 `#dropship` section       | Full supplier-direct dispatch explainer + transparency callout                             | **Section deleted.** §5–§10 renumbered to §4–§9.                 |
| `shipping.html` §5 "Mixed orders"            | "items held by more than one of our supplier partners"                                     | "Sometimes we'll split your order into more than one parcel…"   |
| `terms.html` §5 "Stock and availability"     | "We don't hold stock at our Auckland office — every order is dispatched directly by…"      | Lead-time disclosure only; link points at `/shipping` (no anchor) |
| `faq.html` "Where do orders ship from?"      | "Yes — we're upfront about it … one of our New Zealand wholesale supplier partners"        | "Every order ships from New Zealand on the NZ Post and Aramex networks" |
| `contact.html` OOS-restock footnote          | "our supplier partners usually have replenishment arriving within a few working days"      | "replenishment usually arrives within a few working days"        |
| `legal-config.js` `supplierFulfillment`      | Long disclosure string                                                                     | **Key removed.**                                                 |
| `legal-page.js` `'supplier-fulfillment'`     | Renderer binding                                                                            | **Binding removed.**                                             |
| `shipping.html` `<meta name="description">`  | "…how dropshipped items are handled transparently."                                         | "…what to expect after you place an order."                      |

Cache key on `footer.js` and `legal-config.js` bumped from
`?v=dropship-may2026` → `?v=retail-may2026` on all 22 footer-linked
pages so returning browsers fetch the new copy and don't render stale
"Office:" / supplier-fulfillment HTML from disk cache.

---

## Forbidden tokens (case-insensitive, anywhere customer-facing)

```
supplier partner | supplier-partner | supplier partners
wholesale supplier | wholesale suppliers
dropship | dropshipping | dropshipped | drop ship | drop-ship
don't hold stock | do not hold stock
dispatched directly by
supplier-direct | supplier direct
supplier-fulfilment | supplier fulfilment
warehouse
```

The full list lives in `tests/retail-wording-may2026.test.js` §1
(`FORBIDDEN_TOKENS`). The test scans every footer-linked HTML page plus
`footer.js`, `legal-config.js`, and `legal-page.js`.

If you need to add a new banned phrase, edit `FORBIDDEN_TOKENS` in the
test — the scan picks it up everywhere automatically.

---

## What the test pins

`tests/retail-wording-may2026.test.js` — 21 assertions:

1. §1 — Zero forbidden tokens on each of the 7 footer-linked pages
   (about, contact, faq, terms, privacy, returns, shipping).
2. §1 — Zero forbidden tokens in `footer.js`.
3. §1 — Zero forbidden tokens in `legal-config.js`.
4. §1 — Zero forbidden tokens in `legal-page.js`.
5. §2 — `LegalConfig.supplierFulfillment` is `undefined`.
6. §2 — `legal-page.js` does not declare a `supplier-fulfillment` binding.
7. §2 — No page renders `data-legal-bind="supplier-fulfillment"`.
8. §3 — `shipping.html` does not declare `id="dropship"`.
9. §3 — No page links to `/shipping#dropship`.
10. §4 — `footer.js` Contact column uses `<strong>Office:</strong>` (no
    bare `Address:`).
11. §4 — `about.html` hero meta uses `<strong>Office:</strong>`.
12. §4 — `contact.html` contact-card label is `Office`.
13. §4 — No page renders a bare `<strong>Address:</strong>` label.
14. §5 — Office address (37A Archibald Road, Kelston) still rendered on
    `contact.html` and `about.html`.
15. §5 — `LegalConfig.address.street === '37A Archibald Road'` and
    `address.suburb === 'Kelston'`.
16. §6 — Every footer-linked page loads `footer.js?v=retail-may2026`.
17. §6 — Every footer-linked page loads `legal-config.js?v=retail-may2026`.
18. §6 — Old `v=dropship-may2026` cache key is gone from every page.
19. §7 — `about.html` `#how-we-work` section still exists and mentions
    NZ Post / Aramex.
20. §7 — `shipping.html` lead still promises tracked courier + same-day
    dispatch.
21. §7 — `faq.html` still answers "Where do orders ship from?" and
    links to `/shipping`.

`tests/legal-pages.test.js` §10 keeps the warehouse/Office: pins for
defence-in-depth (those rules survive even if `retail-wording-may2026`
gets retired in a future rollout).

---

## How to add a new policy page or copy block

1. Add the new HTML page to `FOOTER_LINKED_PAGES` in
   `tests/retail-wording-may2026.test.js` if it's reachable from the
   site footer.
2. Make sure the page loads `footer.js?v=retail-may2026` and (if it
   needs `LegalConfig` bindings) `legal-config.js?v=retail-may2026`.
3. Read it. Search the new copy against the `FORBIDDEN_TOKENS` list.
4. Run `node --test tests/retail-wording-may2026.test.js`.

---

## Rollback

If the dropship disclosure ever needs to come back:

1. Restore `LegalConfig.supplierFulfillment` in `legal-config.js`.
2. Restore the `'supplier-fulfillment'` binding in `legal-page.js`.
3. Restore `shipping.html` `#dropship` section and the cross-links from
   `about.html` §3, `terms.html` §5, and `faq.html` "Where do orders
   ship from?".
4. Bump cache key: `retail-may2026` → `<new-tag>-may2026`.
5. Replace `tests/retail-wording-may2026.test.js` with the prior
   `tests/dropship-wording-may2026.test.js` contract (recoverable from
   git history).

---

## Related work

- `tests/legal-pages.test.js` §10 — warehouse-free pin (still active).
- `COMPLIANCE.md` §1, §3, §11 — updated to remove "dropship transparency"
  language and point at `retail-wording-may2026.test.js` §1 for the
  no-positive-false-claim assertion.
