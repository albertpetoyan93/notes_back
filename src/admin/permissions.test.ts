import { describe, expect, it } from "vitest";
import type { StaffRole } from "../models/AdminStaff";
import { can, permissionsFor } from "./permissions";

const expected = {
  admin: ["overview", "overview.revenue", "users.view", "companies.view", "support.actions", "billing.cancel", "billing.manage", "staff.manage", "analytics.view", "marketing.view"],
  support: ["overview", "users.view", "companies.view", "support.actions", "billing.cancel", "analytics.view"],
  marketing: ["overview", "analytics.view", "marketing.view"],
};

describe("permissions", () => {
  it.each(Object.entries(expected))("%s has exactly its permissions", (role, perms) => {
    expect(permissionsFor(role as StaffRole).sort()).toEqual([...perms].sort());
  });

  it("marketing cannot see users", () => expect(can("marketing", "users.view")).toBe(false));
});
