# Security hardening (Sep 2026, round 2) — FE hand-off

**TL;DR: one thing needs your action, and it is urgent-ish. Everything else is FYI.**

The action item is a **SQL script sitting in the frontend repo** that, if anyone
runs it, hands every signed-in customer the ability to set their own price on any
product. It is not currently applied — but it ships with a "paste into the SQL
Editor and Run" instruction and its own header calls it "the durable fix", so it
is a loaded footgun. Details in §1.

No API request/response shape changed in this round. No field added, removed or
renamed. No auth, CORS or rate-limit contract moved.

Companion to `security-hardening-sep2026-FE-handoff.md` (round 1 — search
injection + dependency remediation). This round is the full OWASP pass: nine
findings, all closed or accepted. Backend migrations `166`, `167`, `168`.

---

## 1. ACTION REQUIRED — delete or neuter `sql/analytics_function_grants.sql`

**File:** `inkcartridges/sql/analytics_function_grants.sql` (frontend repo)

It was written to fix the recurring analytics-RPC `42501` outage (ERR-029), and
it does fix it — by blanket-granting, which is far too wide a hammer:

```sql
grant execute on all functions in schema public to authenticated, service_role;
```

**`all functions in schema public` now includes functions that must never be
callable by a customer.** The one that matters most landed in migration 165, after
this script was written:

| Function | What `authenticated` could do if this script runs |
|---|---|
| `set_business_contract_price(...)` | Set an arbitrary negotiated price on **any product for any business account** — including their own. Priced goods at $0.01. |
| `remove_business_contract_price(...)` | Delete another account's negotiated pricing. |

Both are `SECURITY DEFINER` and were deliberately revoked to `service_role` only.
Neither has an internal `is_owner()` guard, because the grant *was* the control —
they are only ever reached through the admin API, which does its own
authorisation. A blanket `grant execute on all functions` removes that control
completely.

The script does two further things that outlive the run:

2. `ALTER DEFAULT PRIVILEGES … grant execute on functions to authenticated` for
   four roles — so **every function created afterwards** inherits the grant.
3. Installs an event trigger that re-grants EXECUTE on **any** function the moment
   it is created or altered.

### Why it hasn't bitten you

The live database has a **narrowed** version of that event trigger (backend
migration 163, `allowlist_function_execute_grant_trigger`). It carries an
explicit allow-list of exactly six analytics functions and re-grants only those.
Verified live today — the mig-165 write RPCs correctly deny both `anon` and
`authenticated`:

```
anon           set_business_contract_price → permission denied
authenticated  set_business_contract_price → permission denied
```

So the current state is correct. The risk is entirely that someone hits the
42501 error again, finds this file, follows its instructions, and silently
reverts migration 163 *and* opens the mig-165 RPCs in one paste.

### What to do

Pick either:

- **Delete the file** and point ERR-029 at the backend's migration 163 instead, or
- **Replace its section 1** with the allow-list form the database actually runs:

```sql
-- Only these six. NOT `all functions in schema public`.
grant execute on function
  public.analytics_kpi_summary(text, text, text, text, text),
  public.analytics_revenue_series(text, text, text, text),
  public.analytics_refunds_series(text, text, text),
  public.analytics_top_products(text, text, text, integer),
  public.analytics_customer_stats(text, text, text),
  public.analytics_brand_breakdown(text, text, text, text, text)
to authenticated, service_role;
```

and **drop sections 2 and 3 entirely** — the backend's migration 163 already
installs the allow-listed trigger, and re-running the wide version replaces it.

> If the analytics dashboard 42501s again, the fix is to re-run backend migration
> 163, not to widen the grant. The diagnosis recipe in the file's header is still
> good; only its remedy is wrong.

---

## 2. FYI — three backend changes with no FE contract impact

