import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/services/admin/StaffService", () => ({ default: { roleOf: vi.fn() } }));
vi.mock("@src/services/admin/AdminActionService", () => ({ default: { record: vi.fn() } }));
vi.mock("@src/services/TwoFactorService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/services/TwoFactorService")>();
  return { ...actual, default: { verify: vi.fn() } };
});
vi.mock("@src/services/PasskeyService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/services/PasskeyService")>();
  return { ...actual, default: { count: vi.fn(), authenticationOptions: vi.fn(), authenticate: vi.fn() } };
});
vi.mock("@src/services/SessionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/services/SessionService")>();
  return { ...actual, default: { create: vi.fn(), rotate: vi.fn(), revoke: vi.fn(), revokeByToken: vi.fn() } };
});
vi.mock("@src/services/AuditService", () => ({ default: { record: vi.fn() } }));

import jwt from "jsonwebtoken";
import EnvVars from "@src/common/EnvVars";
import User from "@src/models/User";
import AuthService from "@src/services/AuthService";
import StaffService from "@src/services/admin/StaffService";
import AdminActionService from "@src/services/admin/AdminActionService";
import TwoFactorService from "@src/services/TwoFactorService";
import AuditService from "@src/services/AuditService";
import PasskeyService, { PasskeyError } from "@src/services/PasskeyService";
import SessionService, { RefreshError } from "@src/services/SessionService";
import AdminAuthController from "./AdminAuthController";
import AuthController from "./AuthController";

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.send = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.cookie = vi.fn(() => res);
  res.clearCookie = vi.fn(() => res);
  return res;
}

function mockReq(body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any {
  return { body, cookies: {}, ip: "127.0.0.1", get: () => "vitest", ...extra };
}

async function run(handler: any, req: any) {
  const res = mockRes();
  const next = vi.fn();
  await handler(req, res, next);
  // Failed attempts are logged after the response; let that settle.
  await new Promise((resolve) => setImmediate(resolve));
  return { res, next };
}

const staffUser = (extra: Record<string, unknown> = {}) =>
  ({
    id: 1,
    email: "s@x.com",
    username: "sam",
    fullName: "Sam Staff",
    twoFactorEnabled: true,
    suspendedAt: null,
    e2eEnabled: false,
    ...extra,
  }) as never;

const tokens = { accessToken: "acc", refreshToken: "ref", sessionId: 5 };

const cookieNames = (res: any) => res.cookie.mock.calls.map((call: any[]) => call[0]);

// Everything written to the admin log except the request itself.
const storedDetails = () =>
  vi.mocked(AdminActionService.record).mock.calls.map(([{ req: _req, ...rest }]) => rest);

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  process.env.ADMIN_EMAILS = "boss@x.com";
});

