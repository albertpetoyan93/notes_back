import express, { NextFunction, Request, Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stands in for the real session check: the role comes from a test header.
vi.mock("@src/middlwares/isStaff", () => ({
  default: (req: any, res: any, next: any) => {
    const role = req.get("x-test-role");
    if (!role) return res.status(401).send({ code: "session_expired", message: "Staff session expired" });
    req.staff = { userId: 1, email: "s@x.com", role, sessionId: 9 };
    next();
  },
}));
vi.mock("@src/services/AdminService", () => ({ default: { overview: vi.fn() } }));
vi.mock("@src/services/admin/AdminActionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/services/admin/AdminActionService")>();
  return { ...actual, default: { record: vi.fn(), recordView: vi.fn(), list: vi.fn() } };
});
vi.mock("@src/services/admin/AdminUsersService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/services/admin/AdminUsersService")>();
  return { ...actual, default: { list: vi.fn(), detail: vi.fn() } };
});
vi.mock("@src/services/admin/AdminCompaniesService", () => ({ default: { list: vi.fn(), detail: vi.fn() } }));
vi.mock("@src/services/admin/StaffService", () => ({
  default: { roleOf: vi.fn(), list: vi.fn(), add: vi.fn(), update: vi.fn() },
}));
vi.mock("@src/services/admin/SupportActionService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/services/admin/SupportActionService")>();
  return {
    ...actual,
    default: {
      sendPasswordReset: vi.fn(),
      signOutAll: vi.fn(),
      suspend: vi.fn(),
      unsuspend: vi.fn(),
      transferCompanyOwnership: vi.fn(),
    },
  };
});
vi.mock("@src/services/admin/SupportRequestService", () => ({
  default: { requestTwoFactorRemoval: vi.fn(), cancel: vi.fn(), confirm: vi.fn() },
}));
vi.mock("@src/services/admin/AdminBillingService", () => ({
  default: {
    cancel: vi.fn(),
    payments: vi.fn(),
    refund: vi.fn(),
    changePlan: vi.fn(),
    extendTrial: vi.fn(),
    decideDiscount: vi.fn(),
    removeDiscount: vi.fn(),
  },
}));
vi.mock("@src/services/SignupSourceService", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, default: { bySource: vi.fn() } };
});
vi.mock("@src/services/admin/AnalyticsService", () => ({
  default: {
    daily: vi.fn(),
    funnel: vi.fn(),
    retention: vi.fn(),
    extensionVersions: vi.fn(),
  },
}));

import { can, Permission } from "@src/admin/permissions";
import type { StaffRole } from "@src/models/AdminStaff";
import AdminService from "@src/services/AdminService";
import AdminActionService from "@src/services/admin/AdminActionService";
import AdminUsersService from "@src/services/admin/AdminUsersService";
import AdminCompaniesService from "@src/services/admin/AdminCompaniesService";
import StaffService from "@src/services/admin/StaffService";
import SupportActionService from "@src/services/admin/SupportActionService";
import SupportRequestService from "@src/services/admin/SupportRequestService";
import AdminBillingService from "@src/services/admin/AdminBillingService";
import AnalyticsService from "@src/services/admin/AnalyticsService";
import SignupSourceService from "@src/services/SignupSourceService";
import adminRouter, { ADMIN_ROUTES } from "./admin";

const TABLE = [
  "get /overview overview",
  "get /analytics/daily analytics.view",
  "get /analytics/funnel analytics.view",
  "get /analytics/retention analytics.view",
  "get /analytics/extension-versions analytics.view",
  "get /marketing/signups marketing.view",
  "get /users users.view",
  "get /users/:id users.view",
  "post /users/:id/password-reset support.actions",
  "post /users/:id/sign-out-all support.actions",
  "post /users/:id/suspend support.actions",
  "post /users/:id/unsuspend support.actions",
  "post /users/:id/2fa-removal support.actions",
  "delete /support-requests/:id support.actions",
  "get /companies companies.view",
  "get /companies/:id companies.view",
  "post /companies/:id/transfer-ownership support.actions",
  "post /subscriptions/:id/cancel billing.cancel",
  "get /subscriptions/:id/payments billing.manage",
  "post /subscriptions/:id/refund billing.manage",
  "post /subscriptions/:id/plan billing.manage",
  "post /subscriptions/:id/extend-trial billing.manage",
  "post /discounts/:id/approve billing.manage",
  "post /discounts/:id/decline billing.manage",
  "delete /companies/:id/discount billing.manage",
  "get /staff staff.manage",
  "post /staff staff.manage",
  "patch /staff/:userId staff.manage",
  "get /actions staff.manage",
];

