import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type Stripe from "stripe";

const { model } = vi.hoisted(() => ({
  model: () => ({
    findOne: vi.fn(),
    findAll: vi.fn(),
    findByPk: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  }),
}));

vi.mock("../../models/Subscription", () => ({ default: model() }));
vi.mock("../../models/Company", () => ({ default: model() }));
vi.mock("../../models/User", () => ({ default: model() }));
vi.mock("../../models/FamilyMember", () => ({ default: model() }));
vi.mock("../../models/DiscountRequest", () => ({ default: model() }));
vi.mock("../DiscountService", () => ({ default: { decide: vi.fn(), remove: vi.fn() } }));
vi.mock("../CompanyBilling", () => ({ default: { reopen: vi.fn() }, recipient: vi.fn() }));
vi.mock("../EmailService", () => ({
  default: { sendComplimentaryGiven: vi.fn(), sendComplimentaryEnded: vi.fn(), sendComplimentaryEnding: vi.fn() },
}));
vi.mock("./AdminActionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AdminActionService")>()),
  default: { record: vi.fn() },
}));

import sequelize from "../../configs/DB/sequelize";
import Company from "../../models/Company";
import FamilyMember from "../../models/FamilyMember";
import Subscription from "../../models/Subscription";
import User from "../../models/User";
import CompanyBilling, { recipient } from "../CompanyBilling";
import EmailService from "../EmailService";
import { best, isLive } from "../EntitlementService";
import StripeService from "../StripeService";
import AdminActionService from "./AdminActionService";
import AdminBillingService, { parseComplimentaryEnd } from "./AdminBillingService";

const m = {
  subscription: vi.mocked(Subscription),
  company: vi.mocked(Company),
  user: vi.mocked(User),
  family: vi.mocked(FamilyMember),
  companyBilling: vi.mocked(CompanyBilling),
  recipient: vi.mocked(recipient),
  email: vi.mocked(EmailService),
  actions: vi.mocked(AdminActionService),
  transaction: vi.spyOn(sequelize, "transaction") as unknown as ReturnType<typeof vi.fn>,
};
const fake = { subscriptions: { update: vi.fn() } };
const sync = vi.spyOn(StripeService, "syncSubscription");

const DAY = 24 * 60 * 60 * 1000;
const dayFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const staff = { userId: 1, email: "anna@2keevo.test", role: "admin" as const, sessionId: 9 };
const req = { ip: "127.0.0.1", get: () => "test" } as unknown as Request;
const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 11,
    userId: 5,
    companyId: null,
    plan: "premium",
    status: "complimentary",
    currentPeriodEnd: new Date(Date.now() + 30 * DAY),
    cancelAtPeriodEnd: false,
    stripeSubscriptionId: null,
    ...over,
  }) as never;

beforeEach(() => {
  vi.resetAllMocks();
  StripeService.setClient(fake as unknown as Stripe);
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn({ id: "tx" }));
  m.user.findByPk.mockResolvedValue({ id: 5 } as never);
  m.company.findByPk.mockResolvedValue({ id: 3 } as never);
  m.family.count.mockResolvedValue(0 as never);
  m.subscription.findAll.mockResolvedValue([] as never);
  m.subscription.create.mockImplementation(async (values: any) => ({ id: 11, ...values }) as never);
  m.subscription.update.mockResolvedValue([1] as never);
  m.recipient.mockResolvedValue({ email: "user@example.test", companyName: null });
  m.email.sendComplimentaryGiven.mockResolvedValue(undefined as never);
  m.email.sendComplimentaryEnded.mockResolvedValue(undefined as never);
  sync.mockResolvedValue({} as never);
});

describe("parseComplimentaryEnd", () => {
  it("ends at the end of the chosen day (UTC)", () => {
    const now = new Date("2026-11-26T10:00:00Z");
    expect(parseComplimentaryEnd("2027-01-31", now).toISOString()).toBe("2027-01-31T23:59:59.999Z");
  });

  it("refuses a missing day, today, and more than 2 years ahead", () => {
    const now = new Date("2026-11-26T20:00:00Z");
    expect(() => parseComplimentaryEnd(undefined, now)).toThrow("Choose the day it ends.");
    expect(() => parseComplimentaryEnd("never", now)).toThrow("Choose the day it ends.");
    expect(() => parseComplimentaryEnd("2026-11-26", now)).toThrow("tomorrow or later");
    expect(() => parseComplimentaryEnd("2028-12-01", now)).toThrow("2 years at most");
  });
});

