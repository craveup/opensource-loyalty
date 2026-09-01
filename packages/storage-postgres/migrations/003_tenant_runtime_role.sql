-- Makes the row-level security in 002 actually apply.
--
-- Enabling and forcing RLS is not sufficient on a managed Postgres. Neon grants
-- its default owner role `BYPASSRLS`, and PostgreSQL checks that attribute on
-- the *current* role before it evaluates any policy. Verified against a real
-- Neon Postgres 18 branch: with 002 applied, `relrowsecurity` and
-- `relforcerowsecurity` were both true on every table, the transaction-local
-- tenant setting was correct -- and an unscoped connection still read every
-- tenant's rows, and could write rows belonging to any of them. The isolation
-- was decorative.
--
-- The fix does not need a second credential. `SET LOCAL ROLE` changes the
-- current role for the transaction, and a role without BYPASSRLS is subject to
-- policies. So: define a NOLOGIN role that cannot bypass anything, grant the
-- connecting role membership in it, and have every tenant transaction assume it
-- before touching a row. The connecting role keeps the ownership it needs to
-- run migrations; the queries that read tenant data do not run as it.
--
-- The role is NOLOGIN on purpose. It exists to be assumed, never to be
-- connected as, so it needs no password and there is no new secret to manage.

DO $$
DECLARE
  scoped_table TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lip_tenant_runtime') THEN
    BEGIN
      CREATE ROLE lip_tenant_runtime NOLOGIN NOBYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      -- A deployment whose role cannot create roles must supply an equivalent
      -- one out of band. Startup refuses to serve if the result is a role that
      -- bypasses RLS, so this cannot fail open -- see assertTenantIsolationEnforced.
      RAISE NOTICE 'lip_tenant_runtime could not be created; tenant isolation must be provisioned out of band';
      RETURN;
    END;
  END IF;

  -- The connecting role must be able to *assume* it, which membership alone no
  -- longer grants. Since PostgreSQL 16 the implicit membership a CREATEROLE
  -- role receives over a role it creates carries SET FALSE, so `pg_has_role(...,
  -- 'MEMBER')` is already true while `SET ROLE` still fails with "permission
  -- denied to set role" -- observed exactly that way on Neon Postgres 18. The
  -- grant is therefore issued unconditionally and asks for SET explicitly;
  -- re-granting an existing membership just updates its options.
  IF current_user <> 'lip_tenant_runtime' THEN
    BEGIN
      EXECUTE format('GRANT lip_tenant_runtime TO %I WITH SET TRUE', current_user);
    EXCEPTION WHEN syntax_error OR feature_not_supported THEN
      -- Before 16 there is no SET option and membership implies it.
      EXECUTE format('GRANT lip_tenant_runtime TO %I', current_user);
    END;
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO lip_tenant_runtime', current_schema());

  FOREACH scoped_table IN ARRAY ARRAY[
    'lip_platform_state',
    'lip_engine_states',
    'lip_engine_members',
    'lip_engine_identities',
    'lip_engine_balances',
    'lip_engine_reservations',
    'lip_engine_ledger',
    'lip_engine_balance_lots',
    'lip_engine_lot_consumptions',
    'lip_engine_idempotency',
    'lip_engine_accruals',
    'lip_engine_adjustments',
    'lip_engine_redemptions',
    'lip_engine_issued_rewards'
  ]
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO lip_tenant_runtime',
      scoped_table
    );
  END LOOP;
END
$$;
