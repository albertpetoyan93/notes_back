import { describe, expect, it } from "vitest";
import Note from "@src/models/Note";
import CompanyMember from "@src/models/CompanyMember";
import CompanyOffboarding from "@src/models/CompanyOffboarding";
import OffboardingTask from "@src/models/OffboardingTask";

describe("work item ownership models", () => {
  it("declares the offboarding tables", () => {
    expect(CompanyOffboarding.getTableName()).toBe("company_offboardings");
    expect(OffboardingTask.getTableName()).toBe("offboarding_tasks");
  });

  it("gives notes a company owner", () => {
    expect(Note.getAttributes().companyId).toBeDefined();
  });

  it("allows the suspended member status and tracks removal time", () => {
    const status: any = CompanyMember.getAttributes().status.type;
    expect(status.values).toEqual(["invited", "active", "suspended", "removed"]);
    expect(CompanyMember.getAttributes().removedAt).toBeDefined();
  });
});
