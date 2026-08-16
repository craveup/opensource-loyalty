import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@loyalty-interchange/adapter-kit": fileURLToPath(new URL("./packages/adapter-kit/src/index.ts", import.meta.url)),
      "@loyalty-interchange/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@loyalty-interchange/reference": fileURLToPath(new URL("./packages/reference/src/index.ts", import.meta.url)),
      "@loyalty-interchange/storage": fileURLToPath(new URL("./packages/storage/src/index.ts", import.meta.url)),
      "@loyalty-interchange/storage-sqlite": fileURLToPath(new URL("./packages/storage-sqlite/src/index.ts", import.meta.url)),
      "@loyalty-interchange/storage-postgres": fileURLToPath(new URL("./packages/storage-postgres/src/index.ts", import.meta.url)),
      "@loyalty-interchange/server": fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
      "@loyalty-interchange/cli": fileURLToPath(new URL("./packages/cli/src/index.ts", import.meta.url)),
      "@loyalty-interchange/identity": fileURLToPath(new URL("./packages/identity/src/index.ts", import.meta.url)),
      "@loyalty-interchange/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url))
    }
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/server/src/cli.ts",
        "packages/server/src/platform.ts",
        "packages/server/src/migration.ts",
        "packages/server/src/engagement.ts",
        "packages/cli/src/cli.ts",
        "packages/cli/src/mock.ts",
        "packages/mcp/src/**",
        "packages/storage-postgres/src/**"
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 75
      }
    },
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"]
  }
});
