import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import type Stripe from "stripe";

const { model } = vi.hoisted(() => ({
  model: () => ({
    findOne: vi.fn(),
    findByPk: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../../models/Subscription", () => ({ default: model() }));
vi.mock("../../models/Company", () => ({ default: model() }));
vi.mock("../../models/DiscountRequest", () => ({ default: model() }));
vi.mock("../DiscountService", () => ({ default: { decide: vi.fn(), remove: vi.fn() } }));
vi.mock("./AdminActionService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./AdminActionService")>()),
  default: { record: vi.fn() },
}));

import sequelize from "../../configs/DB/sequelize";
import Company from "../../models/Company";
import DiscountRequest from "../../models/DiscountRequest";
import Subscription from "../../models/Subscription";
import DiscountService from "../DiscountService";
import StripeService from "../StripeService";
import AdminActionService from "./AdminActionService";
import AdminBillingService from "./AdminBillingService";

const m = {
  subscription: vi.mocked(Subscription),
  company: vi.mocked(Company),
  request: vi.mocked(DiscountRequest),
  discounts: vi.mocked(DiscountService),
  actions: vi.mocked(AdminActionService),
  transaction: vi.spyOn(sequelize, "transaction") as unknown as ReturnType<typeof vi.fn>,
};
const TX = { id: "tx" };

const fake = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  invoices: { list: vi.fn() },
  charges: { list: vi.fn() },
  paymentIntents: { retrieve: vi.fn() },
  refunds: { create: vi.fn() },
  prices: { list: vi.fn() },
};

const staff = { userId: 1, email: "staff@2keevo.test", role: "admin" as const, sessionId: 9 };
const req = { ip: "127.0.0.1", get: () => "test" } as unknown as Request;
const sub = (over: Record<string, unknown> = {}) => ({
  id: 7,
  userId: 5,
  companyId: null,
  plan: "premium",
  interval: "month",
  status: "active",
  cancelAtPeriodEnd: false,
  trialEndsAt: null,
  stripeCustomerId: "cus_A",
  stripeSubscriptionId: "sub_A",
  ...over,
});
const sync = vi.spyOn(StripeService, "syncSubscription");

afterAll(() => {
  StripeService.setClient(null);
  delete process.env.STRIPE_PRICE_TEAM_YEAR;
  delete process.env.STRIPE_PRICE_PREMIUM_MONTH;
});

beforeEach(() => {
  vi.resetAllMocks();
  StripeService.setClient(fake as unknown as Stripe);
  process.env.STRIPE_PRICE_TEAM_YEAR = "price_team_year";
  process.env.STRIPE_PRICE_PREMIUM_MONTH = "price_premium_month";
  m.subscription.findByPk.mockResolvedValue(sub() as never);
  m.subscription.update.mockResolvedValue([1] as never);
  sync.mockResolvedValue({} as never);
  fake.subscriptions.retrieve.mockResolvedValue({
    id: "sub_A",
    status: "active",
    trial_end: null,
    items: { data: [{ id: "si_1", quantity: 1 }] },
  });
  fake.subscriptions.update.mockResolvedValue({ id: "sub_A" });
  fake.refunds.create.mockResolvedValue({ id: "re_1", amount: 1000 });
  m.transaction.mockImplementation(async (fn: (t: unknown) => unknown) => fn(TX));
});

