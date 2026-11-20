import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../models/UserSession", () => ({
  default: { destroy: vi.fn(), create: vi.fn(), findOne: vi.fn(), update: vi.fn() },
}));
vi.mock("../models/User", () => ({ default: { findByPk: vi.fn(), update: vi.fn() } }));
vi.mock("./CompanyPolicyService", () => ({ default: { forUser: vi.fn() } }));
vi.mock("./AuditService", () => ({ default: { record: vi.fn() } }));

import UserSession from "../models/UserSession";
import CompanyPolicyService from "./CompanyPolicyService";
import AuditService from "./AuditService";
import SessionService, { EXTENSION_SESSION_MS, WEB_IDLE_MS } from "./SessionService";
import { REFRESH_MAX_AGE_MS } from "../util/authCookies";

const sessions = vi.mocked(UserSession);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const refresh = (jti = "abc", sid = 6) =>
  jwt.sign({ userId: 1, type: "refresh", sid, jti }, "test-jwt-secret");

/** A stored session whose current token is `current`. */
const stored = (fields: Record<string, unknown>) => {
  const row = {
    id: 6,
    userId: 1,
    kind: "web",
    expiresAt: new Date(Date.now() + HOUR),
    createdAt: new Date(Date.now() - 3 * DAY),
    lastActiveAt: new Date(Date.now() - MIN),
    destroy: vi.fn(),
    reload: vi.fn(),
    ...fields,
  };
  sessions.findOne.mockResolvedValue(row as never);
  return row;
};

const near = (value: Date, expected: number) =>
  expect(Math.abs(value.getTime() - (Date.now() + expected))).toBeLessThan(5000);

const lifetimeOf = (token: string | null) => {
  const payload = jwt.decode(token as string) as { exp: number; iat: number };
  return (payload.exp - payload.iat) * 1000;
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({ maxSessionDays: null } as never);
});

describe("F18: a web sign-in ends after 12 hours without use", () => {
  it("uses the agreed limits", () => {
    expect(WEB_IDLE_MS).toBe(12 * HOUR);
    expect(EXTENSION_SESSION_MS).toBe(7 * DAY);
    expect(REFRESH_MAX_AGE_MS).toBe(12 * HOUR);
  });

  it("a new web sign-in lasts 12 hours; the extension's 7 days", async () => {
    sessions.create.mockResolvedValue({ id: 5 } as never);
    const web = await SessionService.create(1, "web", {});
    near((sessions.create.mock.calls[0][0] as { expiresAt: Date }).expiresAt, 12 * HOUR);
    expect(lifetimeOf(web.refreshToken)).toBe(12 * HOUR);

    const extension = await SessionService.create(1, "extension", {});
    near((sessions.create.mock.calls[1][0] as { expiresAt: Date }).expiresAt, 7 * DAY);
    expect(lifetimeOf(extension.refreshToken)).toBe(7 * DAY);
  });

  it("12 h 1 min without input: signed out, and the session is gone", async () => {
    const row = stored({ lastActiveAt: new Date(Date.now() - 12 * HOUR - MIN) });
    await expect(SessionService.rotate(refresh(), "web", {})).rejects.toMatchObject({ reason: "idle_signed_out" });
    expect(row.destroy).toHaveBeenCalled();
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it("used 11 h 59 min ago (signed in 3 days ago): still signed in, for another 12 hours", async () => {
    stored({ lastActiveAt: new Date(Date.now() - 12 * HOUR + MIN) });
    sessions.update.mockResolvedValue([1] as never);
    const tokens = await SessionService.rotate(refresh(), "web", {});
    near((sessions.update.mock.calls[0][0] as { expiresAt: Date }).expiresAt, 12 * HOUR);
    expect(lifetimeOf(tokens.refreshToken)).toBe(12 * HOUR);
  });

  it("no recorded input: counts from sign-in", async () => {
    stored({ lastActiveAt: null, createdAt: new Date(Date.now() - 13 * HOUR) });
    await expect(SessionService.rotate(refresh(), "web", {})).rejects.toMatchObject({ reason: "idle_signed_out" });
  });

  it("the extension has no idle rule and keeps 7 days", async () => {
    stored({ kind: "extension", lastActiveAt: new Date(Date.now() - 2 * DAY) });
    sessions.update.mockResolvedValue([1] as never);
    const tokens = await SessionService.rotate(refresh(), "extension", {});
    near((sessions.update.mock.calls[0][0] as { expiresAt: Date }).expiresAt, 7 * DAY);
    expect(lifetimeOf(tokens.refreshToken)).toBe(7 * DAY);
  });
});

describe("F18: a reused refresh token ends that sign-in", () => {
  it("web, reused 31 s after rotation: signed out and logged", async () => {
    const row = stored({});
    sessions.update.mockResolvedValue([0] as never);
    row.reload.mockImplementation(async () => {
      Object.assign(row, { previousTokenHash: hashOf("abc"), rotatedAt: new Date(Date.now() - 31 * 1000) });
    });
    await expect(SessionService.rotate(refresh(), "web", {})).rejects.toMatchObject({ reason: "token_reused" });
    expect(row.destroy).toHaveBeenCalled();
    expect(AuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 1, action: "session_token_reused", details: expect.objectContaining({ kind: "web" }) })
    );
  });

  it("web, two tabs within 30 s: still fine, nothing logged", async () => {
    const row = stored({});
    sessions.update.mockResolvedValue([0] as never);
    row.reload.mockImplementation(async () => {
      Object.assign(row, { previousTokenHash: hashOf("abc"), rotatedAt: new Date(Date.now() - 5 * 1000) });
    });
    const tokens = await SessionService.rotate(refresh(), "web", {});
    expect(tokens.refreshToken).toBeNull();
    expect(row.destroy).not.toHaveBeenCalled();
    expect(AuditService.record).not.toHaveBeenCalled();
  });

  it("extension, two parts refreshing within 30 s: still fine, nothing logged", async () => {
    const row = stored({ kind: "extension" });
    sessions.update.mockResolvedValue([0] as never);
    row.reload.mockImplementation(async () => {
      Object.assign(row, { previousTokenHash: hashOf("abc"), rotatedAt: new Date(Date.now() - 5 * 1000) });
    });
    const tokens = await SessionService.rotate(refresh(), "extension", {});
    expect(tokens.refreshToken).toBeNull();
    expect(jwt.decode(tokens.accessToken)).toMatchObject({ type: "access", sid: 6 });
    expect(row.destroy).not.toHaveBeenCalled();
    expect(AuditService.record).not.toHaveBeenCalled();
  });

  it("extension, an old token: signed out and logged", async () => {
    const row = stored({ kind: "extension", previousTokenHash: "other" });
    sessions.update.mockResolvedValue([0] as never);
    await expect(SessionService.rotate(refresh(), "extension", {})).rejects.toMatchObject({ reason: "token_reused" });
    expect(row.destroy).toHaveBeenCalled();
    expect(AuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session_token_reused", details: expect.objectContaining({ kind: "extension" }) })
    );
  });
});

