import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { Op } from "sequelize";

const { model } = vi.hoisted(() => ({
  model: () => ({
    findOne: vi.fn(),
    findByPk: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    destroy: vi.fn(),
  }),
}));

vi.mock("../../models/User", () => ({ default: model() }));
vi.mock("../../models/Company", () => ({ default: model() }));
vi.mock("../../models/CompanyMember", () => ({ default: model() }));
vi.mock("../../models/UserSession", () => ({ default: model() }));
vi.mock("../CompanyPolicyService", () => ({ default: { forUser: vi.fn() } }));
vi.mock("../SessionService", () => ({ default: { revokeAll: vi.fn(), revokeKinds: vi.fn() } }));
vi.mock("../AuthService", () => ({ default: { requestPasswordReset: vi.fn() } }));
vi.mock("../EmailService", () => ({ default: { sendSecurityNotice: vi.fn() } }));
vi.mock("../AuditService", () => ({ default: { record: vi.fn() } }));
vi.mock("./StaffService", () => ({ default: { roleOf: vi.fn() } }));
vi.mock("./AdminActionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AdminActionService")>()),
  default: { record: vi.fn() },
}));

import sequelize from "../../configs/DB/sequelize";
import Company from "../../models/Company";
import CompanyMember from "../../models/CompanyMember";
import User from "../../models/User";
import UserSession from "../../models/UserSession";
import AuditService from "../AuditService";
import AuthService from "../AuthService";
import CompanyPolicyService from "../CompanyPolicyService";
import EmailService from "../EmailService";
import SessionService from "../SessionService";
import AdminActionService from "./AdminActionService";
import StaffService from "./StaffService";
import SupportActionService from "./SupportActionService";

const m = {
  user: vi.mocked(User),
  company: vi.mocked(Company),
  member: vi.mocked(CompanyMember),
  sessions: vi.mocked(SessionService),
  auth: vi.mocked(AuthService),
  email: vi.mocked(EmailService),
  audit: vi.mocked(AuditService),
  staffRole: vi.mocked(StaffService.roleOf),
  actions: vi.mocked(AdminActionService),
  transaction: vi.spyOn(sequelize, "transaction") as unknown as ReturnType<typeof vi.fn>,
};

const staff = { userId: 1, email: "staff@2keevo.test", role: "support" as const, sessionId: 9 };
const req = { ip: "127.0.0.1", get: () => "test" } as unknown as Request;
const target = (over: Record<string, unknown> = {}) => ({
  id: 5,
  email: "user@example.test",
  suspendedAt: null,
  e2eEnabled: false,
  ...over,
});
const TX = { id: "tx" };

beforeEach(() => {
  vi.resetAllMocks();
  m.user.findByPk.mockResolvedValue(target() as never);
  m.user.update.mockResolvedValue([1] as never);
  m.staffRole.mockResolvedValue(null);
  m.email.sendSecurityNotice.mockResolvedValue(true as never);
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(TX));
});

const noWrites = () => {
  expect(m.user.update).not.toHaveBeenCalled();
  expect(m.member.update).not.toHaveBeenCalled();
  expect(m.sessions.revokeAll).not.toHaveBeenCalled();
  expect(m.sessions.revokeKinds).not.toHaveBeenCalled();
  expect(m.auth.requestPasswordReset).not.toHaveBeenCalled();
  expect(m.actions.record).not.toHaveBeenCalled();
  expect(m.audit.record).not.toHaveBeenCalled();
  expect(m.email.sendSecurityNotice).not.toHaveBeenCalled();
};

describe("reasons and targets", () => {
  it("a blank reason is 400 and writes nothing", async () => {
    await expect(SupportActionService.signOutAll(staff, 5, "   ", req)).rejects.toMatchObject({ status: 400 });
    expect(m.user.findByPk).not.toHaveBeenCalled();
    noWrites();
  });

  it("a missing user is 404 and writes nothing", async () => {
    m.user.findByPk.mockResolvedValue(null as never);
    await expect(SupportActionService.unsuspend(staff, 5, "asked", req)).rejects.toMatchObject({
      status: 404,
      message: "User not found.",
    });
    noWrites();
  });
});

