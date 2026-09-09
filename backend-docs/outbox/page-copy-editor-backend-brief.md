# Backend brief — Page Copy editor (`/api/admin/page-copy`)

**Audience:** backend dev + backend CLI Claude (the `ink-backend-zaeq` service).
**Frontend status:** LIVE and usable without you. The admin Page Copy screen
(`#page-copy`, owner-only) already loads the seven content pages, edits them, runs every
guard, renders a diff and a live preview. What it *cannot* do until you ship this brief is
commit. Today it probes your endpoint, gets a 404, and says so in those words —
**"Publishing is not available"** — then offers *Copy diff* / *Download modified file*
instead. It never claims to have saved anything it did not save.

**Repo this writes to:** `github.com/omivie/inkfrontend`, branch `main`.
Vercel auto-deploys `main`; PR branches get preview deployments.

---

## 0. Read this part before anything else

This feature exists because the **previous** attempt at editable site copy was deleted
(ERR-065 → ERR-069, 14 Jul 2026). That version stored copy in a Supabase overrides table
which `js/legal-page.js` read and injected **at render time**. Two consequences, both
fatal:

*(The table's name is deliberately not written anywhere in this brief. It is swept for
across the whole frontend tree by `tests/legal-cms-retired-jul2026.test.js` §4, and a name
in a spec is a name somebody re-creates. There is no table in this design.)*

1. The HTML the server sent and the DOM a browser ended up with were different documents.
   On `/terms` and `/about` that is **cloaking** — the exact charge under appeal with
   Google Ads. AdsBot executes JavaScript, so a `curl`-based check could not even see it.
2. It silently did nothing. `js/config.js` declares `const Config`, which — unlike `var` —
   is not a property of `window`, so the reader's config lookup always returned `null`.
   Five authored rows never rendered, while the editor kept reporting
   *"Saved. Live on next page-load."*

**The design rule that follows, and that this endpoint must not break:**

> The only artifact is the file in git. There is no copy table, no runtime read, no
> render-time injection. An edit rewrites `inkcartridges/html/<doc>.html`, Vercel
> rebuilds, and bots, humans and compliance greps all receive identical bytes.

If a future change to this endpoint would introduce a second place copy can live, that
change is wrong regardless of how convenient it is. `tests/legal-cms-retired-jul2026.test.js`
(21 assertions) and `tests/page-copy-editor-jul2026.test.js` (40) both enforce this from
the frontend side; there is no equivalent guard in your repo, so it rests on you.

---

## 1. Endpoints

All three are **owner-only** and must enforce that server-side. `requireOwner()` in
`inkcartridges/js/admin/auth.js` is a UI convenience — treat any request reaching you as
potentially hand-crafted. Use the same role source as `GET /api/admin/verify`; accept only
`superadmin` and `owner`, not `admin`.

These are the **highest-privilege routes in the service.** Everything else the admin can do
corrupts data that can be restored. This writes to the repository that builds the
production website.

### 1.1 `GET /api/admin/page-copy/:doc`

Read the current file off `main` through the GitHub Contents API — not from a cache, and
not from the deployed site.

`:doc` ∈ `about | terms | privacy | returns | shipping | faq | genuine-vs-compatible`.
Reject anything else with 400. Never interpolate `:doc` into a path without that check.

```jsonc
// 200
{ "ok": true, "data": {
    "path": "inkcartridges/html/returns.html",
    "blobSha": "e3f1c0…",      // the file blob sha; the client returns it on save
    "html": "<!DOCTYPE html>…"  // complete file, UTF-8, unmodified
}}
```

`blobSha` is what makes a save conditional (§3). If you cannot supply it, say so with a
500 — do not return `null` and let the write proceed unguarded.

### 1.2 `POST /api/admin/page-copy/:doc`

```jsonc
// request
{
  "blobSha": "e3f1c0…",              // from the GET; MUST match current main
  "summary": "Clarify change-of-mind wording",   // ≤120 chars, goes in the commit message
  "regions": [
    { "sectionId": "change-of-mind", "blocks": [ /* block model — §4 */ ] }
  ]
}
```

