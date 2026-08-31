-- Database-enforced tenant isolation for the shared managed runtime.
--
-- Every tenant environment in a managed deployment shares one database. Until
-- now the only thing keeping tenant A out of tenant B's rows was that every
-- query happened to carry `WHERE tenant_id = $1`. That is a code invariant: one
-- missing predicate, one new query, one injection, and the isolation is gone
-- with nothing to catch it.
--
-- Row-level security moves the guarantee under the application. `FORCE` is what
-- makes it real here: without it the table owner -- which is the role the
-- managed service connects as -- would bypass every policy. The predicate reads
-- a transaction-local GUC, so a pooled connection cannot leak one tenant's
-- scope into the next transaction, and a query that forgets to set it sees an
-- empty database rather than everyone's.
--
-- `current_setting(..., true)` returns NULL when the GUC was never set, and
-- `tenant_id = NULL` is NULL, which filters every row. Unscoped access is
-- therefore not an error but an empty result -- fail closed by construction.

CREATE OR REPLACE FUNCTION lip_current_tenant() RETURNS TEXT
  LANGUAGE sql
  STABLE
  AS $$ SELECT NULLIF(current_setting('lip.tenant_id', true), '') $$;

COMMENT ON FUNCTION lip_current_tenant() IS
  'Transaction-local tenant scope for row-level security. NULL when unset, which filters every tenant row.';

DO $$
DECLARE
  scoped_table TEXT;
BEGIN
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
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('DROP POLICY IF EXISTS lip_tenant_isolation ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY lip_tenant_isolation ON %I FOR ALL '
      'USING (tenant_id = lip_current_tenant()) '
      'WITH CHECK (tenant_id = lip_current_tenant())',
      scoped_table
    );
  END LOOP;
END
$$;
