import type { ProgramDefinition } from "@loyalty-interchange/reference";

/**
 * The program a freshly provisioned managed environment starts from.
 *
 * It has to be *valid* — the engine refuses to boot on a malformed definition,
 * and a tenant runtime that cannot boot is a tenant that cannot be configured.
 * It must equally be *inert*: a merchant who has not yet published a program
 * must not be able to accrue or redeem anything, and no synthetic member or
 * demo activity may appear in a real merchant's ledger.
 *
 * Zero points per unit of spend is what makes it inert without making it
 * invalid — the engine requires a non-zero denominator but accepts a zero
 * numerator, so every accrual computes to nothing until the merchant publishes
 * a real program through the Admin API. No rewards means nothing is redeemable;
 * no tiers or membership plans means there is no state to migrate when the
 * merchant's first real program lands.
 */
export function createBootstrapProgram(programId: string): ProgramDefinition {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(programId)) {
    throw new Error("Bootstrap program id must be a safe identifier");
  }
  return {
    program_id: programId,
    name: "Unpublished loyalty program",
    description:
      "Provisioned placeholder. Publish a program through the Admin API before accepting traffic.",
    currency: "USD",
    accounts: [{ unit: "points", unit_label: "points", is_primary: true }],
    earn_rate: { points: 0, spend_minor_units: 100 },
    evaluation_ttl_seconds: 300,
    reservation_ttl_seconds: 120,
    rewards: [],
    metadata: { lip_bootstrap: true }
  };
}

/**
 * True while the environment still carries the provisioned placeholder.
 *
 * Callers use this to refuse traffic that only makes sense against a real
 * program, and to tell "the merchant has not configured anything yet" apart
 * from "the merchant deliberately published an empty program".
 */
export function isBootstrapProgram(program: ProgramDefinition): boolean {
  return program.metadata?.["lip_bootstrap"] === true &&
    program.rewards.length === 0 &&
    program.earn_rate.points === 0;
}