// Task 2's matrix, written out again so a change to PERMISSIONS shows up here.
const EXPECTED: Record<Permission, StaffRole[]> = {
  overview: ["admin", "support", "marketing"],
  "overview.revenue": ["admin"],
  "users.view": ["admin", "support"],
  "companies.view": ["admin", "support"],
  "support.actions": ["admin", "support"],
  "billing.cancel": ["admin", "support"],
  "billing.manage": ["admin"],
  "staff.manage": ["admin"],
  "analytics.view": ["admin", "support", "marketing"],
  "marketing.view": ["admin", "marketing"],
};

const ROLES: StaffRole[] = ["admin", "support", "marketing"];

const overview: any = {
  users: { total: 120, last30Days: 3 },
  plans: { premium: { subscribers: 2 } },
  mrrCents: 1200,
  trialsEndingSoon: [],
  failedPayments: [],
  discounts: { percent: 50, pending: [], active: [] },
  companies: { suspended: 2, markedForRemoval: [] },
  suspendedAccounts: 4,
  activity: {
    signups: { today: 3, d7: 10, d30: 40, prevD7: 0, prevD30: 4 },
    activeUsers: { day: 2, week: 20, month: 80 },
    activationRate30d: 0.5,
    daily: [{ date: "2026-10-31", signups: 3, active: 2 }],
  },
};

const REVENUE_KEYS = ["plans", "mrrCents", "failedPayments", "discounts"];

const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status || 500).json({ status: err.status || 500, message: err.message || "Server error" });
});

const as = (role: StaffRole | null, method: string, path: string, body?: object) => {
  const call = (request(app) as any)[method](`/api/admin${path}`);
  if (role) call.set("x-test-role", role);
  return body ? call.send(body) : call;
};

const ANY_BODY = {
  reason: "asked by the owner",
  confirmEmail: "u@x.com",
  newOwnerUserId: 2,
  paymentIntentId: "pi_1",
  plan: "premium",
  interval: "month",
  days: 3,
  email: "new@x.com",
  role: "support",
};

const m = {
  overview: vi.mocked(AdminService.overview),
  actions: vi.mocked(AdminActionService),
  users: vi.mocked(AdminUsersService),
  companies: vi.mocked(AdminCompaniesService),
  staff: vi.mocked(StaffService),
  support: vi.mocked(SupportActionService),
  requests: vi.mocked(SupportRequestService),
  billing: vi.mocked(AdminBillingService),
  analytics: vi.mocked(AnalyticsService),
  sources: vi.mocked(SignupSourceService),
};

beforeEach(() => {
  vi.resetAllMocks();
  m.overview.mockResolvedValue(overview);
  m.analytics.daily.mockResolvedValue([]);
  m.analytics.funnel.mockResolvedValue({ days: [], totals: {
    signedUp: 0, firstItem: 0, extension: 0, autofill: 0, activeDay7: 0, activeDay30: 0, paying: 0,
  }, partial: false });
  m.analytics.retention.mockResolvedValue({ rows: [], maxWeek: 12 });
  m.analytics.extensionVersions.mockResolvedValue([]);
  m.sources.bySource.mockResolvedValue({
    rows: [{ key: "instagram", signups: 12, activated: 3, paying: 0 }, { key: null, signups: 2, activated: 0, paying: 0 }],
    totals: { signups: 14, activated: 3, paying: 0 },
    untagged: 2,
  });
  m.actions.list.mockResolvedValue({ rows: [], total: 0 });
  m.users.list.mockResolvedValue({ rows: [], total: 0 });
  m.users.detail.mockResolvedValue({ account: { id: 1 } } as never);
  m.companies.list.mockResolvedValue({ rows: [], total: 0 });
  m.companies.detail.mockResolvedValue({ id: 3 } as never);
  m.staff.list.mockResolvedValue([]);
  m.staff.add.mockResolvedValue({ userId: 5 } as never);
  m.staff.update.mockResolvedValue({ userId: 2 } as never);
  m.billing.payments.mockResolvedValue([]);
  m.requests.requestTwoFactorRemoval.mockResolvedValue({ id: 4, expiresAt: new Date("2026-11-01T00:00:00Z") });
});

describe("ADMIN_ROUTES", () => {
  it("is exactly the route table", () => {
    expect(ADMIN_ROUTES.map((r) => `${r.method} ${r.path} ${r.permission}`)).toEqual(TABLE);
  });

  it("answers 401 without a staff session", async () => {
    const res = await as(null, "get", "/overview");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("session_expired");
  });
});

