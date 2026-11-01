import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { Op } from "sequelize";

const { model } = vi.hoisted(() => ({
  model: () => ({
    findOne: vi.fn(),
    findByPk: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  }),
}));

vi.mock("../../models/User", () => ({ default: model() }));
vi.mock("../../models/SupportRequest", () => ({ default: model() }));
vi.mock("../SessionService", () => ({ default: { revokeAll: vi.fn() } }));
vi.mock("../CompanyPolicyService", () => ({ default: { clear: vi.fn() } }));
vi.mock("../EmailService", () => ({
  default: { sendSecurityNotice: vi.fn(), sendRemoveTwoFactorConfirm: vi.fn() },
}));
vi.mock("../AuditService", () => ({ default: { record: vi.fn() } }));
vi.mock("./AdminActionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AdminActionService")>()),
  default: { record: vi.fn() },
}));

import sequelize from "../../configs/DB/sequelize";
import SupportRequestController from "../../controller/SupportRequestController";
import SupportRequest from "../../models/SupportRequest";
import User from "../../models/User";
import AuditService from "../AuditService";
import EmailService from "../EmailService";
import SessionService from "../SessionService";
import AdminActionService from "./AdminActionService";
import SupportRequestService from "./SupportRequestService";

const m = {
  user: vi.mocked(User),
  requests: vi.mocked(SupportRequest),
  sessions: vi.mocked(SessionService),
  email: vi.mocked(EmailService),
  audit: vi.mocked(AuditService),
  actions: vi.mocked(AdminActionService),
  transaction: vi.spyOn(sequelize, "transaction") as unknown as ReturnType<typeof vi.fn>,
};

const GONE = "This link has expired or was already used. Contact support for a new one.";
const staff = { userId: 1, email: "staff@2keevo.test", role: "support" as const, sessionId: 9 };
const req = { ip: "127.0.0.1", get: () => "test" } as unknown as Request;
const TX = { id: "tx", LOCK: { UPDATE: "UPDATE" } };
const HOUR = 60 * 60 * 1000;
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

const target = (over: Record<string, unknown> = {}) => ({
  id: 5,
  email: "user@example.test",
  twoFactorEnabled: true,
  ...over,
});
const pending = (over: Record<string, unknown> = {}) => ({
  id: 3,
  kind: "remove_2fa",
  userId: 5,
  status: "pending",
  tokenHash: hash("the-token"),
  expiresAt: new Date(Date.now() + HOUR),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.user.findByPk.mockResolvedValue(target() as never);
  m.user.update.mockResolvedValue([1] as never);
  m.requests.findOne.mockResolvedValue(null as never);
  m.requests.update.mockResolvedValue([1] as never);
  m.requests.create.mockImplementation((async (values: Record<string, unknown>) => ({ id: 3, ...values })) as never);
  m.email.sendSecurityNotice.mockResolvedValue(true as never);
  m.email.sendRemoveTwoFactorConfirm.mockResolvedValue(true as never);
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(TX));
});

const noWrites = () => {
  expect(m.requests.create).not.toHaveBeenCalled();
  expect(m.requests.update).not.toHaveBeenCalled();
  expect(m.user.update).not.toHaveBeenCalled();
  expect(m.actions.record).not.toHaveBeenCalled();
  expect(m.audit.record).not.toHaveBeenCalled();
  expect(m.email.sendRemoveTwoFactorConfirm).not.toHaveBeenCalled();
};