describe("suspend", () => {
  it("a wrong confirmEmail is 400 and does not call User.update", async () => {
    await expect(SupportActionService.suspend(staff, 5, "fraud", "other@example.test", req)).rejects.toMatchObject({ status: 400 });
    expect(m.user.update).not.toHaveBeenCalled();
    noWrites();
  });

  it("refuses a staff member with 409", async () => {
    m.staffRole.mockResolvedValue("admin");
    await expect(SupportActionService.suspend(staff, 5, "fraud", "user@example.test", req)).rejects.toMatchObject({ status: 409 });
    noWrites();
  });

  it("refuses suspending yourself with 409", async () => {
    m.user.findByPk.mockResolvedValue(target({ id: 1, email: "staff@2keevo.test" }) as never);
    await expect(SupportActionService.suspend(staff, 1, "test", "staff@2keevo.test", req)).rejects.toMatchObject({ status: 409 });
    noWrites();
  });

  it("refuses an already suspended user with 409", async () => {
    m.user.findByPk.mockResolvedValue(target({ suspendedAt: new Date() }) as never);
    await expect(SupportActionService.suspend(staff, 5, "fraud", "USER@example.test", req)).rejects.toMatchObject({
      status: 409,
      message: "Already suspended.",
    });
    noWrites();
  });

  it("sets suspendedAt before revoking every session, then logs and tells the user", async () => {
    await SupportActionService.suspend(staff, 5, " fraud ", " User@Example.test ", req);
    const [change, options] = m.user.update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(change.suspendedAt).toBeInstanceOf(Date);
    expect(options.where).toEqual({ id: 5, suspendedAt: null });
    expect(m.sessions.revokeAll).toHaveBeenCalledWith(5);
    expect(m.user.update.mock.invocationCallOrder[0]).toBeLessThan(m.sessions.revokeAll.mock.invocationCallOrder[0]);
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_suspended", targetUserId: 5, reason: "fraud", req })
    );
    expect(m.audit.record).toHaveBeenCalledWith({
      actorId: 5,
      action: "support_action",
      details: { what: "2keevo support suspended your account." },
    });
    expect(m.email.sendSecurityNotice).toHaveBeenCalledWith({
      to: "user@example.test",
      what: "2keevo support suspended your account.",
    });
  });

  it("still records user_suspended when revoking the sessions fails, and rethrows", async () => {
    const boom = new Error("db down");
    m.sessions.revokeAll.mockRejectedValue(boom);
    await expect(SupportActionService.suspend(staff, 5, "fraud", "user@example.test", req)).rejects.toBe(boom);
    expect(m.user.update).toHaveBeenCalled();
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user_suspended", targetUserId: 5, reason: "fraud" })
    );
  });
});

describe("unsuspend", () => {
  it("refuses a user who is not suspended with 409", async () => {
    await expect(SupportActionService.unsuspend(staff, 5, "appeal", req)).rejects.toMatchObject({
      status: 409,
      message: "Not suspended.",
    });
    noWrites();
  });

  it("clears suspendedAt, logs and tells the user", async () => {
    m.user.findByPk.mockResolvedValue(target({ suspendedAt: new Date() }) as never);
    await SupportActionService.unsuspend(staff, 5, "appeal", req);
    expect(m.user.update.mock.calls[0][0]).toEqual({ suspendedAt: null });
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "user_unsuspended", targetUserId: 5 }));
    expect(m.email.sendSecurityNotice).toHaveBeenCalledWith({
      to: "user@example.test",
      what: "2keevo support restored your account.",
    });
  });
});