describe("isLive and best", () => {
  it("free access is live until its end date only", () => {
    expect(isLive(row())).toBe(true);
    expect(isLive(row({ currentPeriodEnd: new Date(Date.now() - 1000) }))).toBe(false);
    expect(isLive(row({ currentPeriodEnd: null }))).toBe(false);
  });

  it("for the same plan, the paid subscription wins over free access", () => {
    const paid = row({ id: 12, status: "active", stripeSubscriptionId: "sub_A" });
    expect((best([row(), paid], new Date()) as any).id).toBe(12);
    expect((best([paid, row()], new Date()) as any).id).toBe(12);
  });

  it("a higher plan wins even when it's free", () => {
    const paid = row({ id: 12, status: "active", stripeSubscriptionId: "sub_A" });
    expect((best([paid, row({ plan: "family" })], new Date()) as any).id).toBe(11);
  });
});

describe("giveComplimentary", () => {
  it("gives a person free Premium until the day, records it and emails them", async () => {
    await AdminBillingService.giveComplimentary(staff, { userId: 5 }, { plan: "premium", until: dayFromNow(30) }, "beta tester", req);
    expect(m.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, plan: "premium", status: "complimentary", grantedBy: "anna@2keevo.test" }),
      expect.anything()
    );
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "complimentary_given", targetUserId: 5, reason: "beta tester" })
    );
    expect(m.email.sendComplimentaryGiven).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.test", planName: "Premium" })
    );
    expect(m.companyBilling.reopen).not.toHaveBeenCalled();
  });

  it("a company gets Team only, and a suspended company opens again", async () => {
    await expect(
      AdminBillingService.giveComplimentary(staff, { companyId: 3 }, { plan: "premium", until: dayFromNow(30) }, "pilot", req)
    ).rejects.toMatchObject({ status: 400 });
    await AdminBillingService.giveComplimentary(staff, { companyId: 3 }, { plan: "team", until: dayFromNow(90) }, "pilot", req);
    expect(m.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 3, plan: "team", status: "complimentary" }),
      expect.anything()
    );
    expect(m.companyBilling.reopen).toHaveBeenCalledWith(3);
  });

  it("refuses a second free access while one is on", async () => {
    m.subscription.findAll.mockResolvedValueOnce([row()] as never);
    await expect(
      AdminBillingService.giveComplimentary(staff, { userId: 5 }, { plan: "premium", until: dayFromNow(30) }, "again", req)
    ).rejects.toMatchObject({ status: 409 });
    expect(m.subscription.create).not.toHaveBeenCalled();
  });

  it("refuses Family for someone in another person's family", async () => {
    m.family.count.mockResolvedValue(1 as never);
    await expect(
      AdminBillingService.giveComplimentary(staff, { userId: 5 }, { plan: "family", until: dayFromNow(30) }, "gift", req)
    ).rejects.toMatchObject({ status: 409 });
  });

  it("cancels a paid plan at period end only when asked", async () => {
    const paid = row({ id: 12, status: "active", stripeSubscriptionId: "sub_A" });
    m.subscription.findAll.mockImplementation((async (options: any) =>
      options.where.status === "complimentary" ? [] : [paid]) as never);

    await AdminBillingService.giveComplimentary(staff, { userId: 5 }, { plan: "premium", until: dayFromNow(30) }, "keep paying", req);
    expect(fake.subscriptions.update).not.toHaveBeenCalled();

    await AdminBillingService.giveComplimentary(
      staff,
      { userId: 5 },
      { plan: "premium", until: dayFromNow(30), cancelPaid: true },
      "comp instead",
      req
    );
    expect(fake.subscriptions.update).toHaveBeenCalledWith("sub_A", { cancel_at_period_end: true });
  });
});

describe("change and end", () => {
  it("a new end date clears the reminder and is recorded", async () => {
    m.subscription.findByPk.mockResolvedValue(row() as never);
    await AdminBillingService.changeComplimentaryEnd(staff, 11, dayFromNow(60), "extended", req);
    expect(m.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ trialReminderSentAt: null }),
      expect.objectContaining({ where: expect.objectContaining({ id: 11, status: "complimentary" }) })
    );
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "complimentary_changed" }));
  });

  it("only free access that's still on can be changed or ended", async () => {
    m.subscription.findByPk.mockResolvedValue(row({ status: "active", stripeSubscriptionId: "sub_A" }) as never);
    await expect(AdminBillingService.changeComplimentaryEnd(staff, 11, dayFromNow(60), "x", req)).rejects.toMatchObject({
      status: 409,
    });
    await expect(AdminBillingService.endComplimentary(staff, 11, "x", req)).rejects.toMatchObject({ status: 409 });
    expect(m.subscription.update).not.toHaveBeenCalled();
  });

  it("ending it now expires it, records it and tells the person", async () => {
    m.subscription.findByPk.mockResolvedValue(row() as never);
    await AdminBillingService.endComplimentary(staff, 11, "abuse", req);
    expect(m.subscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
      expect.objectContaining({ where: { id: 11, status: "complimentary" } })
    );
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "complimentary_ended" }));
    expect(m.email.sendComplimentaryEnded).toHaveBeenCalled();
  });
});
