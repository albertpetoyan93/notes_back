import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../models/User", () => ({ default: { findByPk: vi.fn() } }));
vi.mock("../../models/AdminAction", () => ({
  default: { create: vi.fn(), findAndCountAll: vi.fn(), findOne: vi.fn() },
}));

import AdminAction from "../../models/AdminAction";
import User from "../../models/User";
import AdminActionService, { assertConfirmEmail, cleanReason } from "./AdminActionService";

const user = vi.mocked(User);
const action = vi.mocked(AdminAction);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("cleanReason", () => {
  it("throws 400 for an empty or blank reason", () => {
    expect(() => cleanReason("  ")).toThrow(expect.objectContaining({ status: 400, message: "Give a reason." }));
    expect(() => cleanReason(undefined)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("trims and cuts to 500 characters", () => {
    expect(cleanReason("x".repeat(600)).length).toBe(500);
    expect(cleanReason("  hi  ")).toBe("hi");
  });
});

describe("assertConfirmEmail", () => {
  it("passes ignoring case and surrounding spaces", () => {
    expect(() => assertConfirmEmail(" Ann@X.com ", "ann@x.com")).not.toThrow();
  });

  it("throws 400 for a different email or a non-string", () => {
    expect(() => assertConfirmEmail("bob@x.com", "ann@x.com")).toThrow(
      expect.objectContaining({ status: 400, message: "Type the user's email to confirm." })
    );
    expect(() => assertConfirmEmail(undefined, "ann@x.com")).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("AdminActionService.record", () => {
  it("writes the row with the target email, ip and a 500-char user agent", async () => {
    user.findByPk.mockResolvedValue({ email: "t@x.com" } as never);
    const req = { ip: "1.2.3.4", get: (h: string) => (h === "user-agent" ? "u".repeat(600) : undefined) };
    await AdminActionService.record({
      staff: { userId: 1, email: "s@x.com", role: "support" },
      action: "password_reset_sent",
      targetUserId: 9,
      reason: "asked",
      details: { n: 1 },
      req: req as never,
    });
    expect(user.findByPk).toHaveBeenCalledWith(9, { attributes: ["email"] });
    expect(action.create).toHaveBeenCalledWith({
      staffUserId: 1,
      staffEmail: "s@x.com",
      role: "support",
      action: "password_reset_sent",
      targetUserId: 9,
      targetEmail: "t@x.com",
      targetCompanyId: null,
      reason: "asked",
      details: { n: 1 },
      ip: "1.2.3.4",
      userAgent: "u".repeat(500),
    });
  });

  it("records a system event with no staff and no target", async () => {
    await AdminActionService.record({ staff: null, action: "admin_sign_in_failed" });
    expect(user.findByPk).not.toHaveBeenCalled();
    expect(action.create).toHaveBeenCalledWith(
      expect.objectContaining({
        staffUserId: null,
        staffEmail: "",
        role: null,
        targetEmail: null,
        details: {},
        ip: null,
        userAgent: null,
      })
    );
  });
});

describe("AdminActionService.list", () => {
  const row = (id: number) => ({
    id,
    createdAt: new Date("2026-10-31T10:00:00Z"),
    staffEmail: "s@x.com",
    role: "admin",
    action: "viewed_user",
    targetUserId: 2,
    targetEmail: "t@x.com",
    targetCompanyId: null,
    reason: null,
    details: {},
  });

  it("uses 50 per page, the right offset, newest first, and maps rows", async () => {
    action.findAndCountAll.mockResolvedValue({ rows: [row(5)], count: 120 } as never);
    const from = new Date("2026-10-01");
    const to = new Date("2026-10-31");
    const result = await AdminActionService.list({ staffUserId: 1, from, to, page: 3 });
    const arg = action.findAndCountAll.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.limit).toBe(50);
    expect(arg.offset).toBe(100);
    expect(arg.order).toEqual([
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ]);
    expect(JSON.stringify(arg.where)).toContain("staffUserId");
    expect(result.total).toBe(120);
    expect(result.rows[0]).toEqual({
      id: 5,
      at: "2026-10-31T10:00:00.000Z",
      staffEmail: "s@x.com",
      role: "admin",
      action: "viewed_user",
      targetUserId: 2,
      targetEmail: "t@x.com",
      targetCompanyId: null,
      reason: null,
      details: {},
    });
  });

  it("clamps the page to 1 and defaults it", async () => {
    action.findAndCountAll.mockResolvedValue({ rows: [], count: 0 } as never);
    await AdminActionService.list({ page: -4 });
    await AdminActionService.list({});
    for (const call of action.findAndCountAll.mock.calls) {
      expect((call[0] as Record<string, unknown>).offset).toBe(0);
    }
  });
});

describe("AdminActionService.recordView", () => {
  const staff = { userId: 1, email: "boss@x.com", role: "admin" as const };

  it("records a view when the same staff member hasn't viewed it in the last 10 minutes", async () => {
    action.findOne.mockResolvedValue(null);
    user.findByPk.mockResolvedValue({ email: "ann@x.com" } as never);
    await AdminActionService.recordView({ staff, action: "viewed_user", targetUserId: 7 });
    expect(action.create).toHaveBeenCalledTimes(1);
    const where = (action.findOne.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ staffUserId: 1, action: "viewed_user", targetUserId: 7 });
  });

  it("skips a repeat view within 10 minutes (reloads, double fetch)", async () => {
    action.findOne.mockResolvedValue({ id: 3 } as never);
    await AdminActionService.recordView({ staff, action: "viewed_company", targetCompanyId: 9 });
    expect(action.create).not.toHaveBeenCalled();
    const where = (action.findOne.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ staffUserId: 1, action: "viewed_company", targetCompanyId: 9 });
  });
});
