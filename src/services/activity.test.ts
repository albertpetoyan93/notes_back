import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/configs/DB/sequelize", () => ({ default: { query: vi.fn() } }));
vi.mock("jet-logger", () => ({ default: { err: vi.fn(), info: vi.fn() } }));
vi.mock("@src/services/UserService", () => ({ default: { getUserById: vi.fn() } }));
vi.mock("@src/services/SessionService", () => ({ default: { state: vi.fn() } }));
vi.mock("@src/services/CompanyPolicyService", () => ({
  default: { forUser: vi.fn(), effectiveAutoLock: vi.fn() },
}));

import logger from "jet-logger";
import sequelize from "@src/configs/DB/sequelize";
import UserService from "@src/services/UserService";
import SessionService from "@src/services/SessionService";
import CompanyPolicyService from "@src/services/CompanyPolicyService";
import ActivityService, { utcDate } from "@src/services/ActivityService";
import isAuth from "@src/middlwares/isAuth";

const query = vi.mocked(sequelize.query);
const SECRET = "test-jwt-secret";

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.resetAllMocks();
  query.mockResolvedValue([] as never);
});

describe("utcDate", () => {
  it("formats the UTC day, not the local one", () => {
    expect(utcDate(new Date("2026-10-31T23:30:00-02:00"))).toBe("2026-11-01");
  });
});

describe("ActivityService.note", () => {
  it("writes once per user, kind and UTC day", () => {
    const now = new Date("2026-10-31T10:00:00Z");
    ActivityService.note(7, "web", now);
    ActivityService.note(7, "web", new Date("2026-10-31T22:00:00Z"));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("writes a second row-update for the other kind on the same day", () => {
    const now = new Date("2026-10-31T10:00:00Z");
    ActivityService.note(8, "web", now);
    ActivityService.note(8, "extension", now);
    expect(query).toHaveBeenCalledTimes(2);
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls[0]).toContain(`SET "web" = true`);
    expect(sqls[1]).toContain(`SET "extension" = true`);
  });

  it("writes again on the next UTC day", () => {
    ActivityService.note(9, "web", new Date("2026-10-31T23:59:00Z"));
    ActivityService.note(9, "web", new Date("2026-11-01T00:01:00Z"));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("passes the values as bind parameters, never in the SQL text", () => {
    ActivityService.note(10, "extension", new Date("2026-10-31T10:00:00Z"));
    const [sql, options] = query.mock.calls[0] as [string, any];
    expect(sql).not.toContain("2026-10-31");
    expect(options.bind).toEqual([10, "2026-10-31"]);
  });

  it("does not remember a failed write, so the next call retries", async () => {
    const now = new Date("2026-10-31T10:00:00Z");
    query.mockRejectedValueOnce(new Error("db down") as never);
    expect(() => ActivityService.note(11, "web", now)).not.toThrow();
    await flush();
    expect(logger.err).toHaveBeenCalled();
    ActivityService.note(11, "web", now);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("never throws when the query throws synchronously", () => {
    query.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(() => ActivityService.note(12, "web", new Date("2026-10-31T10:00:00Z"))).not.toThrow();
    expect(logger.err).toHaveBeenCalled();
  });

  it("ignores a kind outside web/extension", () => {
    ActivityService.note(13, "admin" as never, new Date("2026-10-31T10:00:00Z"));
    expect(query).not.toHaveBeenCalled();
  });
});

describe("ActivityService.activeUserIds", () => {
  it("returns the distinct user ids as numbers, using bound dates", async () => {
    query.mockResolvedValue([{ userId: "3" }, { userId: 5 }] as never);
    const ids = await ActivityService.activeUserIds("2026-10-01", "2026-10-31");
    expect(ids).toEqual([3, 5]);
    const [sql, options] = query.mock.calls[0] as [string, any];
    expect(sql).toContain(`SELECT DISTINCT "userId"`);
    expect(sql).toContain(`BETWEEN :from AND :to`);
    expect(options.replacements).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});

describe("isAuth activity", () => {
  const request = (path: string, sid: number | undefined) => ({
    method: "GET",
    originalUrl: path,
    headers: { authorization: `Bearer ${jwt.sign({ userId: 21, type: "access", sid }, SECRET)}` },
    // Express's header getter; isAuth reads the extension version through it.
    get: () => undefined,
  });

  async function run(
    kind: string | null,
    locked: boolean,
    // sid: null builds a token without a session id (older tokens).
    { path = "/api/notes", sid = 4 as number | null } = {}
  ) {
    vi.mocked(UserService.getUserById).mockResolvedValue({ id: 21, autoLockMinutes: 15 } as never);
    vi.mocked(CompanyPolicyService.forUser).mockResolvedValue({} as never);
    vi.mocked(CompanyPolicyService.effectiveAutoLock).mockReturnValue(15);
    vi.mocked(SessionService.state).mockResolvedValue({ active: true, locked, kind } as never);
    const res: any = {};
    res.status = vi.fn(() => res);
    res.send = vi.fn(() => res);
    const next = vi.fn();
    await isAuth(request(path, sid ?? undefined) as never, res, next);
    return { res, next };
  }

  it("records activity for an accepted web request", async () => {
    const spy = vi.spyOn(ActivityService, "note").mockImplementation(() => undefined);
    const { next } = await run("web", false);
    expect(next).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(21, "web");
    spy.mockRestore();
  });

  it("records activity for an accepted extension request", async () => {
    const spy = vi.spyOn(ActivityService, "note").mockImplementation(() => undefined);
    const { next } = await run("extension", false);
    expect(next).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(21, "extension");
    spy.mockRestore();
  });

  it("does not record a locked session on a route that is open while locked", async () => {
    const spy = vi.spyOn(ActivityService, "note").mockImplementation(() => undefined);
    const { res, next } = await run("web", true, { path: "/api/auth/me" });
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not record a token without a session id (no kind)", async () => {
    const spy = vi.spyOn(ActivityService, "note").mockImplementation(() => undefined);
    const { next } = await run(null, false, { sid: null });
    expect(next).toHaveBeenCalled();
    expect(SessionService.state).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not record a locked session", async () => {
    const spy = vi.spyOn(ActivityService, "note").mockImplementation(() => undefined);
    const { res, next } = await run("web", true);
    expect(res.status).toHaveBeenCalledWith(423);
    expect(next).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not record an admin session (rejected)", async () => {
    const spy = vi.spyOn(ActivityService, "note").mockImplementation(() => undefined);
    const { res, next } = await run("admin", false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