Steps, in this order. Do not reorder — the sha check must precede the guards so a stale
edit is rejected before it is evaluated against the wrong baseline.

1. Verify the caller is `superadmin`/`owner`.
2. Validate `:doc` against the allowlist.
3. Re-read the blob from `main`. **If its sha ≠ `blobSha`, return 409** (§3).
4. Parse the current file, and for each region: confirm the manifest marks it `editable`,
   parse the existing section, and run **every guard in §5** against `{before, after}`.
   Any failure → 422 with the error list. Do not partially apply.
5. Splice each region into the file (§4). Everything outside the named sections must be
   byte-identical.
6. Commit to a new branch `page-copy/<doc>-<unix-ts>`.
7. Open a PR against `main`.
8. Return the PR number, its URL, and the Vercel preview URL if you can resolve it.

```jsonc
// 201
{ "ok": true, "data": {
    "prNumber": 412,
    "prUrl": "https://github.com/omivie/inkfrontend/pull/412",
    "previewUrl": "https://inkfrontend-git-page-copy-returns-…vercel.app/returns",
    "commitSha": "9ab3…"
}}
```

`previewUrl` is optional — omit the key if the deployment is not ready yet; the UI simply
shows the PR link on its own. **Do not fabricate a URL.**

Commit message shape:

```
Page copy: <summary>

Sections: change-of-mind
Edited by: <supabase user id> <email>
via admin Page Copy editor
```

### 1.3 `POST /api/admin/page-copy/:doc/publish`

```jsonc
// request
{ "prNumber": 412 }
// 200
{ "ok": true, "data": { "merged": true, "sha": "…" } }
```

Merge the PR (squash). Verify the PR was opened by this service, targets `main`, and
touches **only** `inkcartridges/html/<doc>.html` — refuse anything else with 409. That
check is what stops this route being turned into a general-purpose merge button.

---

## 2. Credential

Use a **GitHub App installation token**, scoped to `omivie/inkfrontend` only, with
`contents: write` and `pull_requests: write`. Not a personal access token: App tokens are
short-lived, revocable per-installation, and not tied to a human account that might leave.

Never return the token, the App private key, or the installation id in any response, log
line or error message. A 500 from the GitHub client must be reported to the client as a
generic failure with a request id, not as the upstream body.

---

## 3. Concurrency — the 409 path

A developer with the repo checked out and the owner in the editor will eventually write to
the same file. The `blobSha` precondition turns silent clobbering into a visible conflict.

Return **409** whenever the current blob sha differs from the submitted one. The frontend
already handles this specifically: it closes the dialog and shows *"Someone else changed
this file — your edits were not saved… reload and re-apply."* Do not soften a 409 into a
200-with-warning; the whole point is that the write did not happen.

---

## 4. The block model and the splice

The frontend sends **blocks**, not HTML, so you never concatenate attacker-controlled
markup into a page. Port the two frontend modules — they are dependency-free ES modules
that already run under `node --test`:

- `inkcartridges/js/admin/utils/page-copy-model.js` — parser, serializer, splicer
- `inkcartridges/js/admin/utils/page-copy-guards.js` — every check in §5
- `inkcartridges/js/admin/utils/page-copy-regions.js` — the manifest

**Vendor them, do not re-implement them.** Two implementations of `serializeRegion` will
diverge, and the day they do, the frontend's preview stops matching what gets committed.
If you cannot import across repos, copy the files verbatim with a header pointing at the
originals and a note that changes must be made in `inkfrontend` first.

Block shapes:

```jsonc
{ "type": "paragraph",  "className": "", "inline": [ …inline nodes… ] }
{ "type": "subheading", "inline": [ … ] }
{ "type": "list",       "ordered": false, "items": [ [ …inline… ], … ] }
{ "type": "callout",    "className": "policy-callout policy-callout--ok",
                        "title": [ …inline… ] | null, "body": [ [ …inline… ], … ] }
{ "type": "verbatim",   "raw": "<table>…</table>" }   // read-only; must arrive unchanged
```