describe("role matrix", () => {
  for (const route of ADMIN_ROUTES) {
    for (const role of ROLES) {
      const allowed = EXPECTED[route.permission].includes(role);
      it(`${role} ${allowed ? "may" : "may not"} ${route.method} ${route.path}`, async () => {
        expect(can(role, route.permission)).toBe(allowed);
        const path = route.path.replace(":id", "1").replace(":userId", "2");
        const res = await as(role, route.method, path, ANY_BODY);
        if (allowed) {
          expect(res.status).toBe(200);
        } else {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe("forbidden");
        }
      });
    }
  }
});

describe("GET /overview", () => {
  it("admin gets the revenue fields", async () => {
    const res = await as("admin", "get", "/overview");
    for (const key of REVENUE_KEYS) expect(res.body).toHaveProperty(key);
  });

  for (const role of ["support", "marketing"] as StaffRole[]) {
    it(`${role} gets no revenue fields`, async () => {
      const res = await as(role, "get", "/overview");
      expect(res.status).toBe(200);
      for (const key of REVENUE_KEYS) expect(res.body).not.toHaveProperty(key);
    });
  }

  it("marketing sees small counts as <5", async () => {
    const res = await as("marketing", "get", "/overview");
    expect(res.body.users.last30Days).toBe("<5");
    expect(res.body.activity.daily[0]).toEqual({ date: "2026-10-31", signups: "<5", active: "<5" });
  });
});

describe("details", () => {
  it("GET /users/:id returns the detail unwrapped and records viewed_user", async () => {
    const res = await as("support", "get", "/users/7");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account: { id: 1 } });
    expect(m.users.detail).toHaveBeenCalledWith(7);
    expect(m.actions.recordView).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "viewed_user",
        targetUserId: 7,
        staff: { userId: 1, email: "s@x.com", role: "support" },
      })
    );
  });

  it("GET /companies/:id returns the detail unwrapped and records viewed_company", async () => {
    const res = await as("admin", "get", "/companies/3");
    expect(res.body).toEqual({ id: 3 });
    expect(m.actions.recordView).toHaveBeenCalledWith(
      expect.objectContaining({ action: "viewed_company", targetCompanyId: 3 })
    );
  });

  it("404s an unknown user and records no view", async () => {
    m.users.detail.mockResolvedValue(null);
    const res = await as("admin", "get", "/users/7");
    expect(res.status).toBe(404);
    expect(m.actions.recordView).not.toHaveBeenCalled();
  });

  for (const bad of ["abc", "0", "-1", "1.5", "1e3", "99999999999"]) {
    it(`400s the id ${bad} without calling the service`, async () => {
      const res = await as("admin", "get", `/users/${bad}`);
      expect(res.status).toBe(400);
      expect(m.users.detail).not.toHaveBeenCalled();
    });
  }
});

describe("GET /users", () => {
  it("parses the filters", async () => {
    const res = await as(
      "support",
      "get",
      "/users?q=a%25&plan=team&e2e=true&twoFactor=false&status=suspended&signedUpFrom=2026-01-01&signedUpTo=2026-02-01&inactiveDays=30&page=2"
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [], total: 0 });
    expect(m.users.list).toHaveBeenCalledWith({
      q: "a%",
      plan: "team",
      e2e: true,
      twoFactor: false,
      status: "suspended",
      signedUpFrom: "2026-01-01",
      signedUpTo: "2026-02-01",
      inactiveDays: 30,
      page: 2,
    });
  });

  it("passes nothing for unset filters", async () => {
    await as("support", "get", "/users");
    expect(m.users.list).toHaveBeenCalledWith({});
  });

  for (const query of ["e2e=yes", "twoFactor=1", "status=gone", "page=abc", "page=0", "inactiveDays=ten", "q=a&q=b"]) {
    it(`400s ${query}`, async () => {
      const res = await as("support", "get", `/users?${query}`);
      expect(res.status).toBe(400);
      expect(m.users.list).not.toHaveBeenCalled();
    });
  }
});

describe("GET /actions", () => {
  it("parses ids, the action and ISO dates", async () => {
    const from = "2026-10-01T00:00:00.000Z";
    const to = "2026-10-31T23:59:59.999Z";
    const res = await as("admin", "get", `/actions?staffUserId=2&action=viewed_user&targetUserId=5&from=${from}&to=${to}&page=3`);
    expect(res.status).toBe(200);
    expect(m.actions.list).toHaveBeenCalledWith({
      staffUserId: 2,
      action: "viewed_user",
      targetUserId: 5,
      from: new Date(from),
      to: new Date(to),
      page: 3,
    });
  });

  for (const query of ["from=yesterday", "to=2026-13-45T00:00:00Z", "staffUserId=x", "targetUserId=-2"]) {
    it(`400s ${query}`, async () => {
      const res = await as("admin", "get", `/actions?${query}`);
      expect(res.status).toBe(400);
      expect(m.actions.list).not.toHaveBeenCalled();
    });
  }
});

