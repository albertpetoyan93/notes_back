import { beforeEach, describe, expect, it, vi } from "vitest";
import { Op } from "sequelize";

const { model } = vi.hoisted(() => ({
  model: () => ({
    findAll: vi.fn(),
    findOne: vi.fn(),
    findByPk: vi.fn(),
    findAndCountAll: vi.fn(),
    count: vi.fn(),
  }),
}));

vi.mock("../../models/Company", () => ({ default: model() }));
vi.mock("../../models/CompanyMember", () => ({ default: model() }));
vi.mock("../../models/Subscription", () => ({ default: model() }));
vi.mock("../../models/User", () => ({ default: model() }));
// AdminUsersService (for escapeLike) pulls these in; none of them is used here.
vi.mock("../../models/UserPasskey", () => ({ default: model() }));
vi.mock("../../models/EmergencyContact", () => ({ default: model() }));
vi.mock("../../models/UserSession", () => ({ default: model() }));
vi.mock("../../models/Note", () => ({ default: model() }));
vi.mock("../../models/Collection", () => ({ default: model() }));
vi.mock("../../models/NoteShare", () => ({ default: model() }));
vi.mock("../../models/CollectionShare", () => ({ default: model() }));
vi.mock("../../models/Attachment", () => ({ default: model() }));
vi.mock("../../models/FamilyMember", () => ({ default: model() }));
vi.mock("../../models/AuditEvent", () => ({ default: model() }));
vi.mock("../../models/SupportRequest", () => ({ default: model() }));
vi.mock("../../models/UserActivityDay", () => ({ default: model() }));
vi.mock("./AdminActionService", () => ({ default: { list: vi.fn() } }));

import sequelize from "../../configs/DB/sequelize";
import Company from "../../models/Company";
import CompanyMember from "../../models/CompanyMember";
import Subscription from "../../models/Subscription";
import User from "../../models/User";
import AdminCompaniesService from "./AdminCompaniesService";

const m = {
  company: vi.mocked(Company),
  member: vi.mocked(CompanyMember),
  subscription: vi.mocked(Subscription),
  // The real instance only connects when a query runs, so just the query is replaced.
  query: vi.spyOn(sequelize, "query") as unknown as ReturnType<typeof vi.fn>,
};

const FORBIDDEN_COLUMNS = [
  "recoveryPublicKey",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "password",
  "twoFactorSecret",
  "twoFactorRecoveryCodes",
  "passwordResetTokenHash",
  "kdfSalt",
  "kdfParams",
  "protectedUserKey",
  "protectedPrivateKey",
  "publicKey",
  "recoveryProtectedUserKey",
  "recoveryAuthHash",
];

type Where = Record<string | symbol, unknown>;
const attrNames = (attributes: unknown[]) => attributes.map((a) => (Array.isArray(a) ? String(a[1]) : String(a)));

const company = (over: Record<string, unknown> = {}) => ({
  id: 7,
  name: "Acme",
  status: "active",
  suspendedAt: null,
  markedForRemovalAt: null,
  discount: null,
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.company.findAndCountAll.mockResolvedValue({ rows: [], count: 0 } as never);
  m.member.findAll.mockResolvedValue([] as never);
  m.subscription.findAll.mockResolvedValue([] as never);
  m.query.mockResolvedValue([] as never);
});