| Change | Migration | FE impact |
|---|---|---|
| Hardened the authorisation guard inside 5 analytics RPCs | 166 | **None.** Your direct `sb.rpc()` calls as a super-admin still work — verified `EXECUTE` for `authenticated` is intentionally preserved. |
| Revoked `TRUNCATE`/`TRIGGER`/`REFERENCES`/`MAINTAIN` from `anon`+`authenticated` on all 130 tables | 167 | **None.** `SELECT`/`INSERT`/`UPDATE`/`DELETE` untouched — RLS remains the control for those. |
| Revoked `SELECT` on `products.manual_retail_price` from client roles | 168 | **None** — verified against your code, see §3. |

On 166: the `authenticated` EXECUTE grant on the analytics RPCs is **deliberate
and was kept**, because your admin dashboard calls those RPCs directly with a
super-admin JWT. `is_owner()` inside each function is what authorises the call.
Do not "clean up" that grant, and expect the Supabase advisor to keep warning
about it — the advisor cannot see the in-function guard.

---

## 3. `manual_retail_price` — checked against your code before revoking

The backend API has always stripped this column from responses
(`sanitizeProductForApi` deletes it alongside `cost_price`), but the database
grant had never been tightened to match, so it was readable directly off
PostgREST with the anon key. Migration 168 closes that.

I grepped your repo rather than guessing, and **no `select()` anywhere names it**:

- `manual_retail_price` is **write-only** in the FE — the admin edit drawer posts
  it, and the drawer's own copy already says "the current override isn't shown
  here because the admin API doesn't return it".
- `product-detail-page.js` `_fetchPrinters` selects `id` only.
- The curated related-products rail uses the explicit `RELATED_COLS` list
  (`retail_price`, `compare_price`, … ) — not `manual_retail_price`.
- The admin ribbon list uses the enumerated `RIBBON_PRODUCT_COLS`, which its own
  comment says is enumerated precisely so a column revoke can't break it. That
  comment did its job here.

Both query shapes were replayed against the live database under `SET ROLE anon`
and `SET ROLE authenticated` after the revoke — both still return rows.

**If you ever do need the value**, read it through an admin API endpoint; don't
re-grant the column.

---

## 4. One behaviour nuance — `*` in search input

Round 1 told you `,` `(` `)` are stripped from search queries. Add `*` to that
list.

PostgREST rewrites `*` into the SQL wildcard `%` inside every `ilike` filter,
unconditionally and with no escape sequence — so the backend's careful escaping
of `%` was bypassable by simply typing `*`. It is now stripped.

Practical effect:

- Normal queries are unaffected — cartridge and printer codes never contain `*`.
- `?q=*` no longer matches everything; it now searches an empty term.
- If any FE feature offers `*` to users as a wildcard, it will stop working.
  I grepped for intentional `*` usage in search calls and found none, so I expect
  zero impact — flagging for completeness.

No change to response shape, status codes, ordering, or the `data.intent` /
`data.recovery` / `data.did_you_mean` envelopes.

---

## 5. Round 1's §4 checklist — two items now verified

The previous hand-off listed FE-side hardening as unverified prompts. Having
looked at the repo this round, two can be upgraded:

| Round-1 item | Status now |
|---|---|
| "Ship the anon key only, never the service-role key" | ✅ **Verified clean.** The only Supabase JWT embedded in the client decodes to `role: anon`. No `sk_live_`/`sk_test_`/service-role material in client config. Your own `tests/security-hardening-sep2026.test.js:234` already asserts this — good. |
| "Don't infer trust from a swallowed error" | ✅ **Verified fixed** in the curated related-products path — `manualError` is now captured and sets `fetchFailed` rather than rendering an empty state. |
| CSP / Vercel host config | ⬜ Still not audited — outside the backend repo. |
| Search input escaping | ✅ No action needed; see §4. |

---

## 6. Verification summary

Backend after all changes: **5754/5754 tests passing** (three consecutive runs),
**0 lint errors**, full app graph loads clean. Every grant change was verified
with `SET ROLE` probes against the live database rather than read from a
migration file — this project has history with migrations that were committed but
never applied, so file presence was not treated as proof.

Migrations 166/167/168 are applied **and** registered in
`supabase_migrations.schema_migrations`.

---

_Author: backend security review round 2, Sep 2026. §1 is the only item needing
FE work. Questions → backend team._
