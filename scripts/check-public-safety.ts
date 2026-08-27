import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface PublicSafetyRule {
  name: string;
  expression: RegExp;
}

const rules: PublicSafetyRule[] = [
  {
    name: "developer-local absolute path",
    expression: new RegExp("/(?:" + "Users|home" + ")/[A-Za-z0-9._-]+/")
  },
  {
    name: "internal issue identifier",
    expression: new RegExp("\\b" + "PLA" + "-[0-9]{2,}\\b")
  },
  {
    name: "AWS access key",
    expression: new RegExp("\\b(?:" + "AKIA|ASIA" + ")[A-Z0-9]{16}\\b")
  },
  {
    name: "GitHub access token",
    expression: new RegExp("\\b(?:" + "ghp_|gho_|github_pat_" + ")[A-Za-z0-9_]{20,}\\b")
  },
  {
    name: "OpenAI or Anthropic key",
    expression: new RegExp("\\b(?:" + "sk-(?:proj-)?|sk-ant-" + ")[A-Za-z0-9_-]{20,}\\b")
  },
  {
    name: "live Stripe secret",
    expression: new RegExp("\\b" + "sk_live_" + "[A-Za-z0-9]{16,}\\b")
  },
  {
    name: "Slack token",
    expression: new RegExp("\\b" + "xox[baprs]-" + "[A-Za-z0-9-]{16,}\\b")
  },
  {
    name: "private key material",
    expression: new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
  },
  {
    name: "private maintainer setup",
    expression: new RegExp(
      "\\b(?:" + ["Infi", "sical"].join("") + "|" + ["Crave", "team", "members"].join(" ") + ")\\b",
      "i"
    )
  }
];

const forbiddenTrackedFiles = new Set([".cursor/mcp.json", "skills-lock.json"]);
const { stdout } = await exec("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024
});
const tracked = stdout.split("\0").filter(Boolean);
const failures: string[] = [];

for (const path of tracked) {
  const buffer = await readFile(path).catch(() => undefined);
  if (!buffer) continue;
  if (forbiddenTrackedFiles.has(path)) {
    failures.push(`${path}: tracked machine-local configuration`);
    continue;
  }
  if (buffer.includes(0)) continue;
  const lines = buffer.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const rule of rules) {
      if (rule.expression.test(lines[index]!)) {
        failures.push(`${path}:${index + 1}: ${rule.name}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Public-safety check failed without printing matched values:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Public-safety check passed for ${tracked.length} tracked files.`);
}
