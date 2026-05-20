# Google Ads "Unacceptable Business Practices" remediation — May 2026

Pins the frontend half of the cloaking-mismatch fix that satisfies Google
Ads' "Business Transparency" + "Misrepresentation" checks. Backend handoff
that triggered the work: `frontend-google-ads-fixes.md` (delivered to the
backend dev, not in-repo). Mirrors backend `src/utils/trustSignals.js`.

The two halves MUST agree. Google fetches every URL twice — once as a bot
(sees the backend prerender), once as a real browser (sees the SPA-rendered
HTML). If the two disagree on any load-bearing fact — legal entity, NZBN,
GST, address, phone, support email, marketing claims, JSON-LD `brand.name`
on compatible products — the appeal is rejected as cloaking.

## Canonical business facts (single source of truth)

Updated in `inkcartridges/js/legal-config.js`. Mirrors the backend module
exactly. Every value below appears on every customer-facing page.

| Field                       | Value                                                   |
| --------------------------- | ------------------------------------------------------- |
| Legal entity                | `Office Consumables Ltd`                                |
| Trading name                | `InkCartridges.co.nz`                                   |
| NZBN                        | `9429033934204`                                         |
| GST number                  | `94-509-459` (dashes form, IRD canonical)               |
| Support email               | `support@inkcartridges.co.nz`                           |
| Phone (display)             | `027 474 0115`                                          |
| Phone (E.164)               | `+64274740115`                                          |
| Phone (schema.org)          | `+64-27-474-0115`                                       |
| Address                     | `37A Archibald Road, Kelston, Auckland 0602, NZ`        |
| Compatible warranty         | `12 months`                                             |
| Returns — faulty            | `30 days` (CGA still applies beyond)                    |
| Returns — change-of-mind    | `14 days`, unopened only                                |
| Dispatch cutoff             | `2pm NZT, Auckland metro, business days`                |
| Disambiguation sentence     | `InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).` |

## What changed (frontend rollout)

| Change                                              | Where                                                    |
| --------------------------------------------------- | -------------------------------------------------------- |
| `legalEntity` → Office Consumables Ltd              | `js/legal-config.js`                                     |
| `email` → `support@inkcartridges.co.nz`             | `js/legal-config.js` + 33 HTML/JS files bulk-rewritten   |
| `nzbn`, `gstNumber`, `compatibleWarrantyMonths`, `returnWindowDaysFaulty`, `returnWindowDaysChange`, `dispatchCutoffDisplay`, `disambiguationLine()`, `copyrightLine()` added | `js/legal-config.js` |
| New `[data-legal-bind]` keys: `disambiguation`, `nzbn`, `gst-number`, `copyright`, `return-window-faulty`, `return-window-change`, `compatible-warranty`, `dispatch-cutoff` | `js/legal-page.js` |
| Footer rebuilt: copyright names legal entity, disambiguation in `<small>`, Org/LocalBusiness JSON-LD carries `legalName` + `alternateName` + `email` + `taxID` + NZBN/GST `identifier[]` | `js/footer.js` |
| Static Org/WebSite/LocalBusiness JSON-LD on the homepage updated to match the post-hydration shape | `inkcartridges/index.html`, `html/index.html` |
| Static 404 footer rewritten with disambiguation + new copyright | `inkcartridges/404.html` |
| Noscript footer fallback rewritten across 31 pages: now reads "InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459). …" | every `html/*.html` |
| `/about` hero re-led with disambiguation line; new sections "What we stock", "Where we ship", "Business details" (NZBN/GST `<dl>`), "Consumer rights" | `html/about.html` |
| `/returns` snapshot now lists 30-day faulty + 14-day change-of-mind windows + 12-month compatible-warranty + returns address names Office Consumables Ltd | `html/returns.html` |
| `/contact`, `/privacy`, `/terms`, `/shipping`, `/faq` heroes carry the disambiguation `<small>` | `html/contact.html`, `privacy.html`, `terms.html`, `shipping.html`, `faq.html` |
| 2pm Auckland-metro dispatch cutoff (was unqualified 12pm) — replaces every "Same-day dispatch on orders placed before 12pm" with the qualified form | `legal-config.js` + `about.html` + `terms.html` + `shipping.html` + `faq.html` |
| FAQ "void warranty" rewritten to CGA-preservation: "Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected by your choice of cartridge." | `index.html`, `html/index.html`, `html/faq.html` (JSON-LD + HTML body) |
| `Lowest Price` comparative badge retired from card render | `js/products.js`, `js/shop-page.js`, `css/components.css`, `css/search.css` |
| "Quality Guaranteed" trust card → "Backed by NZ consumer law" | `index.html`, `html/index.html` |
| "exclusive deals/offers" + "we'll match it for you" rewritten to factual benefit copy | `html/order-confirmation.html`, `html/account/login.html`, `html/shop.html`, `html/ribbons.html` |
| Hero trust-row deduped (was "100% NZ Owned & Operated" twice) | `inkcartridges/index.html` |
| PDP `getCallToActionDescription` "Quality guaranteed" → factual CGA reference | `js/product-detail-page.js` |
| New CSS for `.about-business-details` dl + `.legal-page__disambiguation` + `.footer-brand__disambiguation` + `.footer-disambiguation` | `css/pages.css` |