describe("requestTwoFactorRemoval", () => {
  it("a wrong confirmEmail is 400 and writes nothing", async () => {
    await expect(
      SupportRequestService.requestTwoFactorRemoval(staff, 5, "lost phone", "other@example.test", req)
    ).rejects.toMatchObject({ status: 400 });
    noWrites();
  });

  it("refuses with 409 when two-step sign-in is already off", async () => {
    m.user.findByPk.mockResolvedValue(target({ twoFactorEnabled: false }) as never);
    await expect(
      SupportRequestService.requestTwoFactorRemoval(staff, 5, "lost phone", "user@example.test", req)
    ).rejects.toMatchObject({ status: 409, message: "Two-step sign-in is already off." });
    noWrites();
  });

  it("refuses with 409 while a request is still waiting", async () => {
    m.requests.findOne.mockResolvedValue(pending() as never);
    await expect(
      SupportRequestService.requestTwoFactorRemoval(staff, 5, "lost phone", "user@example.test", req)
    ).rejects.toMatchObject({ status: 409, message: "A request is already waiting for the user." });
    noWrites();
  });

  it("an expired pending request is marked expired and doesn't block a new one", async () => {
    m.requests.findOne.mockResolvedValue(pending({ id: 2, expiresAt: new Date(Date.now() - HOUR) }) as never);
    await SupportRequestService.requestTwoFactorRemoval(staff, 5, "lost phone", "user@example.test", req);
    expect(m.requests.update).toHaveBeenCalledWith(
      { status: "expired" },
      { where: { id: 2, status: "pending" }, transaction: TX }
    );
    expect(m.requests.create).toHaveBeenCalledTimes(1);
  });

  it("locks the user row first, then checks for a waiting request inside the same transaction", async () => {
    await SupportRequestService.requestTwoFactorRemoval(staff, 5, "lost phone", "user@example.test", req);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.user.findByPk).toHaveBeenCalledWith(5, expect.objectContaining({ transaction: TX, lock: "UPDATE" }));
    expect(m.requests.findOne).toHaveBeenCalledWith(expect.objectContaining({ transaction: TX }));
    expect(m.user.findByPk.mock.invocationCallOrder[0]).toBeLessThan(m.requests.findOne.mock.invocationCallOrder[0]);
    expect(m.requests.create).toHaveBeenCalledWith(expect.anything(), { transaction: TX });
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ transaction: TX }));
  });

  it("a failed AdminAction write fails the request: the row rolls back and no email goes out", async () => {
    m.actions.record.mockRejectedValue(new Error("db down"));
    await expect(
      SupportRequestService.requestTwoFactorRemoval(staff, 5, "lost phone", "user@example.test", req)
    ).rejects.toThrow("db down");
    // The row was written in the transaction that failed, so Postgres drops it.
    expect(m.requests.create).toHaveBeenCalledWith(expect.anything(), { transaction: TX });
    expect(m.email.sendRemoveTwoFactorConfirm).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  it("stores only the SHA-256 of the emailed token, for 24 h, and keeps it out of the AdminAction", async () => {
    const before = Date.now();
    const result = await SupportRequestService.requestTwoFactorRemoval(staff, 5, " lost phone ", " User@Example.test ", req);
    const created = m.requests.create.mock.calls[0][0] as Record<string, any>;
    const { to, link, expiresAt } = m.email.sendRemoveTwoFactorConfirm.mock.calls[0][0];
    const token = new URL(link).searchParams.get("token")!;

    expect(to).toBe("user@example.test");
    expect(new URL(link).pathname).toBe("/auth/confirm-support");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.tokenHash).toBe(hash(token));
    expect(created.tokenHash).not.toBe(token);
    expect(created).toMatchObject({ kind: "remove_2fa", userId: 5, requestedBy: 1, reason: "lost phone" });
    expect(created.expiresAt.getTime() - before).toBeGreaterThanOrEqual(24 * HOUR - 1000);
    expect(created.expiresAt.getTime() - before).toBeLessThanOrEqual(24 * HOUR + 1000);
    expect(expiresAt).toBe(created.expiresAt);
    expect(result).toEqual({ id: 3, expiresAt: created.expiresAt });

    expect(m.actions.record).toHaveBeenCalledWith({
      staff: { userId: 1, email: "staff@2keevo.test", role: "support" },
      action: "remove_2fa_requested",
      targetUserId: 5,
      reason: "lost phone",
      details: { requestId: 3 },
      req,
      transaction: TX,
    });
    expect(JSON.stringify(m.actions.record.mock.calls)).not.toContain(token);
    expect(m.audit.record).toHaveBeenCalledWith({
      actorId: 5,
      action: "support_action",
      details: { what: "2keevo support asked to turn off two-step sign-in. Check your email to confirm." },
    });
  });

  it("an email failure does not fail the request", async () => {
    m.email.sendRemoveTwoFactorConfirm.mockRejectedValue(Object.assign(new Error("Could not send the email"), { status: 502 }));
    await expect(
      SupportRequestService.requestTwoFactorRemoval(staff, 5, "lost phone", "user@example.test", req)
    ).resolves.toMatchObject({ id: 3 });
    expect(m.actions.record).toHaveBeenCalled();
  });
});

