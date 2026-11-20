import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Company from "@src/models/Company";
import CompanyMember from "@src/models/CompanyMember";
import User from "@src/models/User";
import UserPasskey from "@src/models/UserPasskey";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import PasskeyService from "@src/services/PasskeyService";
import { table } from "@src/services/recoveryTestDb";
import { meetsTwoFactorRule } from "@src/services/twoFactorRule";

let db: Record<string, any[]>;

// Acme (7) requires 2FA. Olga (1) uses an authenticator app, Pat (2) only a passkey, Lu (3) neither.
beforeEach(() => {
  CompanyPolicyService.clear();
  db = {
    users: table(User, [
      { id: 1, email: "olga@acme.com", username: "olga", twoFactorEnabled: true },
      { id: 2, email: "pat@acme.com", username: "pat", twoFactorEnabled: false },
      { id: 3, email: "lu@acme.com", username: "lu", twoFactorEnabled: false },
    ]),
    passkeys: table(UserPasskey, [{ id: 10, userId: 2, credentialId: "c", name: "Phone" }]),
    companies: table(Company, [{ id: 7, name: "Acme", status: "active", policies: { require2fa: true } }]),
    members: table(CompanyMember, [
      { id: 11, companyId: 7, userId: 1, role: "owner", status: "active" },
      { id: 12, companyId: 7, userId: 2, role: "admin", status: "active" },
      { id: 13, companyId: 7, userId: 3, role: "member", status: "active" },
    ]),
  };
});

afterEach(() => vi.restoreAllMocks());

describe("F15: who meets the company's 2FA rule", () => {
  it("an authenticator app or a passkey counts", async () => {
    expect([...(await meetsTwoFactorRule([1, 2, 3]))].sort()).toEqual([1, 2]);
  });

  it("a passkey-only member isn't blocked; someone with neither is", async () => {
    expect((await CompanyPolicyService.forUser(2)).blocked.has(7)).toBe(false);
    expect((await CompanyPolicyService.forUser(3)).blocked.has(7)).toBe(true);
  });

  it("the Policies page lists only people with neither", async () => {
    vi.spyOn(CompanyMember, "findAll").mockResolvedValue(
      db.users.map((user) => ({ get: () => user })) as never
    );
    const { without2fa } = await CompanyPolicyService.get(7, 1);
    expect(without2fa.map((person) => person.id)).toEqual([3]);
  });

  it("removing the last passkey blocks them again straight away (cache cleared)", async () => {
    expect((await CompanyPolicyService.forUser(2)).blocked.has(7)).toBe(false);
    await PasskeyService.remove(2, 10);
    expect((await CompanyPolicyService.forUser(2)).blocked.has(7)).toBe(true);
  });
});
