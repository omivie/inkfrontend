# Compliance Map — InkCartridges.co.nz Legal & Info Pages

**Effective:** 2026-05-05 &middot; **Scope:** `/terms`, `/privacy`, `/returns`, `/shipping`, `/about`, `/faq`, `/contact`

This document maps every regulatory and platform requirement we built against
to the page and section that satisfies it. It exists to make a Google Ads
policy review, a Google Merchant Center review, or a NZ Commerce Commission
inquiry trivially short — every claim below is grounded in a specific section
of a specific page that you can open in your browser.

The tests in `tests/legal-pages.test.js` pin every load-bearing claim. If a
test fails, that compliance signal has been broken in code and must be
restored before merging.

---

## 1. Google Ads — "Misrepresentation" policy

[Policy reference: https://support.google.com/adspolicy/answer/6020955](https://support.google.com/adspolicy/answer/6020955)

Google Ads disapproves ads from advertisers who misrepresent themselves,
their products, or their business. To pass review consistently we needed to
satisfy four things:

| Requirement | Where it lives | Test |
| --- | --- | --- |
| **Identity is unambiguous** — physical address, phone, email, hours visible site-wide | Footer (`js/footer.js`); Contact `/contact`; Terms §1, §14; Privacy §1, §12; About §6 | `§1`, `§5` |
| **Pricing transparency** — no hidden fees, no card surcharges, GST inclusive | Terms §4 callout; Shipping §1 callout; Returns §1 callout; FAQ "Card surcharges" Q; Footer copyright line | `§3` |
| **Returns / refunds clearly described** before the user pays | Returns page §1–§10; cross-linked from Terms §7 and Shipping §9 | `§4` |
| **Shipping clearly described** including dropshipping transparency | Shipping page §1–§10, especially §4 (dropship disclosure) | `§3` |
| **Cross-linked policies in footer** | Footer Policies column + bottom legal nav strip | `§2` |

> **Why we render the legal nav twice in the footer.** Reviewers scan
> footers either as a column-of-columns (what shoppers see) or a
> single-line-policy strip (what compliance bots see). We render both, so the
> page passes both heuristics regardless of which the reviewer's tool uses.

### "No hidden fees" declaration

Required by Google Ads (Misrepresentation) and a soft signal for Google
Merchant Center (Free and Accurate Listings). The literal phrase appears on
**Terms**, **Returns**, and **Shipping** pages, plus the FAQ. The test
`§3 Terms, Returns, and Shipping each include a "No hidden fees" callout`
will fail if any of those is removed.

---

## 2. Google Merchant Center — Free and Accurate Listings

[Policy reference: https://support.google.com/merchants/answer/6149970](https://support.google.com/merchants/answer/6149970)

| Requirement | Where it lives | Test |
| --- | --- | --- |
| Contact information visible: physical address, phone, email | Contact `/contact` (top card); footer | `§5` |
| Working contact form | `contact.html` form with required fields, Cloudflare Turnstile, honeypot | `§5` |
| Map / physical-location verification | Contact `/contact` map embed (OpenStreetMap), About `/about` §6 | `§5` |
| Returns policy linked from product / checkout / footer | Footer (Policies column + legal nav strip) | `§2` |
| Shipping policy with carriers, transit times, rates | Shipping `/shipping` §2 zone table | `§3` |
| Currency and country consistent | NZD, NZ in `LegalConfig.currency` and `LegalConfig.address` | `§6` |

The map embed on `/contact` and `/about` uses OpenStreetMap (not Google
Maps), so we do not require a paid Maps API key and the user is not
tracked by a third party while viewing our policy pages. Google Merchant
Center accepts any clearly legible map of the business location.

---

## 3. New Zealand Fair Trading Act 1986 — "In trade" status

| Requirement | Where it lives | Test |
| --- | --- | --- |
| Explicit "in trade" declaration on the entity | Terms §1 callout: *"We sell in trade within the meaning of the Fair Trading Act 1986…"* | `§4` |
| No false, misleading, or deceptive representations | Compatible cartridges marked clearly (Terms §8, About §4, FAQ "Genuine vs compatible") | — |
| Disclosure of supplier-fulfilled items (avoiding "ships from NZ" misrepresentation when it doesn't) | Shipping §4 ("Items dispatched directly from our suppliers"), About §3 | — |

The test `§4 Terms page contains an explicit "In trade" declaration` fails
if the callout, the phrase "in trade", or the citation to the Fair Trading
Act 1986 is removed.

---

## 4. New Zealand Consumer Guarantees Act 1993

| Requirement | Where it lives | Test |
| --- | --- | --- |
| Statutory guarantees not contracted out for consumer purchases | Terms §1 (in-trade callout), Terms §11 (Liability) | `§4` |
| Major vs. minor failure remedy distinction | Returns §2 ("Major vs. minor failure") | `§4` |
| Faulty-goods rights NOT time-barred by the change-of-mind window | Returns §2 callout: *"No artificial time limit on CGA claims"* | `§4` |
| Open-cartridge / consumables handling — fault still covered, change-of-mind not | Returns §4 ("Opened, used, or unsealed cartridges") | `§4` |
| Wrong-item supply remedy (we pay return shipping) | Returns §5 | — |
| Business-to-business carve-out (CGA does not apply) | Terms §11, Returns §7 | — |

The two CGA tests that pin the load-bearing claims:
1. `§4 Returns page never time-bars CGA faulty-goods rights`
2. `§4 Returns page handles opened-cartridge case for consumables explicitly`

---

## 5. New Zealand Privacy Act 2020 (13 Information Privacy Principles)

| IPP | Page section |
| --- | --- |
| **IPP 1** Purpose of collection | Privacy §3 |
| **IPP 2** Collection direct from individual | Privacy §4 |
| **IPP 3** Notification at collection (this page itself satisfies IPP3) | Privacy §1–§3, §6 |
| **IPP 4** Manner of collection | Privacy §2 |
| **IPP 5** Storage and security | Privacy §7 |
| **IPP 6** Access | Privacy §9 |
| **IPP 7** Correction | Privacy §9 |
| **IPP 8** Accuracy | Privacy §9 (correction process) |
| **IPP 9** Retention | Privacy §8 |
| **IPP 10** Use limited to purpose | Privacy §3, §5 |
| **IPP 11** Disclosure | Privacy §5 (data-processors table) |
| **IPP 12** Cross-border disclosure | Privacy §5 (region column + closing paragraph) |
| **IPP 13** Unique identifiers | Privacy §4 |

### Other Privacy Act 2020 obligations

| Obligation | Where it lives |
| --- | --- |
| Designated Privacy Officer | Privacy §1, §12 — `LegalConfig.privacyOfficerName` / `LegalConfig.privacyOfficerEmail` |
| Notifiable privacy-breach pathway | Privacy §7 (final paragraph) |
| Right to complain to OPC | Privacy §9 (final paragraph, with phone number 0800 803 909 and link to privacy.org.nz) |
| Cookie disclosure | Privacy §6 (categories table) |
| Data-processor disclosure | Privacy §5 (table generated from `LegalConfig.dataProcessors`) |

The test `§4 Privacy page complies with Privacy Act 2020 IPP transparency
requirements` fails if any of the named anchors is removed.

---

## 6. Children — under-16 protection

Privacy §10 declares we do not knowingly collect personal information from
children under 16, and provides a parent/guardian deletion pathway. The
Privacy Act 2020 does not have a specific children's-data clause comparable
to GDPR Art. 8, but Google Ads policy (Personalised Advertising →
"Children") effectively requires this disclosure for any advertiser whose
audience may include minors.

---

## 7. Pages-and-sections matrix (quick reference)

| Page | URL | Sections | What it covers |
| --- | --- | --- | --- |
| Terms of Service | `/terms` | 14 | The contract; in-trade declaration; pricing transparency; CGA pointer; governing law |
| Privacy Policy | `/privacy` | 12 | Privacy Act 2020 IPPs; processor & cookie tables; access/correction/deletion |
| Refund & Return Policy | `/returns` | 10 | CGA-aligned faulty-goods rights; 30-day change-of-mind window; opened-cartridge consumables rule |
| Shipping & Delivery | `/shipping` | 10 | Carriers; zone-by-zone rates; handling vs. transit times; dropship transparency |
| About Us | `/about` | 7 | NZ-owned framing; values cards; how we work; map; policies hub |
| FAQ | `/faq` | 6 | Cartridge questions; orders/shipping; returns/warranty; account/privacy; business |
| Contact | `/contact` | – | Address card, map, phone, email, contact form (Turnstile + honeypot) |

---

## 8. Single source of truth — `js/legal-config.js`

Every business variable used across these pages — address, phone, email,
hours, free-shipping threshold, shipping zones, data processors, cookie
categories, payment methods, response SLA, policy effective date, version
stamp — lives in `inkcartridges/js/legal-config.js`. Pages reference values
through `data-legal-bind="key"` attributes and `js/legal-page.js` does the
substitution at DOMContentLoaded.

This means:

- **One place to update** when a fact changes (e.g. a new shipping carrier).
- **One place to bump** the policy effective date and version (the stamp on every page updates automatically).
- **One place to add** the GST number / NZBN if you elect to display them — leaving the strings empty hides the line entirely (we deliberately never render `GST: ` with no number).

The test `§6 legal-config.js exposes every binding key used by the pages`
walks every HTML page, collects every `data-legal-bind` key in use, and
fails if any key is referenced but not implemented in `legal-page.js`.

---

## 9. How to evolve this safely

When you change a policy:

1. **Edit only the section that's changing.** Each section is an `id`'d
   `<section class="policy-section">` so the TOC, anchors, and deep links
   stay stable.
2. **Bump `LegalConfig.policyEffectiveDate` and `LegalConfig.policyVersion`.**
   The "Last updated" stamp on every page reads from these.
3. **Run the test suite.** `node --test tests/legal-pages.test.js` should
   stay green.
4. **If you remove a citation or a load-bearing phrase** (e.g. "in trade",
   "Consumer Guarantees Act", "No hidden fees"), expect a test to fail —
   that's by design. Either the change is intentional (update the test in
   the same commit) or the change broke a compliance signal (revert).
5. **For material changes to Privacy, also email account holders.** This is
   an obligation under our own Privacy §11.

---

## 10. What is _not_ in scope of this document

- **Substantive product claims** (e.g. cartridge yield numbers) — those
  belong on individual product pages, not these legal/info pages.
- **Marketing copy** — landing-page hero claims should be reviewed
  separately by the same NZ Fair Trading Act standard.
- **Cookie consent banner** — the cookie disclosures in Privacy §6 are
  notice-based; if we ever add an analytics cookie that's _not_ strictly
  necessary, that's the moment a banner becomes mandatory.
- **PCI-DSS attestation** — we do not handle cardholder data directly.
  Stripe and PayPal each operate under their own PCI-DSS Level 1 scope, as
  documented in Privacy §5.

---

## 11. Related code

| File | Role |
| --- | --- |
| `inkcartridges/js/legal-config.js` | Single-source-of-truth for every business variable |
| `inkcartridges/js/legal-page.js` | Render-side bindings, TOC builder, FAQ telemetry, map embed |
| `inkcartridges/js/footer.js` | Cross-links every legal page from every other page |
| `inkcartridges/css/pages.css` | Legal/policy/info page styles (mobile-first, sticky TOC on desktop) |
| `inkcartridges/html/{terms,privacy,returns,shipping,about,faq,contact}.html` | The seven pages |
| `inkcartridges/vercel.json` | Clean URL rewrites + CSP allow-list for OSM map |
| `tests/legal-pages.test.js` | Pins every claim above to a runnable assertion |
