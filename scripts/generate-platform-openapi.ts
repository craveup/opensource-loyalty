import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

const root = resolve(import.meta.dirname, "..");

const problem = { $ref: "#/components/responses/Problem" };
const json = { schema: { type: "object", additionalProperties: true } };
const requestBody = {
  required: true,
  content: { "application/json": json }
};
const csvOrJsonRequestBody = {
  required: true,
  content: {
    "application/json": json,
    "text/csv": { schema: { type: "string", maxLength: 1_048_576 } }
  }
};
const responses = (status = 200, description = "Success") => ({
  [status]: { description, content: { "application/json": json } },
  default: problem
});
const read = (operationId: string, summary: string, tag: string, parameters: unknown[] = []) => ({
  operationId,
  summary,
  tags: [tag],
  ...(parameters.length ? { parameters } : {}),
  responses: responses()
});
const write = (operationId: string, summary: string, tag: string, status = 200) => ({
  operationId,
  summary,
  tags: [tag],
  requestBody,
  responses: responses(status)
});
const query = (name: string, required = false) => ({
  name,
  in: "query",
  required,
  schema: { type: "string", maxLength: 255 }
});

const openapi = {
  openapi: "3.1.2",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "LIP Reference Platform API",
    version: "0.3.0-beta",
    description:
      "Non-normative customer engagement product API. The portable loyalty transaction contract remains at /lip/v1.",
    license: { name: "Apache-2.0", identifier: "Apache-2.0" }
  },
  servers: [{ url: "https://loyalty.example.com/platform/v1" }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: "Discovery" },
    { name: "Members" },
    { name: "Events" },
    { name: "Segments" },
    { name: "Campaigns" },
    { name: "Connectors" },
    { name: "Analytics" },
    { name: "Imports" }
  ],
  paths: {
    "/": {
      get: read("getPlatformApi", "Discover platform resources and protocol boundaries", "Discovery")
    },
    "/members": {
      get: read("listCustomerProfiles", "List customer profiles and consent", "Members"),
      put: write("upsertCustomerProfile", "Upsert a customer profile and consent", "Members")
    },
    "/events": {
      get: read("listCustomerEvents", "List behavioral events", "Events", [
        query("member_id"), query("type"), query("campaign_id"), query("limit")
      ]),
      post: write("ingestCustomerEvent", "Ingest an idempotent behavioral event", "Events", 201)
    },
    "/segments": {
      get: read("listSegments", "List audience segments", "Segments"),
      put: write("upsertSegment", "Upsert a static or dynamic audience segment", "Segments")
    },
    "/segments/preview": {
      post: write("previewSegment", "Count and sample a segment", "Segments")
    },
    "/campaigns": {
      get: read("listCampaigns", "List campaigns", "Campaigns"),
      put: write("upsertCampaign", "Upsert a reward campaign", "Campaigns")
    },
    "/campaigns/status": {
      post: write("setCampaignStatus", "Set draft, active, or paused status", "Campaigns")
    },
    "/campaigns/run": {
      post: write("runCampaign", "Run an active campaign", "Campaigns")
    },
    "/campaigns/report": {
      get: read("getCampaignAttribution", "Get campaign attribution", "Campaigns", [
        query("campaign_id", true)
      ])
    },
    "/connectors": {
      get: read("listConnectors", "List connectors with secrets redacted", "Connectors"),
      put: write("upsertConnector", "Upsert a connector", "Connectors")
    },
    "/connectors/delete": {
      post: write("deleteConnector", "Delete a connector", "Connectors")
    },
    "/analytics": {
      get: read("getPlatformAnalytics", "Get customer and loyalty analytics", "Analytics")
    },
    "/imports/members": {
      post: {
        operationId: "importMembers",
        summary: "Import up to 1,000 members from JSON rows or bounded CSV",
        tags: ["Imports"],
        requestBody: csvOrJsonRequestBody,
        responses: responses(201)
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" }
    },
    responses: {
      Problem: {
        description: "RFC 9457 problem details",
        content: {
          "application/problem+json": {
            schema: {
              type: "object",
              required: ["type", "title", "status"],
              properties: {
                type: { type: "string", format: "uri-reference" },
                title: { type: "string" },
                status: { type: "integer", minimum: 400, maximum: 599 },
                detail: { type: "string" },
                code: { type: "string" }
              }
            }
          }
        }
      }
    }
  },
  "x-lip-non-normative": true
};

const output = YAML.stringify(openapi, { lineWidth: 100 });
await writeFile(resolve(root, "spec/platform-openapi.yaml"), output);
await writeFile(resolve(root, "docs-site/api-reference/platform-openapi.yaml"), output);
