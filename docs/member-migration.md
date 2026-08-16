# Member and balance migration

Migrations must preserve identity uniqueness, opening balances, historical
source linkage, and a rollback path. Do not turn imported balance into a normal
purchase accrual; the CLI writes an explicit `migration` manual adjustment with
`qualifies_for_tier: false`.

Create a private checksummed plan from JSON or CSV:

```bash
npm run lip -- migration plan \
  --program-id acme-rewards \
  --input members.csv \
  --output .lip/member-plan.json
```

Required columns are `external_member_id`, `identity_value`, and integer
`available_balance`. Optional fields are `identity_type`, `member_id`, and
`unit`. The planner rejects duplicate source ids, identities, or member ids and
derives stable opaque ids when a target id is absent. Output mode is `0600` and
contains identities, so it is not a source-control artifact.

After applying enroll and opening-balance operations through the normal API,
export a checksummed state archive and reconcile:

```bash
npm run lip -- migration reconcile \
  --plan .lip/member-plan.json \
  --archive .lip/target-state.json \
  --output .lip/reconciliation.json
```

For Punchh- or Paytronix-style sources, first inventory household/account
relationships, phone/email normalization, locked or promotional balances,
tier basis, expiration lots, banked rewards, pending transactions, and opt-in
evidence. The generic planner handles one stable identity and available balance
per row; richer source semantics need an explicit adapter and separate
reconciliation. Do not claim source-vendor compatibility from a CSV import.

Run a frozen rehearsal, compare member counts and balances, exercise checkout
through refund, retain the source system as rollback authority, then perform a
bounded cutover following [MIGRATION.md](../MIGRATION.md).