describe("cancel", () => {
  it("refuses a request that isn't waiting with 409", async () => {
    m.requests.findByPk.mockResolvedValue(pending({ status: "confirmed" }) as never);
    await expect(SupportRequestService.cancel(staff, 3, "mistake", req)).rejects.toMatchObject({
      status: 409,
      message: "Only a waiting request can be cancelled.",
    });
    noWrites();
  });

  it("a missing request is 404", async () => {
    m.requests.findByPk.mockResolvedValue(null as never);
    await expect(SupportRequestService.cancel(staff, 3, "mistake", req)).rejects.toMatchObject({ status: 404 });
    noWrites();
  });

  it("marks a waiting request cancelled and logs it", async () => {
    m.requests.findByPk.mockResolvedValue(pending() as never);
    await SupportRequestService.cancel(staff, 3, "mistake", req);
    const [change, options] = m.requests.update.mock.calls[0] as [Record<string, unknown>, { where: Record<string, unknown> }];
    expect(change.status).toBe("cancelled");
    expect(change.decidedAt).toBeInstanceOf(Date);
    expect(options.where).toEqual({ id: 3, status: "pending" });
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "remove_2fa_cancelled", targetUserId: 5, reason: "mistake", details: { requestId: 3 } })
    );
  });
});

describe("confirm", () => {
  it("clears 2FA and every session in one transaction, then records the three events", async () => {
    m.requests.findOne.mockResolvedValue(pending() as never);
    await expect(SupportRequestService.confirm("the-token")).resolves.toEqual({ ok: true });

    expect(m.requests.findOne.mock.calls[0][0]).toMatchObject({ where: { tokenHash: hash("the-token") } });
    const [change, options] = m.requests.update.mock.calls[0] as [Record<string, unknown>, { where: any; transaction: unknown }];
    expect(change.status).toBe("confirmed");
    expect(change.decidedAt).toBeInstanceOf(Date);
    expect(options.where.id).toBe(3);
    expect(options.where.status).toBe("pending");
    expect(options.where.expiresAt[Op.gt]).toBeInstanceOf(Date);
    expect(options.transaction).toBe(TX);
    expect(m.user.update).toHaveBeenCalledWith(
      { twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: null, twoFactorLastStep: null },
      { where: { id: 5 }, transaction: TX }
    );
    expect(m.sessions.revokeAll).toHaveBeenCalledWith(5, undefined, TX);

    expect(m.actions.record).toHaveBeenCalledWith({
      staff: null,
      action: "remove_2fa_confirmed",
      targetUserId: 5,
      details: { requestId: 3 },
    });
    expect(m.audit.record).toHaveBeenCalledWith({
      actorId: 5,
      action: "support_action",
      details: { what: "2keevo support turned off two-step sign-in after you confirmed." },
    });
    expect(m.audit.record).toHaveBeenCalledWith({ actorId: 5, action: "two_factor_disabled" });
    expect(m.email.sendSecurityNotice).toHaveBeenCalledWith({
      to: "user@example.test",
      what: "2keevo support turned off two-step sign-in after you confirmed.",
    });
  });

  it("the same token twice: the second is 410 and 2FA is cleared once", async () => {
    m.requests.findOne.mockResolvedValue(pending() as never);
    // The second click lost the race: the row was already confirmed.
    m.requests.update.mockResolvedValueOnce([1] as never).mockResolvedValueOnce([0] as never);
    await SupportRequestService.confirm("the-token");
    await expect(SupportRequestService.confirm("the-token")).rejects.toMatchObject({ status: 410, message: GONE });
    expect(m.user.update).toHaveBeenCalledTimes(1);
    expect(m.sessions.revokeAll).toHaveBeenCalledTimes(1);

    m.requests.findOne.mockResolvedValue(pending({ status: "confirmed" }) as never);
    await expect(SupportRequestService.confirm("the-token")).rejects.toMatchObject({ status: 410, message: GONE });
    expect(m.user.update).toHaveBeenCalledTimes(1);
  });

  it("a token past expiresAt is 410 and the request is marked expired", async () => {
    m.requests.findOne.mockResolvedValue(pending({ expiresAt: new Date(Date.now() - 1000) }) as never);
    await expect(SupportRequestService.confirm("the-token")).rejects.toMatchObject({ status: 410, message: GONE });
    expect(m.requests.update).toHaveBeenCalledWith({ status: "expired" }, { where: { id: 3, status: "pending" } });
    expect(m.user.update).not.toHaveBeenCalled();
    expect(m.sessions.revokeAll).not.toHaveBeenCalled();
  });

  it("a cancelled request's token is 410 and touches nothing", async () => {
    m.requests.findOne.mockResolvedValue(pending({ status: "cancelled" }) as never);
    await expect(SupportRequestService.confirm("the-token")).rejects.toMatchObject({ status: 410, message: GONE });
    noWrites();
    expect(m.sessions.revokeAll).not.toHaveBeenCalled();
  });

  it("an unknown token is 410", async () => {
    await expect(SupportRequestService.confirm("nope")).rejects.toMatchObject({ status: 410, message: GONE });
    noWrites();
  });

  it("a failing notice after the commit still confirms", async () => {
    m.requests.findOne.mockResolvedValue(pending() as never);
    m.actions.record.mockRejectedValue(new Error("db down"));
    m.email.sendSecurityNotice.mockRejectedValue(new Error("smtp down"));
    await expect(SupportRequestService.confirm("the-token")).resolves.toEqual({ ok: true });
    expect(m.audit.record).toHaveBeenCalledWith({ actorId: 5, action: "two_factor_disabled" });
  });

  it("a failing two_factor_disabled event after the commit still confirms", async () => {
    m.requests.findOne.mockResolvedValue(pending() as never);
    m.audit.record.mockRejectedValue(new Error("db down"));
    await expect(SupportRequestService.confirm("the-token")).resolves.toEqual({ ok: true });
    expect(m.audit.record).toHaveBeenCalledWith({ actorId: 5, action: "two_factor_disabled" });
  });
});

describe("POST /api/auth/support-requests/confirm", () => {
  const mockRes = () => {
    const res: any = {};
    res.status = vi.fn(() => res);
    res.send = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res as Response & { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  };

  it.each([[{}], [{ token: "" }], [{ token: 42 }], [{ token: ["a"] }]])("answers 410 for %j", async (body) => {
    const res = mockRes();
    const next = vi.fn();
    await SupportRequestController.confirm({ body } as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.send).toHaveBeenCalledWith({ message: GONE });
    expect(next).not.toHaveBeenCalled();
    expect(m.requests.findOne).not.toHaveBeenCalled();
  });

  it("answers { ok: true } for a good token", async () => {
    m.requests.findOne.mockResolvedValue(pending() as never);
    const res = mockRes();
    await SupportRequestController.confirm({ body: { token: "the-token" } } as Request, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ ok: true });
  });
});
