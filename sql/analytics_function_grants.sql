-- =============================================================================
-- analytics_function_grants — restore EXECUTE on the SIX analytics RPCs
-- =============================================================================
--
-- ⚠️  READ THIS BEFORE YOU WIDEN ANYTHING. ⚠️
--
-- Until Sep 2026 this file did three things, and two of them were a loaded gun:
--
--     grant execute on all functions in schema public to authenticated, service_role;
--
-- `all functions in schema public` is not a synonym for "the analytics ones".
-- Backend migration 165 added write RPCs that are deliberately revoked to
-- `service_role` only, and they have NO internal is_owner() guard because THE
-- GRANT *WAS* THE CONTROL — they are only ever reached through the admin API,
-- which does its own authorisation:
--
--     set_business_contract_price(...)     an arbitrary negotiated price on ANY
--                                          product for ANY business account,
--                                          including the caller's own. $0.01 goods.
--     remove_business_contract_price(...)  delete another account's pricing.
--
-- One paste of the old section 1 handed both to every signed-in customer.
-- Sections 2 and 3 made it durable: ALTER DEFAULT PRIVILEGES so every FUTURE
-- function inherited the grant, plus an event trigger that re-granted EXECUTE on
-- ANY function the moment it was created or altered. Running the old file also
-- REPLACED the live database's narrowed trigger (backend migration 163,
-- `allowlist_function_execute_grant_trigger`), silently reverting it.
--
-- Sections 2 and 3 are gone. Do not reintroduce them. This file now grants
-- exactly the six functions the admin Dashboard calls, by name and signature.
--
-- IF THE DASHBOARD 42501s AGAIN, THE FIX IS TO RE-RUN BACKEND MIGRATION 163 —
-- NOT TO WIDEN THIS GRANT. 163 installs the allow-listed trigger that re-grants
-- only these six on DDL. That is the durable fix, and it lives in the backend
-- repo where the functions themselves are defined.
--
-- WHY THIS EXISTS (ERR-010 / ERR-029 / ERR-035, recurring):
--   The admin Dashboard's live KPIs (Gross Profit, Gross Margin, New Customers,
--   Returning %, Refund Rate) and the Trends/Forecast COGS line are powered by
--   Supabase RPCs: analytics_kpi_summary, analytics_revenue_series,
--   analytics_brand_breakdown, analytics_refunds_series, analytics_customer_stats,
--   analytics_top_products (called from js/admin/api.js with the admin's
--   `authenticated` JWT).
--
--   These functions are SECURITY DEFINER and gate access internally (backend
--   migration 166 hardened the is_owner() guard inside five of them), so by
--   design `authenticated` must hold EXECUTE on them. A backend DB migration
--   periodically runs `REVOKE EXECUTE ... FROM PUBLIC` (or DROPs + re-CREATEs the
--   functions, which discards their ACL) WITHOUT re-granting. The result:
--   every RPC returns `42501 permission denied for function`, the analytics
--   layer goes dark, and the dashboard falls back to its order-feed self-heal
--   ("Live analytics service is unavailable" banner; Gross Profit etc. show —).
--
--   Expect the Supabase advisor to keep warning about the `authenticated`
--   EXECUTE grant on these six. The advisor cannot see the in-function guard.
--   The grant is deliberate. Do not "clean it up".
--
--   Diagnosis recipe: mint an `authenticated` JWT
--   (POST /auth/v1/token?grant_type=password with the anon key), then curl an
--   RPC with its real named params (`date_from`, `date_to`, `brand_filter`, …).
--   42501 for `authenticated` while table reads return 200 == revoked function
--   EXECUTE. It is ALWAYS a DB grant, never a frontend bug — the rpc() helper in
--   js/admin/api.js sends the user JWT correctly.
--
--   PROBE GOTCHA: an empty-`{}` RPC call returns 404 PGRST202 (signature
--   mismatch) even when the real problem is 42501. A 404 here proves NOTHING.
--   Always send the function's real named params.
--
-- Idempotent — safe to run more than once.
--
-- LOCATION: this file lives at repo-root `sql/`, NOT under `inkcartridges/`.
--   That tree is the Vercel project root with `outputDirectory: "."`, so anything
--   in it is served publicly — this file was downloadable at
--   https://www.inkcartridges.co.nz/sql/analytics_function_grants.sql until
--   ERR-229 (Sep 2026). Never move it back.
--
-- HOW TO APPLY:  Supabase dashboard → SQL Editor → paste this file → Run.
--               (or `supabase db execute`, or the MCP apply_migration tool)
-- Project: lmdlgldjgcanknsjrcxh
-- =============================================================================

-- ── Restore EXECUTE on the six analytics RPCs — and ONLY those six ───────────
-- Named with full signatures so this cannot silently widen if an overload with
-- a different arity is added later.
grant execute on function
  public.analytics_kpi_summary(text, text, text, text, text),
  public.analytics_revenue_series(text, text, text, text),
  public.analytics_refunds_series(text, text, text),
  public.analytics_top_products(text, text, text, integer),
  public.analytics_customer_stats(text, text, text),
  public.analytics_brand_breakdown(text, text, text, text, text)
to authenticated, service_role;

-- ── Reload PostgREST's schema cache so the grant is visible immediately ──────
-- (PostgREST caches the schema; without this the fix can lag by up to its
--  cache-refresh interval.)
notify pgrst, 'reload schema';
