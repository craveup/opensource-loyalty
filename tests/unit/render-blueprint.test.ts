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
  "LIP_CLOUD_DATA_PLANE_DATABASE_URL",
  "LIP_CLOUD_DATABASE_URL",
  "LIP_CLOUD_OIDC_AUDIENCE",
  "LIP_CLOUD_OIDC_ISSUER",
  "LIP_CLOUD_OIDC_JWKS_URI",
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
        healthCheckPath: "/health",
        name,
        numInstances: 1,
        plan: "starter",
        region: "oregon",
        runtime: "docker",
        type: "web",
      });
      expect(service.disk).toEqual({
        mountPath: "/data",
        name: `${name}-data`,
        sizeGB: 1,
      });
      expect(variables.get("LIP_CLOUD_REGIONS")?.value).toBe("render-oregon");
      expect(variables.get("LIP_CLOUD_DATA_PLANE_PUBLIC_HOST")?.value).toBe(
        name,
      );

      for (const key of secretVariables) {
        expect(variables.get(key), `${environment}.${key}`).toEqual({
          key,
          sync: false,
        });
      }
    }

    expect(
      new Set((blueprint.services ?? []).map((service) => service.disk?.name))
        .size,
    ).toBe(3);
  });
});
