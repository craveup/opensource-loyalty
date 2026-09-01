import { describe, expect, it } from "vitest";
import { adminPath } from "./admin-path.js";

describe("Admin mounted paths", () => {
  it("preserves a managed environment prefix for browser API calls", () => {
    expect(adminPath(
      "/admin/api/v1/bootstrap",
      "/runtime/v1/environments/env-alpha/admin/"
    )).toBe("/runtime/v1/environments/env-alpha/admin/api/v1/bootstrap");
  });

  it("keeps standalone Admin paths unchanged", () => {
    expect(adminPath("/admin/api/v1/session", "/admin/")).toBe(
      "/admin/api/v1/session"
    );
  });
});