describe("bodies", () => {
  it("suspend passes the reason and the typed email", async () => {
    await as("support", "post", "/users/7/suspend", { reason: "fraud", confirmEmail: "u@x.com" });
    expect(m.support.suspend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 1, role: "support" }),
      7,
      "fraud",
      "u@x.com",
      expect.anything()
    );
  });

  it("2fa-removal answers with the request id and expiry", async () => {
    const res = await as("support", "post", "/users/7/2fa-removal", { reason: "lost phone", confirmEmail: "u@x.com" });
    expect(res.body).toEqual({ id: 4, expiresAt: "2026-11-01T00:00:00.000Z" });
  });

  it("DELETE /support-requests/:id reads the reason from the body", async () => {
    await as("support", "delete", "/support-requests/4", { reason: "user found the phone" });
    expect(m.requests.cancel).toHaveBeenCalledWith(expect.anything(), 4, "user found the phone", expect.anything());
  });

  it("transfer-ownership needs a valid new owner id", async () => {
    const res = await as("support", "post", "/companies/3/transfer-ownership", { reason: "r", newOwnerUserId: "x" });
    expect(res.status).toBe(400);
    expect(m.support.transferCompanyOwnership).not.toHaveBeenCalled();
    await as("support", "post", "/companies/3/transfer-ownership", { reason: "r", newOwnerUserId: 9 });
    expect(m.support.transferCompanyOwnership).toHaveBeenCalledWith(expect.anything(), 3, 9, "r", expect.anything());
  });

  it("plan takes plan and interval only; seats follow the member count", async () => {
    await as("admin", "post", "/subscriptions/8/plan", { reason: "r", plan: "team", interval: "year", seats: 40 });
    expect(m.billing.changePlan).toHaveBeenCalledWith(
      expect.anything(),
      8,
      { plan: "team", interval: "year" },
      "r",
      expect.anything()
    );
  });

  it("refund passes the payment intent and optional amount", async () => {
    await as("admin", "post", "/subscriptions/8/refund", { reason: "r", paymentIntentId: "pi_1" });
    expect(m.billing.refund).toHaveBeenCalledWith(expect.anything(), 8, "pi_1", undefined, "r", expect.anything());
  });

  it("extend-trial passes the days", async () => {
    await as("admin", "post", "/subscriptions/8/extend-trial", { reason: "r", days: 7 });
    expect(m.billing.extendTrial).toHaveBeenCalledWith(expect.anything(), 8, 7, "r", expect.anything());
  });

  it("approve and decline go through decideDiscount with the reason", async () => {
    await as("admin", "post", "/discounts/6/approve", { reason: "ok" });
    await as("admin", "post", "/discounts/6/decline", { reason: "no" });
    expect(m.billing.decideDiscount).toHaveBeenNthCalledWith(1, expect.anything(), 6, true, "ok", expect.anything());
    expect(m.billing.decideDiscount).toHaveBeenNthCalledWith(2, expect.anything(), 6, false, "no", expect.anything());
  });

  it("DELETE /companies/:id/discount reads the reason from the body", async () => {
    await as("admin", "delete", "/companies/3/discount", { reason: "no longer a nonprofit" });
    expect(m.billing.removeDiscount).toHaveBeenCalledWith(expect.anything(), 3, "no longer a nonprofit", expect.anything());
  });

  it("payments and staff are bare arrays", async () => {
    m.billing.payments.mockResolvedValue([{ id: "pi_1" }] as never);
    expect((await as("admin", "get", "/subscriptions/8/payments")).body).toEqual([{ id: "pi_1" }]);
    m.staff.list.mockResolvedValue([{ userId: 1 }] as never);
    expect((await as("admin", "get", "/staff")).body).toEqual([{ userId: 1 }]);
  });
});

