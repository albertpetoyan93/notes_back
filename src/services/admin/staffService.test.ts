import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../models/User", () => ({ default: { findByPk: vi.fn(), findAll: vi.fn(), findOne: vi.fn() } }));
vi.mock("../../models/AdminStaff", () => ({
  default: { findByPk: vi.fn(), findAll: vi.fn(), create: vi.fn() },
}));

import AdminStaff from "../../models/AdminStaff";
import User from "../../models/User";
import StaffService from "./StaffService";

const user = vi.mocked(User);
const staff = vi.mocked(AdminStaff);

beforeEach(() => {
  vi.resetAllMocks();
  process.env.ADMIN_EMAILS = "boss@x.com";
});

describe("StaffService.roleOf", () => {
  it("is null for a disabled staff row", async () => {
    user.findByPk.mockResolvedValue({ email: "a@x.com" } as never);
    staff.findByPk.mockResolvedValue({ role: "support", disabledAt: new Date() } as never);
    expect(await StaffService.roleOf(1)).toBeNull();
  });

  it("is admin for an ADMIN_EMAILS user with no row", async () => {
    user.findByPk.mockResolvedValue({ email: "Boss@X.com" } as never);
    staff.findByPk.mockResolvedValue(null as never);
    expect(await StaffService.roleOf(2)).toBe("admin");
  });
});

describe("StaffService.list", () => {
  it("includes an env admin whose stored email has uppercase letters", async () => {
    staff.findAll.mockResolvedValue([] as never);
    user.findAll.mockResolvedValue([{ id: 7, email: "Boss@X.com", username: "boss", fullName: "" }] as never);
    const rows = await StaffService.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 7, role: "admin", fromEnv: true, name: "boss" });
  });
});