## What was already compliant (NOT changed)

- Phone `027 474 0115` already canonical everywhere.
- Address `37A Archibald Rd, Kelston, Auckland 0602, NZ` already canonical.
- No countdown timers, "X viewing now" widgets, "Sarah from Auckland just
  bought" social proof, or exit-intent "Wait! Don't miss out" popups.
- OEM brand logos on the ink finder + brand chips render the OEM
  trademarked logo for navigational fair use. The doc flagged this as a
  risk; the call we made is that nominative fair use covers brand
  identification on a search tool, so long as no compatible product page
  shows the OEM logo as decorative imagery — and it doesn't (compatible
  cards render in our house typography). Re-visit if Google's appeal
  reviewer pushes back.
- Stock-urgency "Only N left" pill stays on PDP — gated to
  `source === 'genuine'` only, so compatibles never show urgency. The
  count is the actual backend stock value, not a fabricated pressure tactic.
- Client-side Product / Breadcrumb / FAQ JSON-LD emission stays deleted
  (was retired in `marketing-audit-may2026.md`). Backend prerender owns
  Product schema, so the `brand.name` = `Office Consumables Ltd`
  contract for compatibles is enforced server-side.

## Test coverage

- `tests/google-ads-compliance-may2026.test.js` (108 assertions):
  - Forbidden-copy sweep across 42 HTML + 9 JS + 3 CSS files (regex-based,
    strips JS/HTML comments first so guard prose doesn't false-positive).
  - LegalConfig facts.
  - footer.js disambiguation + JSON-LD shape.
  - legal-page.js bindings.
  - Homepage static JSON-LD `legalName`/`alternateName`/`identifier[]`.
  - Every legal-page hero carries `[data-legal-bind="disambiguation"]`.
  - `/about` has Business Details + Where We Ship + Consumer Rights.
  - `/returns` references the 14-day change-of-mind + 30-day faulty windows.
  - `Lowest Price` badge fully retired from card render.
  - PDP emits no client-side Product/FAQ schema.
  - Noscript footer fallback names Office Consumables Ltd on every page.
- `tests/legal-pages.test.js` updated: §5 contact uses
  `mailto:support@inkcartridges.co.nz`, §6 implemented-bindings list grew
  to include the 8 new keys.
- `tests/navbar-parity-may2026.test.js` updated: canonical site-header
  mailto matches the new support email.
- `tests/retail-wording-may2026.test.js` §7 updated: same-day dispatch
  must now be qualified to Auckland metro + 2pm.

Full suite: `node --test tests/*.test.js` — 1381 passing, 0 failing.

## Manual verification checklist (before re-submitting Google Ads appeal)

Run through this on the deployed SPA after Vercel auto-deploy completes
+ Cloudflare cache purge for `/`, `/shop`, `/brand/*`, `/products/*`,
`/ink-cartridges`, `/toner-cartridges`, `/ribbons`, `/about`, `/returns`,
`/contact`, `/privacy`, `/terms`, `/faq`, `/shipping`:

- [ ] `Ctrl+F` audit on homepage hero, brand pages, category pages, cart,
      checkout, About, Contact, Privacy, Terms for: `70%`, `save up to`,
      `lowest`, `guaranteed`, `hurry`, `limited time`, `exclusive`,
      `identical to genuine`, `won't void`, `2 Queen Street`, `09 813`,
      `inkandtoner@windowslive` — must return zero hits.
- [ ] SPA footer shows: "Office Consumables Ltd" + Kelston address +
      027 474 0115 + support@inkcartridges.co.nz + disambiguation line.
- [ ] `/about` resolves with the new Business Details `<dl>` visible.
- [ ] `/returns` shows 14-day change-of-mind + 30-day faulty side-by-side.
- [ ] `/contact`, `/privacy`, `/terms` show Kelston address + 027 phone
      (not Queen Street + 09 phone).
- [ ] No countdown timers, "X viewing now", or social-proof popups.
- [ ] Google Rich Results Test on the homepage Organization/LocalBusiness
      JSON-LD: `legalName`, `alternateName`, `email`, NZBN + GST
      `identifier[]` all parse cleanly.
- [ ] Google Rich Results Test on a compatible-product URL:
      `brand.name = Office Consumables Ltd`, OEM moved to
      `isCompatibleWith[].name`.
- [ ] Search Console "URL Inspection" on homepage + a brand page + a
      compatible product page: bot-rendered and user-rendered HTML
      contain the same business facts.
