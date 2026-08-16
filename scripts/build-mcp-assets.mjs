import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "packages/mcp/assets");
const entries = [
  "docs",
  "spec",
  "skills",
  "examples/typescript",
  "llms.txt",
  "llms-full.txt",
  "PLAN.md",
  "README.md"
];

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const entry of entries) {
  await cp(resolve(root, entry), resolve(target, entry), { recursive: true });
}
