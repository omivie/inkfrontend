# Backend brief — open items as of 2026-07-14

One consolidated ask list, written for whoever picks up the backend next. Everything in §1 and §2
was **verified against the live API / prerender on 2026-07-14** — the commands are included so you
can re-run them rather than take my word for it. §3 is what I could confirm you've already fixed.
§4 is carried forward from older handoffs and is explicitly **not** re-verified.

Frontend is deployed and green (2185 tests, 0 fail). Nothing below blocks us; it's all parity and
correctness on your side.

---

## 1. ⚠️ ONE commit, one sentence: the prerender footer line

**Three separate asks all edit the same sentence** in `buildFooter()` (`src/routes/prerender.js`),
which mirrors `disambiguationLine()` in `src/utils/trustSignals.js`. Please land them together —
a half-change puts the two footers further apart than they are now.

The line you serve today, on every page:

```
InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).
```

The line the **frontend** renders today, on every page:

```
InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459). Prices in NZD, GST inclusive. No card surcharges.
```

### 1a. You're missing the second sentence

Your own footer-redesign spec locks this string under "⚠️ Locked copy — do NOT reword", and says it
is "checked for cloaking mismatch". The bolded half is absent from your render:

> InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).
> **Prices in NZD, GST inclusive. No card surcharges.**

"No card surcharges" is Google Ads compliance copy — a reviewer scans the footer for it before
opening any policy page — so the bot render should carry it too.

**Ask:** append `Prices in NZD, GST inclusive. No card surcharges.` to the prerender's `<small>` line.

### 1b. The address is abbreviated differently

- You serve: `37A Archibald **Rd**, Kelston, Auckland 0602, New Zealand`
- We serve (and our Organization JSON-LD carries): `37A Archibald **Road**, …`

Minor, but it's a NAP consistency signal and it's free.

**Ask:** `Rd` → `Road`.

### 1c. Still unanswered from the legal-CMS handoff: the NZ Company Number

Your CMS-retirement handoff said your footer line "additionally includes NZ Company Number 1853414"
and suggested we add it for byte-parity. **The served bytes say otherwise** — zero occurrences in
the footer of any page:

```bash
for p in terms about privacy returns; do
  echo -n "/$p → "
  curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1)" \
    "https://www.inkcartridges.co.nz/$p" | grep -c "NZ Company Number"
done
# → 0 0 0 0
```

We did **not** act on it, deliberately: if your footer doesn't ship the number and we add it to ours,
we *create* the divergence we're trying to remove — in the single most compliance-sensitive sentence
on the site, mid-appeal.

**Ask — pick one:**
- **(a) You do ship it** → give us the exact string, byte for byte. We'll change
  `disambiguationLine()` and all 34 fallback copies in one coordinated commit. Don't deploy your side
  until we've deployed ours, or the divergence exists in the gap.
- **(b) You don't** (what the bytes say) → nothing to do. Entity + NZBN + GST is sufficient for
  Business Transparency, and the company number lives on `/terms` where registration detail belongs.
  **We recommend this**: the cheapest correct state is the one we're already in.

### 🔔 Heads-up before you touch that sentence

The frontend now pins your exact string byte-for-byte in a `BACKEND_MIRROR` block
(`tests/footer-redesign-jul2026.test.js` §2). **If you reword it without telling us, our test suite
goes red.** That alarm is intentional — it's how we catch a cloaking mismatch before Google does —
but it's much nicer as a heads-up than as a surprise. Tell us the new string and we'll land both
sides in the same release.

---

## 2. The bot footer advertises a category humans can't see

Your crawler footer has `<nav aria-label="Shop by category">` with **Ink Cartridges · Toner
Cartridges · Drum Units · Printer Ribbons**. Until this week our human footer had *no* category links
at all, so bots saw four links humans didn't — the wrong side of a cloaking review to be standing on.

The footer redesign closes three of the four: the new **Shop** column ships static links to
`/ink-cartridges`, `/toner-cartridges`, `/ribbons`.

**`Drum Units` (`/shop?category=drums`) is still bot-only.**

**Ask — pick one:** drop it from your prerender footer, or tell us and we'll add it to the Shop
column. Either is fine. The two footers just need to agree.

```bash
curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1)" https://www.inkcartridges.co.nz/ \
  | sed -n '/<footer/,/<\/footer>/p'
```

---

## 3. ✅ Verified fixed — close these out

**Canon `CL` truncation (ERR-061)** — the `series_codes` extractor no longer caps bare `CL` codes at
two digits. Verified today; every code survives at full length and no truncated `CL51` exists anywhere:

```bash
curl -s 'https://ink-backend-zaeq.onrender.com/api/products?search=CL511&limit=3'
# → CCL511CLR  series_codes: ["CL511"]      (was ["CL51"])
# → GCL511     series_codes: ["CL511"]
# CL513, CL41, CL38 all likewise intact.
```

Our frontend repair (`_finalizeShopData` in `api.js`) was built to be self-disabling precisely so
your fix needed no coordination — it should now be inert. We'll retire it in a cleanup pass.
`readfirst/canon-cl-truncation-backend-jul2026.md` can be archived.

**Category canonicals** — the old "prerender canonical → `/ink` 404" flag is resolved. `/ink` and
`/toner` now canonicalise to `/ink-cartridges` and `/toner-cartridges`, both 200, correct
self-canonicals. All four of the footer's Shop routes render clean for Googlebot.

---

## 4. Carried forward — logged, but NOT re-verified today

Listed for completeness only. Do not treat these as confirmed-still-broken; check before acting.

- **Merchant Center feed** — 746/3006 items flagged. This is the feed, not our markup.
- **Zero-item shadow orders** (P0 as logged) — an invoice materialised with no line items nulls all
  profit downstream. Your fallback resolver reportedly repaired the affected shadow orders; the
  invoice records themselves still hold the bad codes and are being fixed owner-side. We've since
  closed the hole at our end: invoice/quick-order line codes are now validated against real
  `products.sku` at the save choke point, so a typed non-SKU can no longer be persisted.
- **Invoice `last_emailed_at`** — we render a "Sent" indicator off a server field that isn't
  populated yet.
- **Broken-links audit endpoint** — the admin Control Center "Links" tab is built and waiting on it.
- **Implausible page-yields (ERR-057)** — ~3 ribbon yields plus ~43 others.

---

## 5. Two corrections to the footer-redesign spec (no action needed)

**"`POST /api/newsletter/subscribe` — Turnstile-gated, 10/hr/IP."** — Not true of the footer form,
by design. Your team made the token optional in Jun 2026; the footer ships no widget host, so no
token is ever sent, and a test pins that. The binder still *supports* a token if a
`[data-newsletter-turnstile]` host is added. Nothing to change — but **don't re-gate the endpoint
without telling us**, or every footer subscribe on the site starts failing.

**"The mockup is committed alongside this doc — see `footer-redesign.html`."** — It wasn't in the
handoff. We built from the spec's token/copy/breakpoint tables, which were complete enough. If the
mockup differs from what's now live, send it and we'll reconcile.

---

## Summary

| # | Ask | Effort |
|---|---|---|
| 1a | Append "Prices in NZD, GST inclusive. No card surcharges." to the prerender footer | one line |
| 1b | `Archibald Rd` → `Archibald Road` | one word |
| 1c | Confirm or retract the "NZ Company Number in the footer" claim | a yes/no |
| 2 | Drum Units: drop from the bot footer, or tell us to add it | a decision |

1a/1b/1c are the same sentence — **one commit**, and tell us the final string before you deploy.
