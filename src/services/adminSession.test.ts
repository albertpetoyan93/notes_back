import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../models/UserSession", () => ({
  default: { destroy: vi.fn(), create: vi.fn(), findOne: vi.fn(), update: vi.fn() },
}));
vi.mock("../models/User", () => ({ default: { findByPk: vi.fn(), update: vi.fn() } }));
vi.mock("./CompanyPolicyService", () => ({ default: { forUser: vi.fn() } }));

import UserSession from "../models/UserSession";
import CompanyPolicyService from "./CompanyPolicyService";
import SessionService, { ADMIN_IDLE_MS, ADMIN_MAX_MS, adminSessionUsable } from "./SessionService";

const sessions = vi.mocked(UserSession);
const MIN = 60 * 1000;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({ maxSessionDays: null } as never);
});

describe("adminSessionUsable", () => {
  const now = Date.now();

  it("is true after 29 minutes idle", () => {
    expect(adminSessionUsable({ createdAt: new Date(now - 60 * MIN), lastActiveAt: new Date(now - 29 * MIN) }, now)).toBe(true);
  });

  it("is false after 31 minutes idle", () => {
    expect(adminSessionUsable({ createdAt: new Date(now - 60 * MIN), lastActiveAt: new Date(now - 31 * MIN) }, now)).toBe(false);
  });

  it("is false 12 h 1 min after sign-in even if active a second ago", () => {
    expect(
      adminSessionUsable({ createdAt: new Date(now - 12 * 60 * MIN - MIN), lastActiveAt: new Date(now - 1000) }, now)
    ).toBe(false);
  });

  it("uses the documented limits", () => {
    expect(ADMIN_IDLE_MS).toBe(30 * 60 * 1000);
    expect(ADMIN_MAX_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe("SessionService admin sessions", () => {
  it("create caps an admin session at 12 hours and signs admin_access", async () => {
    sessions.create.mockResolvedValue({ id: 5 } as never);
    const before = Date.now();
    const tokens = await SessionService.create(1, "admin", {});
    const created = sessions.create.mock.calls[0][0] as { expiresAt: Date; kind: string };
    expect(created.kind).toBe("admin");
    expect(created.expiresAt.getTime() - before).toBeGreaterThanOrEqual(ADMIN_MAX_MS - 1000);
    expect(created.expiresAt.getTime() - before).toBeLessThanOrEqual(ADMIN_MAX_MS + 1000);
    expect(jwt.decode(tokens.accessToken)).toMatchObject({ userId: 1, type: "admin_access", sid: 5 });
  });

  it("rotate never extends an admin session and signs admin_access", async () => {
    const refresh = jwt.sign({ userId: 1, type: "refresh", sid: 5, jti: "abc" }, "test-jwt-secret");
    sessions.findOne.mockResolvedValue({
      id: 5,
      userId: 1,
      kind: "admin",
      expiresAt: new Date(Date.now() + 60 * MIN),
      createdAt: new Date(Date.now() - 10 * MIN),
      lastActiveAt: new Date(Date.now() - MIN),
    } as never);
    sessions.update.mockResolvedValue([1] as never);

    const tokens = await SessionService.rotate(refresh, "admin", {});
    const change = sessions.update.mock.calls[0][0] as Record<string, unknown>;
    expect(change).not.toHaveProperty("expiresAt");
    expect(jwt.decode(tokens.accessToken)).toMatchObject({ type: "admin_access", sid: 5 });
  });

  it("rotate refuses an idle admin session", async () => {
    const refresh = jwt.sign({ userId: 1, type: "refresh", sid: 5, jti: "abc" }, "test-jwt-secret");
    sessions.findOne.mockResolvedValue({
      id: 5,
      userId: 1,
      kind: "admin",
      expiresAt: new Date(Date.now() + 60 * MIN),
      createdAt: new Date(Date.now() - 60 * MIN),
      lastActiveAt: new Date(Date.now() - 31 * MIN),
    } as never);

    await expect(SessionService.rotate(refresh, "admin", {})).rejects.toMatchObject({ reason: "session_expired" });
    expect(sessions.update).not.toHaveBeenCalled();
  });

  it("rotate refuses an admin refresh token without a session id", async () => {
    const refresh = jwt.sign({ userId: 1, type: "refresh", jti: "abc" }, "test-jwt-secret");
    await expect(SessionService.rotate(refresh, "admin", {})).rejects.toMatchObject({ reason: "legacy_token" });
  });

  it("rotate still extends a web session and signs access", async () => {
    const refresh = jwt.sign({ userId: 1, type: "refresh", sid: 6, jti: "abc" }, "test-jwt-secret");
    sessions.findOne.mockResolvedValue({
      id: 6,
      userId: 1,
      kind: "web",
      expiresAt: new Date(Date.now() + 60 * MIN),
      createdAt: new Date(),
    } as never);
    sessions.update.mockResolvedValue([1] as never);

    const tokens = await SessionService.rotate(refresh, "web", {});
    expect(sessions.update.mock.calls[0][0]).toHaveProperty("expiresAt");
    expect(jwt.decode(tokens.accessToken)).toMatchObject({ type: "access" });
  });

  it("state reports the session kind", async () => {
    sessions.findOne.mockResolvedValue({ id: 5, kind: "admin" } as never);
    expect(await SessionService.state(5, 1, 15)).toMatchObject({ active: true, kind: "admin" });
  });
});
