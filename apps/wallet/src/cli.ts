import { startWalletServer } from "./server.js";

const port = Number.parseInt(process.env.WALLET_PORT ?? "3230", 10);
const host = process.env.WALLET_HOST ?? "127.0.0.1";
const publicBaseUrl = process.env.WALLET_PUBLIC_BASE_URL ?? `http://${host}:${port}`;
const cloudBaseUrl = process.env.WALLET_CLOUD_BASE_URL ?? "http://127.0.0.1:3220";
const tenantId = process.env.WALLET_TENANT_ID ?? "demo-foodservice";
const providerId = process.env.WALLET_OIDC_PROVIDER_ID ?? "primary";
const demo = process.env.WALLET_DEMO === "true";

if (!demo && (!process.env.WALLET_OIDC_ISSUER || !process.env.WALLET_OIDC_CLIENT_ID)) {
  throw new Error(
    "Set WALLET_OIDC_ISSUER and WALLET_OIDC_CLIENT_ID, or use WALLET_DEMO=true for synthetic local preview"
  );
}

const running = await startWalletServer({
  host,
  port,
  publicBaseUrl,
  cloudBaseUrl,
  tenantId,
  providerId,
  demo,
  ...(process.env.WALLET_OIDC_ISSUER ? { oidcIssuer: process.env.WALLET_OIDC_ISSUER } : {}),
  ...(process.env.WALLET_OIDC_CLIENT_ID ? { oidcClientId: process.env.WALLET_OIDC_CLIENT_ID } : {}),
  ...(process.env.WALLET_OIDC_CLIENT_SECRET
    ? { oidcClientSecret: process.env.WALLET_OIDC_CLIENT_SECRET }
    : {})
});

console.log(`[wallet] listening on ${running.url}${demo ? " (synthetic demo mode)" : ""}`);

const shutdown = async (): Promise<void> => {
  await running.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