describe("refund", () => {
  it("refuses a payment of another customer with 409 and does not refund", async () => {
    fake.paymentIntents.retrieve.mockResolvedValue({ id: "pi_X", customer: "cus_OTHER" });
    await expect(AdminBillingService.refund(staff, 7, "pi_X", undefined, "double charge", req)).rejects.toMatchObject({
      status: 409,
    });
    expect(fake.refunds.create).not.toHaveBeenCalled();
    expect(m.actions.record).not.toHaveBeenCalled();
  });

  it("refunds the customer's payment and records it", async () => {
    fake.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", customer: "cus_A", latest_charge: { amount_refunded: 200 } });
    await AdminBillingService.refund(staff, 7, "pi_1", 500, "double charge", req);
    expect(fake.paymentIntents.retrieve).toHaveBeenCalledWith("pi_1", { expand: ["latest_charge"] });
    expect(fake.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_1", amount: 500 },
      { idempotencyKey: "admin-refund-pi_1-500-200" }
    );
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payment_refunded", targetUserId: 5, reason: "double charge" })
    );
  });

  it("two identical submits send the same idempotency key; a later refund gets a new one", async () => {
    fake.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", customer: "cus_A", latest_charge: { amount_refunded: 0 } });
    await AdminBillingService.refund(staff, 7, "pi_1", undefined, "double charge", req);
    await AdminBillingService.refund(staff, 7, "pi_1", undefined, "double charge", req);
    const keys = fake.refunds.create.mock.calls.map((call) => call[1]?.idempotencyKey);
    expect(keys).toEqual(["admin-refund-pi_1-full-0", "admin-refund-pi_1-full-0"]);

    fake.paymentIntents.retrieve.mockResolvedValue({ id: "pi_1", customer: "cus_A", latest_charge: { amount_refunded: 300 } });
    await AdminBillingService.refund(staff, 7, "pi_1", 300, "second part", req);
    expect(fake.refunds.create.mock.calls[2][1]).toEqual({ idempotencyKey: "admin-refund-pi_1-300-300" });
  });

  it("a blank reason is 400 and touches nothing", async () => {
    await expect(AdminBillingService.refund(staff, 7, "pi_1", undefined, "  ", req)).rejects.toMatchObject({ status: 400 });
    expect(fake.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(fake.refunds.create).not.toHaveBeenCalled();
  });
});

describe("extendTrial", () => {
  it("31 days is 400 and changes nothing", async () => {
    m.subscription.findByPk.mockResolvedValue(
      sub({ status: "trialing", stripeSubscriptionId: null, trialEndsAt: new Date(Date.now() + 86400000) }) as never
    );
    await expect(AdminBillingService.extendTrial(staff, 7, 31, "needs time", req)).rejects.toMatchObject({ status: 400 });
    expect(m.subscription.update).not.toHaveBeenCalled();
    expect(fake.subscriptions.update).not.toHaveBeenCalled();
    expect(m.actions.record).not.toHaveBeenCalled();
  });

  it("moves an app trial's end by the days", async () => {
    const end = new Date(Date.now() + 86400000);
    m.subscription.findByPk.mockResolvedValue(sub({ status: "trialing", stripeSubscriptionId: null, trialEndsAt: end }) as never);
    await AdminBillingService.extendTrial(staff, 7, 10, "needs time", req);
    expect(m.subscription.update).toHaveBeenCalledWith(
      { trialEndsAt: new Date(end.getTime() + 10 * 86400000), trialReminderSentAt: null },
      expect.objectContaining({ where: expect.objectContaining({ id: 7, status: "trialing" }) })
    );
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "trial_extended" }));
  });

  it("writes the extension and its AdminAction in one transaction; a failed record surfaces", async () => {
    const end = new Date(Date.now() + 86400000);
    m.subscription.findByPk.mockResolvedValue(sub({ status: "trialing", stripeSubscriptionId: null, trialEndsAt: end }) as never);
    m.actions.record.mockRejectedValue(new Error("log down"));
    await expect(AdminBillingService.extendTrial(staff, 7, 10, "needs time", req)).rejects.toThrow("log down");
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.subscription.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ transaction: TX }));
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "trial_extended", transaction: TX }));
  });

  it("is 409 when not trialing", async () => {
    await expect(AdminBillingService.extendTrial(staff, 7, 5, "needs time", req)).rejects.toMatchObject({ status: 409 });
    expect(fake.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("changePlan", () => {
  it("team bills the company's member count (seats from the request are ignored), always_invoice, then syncs", async () => {
    m.subscription.findByPk.mockResolvedValue(sub({ userId: null, companyId: 3, plan: "team" }) as never);
    const seatsFor = vi.spyOn(StripeService, "seatsFor").mockResolvedValue(4);
    const input = { plan: "team", interval: "year", seats: 9 } as unknown as { plan: unknown; interval: unknown };
    await AdminBillingService.changePlan(staff, 7, input, "upgrade", req);
    expect(seatsFor).toHaveBeenCalledWith(3);
    expect(fake.subscriptions.update).toHaveBeenCalledWith(
      "sub_A",
      expect.objectContaining({
        items: [{ id: "si_1", price: "price_team_year", quantity: 4 }],
        proration_behavior: "always_invoice",
      })
    );
    expect(sync).toHaveBeenCalledWith("sub_A");
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "plan_changed", targetCompanyId: 3 })
    );
    seatsFor.mockRestore();
  });

  it("still records when the sync after Stripe fails, and rethrows", async () => {
    sync.mockRejectedValue(new Error("db down"));
    await expect(
      AdminBillingService.changePlan(staff, 7, { plan: "premium", interval: "month" }, "fix", req)
    ).rejects.toThrow("db down");
    expect(fake.subscriptions.update).toHaveBeenCalledWith(
      "sub_A",
      expect.objectContaining({ items: [{ id: "si_1", price: "price_premium_month", quantity: 1 }] })
    );
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "plan_changed" }));
  });

  it("a failed Stripe call records nothing", async () => {
    fake.subscriptions.update.mockRejectedValue(new Error("card_declined"));
    await expect(
      AdminBillingService.changePlan(staff, 7, { plan: "premium", interval: "month" }, "fix", req)
    ).rejects.toThrow("card_declined");
    expect(m.actions.record).not.toHaveBeenCalled();
  });
});