describe("signOutAll", () => {
  it("revokes web and extension sessions only, records the AdminAction and the user's event, and emails them", async () => {
    await SupportActionService.signOutAll(staff, 5, "lost phone", req);
    expect(m.sessions.revokeKinds).toHaveBeenCalledWith(5, ["web", "extension"]);
    expect(m.sessions.revokeAll).not.toHaveBeenCalled();
    expect(m.actions.record).toHaveBeenCalledWith({
      staff: { userId: 1, email: "staff@2keevo.test", role: "support" },
      action: "sessions_revoked",
      targetUserId: 5,
      reason: "lost phone",
      req,
    });
    expect(m.audit.record).toHaveBeenCalledWith({
      actorId: 5,
      action: "support_action",
      details: { what: "2keevo support signed you out on all devices." },
    });
    expect(m.email.sendSecurityNotice).toHaveBeenCalledWith({
      to: "user@example.test",
      what: "2keevo support signed you out on all devices.",
    });
  });

  it("an email failure does not fail the action", async () => {
    m.email.sendSecurityNotice.mockRejectedValue(Object.assign(new Error("Could not send the email"), { status: 502 }));
    await expect(SupportActionService.signOutAll(staff, 5, "lost phone", req)).resolves.toBeUndefined();
    expect(m.sessions.revokeKinds).toHaveBeenCalled();
    expect(m.actions.record).toHaveBeenCalled();
    expect(m.audit.record).toHaveBeenCalled();
  });
});

describe("sendPasswordReset", () => {
  it("sends the normal reset email and records only the AdminAction", async () => {
    await SupportActionService.sendPasswordReset(staff, 5, "locked out", req);
    expect(m.auth.requestPasswordReset).toHaveBeenCalledWith("user@example.test");
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "password_reset_sent", targetUserId: 5, reason: "locked out" })
    );
    expect(m.audit.record).not.toHaveBeenCalled();
    expect(m.email.sendSecurityNotice).not.toHaveBeenCalled();
  });
});

describe("transferCompanyOwnership", () => {
  const owner = { id: 11, companyId: 7, userId: 2, role: "owner", status: "active" };
  const newMember = (over: Record<string, unknown> = {}) => ({ id: 12, companyId: 7, userId: 5, role: "member", status: "active", ...over });

  beforeEach(() => {
    m.company.findByPk.mockResolvedValue({ id: 7, name: "Acme" } as never);
    m.user.findByPk.mockImplementation((async (id: number) =>
      id === 2 ? { id: 2, email: "old@acme.test" } : id === 5 ? { id: 5, email: "new@acme.test" } : null) as never);
    m.member.findOne.mockImplementation((async (options: { where: Record<string, unknown> }) =>
      options.where.role === "owner" ? owner : newMember()) as never);
  });

  it("a missing company is 404", async () => {
    m.company.findByPk.mockResolvedValue(null as never);
    await expect(SupportActionService.transferCompanyOwnership(staff, 7, 5, "owner left", req)).rejects.toMatchObject({ status: 404 });
    noWrites();
  });

  it("to a non-member is 409", async () => {
    m.member.findOne.mockImplementation((async (options: { where: Record<string, unknown> }) =>
      options.where.role === "owner" ? owner : null) as never);
    await expect(SupportActionService.transferCompanyOwnership(staff, 7, 5, "owner left", req)).rejects.toMatchObject({
      status: 409,
      message: "The new owner must be an active member.",
    });
    noWrites();
  });

  it("to an invited member is 409", async () => {
    m.member.findOne.mockImplementation((async (options: { where: Record<string, unknown> }) =>
      options.where.role === "owner" ? owner : newMember({ status: "invited" })) as never);
    await expect(SupportActionService.transferCompanyOwnership(staff, 7, 5, "owner left", req)).rejects.toMatchObject({ status: 409 });
    noWrites();
  });

  it("to the current owner is 409", async () => {
    await expect(SupportActionService.transferCompanyOwnership(staff, 7, 2, "owner left", req)).rejects.toMatchObject({ status: 409 });
    noWrites();
  });

  it("swaps the roles inside one transaction, logs for both users and emails both", async () => {
    await SupportActionService.transferCompanyOwnership(staff, 7, 5, "owner left", req);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.member.update).toHaveBeenCalledWith({ role: "admin" }, { where: { id: 11 }, transaction: TX });
    expect(m.member.update).toHaveBeenCalledWith({ role: "owner" }, { where: { id: 12 }, transaction: TX });
    expect(m.actions.record).toHaveBeenCalledWith({
      staff: { userId: 1, email: "staff@2keevo.test", role: "support" },
      action: "company_owner_transferred",
      targetCompanyId: 7,
      targetUserId: 5,
      reason: "owner left",
      details: { fromUserId: 2, toUserId: 5 },
      req,
    });
    expect(m.audit.record).toHaveBeenCalledWith({
      actorId: 5,
      action: "support_action",
      companyId: 7,
      details: { what: "2keevo support made you the owner of Acme." },
    });
    expect(m.audit.record).toHaveBeenCalledWith({
      actorId: 2,
      action: "support_action",
      companyId: 7,
      details: { what: "2keevo support moved ownership of Acme to new@acme.test." },
    });
    expect(m.email.sendSecurityNotice).toHaveBeenCalledWith({ to: "new@acme.test", what: "2keevo support made you the owner of Acme." });
    expect(m.email.sendSecurityNotice).toHaveBeenCalledWith({
      to: "old@acme.test",
      what: "2keevo support moved ownership of Acme to new@acme.test.",
    });
  });
});