import crypto from "crypto";
function hashOf(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("F18: the owner sees it", () => {
  it("is an account event, listed in the person's activity", async () => {
    const { ACCOUNT_ACTIONS } = await vi.importActual<typeof import("./AuditService")>("./AuditService");
    expect(ACCOUNT_ACTIONS).toContain("session_token_reused");
  });
});

describe("F18 review fixes", () => {
  it("admin, two tabs within 30 s: still fine, nothing logged, still an admin token", async () => {
    const row = stored({ kind: "admin", createdAt: new Date(Date.now() - 10 * MIN) });
    sessions.update.mockResolvedValue([0] as never);
    row.reload.mockImplementation(async () => {
      Object.assign(row, { previousTokenHash: hashOf("abc"), rotatedAt: new Date(Date.now() - 5 * 1000) });
    });
    const tokens = await SessionService.rotate(refresh(), "admin", {});
    expect(tokens.refreshToken).toBeNull();
    expect(jwt.decode(tokens.accessToken)).toMatchObject({ type: "admin_access" });
    expect(row.destroy).not.toHaveBeenCalled();
    expect(AuditService.record).not.toHaveBeenCalled();
  });

  it("the last token again from the same device (its answer got lost): ended, logged as a probable lost answer", async () => {
    const row = stored({ kind: "extension", ip: "1.2.3.4", userAgent: "Chrome X" });
    sessions.update.mockResolvedValue([0] as never);
    row.reload.mockImplementation(async () => {
      Object.assign(row, { previousTokenHash: hashOf("abc"), rotatedAt: new Date(Date.now() - 20 * MIN) });
    });
    await expect(
      SessionService.rotate(refresh(), "extension", { ip: "1.2.3.4", userAgent: "Chrome X" })
    ).rejects.toMatchObject({ reason: "token_reused" });
    expect(row.destroy).toHaveBeenCalled();
    // Still in the person's activity, worded as a probable lost answer.
    expect(AuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "session_token_reused", details: { kind: "extension", likelyLostAnswer: true } })
    );
  });

  it("logs the reuse even if ending the session fails", async () => {
    const row = stored({ kind: "extension", previousTokenHash: "other" });
    row.destroy.mockRejectedValue(new Error("db down"));
    sessions.update.mockResolvedValue([0] as never);
    await expect(SessionService.rotate(refresh(), "extension", {})).rejects.toBeTruthy();
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "session_token_reused" }));
  });

  it("the last token again from somewhere else: ended and logged", async () => {
    const row = stored({ kind: "extension", ip: "1.2.3.4", userAgent: "Chrome X" });
    sessions.update.mockResolvedValue([0] as never);
    row.reload.mockImplementation(async () => {
      Object.assign(row, { previousTokenHash: hashOf("abc"), rotatedAt: new Date(Date.now() - 20 * MIN) });
    });
    await expect(
      SessionService.rotate(refresh(), "extension", { ip: "9.9.9.9", userAgent: "Chrome X" })
    ).rejects.toMatchObject({ reason: "token_reused" });
    expect(AuditService.record).toHaveBeenCalledWith(expect.objectContaining({ action: "session_token_reused" }));
  });
});
