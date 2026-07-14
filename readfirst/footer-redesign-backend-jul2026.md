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

## 2. Three backend follow-ups (parity / anti-cloaking)

The spec's own §"Locked copy" says these strings must be byte-identical on both sides and are
"checked for cloaking mismatch". Two of the three currently **aren't**. Verified against the live
crawler render: `curl -A Googlebot https://www.inkcartridges.co.nz/`.

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

---

## 3. Two corrections to the spec (no action needed)

**"Wire to your existing newsletter endpoint (`POST /api/newsletter/subscribe` — Turnstile-gated,
10/hr/IP)."** — The footer form is deliberately **Turnstile-free**. Your team made the token optional
in Jun 2026; the footer ships no widget host, so no token is ever sent, and
`tests/newsletter-subscribe-feedback-jun2026.test.js` pins that. The binder still *supports* a token
if a `[data-newsletter-turnstile]` host is ever added. Nothing to change — just don't re-gate the
endpoint without telling us, or every footer subscribe on the site starts 403ing.

**"Every nav link appears twice … Removed the duplicate row."** — Kept, on the owner's call. That row
(`.footer-legal-nav`) *is* a duplicate of the column grid, deliberately: it was dropped in the
2026-07-02 IA reorg, that loss went unnoticed, and it was restored on 2026-07-14 specifically so an
ads reviewer can reach every compliance surface in one glance. It stays.

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
