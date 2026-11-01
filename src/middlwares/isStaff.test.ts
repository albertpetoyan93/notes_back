import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/models/UserSession", () => ({ default: { findOne: vi.fn(), update: vi.fn() } }));
vi.mock("@src/models/User", () => ({ default: { findByPk: vi.fn() } }));
vi.mock("@src/services/admin/StaffService", () => ({ default: { roleOf: vi.fn() } }));
vi.mock("@src/services/UserService", () => ({ default: { getUserById: vi.fn() } }));
vi.mock("@src/services/SessionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/services/SessionService")>();
  return { ...actual, default: { state: vi.fn() } };
});
vi.mock("@src/services/CompanyPolicyService", () => ({
  default: { forUser: vi.fn(), effectiveAutoLock: vi.fn() },
}));

import UserSession from "@src/models/UserSession";
import User from "@src/models/User";
import StaffService from "@src/services/admin/StaffService";
import UserService from "@src/services/UserService";
import SessionService from "@src/services/SessionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import isStaff from "./isStaff";
import isAuth from "./isAuth";
import requireStaff from "./requireStaff";

const SECRET = "test-jwt-secret";

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res;
}

async function run(handler: any, req: any) {
  const res = mockRes();
  const next = vi.fn();
  await handler(req, res, next);
  // isStaff hands its async work off; let it settle.
  await new Promise((resolve) => setImmediate(resolve));
  return { res, next };
}

const liveSession = () => ({
  id: 9,
  userId: 1,
  kind: "admin",
  createdAt: new Date(Date.now() - 60 * 1000),
  lastActiveAt: new Date(Date.now() - 5 * 60 * 1000),
});

const adminToken = () => jwt.sign({ userId: 1, type: "admin_access", sid: 9 }, SECRET);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isStaff", () => {
  it("rejects a vault access token in the admin_access cookie", async () => {
    const token = jwt.sign({ userId: 1, type: "access", sid: 9 }, SECRET);
    vi.mocked(UserSession.findOne).mockResolvedValue(liveSession() as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("admin");
    const { res, next } = await run(isStaff, { cookies: { admin_access: token } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "session_expired" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("ignores the vault access_token cookie", async () => {
    const { res, next } = await run(isStaff, { cookies: { access_token: adminToken() } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 403 not_staff when the user holds no staff role", async () => {
    vi.mocked(UserSession.findOne).mockResolvedValue(liveSession() as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue(null);
    const { res, next } = await run(isStaff, { cookies: { admin_access: adminToken() } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "not_staff" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 401 for an idle admin session", async () => {
    vi.mocked(UserSession.findOne).mockResolvedValue({
      ...liveSession(),
      lastActiveAt: new Date(Date.now() - 31 * 60 * 1000),
    } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("admin");
    const { res, next } = await run(isStaff, { cookies: { admin_access: adminToken() } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("sets req.staff and touches lastActiveAt for a live staff session", async () => {
    vi.mocked(UserSession.findOne).mockResolvedValue(liveSession() as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(User.findByPk).mockResolvedValue({ email: "s@x.com" } as never);
    const req: any = { cookies: { admin_access: adminToken() } };
    const { next } = await run(isStaff, req);
    expect(next).toHaveBeenCalled();
    expect(req.staff).toEqual({ userId: 1, email: "s@x.com", role: "support", sessionId: 9 });
    expect(UserSession.update).toHaveBeenCalledTimes(1);
  });

  it("does not touch lastActiveAt again within a minute", async () => {
    vi.mocked(UserSession.findOne).mockResolvedValue({
      ...liveSession(),
      lastActiveAt: new Date(Date.now() - 10 * 1000),
    } as never);
    vi.mocked(StaffService.roleOf).mockResolvedValue("support");
    vi.mocked(User.findByPk).mockResolvedValue({ email: "s@x.com" } as never);
    const { next } = await run(isStaff, { cookies: { admin_access: adminToken() } });
    expect(next).toHaveBeenCalled();
    expect(UserSession.update).not.toHaveBeenCalled();
  });
});

describe("isAuth", () => {
  it("rejects a Bearer admin_access token", async () => {
    vi.mocked(UserService.getUserById).mockResolvedValue({ id: 1, autoLockMinutes: 15 } as never);
    vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({} as never);
    vi.mocked(CompanyPolicyService.effectiveAutoLock).mockReturnValue(15);
    vi.mocked(SessionService.state).mockResolvedValue({ active: true, locked: false, kind: "admin" });
    const { res, next } = await run(isAuth, {
      method: "GET",
      headers: { authorization: `Bearer ${adminToken()}` },
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an access token that points at an admin session", async () => {
    const token = jwt.sign({ userId: 1, type: "access", sid: 9 }, SECRET);
    vi.mocked(UserService.getUserById).mockResolvedValue({ id: 1, autoLockMinutes: 15 } as never);
    vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({} as never);
    vi.mocked(CompanyPolicyService.effectiveAutoLock).mockReturnValue(15);
    vi.mocked(SessionService.state).mockResolvedValue({ active: true, locked: false, kind: "admin" });
    const { res, next } = await run(isAuth, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("still lets a web session through", async () => {
    const token = jwt.sign({ userId: 1, type: "access", sid: 9 }, SECRET);
    vi.mocked(UserService.getUserById).mockResolvedValue({ id: 1, autoLockMinutes: 15 } as never);
    vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({} as never);
    vi.mocked(CompanyPolicyService.effectiveAutoLock).mockReturnValue(15);
    vi.mocked(SessionService.state).mockResolvedValue({ active: true, locked: false, kind: "web" });
    const { next } = await run(isAuth, { method: "GET", headers: { authorization: `Bearer ${token}` } });
    expect(next).toHaveBeenCalled();
  });
});

describe("requireStaff", () => {
  it("answers 403 forbidden when the role lacks the permission", async () => {
    const { res, next } = await run(requireStaff("users.view"), {
      staff: { userId: 1, email: "m@x.com", role: "marketing", sessionId: 9 },
    });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ code: "forbidden" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("passes when the role holds the permission", async () => {
    const { next } = await run(requireStaff("users.view"), {
      staff: { userId: 1, email: "s@x.com", role: "support", sessionId: 9 },
    });
    expect(next).toHaveBeenCalled();
  });
});
