import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface BlueprintVariable {
  key: string;
  sync?: boolean;
  value?: string;
}

interface BlueprintService {
  autoDeploy?: boolean;
  branch?: string;
  disk?: {
    mountPath?: string;
    name?: string;
    sizeGB?: number;
  };
  envVars?: BlueprintVariable[];
  healthCheckPath?: string;
  name?: string;
  numInstances?: number;
  plan?: string;
  region?: string;
  runtime?: string;
  type?: string;
}

interface Blueprint {
  previews?: { generation?: string };
  services?: BlueprintService[];
}

const expectedServices = new Map([
  ["development", "crave-loyalty-development"],
  ["sandbox", "crave-loyalty-sandbox"],
  ["production", "crave-loyalty-production"],
]);

/**
 * Each environment tracks its own branch, and promotion is a merge along
 * dev -> sandbox -> main. That is what keeps the deployed commit identical
 * across environments; a direct push to sandbox or main would break the
 * release evidence's exact-commit claim, so those branches are protected.
 */
const expectedBranches = new Map([
  ["development", "dev"],
  ["sandbox", "sandbox"],
  ["production", "main"],
]);

/**
 * Every variable the diskless runtime once needed to find its own files and
 * ports. They are load-bearing in the wrong direction now: any of them still
 * present would either reattach a filesystem dependency or hand out a URL
 * derived from local state rather than the service's real origin.
 */
const retiredVariables = [
  "LIP_CLOUD_ALLOW_LEGACY_CREDENTIAL_MIGRATION",
  "LIP_CLOUD_BACKUP_DIR",
  "LIP_CLOUD_DATA_DIR",
  "LIP_CLOUD_DATA_PLANE_BASE_PORT",
  "LIP_CLOUD_DATA_PLANE_HOST",
  "LIP_CLOUD_DATA_PLANE_PUBLIC_HOST",
  "LIP_CLOUD_PROGRAM_DIR",
] as const;

const secretVariables = [
  "LIP_CLOUD_ALLOWED_ORIGINS",
  "LIP_CLOUD_API_KEY",
  "LIP_CLOUD_BOOTSTRAP_SUBJECTS",
  "LIP_CLOUD_CREDENTIAL_KEY",
  "LIP_CLOUD_CUSTOMER_AUTHORIZED_PARTIES",
  "LIP_CLOUD_CUSTOMER_OIDC_AUDIENCE",
  "LIP_CLOUD_CUSTOMER_OIDC_ISSUER",
  "LIP_CLOUD_CUSTOMER_PROVIDER_ID",
  "LIP_CLOUD_CUSTOMER_TENANT_ID",
  "LIP_CLOUD_DATABASE_URL",
  "LIP_CLOUD_OIDC_AUDIENCE",
  "LIP_CLOUD_OIDC_ISSUER",
  "LIP_CLOUD_OIDC_JWKS_URI",
  "LIP_CLOUD_PUBLIC_BASE_URL",
  "LIP_CLOUD_SHARED_KEY_DISABLED",
  "LIP_CLOUD_STRIPE_PRICE_BUSINESS",
  "LIP_CLOUD_STRIPE_PRICE_PRO",
  "LIP_CLOUD_STRIPE_SECRET_KEY",
  "LIP_CLOUD_STRIPE_WEBHOOK_SECRET",
] as const;

describe("managed Render blueprint", () => {
  it("defines isolated development, sandbox, and production services in Oregon", async () => {
    const blueprint = parse(await readFile("render.yaml", "utf8")) as Blueprint;
    expect(blueprint.previews).toEqual({ generation: "off" });
    expect(blueprint.services).toHaveLength(3);

    const services = new Map(
      (blueprint.services ?? []).map((service) => {
        const variables = new Map(
          (service.envVars ?? []).map((variable) => [variable.key, variable]),
        );
        return [
          variables.get("LIP_CLOUD_DEPLOYMENT_ENVIRONMENT")?.value,
          { service, variables },
        ];
      }),
    );

    expect([...services.keys()].sort()).toEqual(
      [...expectedServices.keys()].sort(),
    );

    for (const [environment, name] of expectedServices) {
      const entry = services.get(environment);
      expect(entry, `${environment} service`).toBeDefined();
      const { service, variables } = entry!;

      expect(service).toMatchObject({
        autoDeploy: false,
        branch: expectedBranches.get(environment),
        // Readiness gates the deploy: migrations, database, worker and
        // restored runtimes. /health remains liveness only, and would let
        // Render cut over to a process that is up but serving nothing.
        healthCheckPath: "/ready",
        name,
        // Not a cost decision. Schedulers, webhook dispatch and the credential
        // single-flight all assume one process.
        numInstances: 1,
        region: "oregon",
        runtime: "docker",
        type: "web",
      });
      expect(variables.get("LIP_CLOUD_REGIONS")?.value).toBe("render-oregon");

      for (const key of secretVariables) {
        expect(variables.get(key), `${environment}.${key}`).toEqual({
          key,
          sync: false,
        });
      }
    }
  });

  it("attaches no disk and keeps no filesystem or port variables", async () => {
    const blueprint = parse(await readFile("render.yaml", "utf8")) as Blueprint;
    for (const service of blueprint.services ?? []) {
      expect(service.disk, `${service.name} disk`).toBeUndefined();
      const keys = new Set((service.envVars ?? []).map((variable) => variable.key));
      for (const retired of retiredVariables) {
        expect(keys.has(retired), `${service.name}.${retired}`).toBe(false);
      }
    }
  });

  it("runs development on Free, which is only possible without a disk", async () => {
    const blueprint = parse(await readFile("render.yaml", "utf8")) as Blueprint;
    const byName = new Map(
      (blueprint.services ?? []).map((service) => [service.name, service]),
    );
    expect(byName.get("crave-loyalty-development")?.plan).toBe("free");
    // Sandbox and production stay on a paid plan: external access and
    // production activation require load, alerting and restore certification
    // that Free cannot support.
    expect(byName.get("crave-loyalty-sandbox")?.plan).toBe("starter");
    expect(byName.get("crave-loyalty-production")?.plan).toBe("starter");
  });
});