describe("AdminCompaniesService.list", () => {
  it("matches the name by escaped prefix and limits to 50", async () => {
    await AdminCompaniesService.list({ q: "_" });
    const args = m.company.findAndCountAll.mock.calls[0][0] as { where: Where; limit: number; offset: number };
    expect(args.where).toEqual({ name: { [Op.iLike]: "\\_%" } });
    expect(args.limit).toBe(50);
    expect(args.offset).toBe(0);
  });

  it("treats % and \\ literally and trims q", async () => {
    await AdminCompaniesService.list({ q: "  100%\\x " });
    const args = m.company.findAndCountAll.mock.calls[0][0] as { where: Where };
    expect(args.where).toEqual({ name: { [Op.iLike]: "100\\%\\\\x%" } });
  });

  it("applies no name filter for an empty or blank q", async () => {
    await AdminCompaniesService.list({ q: "" });
    await AdminCompaniesService.list({ q: "   " });
    await AdminCompaniesService.list({});
    for (const call of m.company.findAndCountAll.mock.calls) expect((call[0] as { where: Where }).where).toEqual({});
  });

  it("page 3 offsets by 100; bad pages clamp to the first page", async () => {
    await AdminCompaniesService.list({ page: 3 });
    await AdminCompaniesService.list({ page: 0 });
    await AdminCompaniesService.list({ page: Number.NaN });
    const offsets = m.company.findAndCountAll.mock.calls.map((c) => (c[0] as { offset: number }).offset);
    expect(offsets).toEqual([100, 0, 0]);
  });

  it("orders newest first and selects explicit non-secret columns", async () => {
    await AdminCompaniesService.list({});
    const args = m.company.findAndCountAll.mock.calls[0][0] as { order: unknown; attributes: string[] };
    expect(args.order).toEqual([
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ]);
    expect(args.attributes).toEqual(
      expect.arrayContaining(["id", "name", "status", "suspendedAt", "markedForRemovalAt", "discount", "createdAt"])
    );
    for (const column of FORBIDDEN_COLUMNS) expect(args.attributes).not.toContain(column);
  });

  it("batches owner, seats and subscription for the page: one query each, none for an empty page", async () => {
    await AdminCompaniesService.list({});
    expect(m.member.findAll).not.toHaveBeenCalled();
    expect(m.subscription.findAll).not.toHaveBeenCalled();

    m.company.findAndCountAll.mockResolvedValue({ rows: [company({ id: 7 }), company({ id: 8, name: "Beta" })], count: 2 } as never);
    m.member.findAll.mockImplementation((async (options: { where: Where }) =>
      options.where.role === "owner"
        ? [{ companyId: 7, userId: 1, email: "owner@acme.test" }]
        : [
            { companyId: 7, count: "4" },
            { companyId: 8, count: "2" },
          ]) as never);
    m.subscription.findAll.mockResolvedValue([
      { id: 1, companyId: 8, plan: "team", interval: "year", status: "active", seats: 3, cancelAtPeriodEnd: false, stripeManaged: true },
      { id: 0, companyId: 8, plan: "team", interval: "month", status: "expired", seats: 2, cancelAtPeriodEnd: false, stripeManaged: false },
    ] as never);

    const { rows, total } = await AdminCompaniesService.list({});
    expect(total).toBe(2);
    expect(m.member.findAll).toHaveBeenCalledTimes(2);
    expect(m.subscription.findAll).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ id: 7, owner: { userId: 1, email: "owner@acme.test" }, seatsUsed: 4, subscription: null });
    expect(rows[1]).toMatchObject({ id: 8, owner: null, seatsUsed: 2 });
    // Latest row wins, and only whether a Stripe id is set comes out.
    expect(rows[1].subscription).toMatchObject({ id: 1, plan: "team", stripeManaged: true });
    expect(JSON.stringify(rows)).not.toMatch(/stripeSubscriptionId|stripeCustomerId/);
  });

  it("counts active members as seats and never selects Stripe ids", async () => {
    m.company.findAndCountAll.mockResolvedValue({ rows: [company()], count: 1 } as never);
    await AdminCompaniesService.list({});
    const seatCall = m.member.findAll.mock.calls.map((c) => c[0] as { where: Where; attributes: unknown[] }).find((a) => a.where.role === undefined)!;
    expect(seatCall.where).toMatchObject({ status: "active" });
    const subAttributes = (m.subscription.findAll.mock.calls[0][0] as { attributes: unknown[] }).attributes;
    for (const column of FORBIDDEN_COLUMNS) expect(attrNames(subAttributes)).not.toContain(column);
    expect(attrNames(subAttributes)).toContain("stripeManaged");
  });
});

