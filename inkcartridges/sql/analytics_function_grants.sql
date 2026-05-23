-- =============================================================================
-- analytics_function_grants — restore + self-defend EXECUTE on public functions
-- =============================================================================
-- WHY THIS EXISTS (ERR-010 / ERR-028 / ERR-029, recurring):
--   The admin Dashboard's live KPIs (Gross Profit, Gross Margin, New Customers,
--   Returning %, Refund Rate) and the Trends/Forecast COGS line are powered by
--   Supabase RPCs: analytics_kpi_summary, analytics_revenue_series,
--   analytics_brand_breakdown, analytics_refunds_series, analytics_customer_stats,
--   analytics_top_products (called from js/admin/api.js with the admin's
--   `authenticated` JWT).
--
--   These functions are SECURITY DEFINER and gate access internally, so by
--   design `authenticated` must hold EXECUTE on them. A backend DB migration
--   periodically runs `REVOKE EXECUTE ... FROM PUBLIC` (or DROPs + re-CREATEs the
--   functions, which discards their ACL) WITHOUT re-granting. The result:
--   every RPC returns `42501 permission denied for function`, the analytics
--   layer goes dark, and the dashboard falls back to its order-feed self-heal
--   ("Live analytics service is unavailable" banner; Gross Profit etc. show —).
--   `get_suppliers` and other unrelated public functions are collateral.
--
--   Diagnosis recipe: mint an `authenticated` JWT
--   (POST /auth/v1/token?grant_type=password with the anon key), then curl an
--   RPC with its real named params. 42501 for `authenticated` while table reads
--   return 200 == revoked function EXECUTE. It is ALWAYS a DB grant, never a
--   frontend bug — the rpc() helper in js/admin/api.js sends the user JWT
--   correctly.
--
-- WHAT THIS DOES:
--   1. Re-GRANTs EXECUTE on every existing function in schema public to
--      `authenticated` and `service_role` (restores live data immediately).
--   2. ALTER DEFAULT PRIVILEGES so functions created by the usual roles inherit
--      the grant.
--   3. Installs an EVENT TRIGGER that re-GRANTs EXECUTE on any function the
--      moment it is CREATEd or ALTERed in schema public. THIS is the durable
--      fix: even a future migration that DROPs + re-CREATEs an analytics
--      function (discarding its ACL) is healed automatically, in the same
--      transaction, before any client can hit a 42501. The outage cannot recur.
--
-- Idempotent — safe to run more than once.
--
-- HOW TO APPLY:  Supabase dashboard → SQL Editor → paste this file → Run.
--               (or `supabase db execute`, or the MCP apply_migration tool)
-- Project: lmdlgldjgcanknsjrcxh
-- =============================================================================

-- ── 1. Restore EXECUTE on everything that exists right now ───────────────────
grant execute on all functions in schema public to authenticated, service_role;

-- ── 2. Make future functions created by the standard roles inherit the grant ─
-- ALTER DEFAULT PRIVILEGES is per-creating-role, so cover the roles Supabase
-- migrations actually run as. Wrapped in a DO block so an unknown role never
-- aborts the script.
do $$
declare
  r text;
begin
  foreach r in array array['postgres', 'supabase_admin', 'service_role', 'authenticated'] loop
    begin
      execute format(
        'alter default privileges for role %I in schema public grant execute on functions to authenticated, service_role',
        r
      );
    exception when others then
      raise notice 'skipped default privileges for role %: %', r, sqlerrm;
    end;
  end loop;
end
$$;

-- ── 3. Self-defending event trigger ─────────────────────────────────────────
-- Fires at the end of every DDL command and re-grants EXECUTE on any function
-- touched in schema public. SECURITY DEFINER so it runs with the (superuser)
-- owner's rights regardless of who ran the migration. This is what makes the
-- grant survive DROP+CREATE redeploys — the root cause of the recurrence.
create or replace function public.grant_execute_on_public_functions()
  returns event_trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  obj record;
begin
  for obj in
    select object_identity
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE FUNCTION', 'ALTER FUNCTION')
      and schema_name = 'public'
      and object_type = 'function'
  loop
    -- object_identity is fully qualified + arg-typed, e.g.
    -- "public.analytics_kpi_summary(date, date, text, text, text)"
    execute format('grant execute on function %s to authenticated, service_role', obj.object_identity);
  end loop;
exception when others then
  -- Never let a grant failure abort the user's DDL transaction.
  raise warning 'grant_execute_on_public_functions: %', sqlerrm;
end;
$$;

comment on function public.grant_execute_on_public_functions() is
  'Auto-grants EXECUTE to authenticated+service_role on every function created/altered in schema public. Guards against the recurring analytics RPC 42501 outage (see sql/analytics_function_grants.sql / errors.md ERR-029).';

drop event trigger if exists trg_grant_execute_on_public_functions;
create event trigger trg_grant_execute_on_public_functions
  on ddl_command_end
  when tag in ('CREATE FUNCTION', 'ALTER FUNCTION')
  execute function public.grant_execute_on_public_functions();

-- ── 4. Reload PostgREST's schema cache so the grant is visible immediately ───
-- (PostgREST caches the schema; without this the fix can lag by up to its
--  cache-refresh interval.)
notify pgrst, 'reload schema';
