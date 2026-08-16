#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { schemaRegistry } from "@loyalty-interchange/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  CHECKOUT_FLOW,
  SDK_SNIPPETS,
  listApiOperations,
  readRepoFile,
  validateJsonPayload
} from "./lib.js";

function textResult(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

export function createLipMcpServer(): McpServer {
  const server = new McpServer(
    { name: "lip", version: "0.2.0" },
    {
      instructions: [
        "Loyalty Interchange Protocol (LIP) MCP server.",
        "Use lip_index and lip_read_doc before implementing loyalty features.",
        "LIP is a transaction protocol — customer auth lives in the app BFF, not LIP.",
        "When docs and spec/ disagree, spec/ is canonical."
      ].join(" ")
    }
  );

  server.registerTool(
    "lip_index",
    {
      description: "Return llms.txt — the compact LIP repo index for agents. Call this first.",
      inputSchema: z.object({})
    },
    async () => textResult(await readRepoFile("llms.txt"))
  );

  server.registerTool(
    "lip_read_doc",
    {
      description:
        "Read an allowed doc or spec file from the LIP repo (docs/, spec/, skills/, examples/typescript/, llms.txt, llms-full.txt).",
      inputSchema: z.object({
        path: z.string().describe("Repo-relative path, e.g. docs/using-lip-with-ai.md")
      })
    },
    async ({ path }) => textResult(await readRepoFile(path))
  );

  server.registerTool(
    "lip_list_api_operations",
    {
      description: "List HTTP operations from spec/openapi.yaml with method, path, tag, and summary.",
      inputSchema: z.object({})
    },
    async () => textResult(await listApiOperations())
  );

  server.registerTool(
    "lip_list_schemas",
    {
      description: "List JSON schema names accepted by lip validate and lip_validate_json.",
      inputSchema: z.object({})
    },
    async () => textResult(Object.keys(schemaRegistry).sort().join("\n"))
  );

  server.registerTool(
    "lip_validate_json",
    {
      description: "Validate a JSON payload string against a LIP schema (same as lip validate).",
      inputSchema: z.object({
        schema: z.string().describe("Schema name, e.g. FoodserviceOrder"),
        json: z.string().describe("JSON payload string")
      })
    },
    async ({ schema, json }) => {
      const result = validateJsonPayload(schema, json);
      if (result.ok) return textResult(`[pass] Valid ${schema}`);
      return textResult(`[fail] ${schema}\n${result.message}`);
    }
  );

  server.registerTool(
    "lip_checkout_flow",
    {
      description: "Return the normative foodservice checkout and refund lifecycle checklist.",
      inputSchema: z.object({})
    },
    async () => textResult(CHECKOUT_FLOW)
  );

  server.registerTool(
    "lip_sdk_snippet",
    {
      description:
        "Return a TypeScript SDK snippet for a LIP operation (enroll, evaluate, accrue, reserve, capture, reverse, adjust, webhook).",
      inputSchema: z.object({
        operation: z.enum([
          "enroll",
          "evaluate",
          "accrue",
          "reserve",
          "capture",
          "reverse",
          "adjust",
          "webhook"
        ])
      })
    },
    async ({ operation }) => textResult(SDK_SNIPPETS[operation] ?? "Unknown operation")
  );

  return server;
}

async function main(): Promise<void> {
  const server = createLipMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { REPO_ROOT } from "./lib.js";
