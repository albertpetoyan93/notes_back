import { describe, expect, it } from "vitest";
import Company from "@src/models/Company";
import * as CompanyRecovery from "@src/models/CompanyRecovery";

describe("vault recovery models (migration 051)", () => {
  it("map to their tables", () => {
    expect(CompanyRecovery.RecoveryCustodian.getTableName()).toBe("company_recovery_custodians");
    expect(CompanyRecovery.VaultRecoveryKey.getTableName()).toBe("company_vault_recovery");
    expect(CompanyRecovery.RecoveryRequest.getTableName()).toBe("company_recovery_requests");
  });

  it("gives companies a 24-hour waiting period by default", () => {
    expect(Company.getAttributes().recoveryWaitHours?.defaultValue).toBe(24);
  });

  it("no longer has members' user keys sealed to the company", () => {
    expect((CompanyRecovery as Record<string, unknown>).MemberRecovery).toBeUndefined();
  });
});
