import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface PackResult {
  id: string;
  files: Array<{ path: string }>;
}

const exec = promisify(execFile);
const workspaces: Array<{ name: string; entry: string; required?: string[] }> = [
  { name: "@loyalty-interchange/protocol", entry: "dist/index" },
  { name: "@loyalty-interchange/adapter-kit", entry: "dist/index" },
  { name: "@loyalty-interchange/reference", entry: "dist/index" },
  { name: "@loyalty-interchange/storage", entry: "dist/index" },
  { name: "@loyalty-interchange/storage-sqlite", entry: "dist/index" },
  {
    name: "@loyalty-interchange/storage-postgres",
    entry: "dist/index",
    required: ["migrations/001_normalized_engine.sql"]
  },
  {
    name: "@loyalty-interchange/server",
    entry: "dist/index",
    required: ["dist/admin/index.html"]
  },
  { name: "@loyalty-interchange/cli", entry: "dist/index" },
  { name: "@loyalty-interchange/sdk", entry: "dist/index" },
  { name: "@loyalty-interchange/identity", entry: "dist/index" },
  {
    name: "@loyalty-interchange/mcp",
    entry: "dist/server",
    required: [
      "assets/llms.txt",
      "assets/llms-full.txt",
      "assets/spec/openapi.yaml",
      "assets/skills/lip/SKILL.md"
    ]
  }
];

for (const workspace of workspaces) {
  const runPrepack = [
    "@loyalty-interchange/server",
    "@loyalty-interchange/mcp"
  ].includes(workspace.name);
  const { stdout } = await exec("npm", [
    "pack",
    "--dry-run",
    "--workspace",
    workspace.name,
    "--json",
    ...(runPrepack ? [] : ["--ignore-scripts"])
  ]);
  const jsonStart = stdout.lastIndexOf("\n[");
  const json = jsonStart >= 0 ? stdout.slice(jsonStart + 1) : stdout;
  const result = (JSON.parse(json) as PackResult[])[0];
  if (!result) throw new Error(`npm pack returned no result for ${workspace.name}`);
  const files = result.files.map((file) => file.path);
  for (const required of [
    "package.json",
    `${workspace.entry}.js`,
    `${workspace.entry}.d.ts`,
    ...(workspace.required ?? [])
  ]) {
    if (!files.includes(required)) {
      throw new Error(`${result.id} package is missing ${required}`);
    }
  }
  if (files.some((path) => path.endsWith(".tsbuildinfo"))) {
    throw new Error(`${result.id} package contains TypeScript build metadata`);
  }
  console.log(`${result.id}: ${files.length} files`);
}