describe("cancel", () => {
  it("is 409 when not managed by Stripe", async () => {
    m.subscription.findByPk.mockResolvedValue(sub({ stripeSubscriptionId: null, status: "trialing" }) as never);
    await expect(AdminBillingService.cancel(staff, 7, "asked", req)).rejects.toMatchObject({ status: 409 });
    expect(fake.subscriptions.update).not.toHaveBeenCalled();
  });

  it("cancels at period end and records", async () => {
    await AdminBillingService.cancel(staff, 7, "asked", req);
    expect(fake.subscriptions.update).toHaveBeenCalledWith("sub_A", { cancel_at_period_end: true });
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "subscription_cancelled" }));
  });
});

describe("payments", () => {
  it("lists invoices with a payment intent, newest first, with refunded amounts", async () => {
    fake.invoices.list.mockResolvedValue({
      data: [
        {
          id: "in_2",
          amount_paid: 1000,
          currency: "eur",
          created: 1700000100,
          status: "paid",
          payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_2" } }] },
        },
        { id: "in_0", amount_paid: 0, currency: "eur", created: 1700000050, status: "paid", payments: { data: [] } },
        { id: "in_1", amount_paid: 1000, currency: "eur", created: 1700000000, status: "paid", payment_intent: "pi_1" },
      ],
    });
    fake.charges.list.mockResolvedValue({ data: [{ payment_intent: "pi_2", amount_refunded: 300 }] });
    const rows = await AdminBillingService.payments(7);
    expect(fake.invoices.list).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_A", limit: 12 }));
    expect(rows).toEqual([
      { id: "pi_2", amountCents: 1000, refundedCents: 300, currency: "eur", createdAt: new Date(1700000100 * 1000).toISOString(), status: "paid" },
      { id: "pi_1", amountCents: 1000, refundedCents: 0, currency: "eur", createdAt: new Date(1700000000 * 1000).toISOString(), status: "paid" },
    ]);
  });
});

describe("discounts", () => {
  it("approves through DiscountService and records", async () => {
    m.request.findByPk.mockResolvedValue({ id: 4, companyId: 3, status: "pending" } as never);
    m.discounts.decide.mockResolvedValue({ ok: true });
    await AdminBillingService.decideDiscount(staff, 4, true, "is a school", req);
    expect(m.discounts.decide).toHaveBeenCalledWith(4, true);
    expect(m.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "discount_approved", targetCompanyId: 3 })
    );
  });

  it("removing when there is no discount is 409", async () => {
    m.company.findByPk.mockResolvedValue({ id: 3, discount: null } as never);
    await expect(AdminBillingService.removeDiscount(staff, 3, "no longer", req)).rejects.toMatchObject({ status: 409 });
    expect(m.discounts.remove).not.toHaveBeenCalled();
  });

  it("records the removal even when Stripe fails after the discount is gone", async () => {
    m.company.findByPk
      .mockResolvedValueOnce({ id: 3, discount: "school" } as never)
      .mockResolvedValueOnce({ id: 3, discount: null } as never);
    m.discounts.remove.mockRejectedValue(new Error("stripe down"));
    await expect(AdminBillingService.removeDiscount(staff, 3, "no longer", req)).rejects.toThrow("stripe down");
    expect(m.actions.record).toHaveBeenCalledWith(expect.objectContaining({ action: "discount_removed" }));
  });
});
