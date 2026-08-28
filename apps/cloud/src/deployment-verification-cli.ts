#!/usr/bin/env node

const baseUrl = process.env["LIP_DEPLOYMENT_URL"]?.replace(/\/+$/u, "");
const expectedEnvironment = process.env["LIP_EXPECTED_ENVIRONMENT"];
const expectedRelease = process.env["LIP_EXPECTED_RELEASE"];
if (!baseUrl || !expectedEnvironment) {
  throw new Error("LIP_DEPLOYMENT_URL and LIP_EXPECTED_ENVIRONMENT are required");
}

const healthResponse = await fetch(`${baseUrl}/health`, {
  signal: AbortSignal.timeout(10_000)
});
if (!healthResponse.ok) throw new Error(`Deployment health returned ${healthResponse.status}`);
const health = await healthResponse.json() as Record<string, unknown>;
if (
  health["status"] !== "ok" ||
  health["service"] !== "lip-cloud-control-plane" ||
  health["instance_policy"] !== "single" ||
  health["environment"] !== expectedEnvironment ||
  (expectedRelease && health["release"] !== expectedRelease)
) {
  throw new Error("Deployment health evidence does not match the expected environment/release");
}

const metricsResponse = await fetch(`${baseUrl}/metrics`, {
  signal: AbortSignal.timeout(10_000)
});
const metrics = await metricsResponse.text();
if (!metricsResponse.ok || !metrics.includes("lip_cloud_http_requests_total")) {
  throw new Error("Deployment metrics evidence is unavailable");
}

console.log(JSON.stringify({
  event: "loyalty_deployment_verified",
  environment: expectedEnvironment,
  release: health["release"],
  service: health["service"]
}));
