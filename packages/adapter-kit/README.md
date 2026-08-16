# `@loyalty-interchange/adapter-kit`

Build and certify ordering/POS mappings without putting vendor behavior into the
normative LIP routes.

An adapter maps a provider order into `FoodserviceOrder`, maps refunds or voids
into `OrderAdjustment`, and derives stable operation-scoped idempotency keys.
`certifyAdapter` validates an intentionally scoped fixture run;
`certifyFoodserviceAdapter` additionally requires every shared scenario before
returning a passing full-foodservice report. Both validate protocol structure,
reconciliation, determinism, declared capabilities, and fixture expectations.

See `examples/typescript/ordering-bff.ts` and
`tests/fixtures/adapter-foodservice.ts` for a runnable implementation and the
reference edge-case corpus.
