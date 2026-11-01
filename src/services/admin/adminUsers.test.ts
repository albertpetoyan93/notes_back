import { beforeEach, describe, expect, it, vi } from "vitest";
import { Op } from "sequelize";

const { model } = vi.hoisted(() => ({
  model: () => ({
    findAll: vi.fn(),
    findOne: vi.fn(),
    findByPk: vi.fn(),
    findAndCountAll: vi.fn(),
    count: vi.fn(),
    sum: vi.fn(),
    max: vi.fn(),
  }),
}));

vi.mock("../../models/User", () => ({ default: model() }));
vi.mock("../../models/UserPasskey", () => ({ default: model() }));
vi.mock("../../models/EmergencyContact", () => ({ default: model() }));
vi.mock("../../models/UserSession", () => ({ default: model() }));
vi.mock("../../models/Note", () => ({ default: model() }));
vi.mock("../../models/Collection", () => ({ default: model() }));
vi.mock("../../models/NoteShare", () => ({ default: model() }));
vi.mock("../../models/CollectionShare", () => ({ default: model() }));
vi.mock("../../models/Attachment", () => ({ default: model() }));
vi.mock("../../models/Subscription", () => ({ default: model() }));
vi.mock("../../models/FamilyMember", () => ({ default: model() }));
vi.mock("../../models/CompanyMember", () => ({ default: model() }));
vi.mock("../../models/Company", () => ({ default: model() }));
vi.mock("../../models/AuditEvent", () => ({ default: model() }));
vi.mock("../../models/SupportRequest", () => ({ default: model() }));
vi.mock("../../models/UserActivityDay", () => ({ default: model() }));
vi.mock("./AdminActionService", () => ({ default: { list: vi.fn() } }));

import Attachment from "../../models/Attachment";
import AuditEvent from "../../models/AuditEvent";
import Collection from "../../models/Collection";
import CollectionShare from "../../models/CollectionShare";
import CompanyMember from "../../models/CompanyMember";
import EmergencyContact from "../../models/EmergencyContact";
import FamilyMember from "../../models/FamilyMember";
import Note from "../../models/Note";
import NoteShare from "../../models/NoteShare";
import Subscription from "../../models/Subscription";
import SupportRequest from "../../models/SupportRequest";
import User from "../../models/User";
import UserActivityDay from "../../models/UserActivityDay";
import UserPasskey from "../../models/UserPasskey";
import UserSession from "../../models/UserSession";
import { USER_ACTIVITY_ACTIONS } from "../AuditService";
import EntitlementService, { decidePlan } from "../EntitlementService";
import AdminActionService from "./AdminActionService";
import AdminUsersService, { escapeLike } from "./AdminUsersService";

const m = {
  user: vi.mocked(User),
  passkey: vi.mocked(UserPasskey),
  emergency: vi.mocked(EmergencyContact),
  session: vi.mocked(UserSession),
  note: vi.mocked(Note),
  collection: vi.mocked(Collection),
  noteShare: vi.mocked(NoteShare),
  collectionShare: vi.mocked(CollectionShare),
  attachment: vi.mocked(Attachment),
  subscription: vi.mocked(Subscription),
  family: vi.mocked(FamilyMember),
  companyMember: vi.mocked(CompanyMember),
  audit: vi.mocked(AuditEvent),
  support: vi.mocked(SupportRequest),
  activity: vi.mocked(UserActivityDay),
  actions: vi.mocked(AdminActionService),
};

const FORBIDDEN_USER_COLUMNS = [
  "password",
  "twoFactorSecret",
  "twoFactorRecoveryCodes",
  "twoFactorLastStep",
  "passwordResetTokenHash",
  "kdfSalt",
  "kdfParams",
  "protectedUserKey",
  "protectedPrivateKey",
  "publicKey",
  "recoveryProtectedUserKey",
  "recoveryAuthHash",
  "refreshTokenId",
  "extensionRefreshTokenId",
];

type Where = Record<string | symbol, unknown>;
const conditions = (where: Where): Where[] => (where[Op.and] as Where[] | undefined) ?? [];
const attrNames = (attributes: unknown[]) => attributes.map((a) => (Array.isArray(a) ? String(a[1]) : String(a)));