Inline nodes: `{ "type":"text", "raw":"…" }` (decoded — literal `’`, not `&rsquo;`) and
`{ "type":"element", "name":"strong|em|u|a|br|span|small|sup|sub|abbr|code",
"attrs":[{name,value}], "children":[…] }`.

Splice invariants — assert these after building the new file, and refuse the commit if any
fails, rather than pushing a file you have not verified:

| Must be byte-identical before and after |
|---|
| `<head>`, meta, canonical, hreflang, any JSON-LD block |
| every `<script … src="/js/*.js?v=…">` line — the `?v=` tokens are content hashes restamped by `npm run build`; pinning one is ERR-067 |
| every `<section class="policy-section" id="…">` open tag and its `<h2>` — `buildTOC()` in `js/legal-page.js` derives the whole table of contents from them, and the ids are public deep links |
| every section **other than** the ones named in `regions` |
| the per-file multiset of `data-legal-bind` keys |

---

## 5. Guards — run all of these, server-side, before writing

The frontend runs the identical set for immediate feedback. That is **not** a control: a
tampered client skips it. Re-run everything here. Reject with 422 and the full error list;
never silently strip and save a modified version of what was submitted.

```jsonc
// 422
{ "ok": false, "errors": [
    { "code": "BANNED_CLAIM", "message": "…", "detail": "does not void" }
]}
```

| Code | Rule |
|---|---|
| `LOCKED_SECTION` | the manifest marks the section `locked`, or does not list it at all. **Fails closed** — an unlisted section is never editable. |
| `DISALLOWED_TAG` | an inline element outside the allowlist. This writes into a shipped page, so it is a stored-XSS sink with a permanent payload. |
| `DISALLOWED_ATTR` | any `on*` handler, `style`, `class`, `id`, or any attribute not allowed for that tag. |
| `UNSAFE_HREF` | `href` not one of `https://`, `mailto:`, `tel:`, a site path `/…`, or `#fragment`. Explicitly refuse `javascript:`, `data:`, and protocol-relative `//host`. |
| `BINDING_CHANGED` | the ordered multiset of `(tag, data-legal-bind key)` differs. Deleting, duplicating **or inventing** a key is a reject — §5 of `tests/legal-cms-retired-jul2026.test.js` asserts every key present in the HTML is implemented by `legal-page.js`, so an invented key breaks CI exactly as a deleted one does. |
| `VERBATIM_CHANGED` | a `verbatim` block's `raw` differs from the file. Tables, `<address>`, `<dl>` fact lists and FAQ accordions are immutable here. |
| `FACT_INLINED` | the NZBN, GST number, phone, email or street address appears as plain prose **outside** a `data-legal-bind` element. That is how a fact drifts from `src/utils/trustSignals.js`. Text *inside* a binding is fine — it is placeholder copy. |
| `BANNED_CLAIM` | text matches `LegalConfig.BANNED_CLAIM_PATTERNS`. See below. |
| `MISSING_PHRASE` | a `requiredPhrases` entry for that section is no longer present. |
| `UNPARSEABLE` | the submitted blocks do not survive serialize → re-parse → serialize unchanged. |
| `GUARD_UNAVAILABLE` | the banned-claim list or business facts could not be read. **Refuse the save.** An absent list must never read as "no violations found" (ERR-063 / ERR-068 / ERR-075). |

All text checks run on **entity-decoded, whitespace-collapsed** text with curly quotes
folded to ASCII — so `does&nbsp;not void`, `does\n  not void` and `won’t void` all trip.
Matching raw source instead would let every one of those through.

### 5.1 The banned-claim list

These are assertions about the **printer manufacturer's** warranty. This claim class is
what suspended the Google Ads account. We may describe our own guarantee and statutory CGA
rights; we may never characterise what an OEM will or will not honour.