describe("POST /login", () => {
  it("answers 403 needs_second_factor for staff without 2FA or a passkey, and sets no cookie", async () => {
    vi.spyOn(AuthService, "login").mockResolvedValue(staffUser({ twoFactorEnabled: false }));
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(PasskeyService.count).mockResolvedValue(0);
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "needs_second_factor" }));
    expect(res.cookie).not.toHaveBeenCalled();
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  it("answers 403 not_staff for a user who is not staff", async () => {
    vi.spyOn(AuthService, "login").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue(null);
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "not_staff" }));
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("answers 403 use_passkey for staff without 2FA but with a passkey", async () => {
    vi.spyOn(AuthService, "login").mockResolvedValue(staffUser({ twoFactorEnabled: false }));
    vi.mocked(StaffService.roleOf).mockResolvedValue("admin");
    vi.mocked(PasskeyService.count).mockResolvedValue(2);
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "use_passkey" }));
  });

  it("issues an admin challenge for staff with 2FA, and no session", async () => {
    vi.spyOn(AuthService, "login").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.send.mock.calls[0][0];
    expect(body.twoFactorRequired).toBe(true);
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    await expect(AuthService.readLoginChallenge(body.challengeToken, "admin")).resolves.toBeTruthy();
    expect(SessionService.create).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("answers 403 suspended for a suspended account", async () => {
    vi.spyOn(AuthService, "login").mockResolvedValue(staffUser({ suspendedAt: new Date() }));
    vi.mocked(StaffService.roleOf).mockResolvedValue("admin");
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith({
      code: "suspended",
      message: "This account is suspended. Contact support.",
    });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  it("answers 401 and records admin_sign_in_failed for a wrong password on a staff email", async () => {
    vi.spyOn(AuthService, "login").mockRejectedValue(new Error("Invalid credentials"));
    vi.spyOn(User, "findOne").mockResolvedValue({ id: 1, email: "s@x.com" } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "typed-secret" }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: "Invalid credentials" });
    expect(AdminActionService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_sign_in_failed",
        staff: { userId: 1, email: "s@x.com", role: "support" },
      })
    );
    expect(JSON.stringify(storedDetails())).not.toContain("typed-secret");
  });

  it("records admin_sign_in_failed for an ADMIN_EMAILS account without a staff row", async () => {
    vi.spyOn(AuthService, "login").mockRejectedValue(new Error("Invalid credentials"));
    vi.spyOn(User, "findOne").mockResolvedValue({ id: 2, email: "Boss@x.com" } as never);
    const { res } = await run(AdminAuthController.login, mockReq({ email: "Boss@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(AdminActionService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin_sign_in_failed", staff: { userId: 2, email: "Boss@x.com", role: "admin" } })
    );
  });

  it("gives the same 401 for a non-staff email, logs login_failed for the owner, and no admin row", async () => {
    vi.spyOn(AuthService, "login").mockRejectedValue(new Error("Invalid credentials"));
    vi.spyOn(User, "findOne").mockResolvedValue({ id: 3, email: "u@x.com" } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue(null);
    const req = mockReq({ email: "u@x.com", password: "pw" });
    const { res } = await run(AdminAuthController.login, req);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: "Invalid credentials" });
    expect(AuditService.record).toHaveBeenCalledWith({
      actorId: 3,
      action: "login_failed",
      details: { kind: "admin" },
      req,
    });
    expect(AdminActionService.record).not.toHaveBeenCalled();
  });

  it("sends the 401 before looking up the email, staff or not", async () => {
    vi.spyOn(AuthService, "login").mockRejectedValue(new Error("Invalid credentials"));
    const findOne = vi.spyOn(User, "findOne").mockResolvedValue({ id: 1, email: "s@x.com" } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.send.mock.invocationCallOrder[0]).toBeLessThan(findOne.mock.invocationCallOrder[0]);
    expect(res.send.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(AdminActionService.record).mock.invocationCallOrder[0]
    );
  });

  it("still answers 401 when the owner's activity log write throws", async () => {
    vi.spyOn(AuthService, "login").mockRejectedValue(new Error("Invalid credentials"));
    vi.spyOn(User, "findOne").mockResolvedValue({ id: 1, email: "s@x.com" } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(AuditService.record).mockRejectedValue(new Error("db down"));
    const { res, next } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(AdminActionService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin_sign_in_failed" })
    );
  });

  it("still answers 401 when recording the failed sign-in throws", async () => {
    vi.spyOn(AuthService, "login").mockRejectedValue(new Error("Invalid credentials"));
    vi.spyOn(User, "findOne").mockResolvedValue({ id: 1, email: "s@x.com" } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(AdminActionService.record).mockRejectedValue(new Error("db down"));
    const { res, next } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: "Invalid credentials" });
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 400 e2e_required when a master-password account sends no authKey", async () => {
    vi.spyOn(AuthService, "login").mockRejectedValue(new Error("E2E_REQUIRED"));
    const { res } = await run(AdminAuthController.login, mockReq({ email: "s@x.com", password: "pw" }));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "e2e_required" }));
  });
});

