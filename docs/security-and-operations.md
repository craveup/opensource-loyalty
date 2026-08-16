# Security and operations

This document describes the current controls and the checks still required for
a production deployment. It is not a certification or contractual SLA.

## Threat model and data boundaries

Protected assets include merchant/admin keys, Cloud operator keys, customer
identity links, loyalty balances, ledger history, program policy, webhook
secrets, and backups. Relevant threats include tenant crossover, key theft,
replay, duplicate financial mutation, forged webhook delivery, malicious
adapter payloads, unsafe restore, dependency compromise, and operator lockout.

Controls in the repository include tenant-scoped Postgres repositories,
role/location checks, hashed API keys, bounded key rotation overlap, explicit
idempotency conflicts, integer money, signed webhooks, checksummed migration
archives, authenticated-encryption for local Cloud credential files, private
file modes, atomic writes, and protected release evidence. Customer passwords,
refresh tokens, payment cards, and payment execution remain with their owning
providers.

## Recovery objectives

Proposed launch objectives, to be validated by production drills:

- control-plane RPO: 15 minutes; RTO: 4 hours;
- loyalty ledger RPO: 5 minutes with managed Postgres; RTO: 2 hours;
- local SQLite design-partner environments: backup-at-operation-boundary, RTO
  4 hours; not positioned as multi-region production.

The local provisioner quiesces a runtime, writes a checksummed encrypted backup
atomically, then resumes it in `finally`. Restore validates checksum, identifier
paths, credential authentication, and metadata binding before replacing files.
Postgres deployments must use provider-native backups and tested point-in-time
recovery; the local backup command intentionally refuses Postgres.

## Incident process

1. Triage severity and affected tenants without copying secrets into chat or issues.
2. Freeze writes when integrity is uncertain; preserve reads and evidence.
3. Revoke or rotate affected credentials and verify webhook consumers.
4. Reconcile ledger, idempotency, and source orders before reopening writes.
5. Notify affected parties under the applicable contract/law and maintain a timeline.
6. Publish a blameless post-incident record with corrective owners and dates.

## Proposed service objectives

Production Cloud targets are 99.9% monthly data-plane availability and 99.5%
control-plane availability, excluding documented maintenance. They are targets,
not attained or contracted claims. Measure availability from an external probe;
track mutation latency, error rate, webhook age, backup age, restore drills,
queue lag, and reconciliation discrepancies per tenant.

## Production-readiness checklist

- Dedicated secret manager/KMS and key-rotation drill; never keep the local
  base64 key in source control.
- Managed Postgres encryption, automated PITR, restore exercise, and tenant
  isolation test.
- OIDC operator auth, at least two platform admins, least-privilege org scope,
  and shared bootstrap key disabled.
- TLS, network boundary, rate limits, audit export, alerts, on-call ownership,
  runbooks, data retention/deletion policy, DPA, and incident contacts.
- Signed Stripe and LIP webhooks tested with replay/duplicate delivery.
- Release manifest, SBOM, dependency-risk review, image provenance, conformance,
  and rollback artifact recorded for the deployed commit.