```js
/does\s+not\s+void/i,
/won['’]?t\s+void/i,
/will\s+not\s+void/i,
/voids?\s+(your|the|my)\s+(printer\s+)?warranty/i,
/refuse\s+to\s+honou?r/i,
/cannot\s+refuse/i,
/cannot\s+require\s+you\s+to\s+use/i,
/warranty\s+(is|remains)\s+(unaffected|intact|valid)/i,
/warranty\s+stays\s+(intact|valid)/i,
```

**Canonical source: `inkcartridges/js/legal-config.js` → `LegalConfig.BANNED_CLAIM_PATTERNS`.**
The list above is a transcription for your convenience and will rot. Read it from the
vendored file. If you keep a copy in `src/utils/trustSignals.js`, add a comment in both
places that they must move together.

Note the patterns are assertion-shaped on purpose — never a bare `warranty` or `void`.
"Genuine cartridges carry the manufacturer's own warranty" is legitimate copy, and the
admin invoice **Void** status must not trip this.

### 5.2 Business facts

Read from `LegalConfig`: `nzbn`, `gstNumber`, `phoneDisplay`, `phoneE164`, `email`,
`address.street`. These mirror your `src/utils/trustSignals.js` and are the Google Ads
"Business Transparency" evidence — a second, unbound copy inside page prose is precisely
the drift this check exists to prevent.

---

## 6. What this endpoint must never do

- Write copy to any database table. There is no table. The write target is a git blob.
- Touch `inkcartridges/js/legal-config.js`. The "Last updated" date is one value shared by
  every policy page and it mirrors your backend — bumping it is a deliberate release
  decision, and the editor deliberately refuses to automate it. If a scoped endpoint for
  that is ever wanted, it is a separate brief with its own tests.
- Touch any file other than `inkcartridges/html/<doc>.html`.
- Commit straight to `main`. Every change goes through a PR so the owner can read the
  rendered preview first. The whole reason the frontend says *"Nothing reaches customers
  until you press Go live"* is that this is true.
- Return 200 for a write that did not happen.

---

## 7. Acceptance

1. `GET /api/admin/page-copy/returns` as owner → 200 with `html` and `blobSha`; as a
   non-owner admin → 403; unauthenticated → 401.
2. `GET /api/admin/page-copy/../../etc/passwd` → 400.
3. Round trip: GET, submit the parsed blocks **unchanged** → the spliced file is
   byte-identical to the input. (This is the single most valuable test here. If it fails,
   the vendored serializer has drifted from the frontend's.)
4. Edit one paragraph → the resulting commit diff touches that section only; script tags,
   `<h2>`s, ids, `<head>` and the bind multiset are unchanged.
5. Stale `blobSha` → 409, no branch created, no commit.
6. Submit `<script>alert(1)</script>` as an inline element → 422 `DISALLOWED_TAG`, no commit.
7. Submit `href: "javascript:alert(1)"` → 422 `UNSAFE_HREF`.
8. Submit text containing `does not void your printer warranty` → 422 `BANNED_CLAIM`.
9. Submit blocks with a `data-legal-bind` span removed → 422 `BINDING_CHANGED`.
10. Submit a locked section (`returns#address`, any `faq` section) → 422 `LOCKED_SECTION`.
11. Delete the vetted sentence from `genuine-vs-compatible#warranty` → 422 `MISSING_PHRASE`.
12. Make `LegalConfig` unreadable → 422 `GUARD_UNAVAILABLE`, **not** a successful save.
13. Publish → PR merges, Vercel rebuilds, and `curl https://www.inkcartridges.co.nz/returns`
    shows the new text with no JavaScript executed. That last clause is the whole point.

---

## 8. Frontend contract (for reference)

- Caller: `inkcartridges/js/admin/pages/page-copy.js`
- Base URL: `Config.API_URL`; auth via `Authorization: Bearer <supabase access_token>`
- The frontend treats **404 and 501** as "not deployed yet" and falls back to the
  read-only/diff path. Every other status is surfaced to the owner as a failure. So while
  you are building, an unimplemented route should 404 — do **not** stub it with a 200.
