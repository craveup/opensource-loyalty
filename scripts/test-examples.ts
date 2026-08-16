import { LoyaltyEngine } from "@loyalty-interchange/reference";
import { createDemoProgram, startReferenceServer } from "@loyalty-interchange/server";

const apiKey = "lip-example-test-key";
const running = await startReferenceServer(new LoyaltyEngine(createDemoProgram()), { apiKey });

try {
  process.env.LIP_BASE_URL = running.url;
  process.env.LIP_API_KEY = apiKey;
  await import("../examples/typescript/full-lifecycle.js");
  const { runOrderingBffDemo } = await import("../examples/typescript/ordering-bff.js");
  await runOrderingBffDemo();
} finally {
  await running.close();
}
