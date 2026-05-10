# Legal-content CMS — May 2026

Admin-editable text for every footer-linked policy / info page (`/about`,
`/terms`, `/privacy`, `/returns`, `/shipping`, `/faq`, `/contact`) plus the
single-source-of-truth "Site Facts" used by `legal-config.js` (trading
name, address, phone, email, hours, free-shipping threshold, policy
effective date, etc).

Owner role only. No backend repo changes — overrides live in a Supabase
table read directly from the storefront with the public anon key.

---

## 1. Storage — Supabase table

Table `public.legal_content_overrides` holds one row per editable string.
Run this once in Supabase Studio → SQL Editor (the admin page surfaces
the same SQL inline if the table is missing, mirroring the `site_lock`
setup pattern):

```sql
CREATE TABLE IF NOT EXISTS public.legal_content_overrides (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  UUID REFERENCES auth.users(id)
);

ALTER TABLE public.legal_content_overrides ENABLE ROW LEVEL SECURITY;

-- Public read (this is what the storefront fetches with the anon key).
CREATE POLICY "Public read legal_content_overrides"
  ON public.legal_content_overrides FOR SELECT USING (true);

-- Authenticated write — same pattern as site_settings. Backend
-- verifyAdmin still gates the admin UI, so only owners ever reach
-- the write path through the page.
CREATE POLICY "Authenticated write legal_content_overrides"
  ON public.legal_content_overrides FOR ALL USING (auth.uid() IS NOT NULL);

CREATE INDEX IF NOT EXISTS legal_content_overrides_updated_at_idx
  ON public.legal_content_overrides (updated_at DESC);
```

Storefront reads the whole table once on legal-page load (it's tiny —
one row per overridden field). 5-second timeout, fail-open: if the
fetch errors, the page renders the default HTML untouched. Never
blocks render.

---

## 2. Override-key format

Three namespaces, all in the same table:

| Key shape                             | Replaces                                         |
|---------------------------------------|--------------------------------------------------|
| `<page>.hero`                         | `innerHTML` of the page hero block               |
| `<page>.section.<sectionId>`          | `innerHTML` of `.policy-section[id="<id>"]`      |
| `site_facts.<configKey>`              | A single `LegalConfig` value (string / number)   |

`<page>` is the slug from `<link rel="canonical">`: `about`, `terms`,
`privacy`, `returns`, `shipping`, `faq`, `contact`.

`<sectionId>` is the existing `id` already on every `.policy-section`
(e.g., `story`, `values`, `who-we-are`, `pricing`). The id is the join
key — never rename a section id without first updating its override key.

The hero block matched by selector union: `.legal-page__hero,
.about-hero, .contact-page__header`. Pages have exactly one.

`site_facts.<configKey>` mutates `window.LegalConfig` before
`applyBindings()` runs — that's how facts cascade to every
`data-legal-bind` placeholder across all seven pages and the footer.

Recognised `configKey` values:

```
tradingName, legalEntity, gstNumber, nzbn,
phoneDisplay, phoneE164, email,
hoursDisplay, responseSLA,
freeShippingThreshold, policyEffectiveDate, policyVersion,
address.street, address.suburb, address.city, address.postcode, address.country,
privacyOfficerName, privacyOfficerEmail
```

`address.*` is a dotted child path; the override loader sets it through
`LegalConfig.address[field]`.

---

## 3. Storefront wiring — `inkcartridges/js/legal-page.js`

Adds `fetchOverrides()` and an apply-pass before the existing init
sequence. Order is load-bearing:

1. **Detect page slug** from `<link rel="canonical">`.
2. **Fetch overrides** from Supabase (`apikey + Authorization: anon`).
3. **Apply `site_facts.*`** to `LegalConfig` (in-memory mutation only).
4. **Apply `<page>.hero`** by replacing hero `innerHTML`.
5. **Apply `<page>.section.<id>`** by replacing each `.policy-section[id]`'s
   `innerHTML`.
6. Existing `applyBindings()` — runs *after* HTML overrides so any new
   `data-legal-bind` placeholders inside the override HTML still resolve.
7. Existing `buildTOC()` — already reflects updated h2 text.
8. Existing `wireFAQ()`.

If Supabase is unreachable, the apply pass is skipped — the rendered
HTML stays as authored. The page's compliance contract (CGA, Privacy
Act, no-card-surcharges, etc.) is unaffected because the static HTML
already satisfies it. Overrides are additive.

The fetch is unconditional on every page load (no caching) so a
content edit becomes visible site-wide on the next visitor's hit.

---

## 4. Admin UI — `inkcartridges/js/admin/pages/legal-content.js`

Owner-only page at `#legal-content`. Eight tabs across the top:

| Tab          | What it edits                                                       |
|--------------|---------------------------------------------------------------------|
| About        | `about.hero` + `about.section.<id>` for each section in /about      |
| Terms        | `terms.hero` + `terms.section.<id>` for each section in /terms      |
| Privacy      | `privacy.hero` + `privacy.section.<id>` …                           |
| Returns      | `returns.hero` + `returns.section.<id>` …                           |
| Shipping     | `shipping.hero` + `shipping.section.<id>` …                         |
| FAQ          | `faq.hero` + `faq.section.<id>` …                                   |
| Contact      | `contact.hero` (the `/contact` page only renders a single block)    |
| Site Facts   | One input per `LegalConfig` field — no HTML, just plain values      |

For each editable block:

- **Default preview** — fetched once per tab open from the live HTML
  (`fetch('/about')` etc), parsed with `DOMParser`, the matching
  hero/section's `innerHTML` extracted and shown collapsed.
- **Override editor** — a HTML-aware textarea (monospace, source mode).
  Empty means "no override; use default". Saving writes the row.
- **Reset** — deletes the row. The default reappears.
- **Open page** — opens the live URL in a new tab so the editor can
  diff the result against the rendered output.

Save flow uses Supabase `upsert(..., { onConflict: 'key' })` — same
pattern used by `site-lock.js`.

Site Facts tab is a flat form: trading name, legal entity, GST number,
NZBN, address (5 lines), phone (display + E.164), email, hours, response
SLA, free-shipping threshold, policy effective date (ISO), policy
version, privacy officer name + email. Each field is a plain `<input>`
with the current default rendered inline.

---

## 5. Admin nav

Added to `NAV_ITEMS` in `js/admin/app.js` as `{ key: 'legal-content',
label: 'Legal Content', icon: 'invoice', ownerOnly: true }`. Added to
the owner-only allowlist inside `navigate()`.

---

## 6. Tests

`tests/legal-content-cms.test.js` pins the contract:

- Admin nav exposes the `legal-content` route.
- Page module exists, exports `default { title, init, destroy }`.
- `legal-page.js` exposes the override-fetch entrypoint and applies
  overrides before `applyBindings()` / `buildTOC()`.
- Override key shape is documented exactly.
- Public-read RLS policy is documented in this spec (so anyone re-running
  the migration grants the right policies).
- Migration SQL block is present in this spec.

Run with: `node --test tests/legal-content-cms.test.js`.

---

## 7. Migration / rollback

- **Forward**: run §1 SQL once in Supabase Studio. Existing storefront
  pages keep rendering their static HTML until a row is written.
- **Rollback**: `DROP TABLE public.legal_content_overrides;` — pages
  fall back to default HTML automatically.
- **Bypass**: an empty table is identical to "no overrides" — no flag
  flip needed.
