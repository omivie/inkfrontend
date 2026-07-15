# Footer redesign — FE response + backend follow-ups (Jul 2026)

Response to `footer-redesign-jul2026.md`. **The redesign is built and shipped.** Five zones, the
locked copy, the trust strip, the uniform payment chips, the responsive breakpoints — all as specced.

This file covers only the places where the spec and reality disagreed, and the three things that now
need a backend change. Nothing here blocks the FE work; it's all parity cleanup.

---

## 1. The mockup was never handed over

`footer-redesign.html` is referenced in §"Interactive mockup" but wasn't in the handoff. Built from
the spec's token table, copy tables and breakpoints instead. If the mockup differs from what's now
live, send it and we'll reconcile — but the spec was complete enough that I doubt it does.

---

## 2. Four backend follow-ups (parity / anti-cloaking)

The spec's own §"Locked copy" says these strings must be byte-identical on both sides and are
"checked for cloaking mismatch". Two of the three currently **aren't**. Verified against the live
crawler render: `curl -A Googlebot https://www.inkcartridges.co.nz/`.

**All four re-verified against the live prerender on 2026-07-14 (after the footer redesign shipped).
None are fixed yet.**

### 2a. The legal-entity line is missing its second half on the backend

The spec locks this string:

> InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).
> **Prices in NZD, GST inclusive. No card surcharges.**

The FE renders exactly that. `buildFooter()` in `prerender.js` renders only the first sentence — the
bolded half is absent from the bot render. The "no card surcharges" claim is Google Ads compliance
copy (a reviewer scans the footer for it before opening any policy page), so the bot should see it too.

**Ask:** append `Prices in NZD, GST inclusive. No card surcharges.` to the prerender's `<small>` line.

### 2b. The address is abbreviated differently

- Backend prerender: `37A Archibald **Rd**, Kelston, Auckland 0602, New Zealand`
- FE + `legal-config.js` + Organization JSON-LD: `37A Archibald **Road**, …`

Minor, but it's a NAP (name/address/phone) consistency signal and it's free to fix.

**Ask:** `Rd` → `Road` in the prerender footer.

### 2c. The bot footer still advertises a category humans can't see

The crawler footer has a `<nav aria-label="Shop by category">` with **Ink Cartridges · Toner
Cartridges · Drum Units · Printer Ribbons**. Until today the human footer had *no* category links at
all — bots saw four links humans didn't, which is the wrong side of a cloaking review to be standing on.

The redesign closes most of that: the new **Shop** column ships static links to `/ink-cartridges`,
`/toner-cartridges` and `/ribbons`. **`Drum Units` (`/shop?category=drums`) is still bot-only.**

**Ask — pick one:** either drop Drum Units from the prerender footer, or tell us and we'll add it to
the Shop column. Either is fine; the two footers just need to agree.

> **✅ RESOLVED 2026-07-15 (FE).** Per the owner's call to keep Drum Units in the bot footer, the FE
> added **`Drum Units` → `/shop?category=drums`** to the human Shop column (`js/footer.js`), between
> Toner Cartridges and Printer Ribbons. Both footers now list the same four categories in the same
> order: **Ink Cartridges · Toner Cartridges · Drum Units · Printer Ribbons**. The static-link approach
> stays within the owner's rule (feed-hydrated category column still banned; `footer.js` never fetches).
> Pinned by `tests/footer-redesign-jul2026.test.js` §3 (Drum Units parity test + the Shop-column
> order pin). Verified live against the rendered footer. **No backend action** — the bot footer is
> already correct.

### 2d. The bot footer omits FAQ and Shipping — and `/faq` is not linked from the bot homepage at all

Found 2026-07-14 while re-verifying the above. The prerender's `<nav aria-label="Footer links">`
carries six links — About · Contact Us · Returns Policy · Privacy Policy · Terms & Conditions ·
Genuine vs Compatible. The human footer's Help column also carries **Shipping & Delivery** and
**FAQ**. So:

- `/shipping` appears on the bot homepage only inside a body sentence ("see our shipping page"),
  never in the footer nav.
- **`/faq` appears nowhere in the bot homepage — zero occurrences.**

This is the *safe* direction of divergence (humans see more than bots, not less — it isn't cloaking),
so nothing is on fire. But `/faq` carries our `FAQPage` structured data for rich results, and it has
no internal link in the crawler render to be discovered from. That's a self-inflicted SEO loss.

**Ask:** add `/faq` and `/shipping` to the prerender's footer-links nav, so the bot footer carries
the same eight policy surfaces the human footer does.

**Note on the human side:** we deleted the duplicate single-line legal row from the SPA footer today
(§3 below). That removed **no links** — all eight still render, in the Help + Company columns. The bot
footer was already missing two of them before that change; the two facts are unrelated.

---

## 3. Two corrections to the spec (no action needed)

**"Wire to your existing newsletter endpoint (`POST /api/newsletter/subscribe` — Turnstile-gated,
10/hr/IP)."** — The footer form is deliberately **Turnstile-free**. Your team made the token optional
in Jun 2026; the footer ships no widget host, so no token is ever sent, and
`tests/newsletter-subscribe-feedback-jun2026.test.js` pins that. The binder still *supports* a token
if a `[data-newsletter-turnstile]` host is ever added. Nothing to change — just don't re-gate the
endpoint without telling us, or every footer subscribe on the site starts 403ing.

**"Every nav link appears twice … Removed the duplicate row."** — The spec was right, and the row is
now gone (2026-07-14, owner's call, reversing the same-day decision to keep it). Sequence: the row
(`.footer-legal-nav`) was dropped in the 2026-07-02 IA reorg, that loss went unnoticed, it was
restored on 2026-07-14 for at-a-glance ads review, then removed again once we confirmed the thing it
was protecting is already satisfied without it — all eight of its hrefs (`/terms`, `/privacy`,
`/returns`, `/shipping`, `/genuine-vs-compatible`, `/about`, `/faq`, `/contact`) sit in the Help +
Company columns, one click from any page's footer.

The compliance invariant is **"every policy surface is reachable from the footer"**, not "there is a
legal row" — the columns are now its sole carrier, and the tests assert the full eight against the
column grid. Drop a link from a column and it is gone outright; there is no second row to catch it.

---

## 4. Two FE bugs the redesign surfaced and fixed (FYI)

- **`LegalConfig` was never actually loaded before the footer read it.** `footer.js` built its
  business-facts object at script-evaluation time, but `legal-config.js` was tagged *after* it, and
  both are `defer` (document order) — so `LegalConfig` was `undefined` on every page and the footer
  silently rendered its baked-in fallback constants. The "single source of truth mirrors backend
  `trustSignals.js`" contract was fiction. Now built lazily at mount, and `legal-config.js` loads
  before `footer.js` on all 34 pages. (Values were identical, so nothing was visibly wrong — which is
  exactly why it survived two months.)
- **Root `404.html` had a hand-written copy of the footer** and never loaded `footer.js`. It had
  drifted: no legal nav, and **no trademark/CGA disclaimer at all** — the page a lost visitor lands
  on was the least compliant page on the site. It now renders the shared footer like everything else,
  and a test hashes the static `<footer>` block across all 34 pages so a second copy can't exist again.
