# Security hardening (Sep 2026) — FE response

**Status: your §1, §2, §4.1 and §4.4 all check out. §3 is wrong about two of the
three endpoints it names, and §4.3 is backwards for our admin SPA — which is
where we found the same vulnerability class you had just fixed, still open on
our side. Fixed, tested and shipped as ERR-202.**

You offered a dedicated FE-repo pass as "a separate engagement". We ran it. This
is the result — you don't need to schedule it.

Everything below was measured, not read. Re-runnable:
`npm run probe:search-escaping` (read-only).

---

## 1. What we confirmed

| Your claim | Verdict | Measurement |
|---|---|---|
| Injection fix is live | ✅ | `/api/search/smart?q=zzqqxnonexistent,sku.eq.GTN251BK` → 0 rows + recovery rails. `…,or(sku.eq.GTN251BK)` → 0 rows. |
| No request/response shape changed | ✅ | `products / facets / total / pagination / intent` intact; `did_you_mean` + `corrected_from` and `recovery.rails[]` unchanged. |
| No auth/CORS/rate-limit contract moved | ✅ | Storefront and admin exercised end to end. |
| §4.1 — anon key only | ✅ | `config.js` JWT decoded: `"role":"anon"`. Stripe is `pk_live_` (publishable), PayPal a client ID, Turnstile a site key. No service-role key, no committed `.env`, nothing stray under the publicly-served tree. Now pinned by a test that decodes every JWT in client config and fails on any non-`anon` role. |
| §4.4 — CSP not wider than needed | ✅ | Live on `www`: `script-src 'self'` + explicit hosts + a sha256 hash — **no `unsafe-inline`, no `unsafe-eval`** — plus `frame-ancestors 'none'`, HSTS preload, nosniff, `X-Frame-Options: DENY`. Pinned by a test so it can't regress. |

**One measurement trap worth passing on:** check headers on `www`, not the apex.
The apex 307s to `www` before headers apply, so a completely healthy CSP reads
as "only HSTS" if you probe `inkcartridges.co.nz` directly. We briefly recorded
that as a finding before catching it.

---

## 2. §3 is wrong about `by-part` and `by-printer`

You wrote that the search endpoints "**strip the characters `,` `(` `)` from the
query string** before matching". That is true for `/api/search/smart` and we
verified it holds — `(TN251)` and `TN251,` both return the identical 7 rows as
`TN251`, and a real product title round-trips with its brackets intact.

It is **not** true for `/api/search/by-part`:

```
/api/search/by-part?q=TN251     → 7 rows
/api/search/by-part?q=(TN251)   → 0 rows
/api/search/by-part?q=TN251,    → 0 rows
/api/search/by-part?q=TN251␣    → 7 rows      ← whitespace IS trimmed
```

Punctuation is passed through and kills the match rather than being stripped.

**Impact today: none.** `API.searchByPart` is exported and has no caller in our
storefront, so nothing hits it. We're flagging it because the doc will outlive
that fact — the day someone wires up a part-number box trusting §3, they ship a
search that dies on a bracket. Either bring `by-part` in line with `smart`, or
narrow §3 to name `smart` only. We've pinned the current behaviour in our probe
so we'll notice if it changes either way.

---

## 3. §4.3 is backwards for our admin SPA — and it hid a real bug

> "**Search input:** no client-side escaping is needed (the backend handles it)"

True for anything that goes *through* the backend. **Our admin SPA has three
searches that don't.** They talk directly to PostgREST via the Supabase client,
so your escaper was never in the path — and each built its filter by
interpolating the operator's raw text into a comma/paren-delimited `.or()`:

```js
query.or(`name.ilike.%${_search}%,sku.ilike.%${_search}%`)   // products list
query.or(`name.ilike.%${filters.search}%,…`)                 // ribbon products
query.or(`full_name.ilike.%${search}%,…`)                    // printer models
```

**Same vulnerability class you'd just closed, still open one layer over.**
Measured against PostgREST with an admin JWT:

| Operator types | Result |
|---|---|
| `TN251` | 200, correct rows |
| `Smith, Ltd` | **400** `PGRST100 failed to parse logic tree` |
| `Acme (NZ)` | 200 but **`[]`** — parens are literal to `ilike` |
| `x,is_active.eq.false` | **400** `invalid input syntax for boolean: "false%"` |

PostgREST rejects the malformed tree, so this was never exfiltration. It was
worse in the boring direction: **a comma or a bracket isn't an attack, it's a
Tuesday.** Company names carry them, operators type them, and our own product
titles end in `(2,500 pages)`. Those searches were erroring or silently
returning nothing, and both failure paths were invisible — one swallowed the 400
into an empty picker, the other silently fell through to the HTTP backend so the
same box was served by two different engines.

### We quoted rather than stripped

Worth flagging because it may be useful on your side too. Stripping the
characters (what your escaper does, and what a helper in our tree already did)
is safe but lossy — `(2,500 pages)` degrades to `2 500 pages`. PostgREST accepts
a **double-quoted value**, inside which `,` `(` `)` `.` carry no syntactic
weight:

```
name.ilike."%Black (2,500 pages)%"   → 200, the two real products
name.ilike."%x,is_active.eq.false%"  → 200, [] — inert literal text
name.ilike."%quote\" inject%"        → 200, [] — no break-out
```

The value survives **and** the injection is closed — `(2,500 pages)` now finds
rows where it previously 400'd. Only `"` and `\` can terminate a quoted value,
so only those need escaping.

**If `/api/search/*` is doing the same `.or()` construction server-side, quoting
would let you stop dropping customers' punctuation** — which would also make §3
moot rather than merely documented.

---

## 4. What we changed (all in the FE repo, no backend dependency)

1. **`js/admin/utils/pgrst.js`** (new) — one module owning the rule.
   `pgrstLike()` for anything searched; `foldFilterPunct()` for the local half
   of a search that also runs remotely, so both halves agree on what a token is.
2. All three `.or()` call sites now escape. A test fails on **any** future raw
   `ilike.%${...}` interpolation, so this can't creep back.
3. `getPrinters` returns **`null` = "couldn't ask"** instead of an empty list —
   it was rendering a 400 as "no printers exist".
4. The products list now says out loud when its search falls back to the backend
   engine.
5. **Party picker bug, same root cause running the other way**: it sent one
   token remotely then filtered the returned rows locally with punctuation
   intact, so `Walker, Vieland` discarded a stored `Vieland Walker` — reporting
   "no match" for a customer we'd just been handed. Your stripping widened that
   gap, since the remote leg now loses the comma too.
6. Admin `noindex` was on `/admin/(.*)`, which doesn't match the bare `/admin` —
   the admin index was being served with no `X-Robots-Tag`. Fixed.

**Verification:** `tests/security-hardening-sep2026.test.js` (21 tests, incl.
two positive controls so the suite can't pass by escaping everything into
uselessness). All four fixes were mutation-tested — each reverted in turn, each
confirmed to turn the suite red. Full suite: 5,081 tests, 0 failures.
`npm run probe:search-escaping` re-measures the live contract, including your
§3; its PostgREST section **skips by name** without a JWT, because a skip is not
a pass. Punctuation cases added to `npm run audit:typeahead`, whose corpus had
been hyphens-only — which is why none of this surfaced sooner.

---

## 5. One ask

`§4` was the only unmeasured part of the hand-off, and it was the part with the
finding in it. No complaint — you flagged it as unverified, and that flag is
exactly what made us go look.

The generalisable version, for next time: **"the backend handles it" is scoped
to the calls that go through the backend.** Any direct-to-Supabase call from a
browser is a second front door with no guard on it. If you know of other places
the FE holds a Supabase client, say so and we'll audit those the same way.

_FE team, 2026-09-03 · ERR-202 in `errors.md`._
