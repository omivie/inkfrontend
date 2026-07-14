# Backend: legal-content CMS retirement — frontend DONE; two items back to you

**Status:** frontend **complete + deployed** · **Raised:** 2026-07-14 · **Re:** your `FE-followup-legal-cms-removal-jul2026.md`
**Backend action required:** (1) drop the table when convenient, (2) **confirm or correct one claim in your handoff before anyone acts on it**
**Storefront tickets:** ERR-065 (root cause) → **ERR-069** (retirement)
**Commits:** `d2cefdf` (retirement), `3e64439` (docs)

---

## 1. Your acceptance check passes

The command from your handoff, run against the deployed file:

```bash
curl -s "https://www.inkcartridges.co.nz/js/legal-page.js?cb=$(date +%s)" \
  | grep -Eic "legal_content_overrides|fetchOverrides|getSupabaseConfig"
```

```
→ 0        (was 7)
```

Note it prints `0` including **comments** — `legal-page.js` no longer even *names* the mechanism,
so your grep stays a clean signal rather than tripping on documentation about the thing it's
checking for. There is a CI test that runs this exact grep and fails the build if it ever returns
non-zero again.

**You are clear to `DROP TABLE public.legal_content_overrides` whenever you like.** Nothing in the
frontend reads it, writes it, or carries its DDL. No coordination needed — just drop it.

---

## 2. We removed more than you asked for, deliberately

Your handoff asked for one thing: strip the override **read** path out of `legal-page.js`. That
would have been an incomplete retirement, and the incomplete version is worse than the bug.

`inkcartridges/js/admin/pages/legal-content.js` — 881 lines, mounted at **Settings → Legal
Content** — was still doing this:

```js
const { error } = await sb.from('legal_content_overrides').upsert({ key, value, ... });
...
flashStatus(status, 'Saved. Live on next page-load.');
```

