import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures: string[] = [];

const readme = await readFile(join(root, "README.md"), "utf8");
const prohibitedReadmeCompetitorNames = [
  ["Pu", "nchh"].join(""),
  ["Olo", " Engage"].join("")
];
for (const competitorName of prohibitedReadmeCompetitorNames) {
  if (readme.toLocaleLowerCase("en-US").includes(competitorName.toLocaleLowerCase("en-US"))) {
    failures.push("README.md includes prohibited competitor naming");
  }
}
for (const [needle, label] of [
  ["docs/images/admin-overview.png", "verified Admin visual"],
  ["https://opensource-loyalty.vercel.app/#walkthrough", "browser walkthrough call to action"],
  ["Run checkout through refund in your browser", "primary newcomer path"]
] as const) requireText(readme, needle, `README ${label}`);
const readmeAdminVisual = await readFile(join(root, "docs/images/admin-overview.png")).catch(() => undefined);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
if (!readmeAdminVisual || readmeAdminVisual.length < 10_000 ||
    !readmeAdminVisual.subarray(0, pngSignature.length).equals(pngSignature)) {
  failures.push("README verified Admin visual is missing or invalid");
}

function requireText(value: string, needle: string, label: string): void {
  if (!value.includes(needle)) failures.push(`${label} is missing ${needle}`);
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => ![".git", "node_modules", "dist", "coverage", ".lip"].includes(entry.name))
    .map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }));
  return nested.flat();
}

const landing = await readFile(join(root, "landing/index.html"), "utf8");
for (const [needle, label] of [
  ['rel="canonical" href="https://opensource-loyalty.vercel.app/"', "canonical URL"],
  ['type="application/ld+json"', "structured data"],
  ['id="walkthrough"', "browser walkthrough"],
  ["Evaluate", "evaluate step"],
  ["Reserve", "reserve step"],
  ["Accrue", "accrue step"],
  ["Capture", "capture step"],
  ["Reverse", "reverse step"],
  ["Refund adjust", "adjustment step"],
  ["idempotency_key", "visible idempotency context"],
  ["Ledger / account effect", "ledger effects"],
  ["walkthrough_completed", "activation event"],
  ["white-space: pre-wrap", "mobile-safe code wrapping"],
  ["min-width: 0", "grid overflow containment"],
  ["overflow-x: hidden", "page overflow containment"],
  ["overflow: clip", "hero overflow containment"],
  ["Design partner", "design-partner path"],
  ["Self-host", "self-host path"],
  ["The open-source loyalty platform", "platform positioning"],
  ["Marketer workspace", "marketer workflow"],
  ["Reference guest wallet", "guest wallet"],
  ['name="posthog-key" content=""', "analytics disabled by default"],
  ['cookieless_mode: "always"', "cookieless analytics"],
  ['person_profiles: "never"', "anonymous analytics"],
  ["autocapture: false", "autocapture disabled"],
  ["disable_session_recording: true", "session recording disabled"],
  ["advanced_disable_flags: true", "PostHog remote flags disabled"],
  ["before_send", "analytics event allowlist"]
] as const) requireText(landing, needle, label);

if (/noindex/i.test(landing)) failures.push("landing must be indexable");
if (/white-space:\s*pre(?:;|\s)/.test(landing)) {
  failures.push("landing contains overflow-prone preformatted whitespace");
}
const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(landing)?.[1];
try {
  if (!jsonLd) throw new Error("missing JSON-LD block");
  JSON.parse(jsonLd);
} catch (error) {
  failures.push(`landing JSON-LD is invalid: ${error instanceof Error ? error.message : error}`);
}

const robots = await readFile(join(root, "landing/robots.txt"), "utf8");
const sitemap = await readFile(join(root, "landing/sitemap.xml"), "utf8");
requireText(robots, "Allow: /", "robots.txt");
requireText(robots, "https://opensource-loyalty.vercel.app/sitemap.xml", "robots.txt sitemap");
requireText(sitemap, "<loc>https://opensource-loyalty.vercel.app/</loc>", "sitemap canonical");

const technicalPages = [
  "docs/open-source-loyalty-api.md",
  "docs/restaurant-checkout-and-refunds.md",
  "docs/idempotency.md",
  "docs/ordering-adapters.md",
  "docs/member-migration.md",
  "docs/provider-selection.md",
  "docs/design-partners.md",
  "docs/security-and-operations.md",
  "docs/launch-kit.md",
  "docs/metrics.md",
  "docs/platform-api.md",
  "docs/wallet.md",
  "docs/square.md",
  "docs/deployment.md",
  "docs/telemetry.md",
  "docs/distribution.md",
  "llms.txt",
  "llms-full.txt"
];
for (const path of technicalPages) {
  const contents = await readFile(join(root, path), "utf8").catch(() => "");
  if (contents.length < 200) failures.push(`${path} is missing or not substantive`);
}

const docsNavigation = JSON.stringify(
  JSON.parse(await readFile(join(root, "docs-site/docs.json"), "utf8"))
);
for (const page of [
  "concepts/open-source-loyalty-api",
  "concepts/checkout-refunds",
  "concepts/idempotency",
  "guides/ordering-adapters",
  "guides/member-migration",
  "concepts/provider-selection",
  "about/design-partners",
  "about/security-operations",
  "guides/platform-api",
  "guides/wallet",
  "guides/square",
  "guides/deployment",
  "guides/telemetry",
  "api-reference/platform-overview"
]) requireText(docsNavigation, page, "docs navigation");

const textExtensions = new Set([
  ".md", ".mdx", ".json", ".yaml", ".yml", ".ts", ".tsx", ".js", ".mjs",
  ".html", ".txt", ".xml"
]);
const retiredRepositoryNamespaces = [
  ["alvinjchoi", "opensource-loyalty"].join("/"),
  ["craveup", "opensource-loyalty"].join("/")
];
for (const path of await files(root)) {
  if (!textExtensions.has(extname(path))) continue;
  const contents = await readFile(path, "utf8").catch(() => "");
  for (const retiredRepositoryNamespace of retiredRepositoryNamespaces) {
    if (contents.includes(retiredRepositoryNamespace)) {
      failures.push(`${relative(root, path)} references the retired repository namespace`);
    }
  }
}

const workspaceDirectories = await readdir(join(root, "packages"), { withFileTypes: true });
for (const entry of workspaceDirectories.filter((candidate) => candidate.isDirectory())) {
  const manifestPath = join(root, "packages", entry.name, "package.json");
  const manifest = await readFile(manifestPath, "utf8").catch(() => "");
  if (!manifest) continue;
  const value = JSON.parse(manifest) as { private?: boolean; version?: string };
  if (!value.private && value.version !== "0.2.0") {
    failures.push(`${relative(root, manifestPath)} must be version 0.2.0`);
  }
}

if (failures.length > 0) {
  console.error("Launch surface check failed:\n");
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log("Launch surface OK: canonical, crawl, walkthrough, docs, namespace, and versions.");
