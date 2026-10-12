# Same-day dispatch cutoff moves from 2pm to 12pm NZT — backend ask (ERR-319)

**From:** frontend · **Date:** 2026-10-12 · **Owner decision:** Auckland metro orders placed before **12pm (12:00) NZT** on a business day ship the same day. Before this change the cutoff was 2pm.

## What the FE changed (static copy only)

All static copy and FE fallbacks now say 12pm: /terms, /shipping (handling time and the cut-offs section), /faq (including the FAQPage JSON-LD), /about, /business, `legal-config.js` (`handlingTime`, `dispatchCutoffDisplay`), and the PDP fallback `SPEC_DELIVERY_CUTOFF = '12pm'`.

## What still says 2pm — these values come from the API

Measured 2026-10-12: `GET /api/site/trust` returns `"dispatch_cutoff_nzt":"14:00"` and `"label":"Dispatched same day in Auckland metro (order by 2pm)"`.

The FE renders these values exactly as the API sends them. Until the backend changes them, live pages contradict the policy pages.

| Field | Where FE shows it | Needs to become |
|---|---|---|
| `dispatch_cutoff_nzt` (`/api/site/trust`, `delivery_estimate`, `shipping_promise`) | service row, SEO meta descriptions | `"12:00"` |
| `dispatch_cutoff_human` (`delivery_estimate`) | PDP "Order before … NZT for same-day dispatch" | `"12pm"` |
| `shipping_promise.label` ("Same-day dispatch before 2pm") and the trust label "Dispatched same day in Auckland metro (order by 2pm)" | wherever it is surfaced | 12pm wording |
| `delivery_estimate.promise` ("…placed before 14:00 NZT…") | PDP dispatch clause | 12:00 wording |
| `cutoff_remaining_seconds`, `same_day_eligible` | PDP and cart dispatch countdown | computed against 12:00 NZT |
| `/api/prerender/*` meta descriptions ("Auckland metro orders by 2pm NZT dispatch same day.") | `<meta name="description">` on home, /shop, series pages and /ribbons. `SeoMeta.reconcile()` copies it, and Google's snippet uses it | 12pm |
| Cart `delivery_estimate.promise` ("Order by 2pm for same-day dispatch (Auckland metro) — 1–3 business days NZ-wide") | /cart summary, owner screenshot 2026-10-13 | 12pm |
| `trust_signals` label "Dispatched same day in Auckland metro (order by 2pm)" | /cart trust badges | 12pm |
| Any email or order-confirmation template that quotes the cutoff | emails | 12pm |

**The countdown matters most.** Until `cutoff_remaining_seconds` and `same_day_eligible` are computed against 12:00, shoppers between 12:00 and 14:00 see "same-day dispatch" counting down to a cutoff that has already passed.

## FE side verified (2026-10-13, Playwright against the local working tree)

- With live API responses: the only 2pm text left on 21 pages comes from the API. It appears in the prerender meta descriptions, the PDP delivery line (`dispatch_cutoff_human`), the PDP service row, and the countdown. Static pages (/shipping, /terms, /faq, /about, /business) render 12pm.
- With API responses rewritten in the browser (14:00 to 12:00, 2pm to 12pm, `cutoff_remaining_seconds` minus 7200), the same pages show **0** instances of 2pm, and the PDP reads "Order before 12pm NZT…". **Once you ship, nothing else is needed on the FE.**
- Countdown measured at about 01:50 NZT on 10-13: `cutoff_remaining_seconds` = 43803, which gives a 14:00 deadline.
- The /cart signals were not exercised: that needs a cart add, which writes a guest session. The cart code renders the API strings verbatim (`cart.js` `renderCartSignals`).

## Outside both repos

The owner must also update the Google Merchant Center shipping handling-time cutoff to 12:00. If Merchant Center and the site disagree, that is a Misrepresentation risk.

Please reply with a deploy time, so we can re-measure `/api/site/trust` and a PDP `delivery_estimate`.
