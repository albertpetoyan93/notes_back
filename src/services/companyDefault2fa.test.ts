import { afterEach, describe, expect, it, vi } from "vitest";
import sequelize from "@src/configs/DB/sequelize";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import User from "@src/models/User";
import UserPasskey from "@src/models/UserPasskey";
import CompanyBilling from "@src/services/CompanyBilling";
import CompanyService from "@src/services/CompanyService";
import { table } from "@src/services/recoveryTestDb";

afterEach(() => vi.restoreAllMocks());

const setUp = (creator: Record<string, unknown>, passkeys: any[] = []) => {
  vi.spyOn(sequelize, "transaction").mockResolvedValue({ commit: vi.fn(), rollback: vi.fn() } as never);
  vi.spyOn(CompanyBilling, "startTrial").mockResolvedValue(null as never);
  table(User, [{ id: 1, email: "olga@acme.com", ...creator }]);
  table(UserPasskey, passkeys);
  const companies = table(Company, []);
  table(CompanyMember, []);
  return companies;
};

describe("F15: new companies require two-factor sign-in by default", () => {
  it("on when the creator already uses an authenticator app or a passkey", async () => {
    const companies = setUp({ twoFactorEnabled: false }, [{ id: 1, userId: 1, credentialId: "c", name: "Phone" }]);
    const summary = await CompanyService.create(1, "Acme");
    expect(companies[0].policies).toMatchObject({ require2fa: true });
    expect(summary.policies).toMatchObject({ require2fa: true });
  });

  it("off when the creator has neither, so they aren't locked out of their own company", async () => {
    const companies = setUp({ twoFactorEnabled: false });
    const summary = await CompanyService.create(1, "Acme");
    expect(companies[0].policies?.require2fa).toBeFalsy();
    expect(summary.policies.require2fa).toBeFalsy();
  });
});