describe("staff", () => {
  it("POST adds and records staff_added with the reason", async () => {
    const res = await as("admin", "post", "/staff", { reason: "new hire", email: "new@x.com", role: "marketing" });
    expect(res.status).toBe(200);
    expect(m.staff.add).toHaveBeenCalledWith("new@x.com", "marketing", 1);
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "staff_added",
        targetUserId: 5,
        reason: "new hire",
        details: { role: "marketing" },
      })
    );
  });

  it("POST refuses an unknown role or a missing reason and changes nothing", async () => {
    expect((await as("admin", "post", "/staff", { reason: "r", email: "a@x.com", role: "owner" })).status).toBe(400);
    expect((await as("admin", "post", "/staff", { reason: "  ", email: "a@x.com", role: "support" })).status).toBe(400);
    expect((await as("admin", "post", "/staff", { reason: "r", role: "support" })).status).toBe(400);
    expect(m.staff.add).not.toHaveBeenCalled();
    expect(m.actions.record).not.toHaveBeenCalled();
  });

  it("PATCH changes the role and records staff_changed", async () => {
    await as("admin", "patch", "/staff/2", { reason: "moved team", role: "support" });
    expect(m.staff.update).toHaveBeenCalledWith(2, { role: "support" }, 1);
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "staff_changed", targetUserId: 2, reason: "moved team", details: { role: "support" } })
    );
  });

  it("PATCH disables", async () => {
    await as("admin", "patch", "/staff/2", { reason: "left", disabled: true });
    expect(m.staff.update).toHaveBeenCalledWith(2, { disabled: true }, 1);
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ details: { disabled: true } }));
  });

  for (const body of [{ role: "boss" }, { disabled: "yes" }, {}]) {
    it(`PATCH 400s ${JSON.stringify(body)}`, async () => {
      const res = await as("admin", "patch", "/staff/2", { reason: "r", ...body });
      expect(res.status).toBe(400);
      expect(m.staff.update).not.toHaveBeenCalled();
    });
  }

  it("a refused change is not recorded", async () => {
    m.staff.update.mockRejectedValue(Object.assign(new Error("You can't change your own access"), { status: 409 }));
    const res = await as("admin", "patch", "/staff/2", { reason: "r", role: "admin" });
    expect(res.status).toBe(409);
    expect(m.actions.record).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("keeps the service's status, message and code", async () => {
    m.support.unsuspend.mockRejectedValue(
      Object.assign(new Error("This account is suspended. Contact support."), { status: 403, code: "suspended" })
    );
    const res = await as("support", "post", "/users/7/unsuspend", { reason: "r" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: "This account is suspended. Contact support.", code: "suspended" });
  });

  it("sends a 400 from the service as is", async () => {
    m.support.sendPasswordReset.mockRejectedValue(Object.assign(new Error("Give a reason."), { status: 400 }));
    const res = await as("support", "post", "/users/7/password-reset", {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: "Give a reason." });
  });

  it("answers 502 for a Stripe error", async () => {
    m.billing.cancel.mockRejectedValue(Object.assign(new Error("No such subscription"), { type: "StripeInvalidRequestError" }));
    const res = await as("support", "post", "/subscriptions/8/cancel", { reason: "r" });
    expect(res.status).toBe(502);
  });

  it("hands unknown errors to the error handler", async () => {
    m.users.list.mockRejectedValue(new Error("db down"));
    const res = await as("admin", "get", "/users");
    expect(res.status).toBe(500);
  });
});

describe("marketing sign-ups by source", () => {
  it("passes period and grouping to the service and returns plain numbers to admins", async () => {
    const res = await as("admin", "get", "/marketing/signups?from=2026-11-01&to=2026-11-30&groupBy=campaign");
    expect(res.status).toBe(200);
    expect(m.sources.bySource).toHaveBeenCalledWith("2026-11-01", "2026-11-30", "campaign");
    expect(res.body.rows[0]).toEqual({ key: "instagram", signups: 12, activated: 3, paying: 0 });
    expect(res.body.untagged).toBe(2);
  });

  it("shows marketing small counts as <5", async () => {
    const res = await as("marketing", "get", "/marketing/signups?from=2026-11-01&to=2026-11-30");
    expect(res.status).toBe(200);
    expect(m.sources.bySource).toHaveBeenCalledWith("2026-11-01", "2026-11-30", "source");
    expect(res.body.rows[0]).toEqual({ key: "instagram", signups: 12, activated: "<5", paying: 0 });
    expect(res.body.rows[1].signups).toBe("<5");
    expect(res.body.totals).toEqual({ signups: 14, activated: "<5", paying: 0 });
    expect(res.body.untagged).toBe("<5");
  });

  it("refuses support (no marketing.view)", async () => {
    const res = await as("support", "get", "/marketing/signups");
    expect(res.status).toBe(403);
  });

  it("400s an unknown grouping or a bad date", async () => {
    expect((await as("admin", "get", "/marketing/signups?groupBy=email")).status).toBe(400);
    expect((await as("admin", "get", "/marketing/signups?from=yesterday")).status).toBe(400);
    expect(m.sources.bySource).not.toHaveBeenCalled();
  });
});