describe("POST /2fa", () => {
  const adminChallenge = () => AuthService.createLoginChallenge(staffUser(), "admin");

  it("creates an admin session, sets admin cookies and records admin_sign_in", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(TwoFactorService.verify).mockResolvedValue(true);
    vi.mocked(SessionService.create).mockResolvedValue(tokens);
    const req = mockReq({ challengeToken: adminChallenge(), code: "123456" });
    const { res } = await run(AdminAuthController.verifyTwoFactor, req);
    expect(SessionService.create).toHaveBeenCalledWith(1, "admin", expect.anything());
    expect(cookieNames(res)).toEqual(["admin_access", "admin_refresh"]);
    expect(AdminActionService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin_sign_in",
        staff: { userId: 1, email: "s@x.com", role: "support" },
        req,
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({
      staff: {
        userId: 1,
        email: "s@x.com",
        name: "Sam Staff",
        role: "support",
        permissions: ["overview", "users.view", "companies.view", "support.actions", "billing.cancel", "analytics.view"],
      },
    });
  });

  it("rejects a vault (web) challenge", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue("admin");
    vi.mocked(TwoFactorService.verify).mockResolvedValue(true);
    const challengeToken = AuthService.createLoginChallenge(staffUser(), "web");
    const { res } = await run(AdminAuthController.verifyTwoFactor, mockReq({ challengeToken, code: "123456" }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({
      code: "challenge_expired",
      message: "Sign-in expired. Enter your password again.",
    });
    expect(SessionService.create).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("is refused by the vault's /2fa/verify when given an admin challenge", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(TwoFactorService.verify).mockResolvedValue(true);
    const { res } = await run(AuthController.verifyTwoFactor, mockReq({ challengeToken: adminChallenge(), code: "123456" }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: "Sign-in expired. Enter your password again." });
    expect(SessionService.create).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("is refused by the extension's /2fa/verify when given an admin challenge", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(TwoFactorService.verify).mockResolvedValue(true);
    const { res } = await run(
      AuthController.extensionVerifyTwoFactor,
      mockReq({ challengeToken: adminChallenge(), code: "123456" })
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  it("answers 401 challenge_expired for an expired challenge, so the app asks for the password again", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    const challengeToken = jwt.sign({ type: "2fa", kind: "admin", userId: 1 }, EnvVars.Jwt.Secret, { expiresIn: -10 });
    const { res, next } = await run(AdminAuthController.verifyTwoFactor, mockReq({ challengeToken, code: "123456" }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({
      code: "challenge_expired",
      message: "Sign-in expired. Enter your password again.",
    });
    expect(next).not.toHaveBeenCalled();
    expect(TwoFactorService.verify).not.toHaveBeenCalled();
  });

  it("keeps a wrong code on the code step: 401 without challenge_expired", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(TwoFactorService.verify).mockResolvedValue(false);
    const { res } = await run(
      AdminAuthController.verifyTwoFactor,
      mockReq({ challengeToken: adminChallenge(), code: "000000" })
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send.mock.calls[0][0]).not.toHaveProperty("code");
  });

  it("answers 401 and records admin_sign_in_failed for a wrong code", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(TwoFactorService.verify).mockResolvedValue(false);
    vi.mocked(AdminActionService.record).mockRejectedValue(new Error("db down"));
    const { res, next } = await run(
      AdminAuthController.verifyTwoFactor,
      mockReq({ challengeToken: adminChallenge(), code: "999111" })
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: "That code is not valid." });
    expect(next).not.toHaveBeenCalled();
    expect(AdminActionService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin_sign_in_failed" })
    );
    expect(JSON.stringify(storedDetails())).not.toContain("999111");
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  it("logs two_factor_failed for the owner after sending the 401 for a wrong code", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(TwoFactorService.verify).mockResolvedValue(false);
    const req = mockReq({ challengeToken: adminChallenge(), code: "999111" });
    const { res } = await run(AdminAuthController.verifyTwoFactor, req);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(AuditService.record).toHaveBeenCalledWith({
      actorId: 1,
      action: "two_factor_failed",
      details: { kind: "admin" },
      req,
    });
    expect(res.send.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(AuditService.record).mock.invocationCallOrder[0]
    );
  });

  it("answers 403 suspended and creates no session", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser({ suspendedAt: new Date() }));
    vi.mocked(StaffService.roleOf).mockResolvedValue("admin");
    vi.mocked(TwoFactorService.verify).mockResolvedValue(true);
    const { res } = await run(
      AdminAuthController.verifyTwoFactor,
      mockReq({ challengeToken: adminChallenge(), code: "123456" })
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "suspended" }));
    expect(SessionService.create).not.toHaveBeenCalled();
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it("fails the sign-in and revokes the session when admin_sign_in cannot be recorded", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue(staffUser());
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(TwoFactorService.verify).mockResolvedValue(true);
    vi.mocked(SessionService.create).mockResolvedValue(tokens);
    const failure = new Error("db down");
    vi.mocked(AdminActionService.record).mockRejectedValue(failure);
    const { res, next } = await run(
      AdminAuthController.verifyTwoFactor,
      mockReq({ challengeToken: adminChallenge(), code: "123456" })
    );
    expect(next).toHaveBeenCalledWith(failure);
    expect(SessionService.revoke).toHaveBeenCalledWith(1, 5);
    expect(res.cookie).not.toHaveBeenCalled();
  });
});

describe("POST /passkey", () => {
  it("signs staff in with admin cookies and records admin_sign_in", async () => {
    vi.mocked(PasskeyService.authenticate).mockResolvedValue({
      user: staffUser({ twoFactorEnabled: false }),
      passkey: { name: "Laptop" },
    } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("marketing");
    vi.mocked(SessionService.create).mockResolvedValue(tokens);
    const { res } = await run(AdminAuthController.passkeyLogin, mockReq({ challengeToken: "t", response: {} }));
    expect(SessionService.create).toHaveBeenCalledWith(1, "admin", expect.anything());
    expect(cookieNames(res)).toEqual(["admin_access", "admin_refresh"]);
    expect(AdminActionService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin_sign_in", staff: { userId: 1, email: "s@x.com", role: "marketing" } })
    );
    expect(res.send).toHaveBeenCalledWith({
      staff: expect.objectContaining({ role: "marketing", permissions: ["overview", "analytics.view", "marketing.view"] }),
    });
  });

  it("answers 403 not_staff for a passkey of a non-staff user", async () => {
    vi.mocked(PasskeyService.authenticate).mockResolvedValue({ user: staffUser(), passkey: { name: "P" } } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue(null);
    const { res } = await run(AdminAuthController.passkeyLogin, mockReq({ challengeToken: "t", response: {} }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "not_staff" }));
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  it("answers 403 suspended for a suspended staffer", async () => {
    vi.mocked(PasskeyService.authenticate).mockResolvedValue({
      user: staffUser({ suspendedAt: new Date() }),
      passkey: { name: "P" },
    } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("admin");
    const { res } = await run(AdminAuthController.passkeyLogin, mockReq({ challengeToken: "t", response: {} }));
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "suspended" }));
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  it("answers 401 when the passkey does not verify", async () => {
    vi.mocked(PasskeyService.authenticate).mockRejectedValue(new PasskeyError("Could not verify this passkey. Try again."));
    const { res } = await run(AdminAuthController.passkeyLogin, mockReq({ challengeToken: "t", response: {} }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(SessionService.create).not.toHaveBeenCalled();
  });
});

describe("POST /refresh and /logout", () => {
  it("rotates the admin refresh cookie", async () => {
    vi.mocked(SessionService.rotate).mockResolvedValue(tokens);
    const req = mockReq({}, { cookies: { admin_refresh: "old" } });
    const { res } = await run(AdminAuthController.refresh, req);
    expect(SessionService.rotate).toHaveBeenCalledWith("old", "admin", expect.anything());
    expect(cookieNames(res)).toEqual(["admin_access", "admin_refresh"]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("clears admin cookies and answers 401 session_expired when refresh fails", async () => {
    vi.mocked(SessionService.rotate).mockRejectedValue(new RefreshError("session_expired"));
    const { res } = await run(AdminAuthController.refresh, mockReq({}, { cookies: { admin_refresh: "old" } }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "session_expired" }));
    expect(res.clearCookie.mock.calls.map((call: any[]) => call[0])).toEqual(["admin_access", "admin_refresh"]);
  });

  it("revokes the admin session and clears cookies on logout", async () => {
    const { res } = await run(AdminAuthController.logout, mockReq({}, { cookies: { admin_refresh: "tok" } }));
    expect(SessionService.revokeByToken).toHaveBeenCalledWith("tok", "admin");
    expect(res.clearCookie).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("answers 200 on logout when already signed out", async () => {
    const { res } = await run(AdminAuthController.logout, mockReq());
    expect(SessionService.revokeByToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("GET /me", () => {
  it("returns StaffMe for the signed-in staffer", async () => {
    vi.spyOn(User, "findByPk").mockResolvedValue({ id: 1, email: "s@x.com", username: "sam", fullName: "" } as never);
    const req = mockReq({}, { staff: { userId: 1, email: "s@x.com", role: "admin", sessionId: 5 } });
    const { res } = await run(AdminAuthController.me, req);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.send.mock.calls[0][0];
    expect(body.staff).toMatchObject({ userId: 1, email: "s@x.com", name: "sam", role: "admin" });
    expect(body.staff.permissions).toContain("staff.manage");
    expect(Object.keys(body.staff).sort()).toEqual(["email", "name", "permissions", "role", "userId"]);
  });
});