That sentence has **never** been true (that's ERR-065), and once the reader is deleted it can never
*become* true. Shipping only the reader-removal would have left the owner with a live admin screen
that writes into a table you're about to drop and reports success — i.e. it would have preserved
the exact silent-vanish trap the retirement exists to eliminate, and left a write path into a
dropped table (which, once you drop it, starts throwing 42P01 at the owner instead).

So all four corners went together:

| Corner | What was removed |
|---|---|
| **Reader** | the override fetch/apply path in `js/legal-page.js` |
| **Writer** | `js/admin/pages/legal-content.js` + its Settings tab (`settings.js`) |
| **Route** | the `#legal-content` → `?tab=legal` redirect (see note below) |
| **Spec** | the inline `CREATE TABLE legal_content_overrides` DDL, and stale doc/comment references |

**The invariant we now test is stronger than "that table is unreachable":** `legal-page.js`
performs **zero network I/O of any kind** — no `fetch(`, no `XMLHttpRequest`, no Supabase, no
dynamic `import()`, and no bare-variable `.innerHTML` assignment. It renders vetted static HTML and
binds facts from `legal-config.js`. Nothing else. That's the property that actually prevents
cloaking; "we deleted one URL" is not.

**One thing we kept on purpose:** the legacy `#legal-content` admin hash still redirects — but now
to the bare `settings` hub rather than the deleted `?tab=legal`. Deleting the route outright would
have given an old bookmark an "Error Loading Page" screen. Verified: `#legal-content` → `#settings`,
no error.

**And one thing we did NOT delete, on purpose:** `LegalConfig.BANNED_CLAIM_PATTERNS` stays. The CMS
override guard was only *one* of its consumers; the compliance source sweep
(`google-ads-compliance-may2026.test.js`, `genuine-vs-compatible-warranty.test.js`) still imports
it. Removing it as "CMS collateral" would have silently disarmed the banned-copy sweep — which is
precisely the ERR-063 failure mode wearing a cleanup costume. The runtime guard `rejectIfBanned()`
*is* gone, because with no override path there is nothing left to screen. A removed mechanism beats
a guarded one.

---

## 3. ⚠️ ACTION: please confirm or correct your footer claim

This is the one item that needs a decision from you, and it is the reason we did **not** implement
your "optional nicety".

**Your handoff said:**

> The **rendered footer** shows the legal entity + NZBN + GST, which is sufficient identification.
> The backend's own footer line additionally includes **NZ Company Number 1853414**; if you want
> byte-parity you could add it to the SPA footer line too.

**We checked before acting. That does not match what is being served.** Fetched under a Googlebot
UA on 2026-07-14:

```bash
for p in terms about privacy returns; do
  echo -n "/$p → "
  curl -s -A "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" \
    "https://www.inkcartridges.co.nz/$p" | grep -c "NZ Company Number"
done
```

| Page | `"NZ Company Number"` occurrences in the served **footer** |
|---|---|
| `/terms` | **0** |
| `/about` | **0** |
| `/privacy` | **0** |
| `/returns` | **0** |

The footer line actually served on every page is:

```
InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).
```

— no company number. The **only** occurrence of "NZ Company Number" anywhere in the bot-served
bytes is inside the **`/terms` body**, which is our own static HTML (`terms.html`, already carrying
`data-legal-bind="company-number"`).

**Why we stopped rather than "just adding it".** The whole point of this workstream is that bot
copy must equal browser copy. If your footer does *not* ship the company number and we add it to
ours, we would be **creating** the divergence we're trying to eliminate — a self-inflicted cloaking
signal, mid-appeal, in the single most compliance-sensitive sentence on the site. It also isn't a
one-line change on our side: `disambiguationLine()` in `legal-config.js` is the single source for
that sentence, and it fans out into `footer.js`'s fallback string, **33 hardcoded `<noscript>`
footers**, `404.html` (twice), and 4 compliance test pins. That is not a change to make on an
unverified premise.

**What we need from you — pick one:**

- **(a) Your footer genuinely does ship it** → tell us the **exact string**, byte for byte, and we
  will change `disambiguationLine()` + all 34 fallback copies to match it in one coordinated
  commit. Do not change your side until we've deployed, or the divergence exists in the window
  between.
- **(b) It doesn't** (which is what the bytes say) → then there is nothing to fix. Both sides
  already agree, entity + NZBN + GST is sufficient identification for Business Transparency, and
  the company number is on `/terms` where the registration detail belongs. We recommend this: the
  cheapest correct state is the one we're already in.

---

## 4. What is now guaranteed on the frontend

`tests/legal-cms-retired-jul2026.test.js` (21 tests) replaces the old 25-test
`legal-content-cms.test.js`, which asserted the CMS *existed*. The new file asserts the inverse,
plus the half we kept:

- **§1** — `legal-page.js` contains **zero** trace of `legal_content_overrides`, `fetchOverrides`,
  `getSupabaseConfig`, `applyOverrides`, `LegalContent`, `siteFactsApply`, `pageContentApply`,
  `rejectIfBanned`, `violatesBannedClaims`, `detectPageSlug` — and your grep returns 0.
- **§2** — the file performs no network I/O and never assigns a bare variable to `.innerHTML`.
- **§3** — the admin editor module, its Settings tab, and its route are gone.
- **§4** — a **tree-wide sweep** (never a hand-maintained allowlist — that's the ERR-063 lesson)
  proves nothing shipped to users mentions the table.
- **§5** — the **kept** half still works: every `data-legal-bind` key used in the HTML is still
  implemented, TOC/FAQ/binder survive, and `BANNED_CLAIM_PATTERNS` is intact.

Suite: **2146 tests, 0 fail.**

**Verified in the rendered DOM, not by curl.** Your acceptance grep can't see SPA-injected copy —
AdsBot executes JavaScript, which is the whole reason ERR-065 hid for so long. So we drove all 8
legal pages in headless Chromium **against production**:

- zero requests to `legal_content_overrides`
- `window.LegalContent` is `undefined`
- all 8–22 `data-legal-bind` values per page still resolve (entity, NZBN, GST, company number,
  address, hours, return window, map)
- TOC builds, FAQ accordions toggle, policy copy intact, no uncaught exceptions

A useful artefact fell out of this: rendering the **pre-retirement** commit showed
`window.LegalContent` present while making **zero** requests to the overrides table — direct
runtime confirmation of the ERR-065 `const Config` ≠ `window.Config` diagnosis. The CMS surface
existed; the fetch never fired. Your 5 purged rows had never rendered for a single visitor.

---

## 5. Still open on your side (unrelated to this file)

- **Canon `CL` truncation (ERR-061)** — the `series_codes` extractor caps bare `CL` at two digits
  (`CL511` + `CL513` → `CL51`), so `PG510/CL511` chips ship only their black half. Frontend is
  self-disablingly mitigated and needs no coordination to deploy, but the durable fix is yours.
  Full repro in `readfirst/canon-cl-truncation-backend-jul2026.md`.

---

## Summary

| Item | Owner | Status |
|---|---|---|
| Strip CMS read path from `legal-page.js` | FE | ✅ done, deployed, grep = 0 |
| Delete CMS write path (admin editor + tab + route) | FE | ✅ done (not in your handoff — see §2) |
| Regression test so it can't come back | FE | ✅ `legal-cms-retired-jul2026.test.js` |
| `DROP TABLE legal_content_overrides` | **BE** | 🟡 clear to proceed, no coordination needed |
| **Confirm whether your footer ships "NZ Company Number"** | **BE** | 🔴 **needs your answer — see §3** |
| Canon `CL` truncation (ERR-061) | **BE** | 🔴 open |
