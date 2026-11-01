import { describe, expect, it } from "vitest";
import { redactOverview, smallCount } from "./redact";

const full: any = {
  users: { total: 120, last30Days: 3 },
  plans: { premium: { subscribers: 2 } },
  mrrCents: 1200,
  trialsEndingSoon: [{ id: 1, owner: { label: "a@b.c" } }],
  failedPayments: [{ id: 2 }],
  discounts: { percent: 50, pending: [], active: [] },
  companies: { suspended: 2, markedForRemoval: [{ id: 1, name: "Acme" }] },
  suspendedAccounts: 4,
  activity: {
    signups: { today: 3, d7: 10, d30: 40, prevD7: 0, prevD30: 4 },
    activeUsers: { day: 2, week: 20, month: 80 },
    activationRate30d: 0.5,
    daily: [
      { date: "2026-10-31", signups: 3, active: 2 },
      { date: "2026-10-30", signups: 0, active: 7 },
    ],
  },
};

describe("smallCount", () => {
  it("hides 1..4 only", () => {
    expect(smallCount(0)).toBe(0);
    expect(smallCount(1)).toBe("<5");
    expect(smallCount(4)).toBe("<5");
    expect(smallCount(5)).toBe(5);
  });
});

describe("redactOverview", () => {
  it("admin gets everything unchanged", () => {
    expect(redactOverview(full, "admin")).toEqual(full);
  });

  it("support loses revenue fields but keeps real counts", () => {
    const out: any = redactOverview(full, "support");
    for (const key of ["mrrCents", "plans", "failedPayments", "discounts"]) expect(out).not.toHaveProperty(key);
    expect(out.suspendedAccounts).toBe(4);
    expect(out.activity.signups.today).toBe(3);
  });

  it("marketing loses owners and small counts are hidden", () => {
    const out: any = redactOverview(full, "marketing");
    for (const key of ["mrrCents", "plans", "failedPayments", "discounts", "trialsEndingSoon", "suspendedAccounts"]) {
      expect(out).not.toHaveProperty(key);
    }
    expect(out.companies.markedForRemoval).toEqual([]);
    expect(out.activity.signups.today).toBe("<5");
    expect(out.activity.signups.prevD7).toBe(0);
    expect(out.activity.signups.d7).toBe(10);
    expect(out.activity.activeUsers.day).toBe("<5");
    expect(out.users.last30Days).toBe("<5");
    expect(out.companies.suspended).toBe("<5");
    expect(out.activity.daily).toEqual([
      { date: "2026-10-31", signups: "<5", active: "<5" },
      { date: "2026-10-30", signups: 0, active: 7 },
    ]);
    const support: any = redactOverview(full, "support");
    expect(support.activity.daily).toEqual(full.activity.daily);
  });

  it("does not mutate its input", () => {
    const copy = JSON.parse(JSON.stringify(full));
    redactOverview(full, "marketing");
    redactOverview(full, "support");
    expect(full).toEqual(copy);
  });
});
