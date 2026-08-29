#!/usr/bin/env node

const baseUrl = process.env["LIP_DEPLOYMENT_URL"]?.replace(/\/+$/u, "");
const expectedEnvironment = process.env["LIP_EXPECTED_ENVIRONMENT"];
const expectedRelease = process.env["LIP_EXPECTED_RELEASE"];
// Metrics are operator-only, so verification authenticates like any other
// operator caller. Health stays public: it is the liveness probe Render calls.
const operatorKey =
  process.env["LIP_CLOUD_OPERATOR_KEY"] ?? process.env["LIP_CLOUD_API_KEY"];
if (!baseUrl || !expectedEnvironment) {
  throw new Error("LIP_DEPLOYMENT_URL and LIP_EXPECTED_ENVIRONMENT are required");
}
if (!operatorKey) {
  throw new Error(
    "LIP_CLOUD_OPERATOR_KEY (or, for bootstrap only, the legacy LIP_CLOUD_API_KEY) " +
      "is required to read deployment metrics evidence"
  );
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
  headers: { authorization: `Bearer ${operatorKey}` },
  signal: AbortSignal.timeout(10_000)
});
const metrics = await metricsResponse.text();
if (!metricsResponse.ok || !metrics.includes("lip_cloud_http_requests_total")) {
  throw new Error("Deployment metrics evidence is unavailable");
}

// Evidence that an anonymous scrape is refused, so the record can assert it.
const anonymousMetrics = await fetch(`${baseUrl}/metrics`, {
  signal: AbortSignal.timeout(10_000)
});
if (anonymousMetrics.status !== 401) {
  throw new Error(
    `Deployment metrics are reachable without an operator key (status ${anonymousMetrics.status})`
  );
}

console.log(JSON.stringify({
  event: "loyalty_deployment_verified",
  environment: expectedEnvironment,
  release: health["release"],
  service: health["service"],
  // Copy into the release evidence record; sandbox and production must differ.
  control_plane_database: health["control_plane_database"],
  data_plane_database: health["data_plane_database"],
  metrics_anonymous_status: anonymousMetrics.status,
  metrics_authenticated_status: metricsResponse.status
}));