describe("SessionService refuses suspended users", () => {
  const load = async () => (await vi.importActual<typeof import("../SessionService")>("../SessionService")).default;

  it("create rejects with 403", async () => {
    const Real = await load();
    m.user.findByPk.mockResolvedValue({ suspendedAt: new Date() } as never);
    await expect(Real.create(5, "web", {})).rejects.toMatchObject({
      status: 403,
      code: "suspended",
      message: "This account is suspended. Contact support.",
    });
    expect(vi.mocked(UserSession).create).not.toHaveBeenCalled();
    expect(m.user.findByPk.mock.calls[0][1]).toEqual({ attributes: ["suspendedAt"] });
  });

  it("rotate rejects with 403", async () => {
    const Real = await load();
    vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({ maxSessionDays: null } as never);
    m.user.findByPk.mockResolvedValue({ suspendedAt: new Date() } as never);
    vi.mocked(UserSession).findOne.mockResolvedValue({
      id: 6,
      userId: 5,
      kind: "web",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    } as never);
    const refresh = jwt.sign({ userId: 5, type: "refresh", sid: 6, jti: "abc" }, "test-jwt-secret");
    await expect(Real.rotate(refresh, "web", {})).rejects.toMatchObject({ status: 403, code: "suspended" });
    expect(vi.mocked(UserSession).update).not.toHaveBeenCalled();
  });
});

describe("SessionService.revokeKinds", () => {
  const load = async () => (await vi.importActual<typeof import("../SessionService")>("../SessionService")).default;

  it("destroys only web and extension sessions, so an admin session survives, and clears both legacy tokens", async () => {
    const Real = await load();
    const rows = [
      { id: 1, userId: 5, kind: "web" },
      { id: 2, userId: 5, kind: "extension" },
      { id: 3, userId: 5, kind: "admin" },
    ];
    await Real.revokeKinds(5, ["web", "extension"]);
    const where = (vi.mocked(UserSession).destroy.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({ userId: 5, kind: { [Op.in]: ["web", "extension"] } });
    const kinds = (where.kind as Record<symbol, string[]>)[Op.in];
    expect(rows.filter((row) => !kinds.includes(row.kind)).map((row) => row.kind)).toEqual(["admin"]);
    expect(m.user.update).toHaveBeenCalledWith(
      { refreshTokenId: null, extensionRefreshTokenId: null },
      { where: { id: 5 } }
    );
  });

  it("revokeAll still destroys every kind", async () => {
    const Real = await load();
    await Real.revokeAll(5);
    expect(vi.mocked(UserSession).destroy).toHaveBeenCalledWith({ where: { userId: 5 } });
  });
});