beforeEach(() => {
  vi.resetAllMocks();
  m.user.findAndCountAll.mockResolvedValue({ rows: [], count: 0 } as never);
  m.activity.findAll.mockResolvedValue([] as never);
  for (const mock of [m.subscription, m.family, m.companyMember]) mock.findAll.mockResolvedValue([] as never);
});

describe("escapeLike", () => {
  it("escapes backslash, percent and underscore", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

describe("AdminUsersService.list", () => {
  it("matches a literal % by prefix on email, name and username, and limits to 50", async () => {
    await AdminUsersService.list({ q: "%" });
    const args = m.user.findAndCountAll.mock.calls[0][0] as { where: Where; limit: number; offset: number };
    expect(args.limit).toBe(50);
    expect(args.offset).toBe(0);
    const [search] = conditions(args.where);
    expect(search[Op.or]).toEqual([
      { email: { [Op.iLike]: "\\%%" } },
      { fullName: { [Op.iLike]: "\\%%" } },
      { username: { [Op.iLike]: "\\%%" } },
    ]);
  });

  it("escapes _ and \\ in the search text", async () => {
    await AdminUsersService.list({ q: "a_b\\c" });
    const args = m.user.findAndCountAll.mock.calls[0][0] as { where: Where };
    const [search] = conditions(args.where);
    expect((search[Op.or] as Where[])[0]).toEqual({ email: { [Op.iLike]: "a\\_b\\\\c%" } });
  });

  it("applies no filter for an empty or blank q", async () => {
    await AdminUsersService.list({ q: "" });
    await AdminUsersService.list({ q: "   " });
    for (const call of m.user.findAndCountAll.mock.calls) {
      expect(conditions((call[0] as { where: Where }).where)).toEqual([]);
    }
  });

  it("trims q before matching", async () => {
    await AdminUsersService.list({ q: "  bob " });
    const args = m.user.findAndCountAll.mock.calls[0][0] as { where: Where };
    expect((conditions(args.where)[0][Op.or] as Where[])[0]).toEqual({ email: { [Op.iLike]: "bob%" } });
  });

  it("page 3 offsets by 100; page below 1 clamps to the first page", async () => {
    await AdminUsersService.list({ page: 3 });
    await AdminUsersService.list({ page: 0 });
    await AdminUsersService.list({ page: -4 });
    const offsets = m.user.findAndCountAll.mock.calls.map((c) => (c[0] as { offset: number }).offset);
    expect(offsets).toEqual([100, 0, 0]);
  });

  it("orders newest first and never selects secret columns", async () => {
    await AdminUsersService.list({});
    const args = m.user.findAndCountAll.mock.calls[0][0] as { order: unknown; attributes: string[] };
    expect(args.order).toEqual([
      ["createdAt", "DESC"],
      ["id", "DESC"],
    ]);
    for (const column of FORBIDDEN_USER_COLUMNS) expect(args.attributes).not.toContain(column);
    expect(args.attributes).toEqual(
      expect.arrayContaining(["id", "email", "username", "fullName", "createdAt", "suspendedAt", "e2eEnabled", "twoFactorEnabled"])
    );
  });

  it("filters booleans, status and signup days (inclusive, UTC)", async () => {
    await AdminUsersService.list({
      e2e: true,
      twoFactor: false,
      status: "suspended",
      signedUpFrom: "2026-01-02",
      signedUpTo: "2026-01-03",
    });
    const args = m.user.findAndCountAll.mock.calls[0][0] as { where: Where };
    const all = conditions(args.where);
    expect(all).toContainEqual({ e2eEnabled: true });
    expect(all).toContainEqual({ twoFactorEnabled: false });
    expect(all).toContainEqual({ suspendedAt: { [Op.ne]: null } });
    expect(all).toContainEqual({
      createdAt: { [Op.gte]: new Date("2026-01-02T00:00:00.000Z"), [Op.lte]: new Date("2026-01-03T23:59:59.999Z") },
    });
    await AdminUsersService.list({ status: "active" });
    const second = m.user.findAndCountAll.mock.calls[1][0] as { where: Where };
    expect(conditions(second.where)).toContainEqual({ suspendedAt: null });
  });

  it("rejects bad dates, plans and inactiveDays instead of building SQL from them", async () => {
    await expect(AdminUsersService.list({ signedUpFrom: "x'; DROP TABLE users;--" })).rejects.toMatchObject({ status: 400 });
    await expect(AdminUsersService.list({ plan: "gold'--" })).rejects.toMatchObject({ status: 400 });
    await expect(AdminUsersService.list({ inactiveDays: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(AdminUsersService.list({ inactiveDays: 1.5 })).rejects.toMatchObject({ status: 400 });
    await expect(AdminUsersService.list({ inactiveDays: Number.NaN })).rejects.toMatchObject({ status: 400 });
    expect(m.user.findAndCountAll).not.toHaveBeenCalled();
  });

  it("inactiveDays excludes users with activity on or after today minus N", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    try {
      await AdminUsersService.list({ inactiveDays: 30 });
    } finally {
      vi.useRealTimers();
    }
    const args = m.user.findAndCountAll.mock.calls[0][0] as { where: Where };
    const [condition] = conditions(args.where);
    const subquery = (condition.id as Where)[Op.notIn] as { val: string };
    expect(subquery.val).toContain(`"user_activity_days"`);
    expect(subquery.val).toContain(`"date" >= '2026-10-01'`);
  });

  it("plan filter becomes a subquery on id, with a fixed plan name", async () => {
    await AdminUsersService.list({ plan: "premium" });
    const args = m.user.findAndCountAll.mock.calls[0][0] as { where: Where };
    const [condition] = conditions(args.where);
    const sql = (condition.id as Where)[Op.in] as { val: string };
    expect(sql.val).toContain(`s."plan" = 'premium'`);
    await AdminUsersService.list({ plan: "free" });
    const free = m.user.findAndCountAll.mock.calls[1][0] as { where: Where };
    expect((conditions(free.where)[0].id as Where)[Op.notIn]).toBeDefined();
  });

  it("builds rows with one batched lastActive query and batched plans", async () => {
    const created = new Date("2026-01-01T00:00:00Z");
    m.user.findAndCountAll.mockResolvedValue({
      rows: [
        { id: 1, email: "a@x.com", username: "a", fullName: "", createdAt: created, suspendedAt: null, e2eEnabled: true, twoFactorEnabled: false },
        { id: 2, email: "b@x.com", username: "b", fullName: "Bee", createdAt: created, suspendedAt: created, e2eEnabled: false, twoFactorEnabled: true },
      ],
      count: 120,
    } as never);
    m.activity.findAll.mockResolvedValue([{ userId: 1, lastDate: "2026-10-30" }] as never);
    m.subscription.findAll.mockResolvedValueOnce([
      { userId: 2, companyId: null, plan: "premium", status: "active" },
    ] as never);

    const { rows, total } = await AdminUsersService.list({});

    expect(total).toBe(120);
    expect(m.activity.findAll).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ id: 1, name: "a", plan: "free", lastActive: "2026-10-30T00:00:00.000Z", status: "active" });
    expect(rows[1]).toMatchObject({ id: 2, name: "Bee", plan: "premium", lastActive: null, status: "suspended" });
    // Subscriptions are read in explicit columns only.
    const subscriptionArgs = m.subscription.findAll.mock.calls[0][0] as { attributes: string[] };
    expect(subscriptionArgs.attributes).not.toContain("stripeCustomerId");
    expect(subscriptionArgs.attributes).not.toContain("stripeSubscriptionId");
  });

  it("gives a team member Team and a family member Family", async () => {
    m.user.findAndCountAll.mockResolvedValue({
      rows: [
        { id: 1, email: "a@x.com", username: "a", createdAt: new Date(), e2eEnabled: false, twoFactorEnabled: false },
        { id: 2, email: "b@x.com", username: "b", createdAt: new Date(), e2eEnabled: false, twoFactorEnabled: false },
      ],
      count: 2,
    } as never);
    m.family.findAll.mockResolvedValue([{ userId: 1, ownerId: 9 }] as never);
    m.companyMember.findAll.mockResolvedValue([{ userId: 2, companyId: 5 }] as never);
    m.subscription.findAll.mockImplementation((async (options: { where: Where }) => {
      if (options.where.plan === "family") return [{ userId: 9, companyId: null, plan: "family", status: "active" }];
      if (options.where.plan === "team") return [{ userId: null, companyId: 5, plan: "team", status: "active" }];
      return [];
    }) as never);
    const { rows } = await AdminUsersService.list({});
    expect(rows.map((r) => r.plan)).toEqual(["family", "team"]);
  });
});

describe("AdminUsersService.detail", () => {
  const baseUser = {
    id: 5,
    email: "u@x.com",
    username: "u",
    fullName: "Una",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    suspendedAt: null,
    e2eEnabled: true,
    twoFactorEnabled: true,
    mustChangeMasterPassword: false,
    passwordResetExpires: null,
    recoveryCodesLeft: 3,
    hasRecoveryKey: true,
  };

  function mockDetail() {
    m.user.findByPk.mockResolvedValue({ ...baseUser } as never);
    m.passkey.findAll.mockResolvedValue([{ name: "Laptop", lastUsedAt: null, createdAt: new Date("2026-02-01T00:00:00Z") }] as never);
    m.emergency.count.mockResolvedValue(2 as never);
    m.session.findAll.mockResolvedValue([
      { id: 1, kind: "web", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0", ip: "1.2.3.4", createdAt: new Date(), lastUsedAt: new Date() },
    ] as never);
    m.note.findAll.mockResolvedValue([
      { category: "login", count: "4" },
      { category: "note", count: "1" },
    ] as never);
    m.note.max.mockResolvedValue(new Date("2026-03-01T00:00:00Z") as never);
    m.collection.count.mockResolvedValue(3 as never);
    m.noteShare.count.mockResolvedValueOnce(1 as never).mockResolvedValueOnce(2 as never);
    m.collectionShare.count.mockResolvedValueOnce(10 as never).mockResolvedValueOnce(20 as never);
    m.attachment.sum.mockResolvedValue("2048" as never);
    m.subscription.findAll.mockResolvedValue([
      { id: 1, plan: "premium", interval: "month", status: "active", cancelAtPeriodEnd: false, stripeManaged: true },
    ] as never);
    m.companyMember.findAll.mockResolvedValue([{ companyId: 7, role: "admin", company: { name: "Acme" } }] as never);
    m.audit.findAll.mockResolvedValue([{ action: "login", createdAt: new Date("2026-04-01T00:00:00Z") }] as never);
    m.actions.list.mockResolvedValue({
      rows: [
        {
          id: 1,
          at: "2026-05-01T00:00:00.000Z",
          staffEmail: "s@x.com",
          role: "support",
          action: "viewed_user",
          targetUserId: 5,
          targetEmail: "u@x.com",
          targetCompanyId: null,
          reason: null,
          details: {},
        },
      ],
      total: 1,
    } as never);
    m.support.findAll.mockResolvedValue([
      { id: 2, kind: "remove_2fa", status: "pending", createdAt: new Date("2026-06-01T00:00:00Z"), expiresAt: new Date("2026-06-02T00:00:00Z") },
    ] as never);
  }

  it("is null when the user does not exist", async () => {
    m.user.findByPk.mockResolvedValue(null as never);
    expect(await AdminUsersService.detail(999)).toBeNull();
    expect(m.session.findAll).not.toHaveBeenCalled();
  });

  it("selects only safe user columns", async () => {
    mockDetail();
    await AdminUsersService.detail(5);
    const [id, options] = m.user.findByPk.mock.calls[0] as [number, { attributes: unknown[] }];
    expect(id).toBe(5);
    const names = attrNames(options.attributes);
    for (const column of FORBIDDEN_USER_COLUMNS) expect(names).not.toContain(column);
    expect(names).toEqual(expect.arrayContaining(["id", "email", "username", "fullName", "suspendedAt", "recoveryCodesLeft", "hasRecoveryKey"]));
  });

  it("reads passkeys, sessions, subscriptions and support requests in explicit safe columns", async () => {
    mockDetail();
    await AdminUsersService.detail(5);
    const attrs = (mock: { mock: { calls: unknown[][] } }) => (mock.mock.calls[0][0] as { attributes: unknown[] }).attributes;
    expect(attrs(m.passkey.findAll)).toEqual(["name", "lastUsedAt", "createdAt"]);
    expect(attrNames(attrs(m.session.findAll))).not.toContain("tokenHash");
    expect(attrNames(attrs(m.subscription.findAll))).not.toContain("stripeCustomerId");
    expect(attrNames(attrs(m.subscription.findAll))).not.toContain("stripeSubscriptionId");
    expect(attrs(m.support.findAll)).toEqual(["id", "kind", "status", "createdAt", "expiresAt"]);
  });

  it("counts notes by category only, never reading item content", async () => {
    mockDetail();
    await AdminUsersService.detail(5);
    const options = m.note.findAll.mock.calls[0][0] as { attributes: unknown[]; group: string[]; where: Where; raw: boolean };
    expect(attrNames(options.attributes)).toEqual(["category", "count"]);
    expect(options.group).toEqual(["category"]);
    expect(options.where).toEqual({ userId: 5, deletedAt: null });
    expect(options.raw).toBe(true);
  });

  it("sums attachment size only", async () => {
    mockDetail();
    await AdminUsersService.detail(5);
    expect(m.attachment.sum).toHaveBeenCalledWith("size", { where: { ownerUserId: 5 } });
  });

  it("reads the last 100 user-facing audit events: action and createdAt only", async () => {
    mockDetail();
    await AdminUsersService.detail(5);
    const options = m.audit.findAll.mock.calls[0][0] as { where: Where; attributes: string[]; limit: number };
    expect(options.where).toEqual({ actorId: 5, action: { [Op.in]: USER_ACTIVITY_ACTIONS } });
    expect(options.attributes).toEqual(["action", "createdAt"]);
    expect(options.limit).toBe(100);
  });

  it("builds the detail from each query", async () => {
    mockDetail();
    const detail = await AdminUsersService.detail(5);
    expect(detail).not.toBeNull();
    expect(detail!.account).toMatchObject({ id: 5, email: "u@x.com", name: "Una", status: "active" });
    expect(detail!.security).toMatchObject({ e2e: true, twoFactor: true, recoveryCodesLeft: 3, recoveryKey: true, emergencyContacts: 2 });
    expect(detail!.security.passkeys).toHaveLength(1);
    expect(detail!.sessions[0]).toMatchObject({ browser: "Chrome", os: "Windows" });
    expect(detail!.usage).toMatchObject({
      itemsByCategory: { login: 4, note: 1 },
      collections: 3,
      sharesSent: 11,
      sharesReceived: 22,
      attachmentBytes: 2048,
      lastItemChangeAt: "2026-03-01T00:00:00.000Z",
    });
    expect(detail!.subscriptions[0]).toMatchObject({ plan: "premium", stripeManaged: true });
    expect(detail!.companies).toEqual([{ id: 7, name: "Acme", role: "admin" }]);
    expect(detail!.activity).toEqual([{ action: "login", at: "2026-04-01T00:00:00.000Z" }]);
    expect(m.actions.list).toHaveBeenCalledWith({ targetUserId: 5 });
    expect(detail!.staffActions[0]).toMatchObject({ id: 1, at: "2026-05-01T00:00:00.000Z", action: "viewed_user" });
    expect(detail!.supportRequests).toEqual([
      { id: 2, kind: "remove_2fa", status: "pending", createdAt: "2026-06-01T00:00:00.000Z", expiresAt: "2026-06-02T00:00:00.000Z" },
    ]);
  });
});

describe("plan decision shared with EntitlementService", () => {
  const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sub = (fields: Record<string, unknown>) => ({
    userId: null,
    companyId: null,
    status: "active",
    trialEndsAt: null,
    currentPeriodEnd: null,
    graceEndsAt: null,
    ...fields,
  });
  const inList = (value: unknown, id: unknown) =>
    value && typeof value === "object" && Op.in in (value as object)
      ? ((value as Record<symbol, unknown[]>)[Op.in] as unknown[]).includes(id)
      : value === id;

  // Serves the same fake database to forUser and to the batched list.
  function seed(data: { subs: Record<string, unknown>[]; family?: { ownerId: number }; companyId?: number }) {
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      (where.userId === undefined || inList(where.userId, row.userId)) &&
      (where.companyId === undefined || inList(where.companyId, row.companyId)) &&
      (where.plan === undefined || where.plan === row.plan);
    m.subscription.findAll.mockImplementation((async (o: { where: Record<string, unknown> }) =>
      data.subs.filter((row) => matches(row, o.where))) as never);
    m.family.findAll.mockResolvedValue((data.family ? [{ userId: 1, ownerId: data.family.ownerId }] : []) as never);
    m.family.findOne.mockResolvedValue((data.family ? { ownerId: data.family.ownerId } : null) as never);
    const members = data.companyId ? [{ userId: 1, companyId: data.companyId }] : [];
    m.companyMember.findAll.mockResolvedValue(members as never);
    m.user.findAndCountAll.mockResolvedValue({
      rows: [{ id: 1, email: "a@x.com", username: "a", createdAt: new Date(), e2eEnabled: false, twoFactorEnabled: false }],
      count: 1,
    } as never);
  }

  const scenarios: [string, Parameters<typeof seed>[0], string][] = [
    [
      "own Premium + Family membership gives family",
      { subs: [sub({ userId: 1, plan: "premium" }), sub({ userId: 9, plan: "family" })], family: { ownerId: 9 } },
      "family",
    ],
    [
      "own Premium + Team gives premium (equal rank, own wins)",
      { subs: [sub({ userId: 1, plan: "premium" }), sub({ companyId: 5, plan: "team" })], companyId: 5 },
      "premium",
    ],
    [
      "own Family + Family membership gives family",
      { subs: [sub({ userId: 1, plan: "family" }), sub({ userId: 9, plan: "family" })], family: { ownerId: 9 } },
      "family",
    ],
    ["Team only gives team", { subs: [sub({ companyId: 5, plan: "team" })], companyId: 5 }, "team"],
    [
      "an ended own Premium + Team gives team",
      { subs: [sub({ userId: 1, plan: "premium", status: "canceled", currentPeriodEnd: PAST }), sub({ companyId: 5, plan: "team" })], companyId: 5 },
      "team",
    ],
    [
      "a cancelled Premium still inside its paid period gives premium",
      { subs: [sub({ userId: 1, plan: "premium", status: "canceled", currentPeriodEnd: FUTURE })] },
      "premium",
    ],
    ["a Family membership whose organizer's plan ended gives free", { subs: [sub({ userId: 9, plan: "family", status: "expired" })], family: { ownerId: 9 } }, "free"],
    ["nothing gives free", { subs: [] }, "free"],
  ];

  it.each(scenarios)("%s, the same in forUser and in the list", async (_name, data, expected) => {
    seed(data);
    expect((await EntitlementService.forUser(1)).plan).toBe(expected);
    const { rows } = await AdminUsersService.list({});
    expect(rows[0].plan).toBe(expected);
  });

  it("decidePlan alone follows the same rule", () => {
    const own = { plan: "premium" } as never;
    const family = { plan: "family" } as never;
    const team = { plan: "team" } as never;
    expect(decidePlan(own, family, { ownerId: 9 }, null)).toBe("family");
    expect(decidePlan(own, null, null, team)).toBe("own");
    expect(decidePlan(null, null, null, team)).toBe("team");
    expect(decidePlan(null, family, null, null)).toBe("free");
    expect(decidePlan(null, null, null, null)).toBe("free");
  });
});

describe("AdminUsersService.list with huge numbers", () => {
  it("answers 400 for inactiveDays beyond ten years instead of crashing", async () => {
    await expect(AdminUsersService.list({ inactiveDays: 1e12 })).rejects.toMatchObject({ status: 400 });
    await expect(AdminUsersService.list({ inactiveDays: 3651 })).rejects.toMatchObject({ status: 400 });
    await AdminUsersService.list({ inactiveDays: 3650 });
    expect(m.user.findAndCountAll).toHaveBeenCalledTimes(1);
  });

  it("falls back to page 1 for non-finite pages and keeps the offset a safe integer", async () => {
    await AdminUsersService.list({ page: Number.POSITIVE_INFINITY });
    await AdminUsersService.list({ page: Number.NaN });
    await AdminUsersService.list({ page: 1e300 });
    const offsets = m.user.findAndCountAll.mock.calls.map((c) => (c[0] as { offset: number }).offset);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(0);
    expect(Number.isSafeInteger(offsets[2])).toBe(true);
  });
});