describe("AdminCompaniesService.detail", () => {
  it("returns null for a missing company without more queries", async () => {
    m.company.findByPk.mockResolvedValue(null as never);
    expect(await AdminCompaniesService.detail(99)).toBeNull();
    expect(m.member.findAll).not.toHaveBeenCalled();
    expect(m.query).not.toHaveBeenCalled();
  });

  it("never selects the recovery key, only whether it is set", async () => {
    m.company.findByPk.mockResolvedValue(company({ policies: {}, hasRecoveryKey: true }) as never);
    const detail = await AdminCompaniesService.detail(7);
    const options = m.company.findByPk.mock.calls[0][1] as { attributes: unknown[] };
    expect(attrNames(options.attributes)).not.toContain("recoveryPublicKey");
    expect(attrNames(options.attributes)).toContain("hasRecoveryKey");
    expect(detail?.recovery).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('"set"');
  });

  it("selects no User columns beyond id, email and twoFactorEnabled", async () => {
    m.company.findByPk.mockResolvedValue(company({ policies: {}, hasRecoveryKey: false }) as never);
    await AdminCompaniesService.detail(7);
    const options = m.member.findAll.mock.calls[0][0] as {
      where: Where;
      attributes: string[];
      include: { model: unknown; attributes: string[] }[];
    };
    expect(options.where).toMatchObject({ companyId: 7 });
    expect(options.include).toHaveLength(1);
    expect(options.include[0].model).toBe(User);
    expect(options.include[0].attributes).toEqual(["id", "email", "twoFactorEnabled"]);
    for (const column of FORBIDDEN_COLUMNS) expect(options.attributes).not.toContain(column);
  });

  it("builds members (owner first, then admins, then members), owner, seats, subscription and groups", async () => {
    m.company.findByPk.mockResolvedValue(
      company({ policies: { require2fa: true, maxIdleMinutes: 15 }, hasRecoveryKey: false, discount: "school" }) as never
    );
    const joined = new Date("2026-02-03T00:00:00.000Z");
    m.member.findAll.mockImplementation((async (options: { include?: unknown }) =>
      options.include
        ? [
            { userId: 3, email: "a@acme.test", role: "member", status: "active", createdAt: joined, user: { twoFactorEnabled: false } },
            { userId: 2, email: "b@acme.test", role: "admin", status: "active", createdAt: joined, user: { twoFactorEnabled: true } },
            { userId: null, email: "c@acme.test", role: "member", status: "invited", createdAt: joined, user: null },
            { userId: 1, email: "z@acme.test", role: "owner", status: "active", createdAt: joined, user: { twoFactorEnabled: true } },
          ]
        : [{ companyId: 7, count: "3" }]) as never);
    m.subscription.findAll.mockResolvedValue([
      { id: 5, companyId: 7, plan: "team", interval: "month", status: "active", seats: 3, cancelAtPeriodEnd: false, stripeManaged: true },
    ] as never);
    m.query.mockResolvedValue([{ id: 4, name: "Design", members: "2" }] as never);

    const detail = await AdminCompaniesService.detail(7);
    expect(detail).toMatchObject({
      id: 7,
      discount: "school",
      owner: { userId: 1, email: "z@acme.test" },
      seatsUsed: 3,
      subscription: { id: 5, stripeManaged: true },
      policies: { require2fa: true, minPasswordLength: null, maxSessionDays: null, maxIdleMinutes: 15 },
      groups: [{ id: 4, name: "Design", members: 2 }],
    });
    expect(detail?.members.map((member) => member.email)).toEqual(["z@acme.test", "b@acme.test", "a@acme.test", "c@acme.test"]);
    expect(detail?.members[0]).toMatchObject({ userId: 1, role: "owner", twoFactor: true, joinedAt: joined.toISOString() });
    expect(detail?.members[3]).toMatchObject({ userId: null, status: "invited", twoFactor: false });
    expect(m.query.mock.calls[0][1]).toMatchObject({ replacements: { companyId: 7 } });
  });

  it("has owner null when no active member has the owner role", async () => {
    m.company.findByPk.mockResolvedValue(company({ policies: {}, hasRecoveryKey: false }) as never);
    m.member.findAll.mockImplementation((async (options: { include?: unknown }) =>
      options.include
        ? [{ userId: 2, email: "b@acme.test", role: "admin", status: "active", createdAt: new Date(), user: { twoFactorEnabled: false } }]
        : []) as never);
    const detail = await AdminCompaniesService.detail(7);
    expect(detail?.owner).toBeNull();
    expect(detail?.seatsUsed).toBe(0);
    expect(detail?.subscription).toBeNull();
    expect(detail?.groups).toEqual([]);
  });
});
