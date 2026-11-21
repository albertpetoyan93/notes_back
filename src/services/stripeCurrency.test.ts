import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import sequelize from "../configs/DB/sequelize";
import Subscription from "../models/Subscription";
import User from "../models/User";
import StripeService from "./StripeService";

const fake = {
  checkout: { sessions: { create: vi.fn() } },
  subscriptions: { retrieve: vi.fn() },
};

const findOne = vi.spyOn(Subscription, "findOne");
const update = vi.spyOn(Subscription, "update");

afterAll(() => StripeService.setClient(null));

beforeEach(() => {
  vi.resetAllMocks();
  StripeService.setClient(fake as unknown as Stripe);
  update.mockResolvedValue([0] as never);
});

describe("checkout currency", () => {
  it("keeps the currency this person already pays in", async () => {
    findOne.mockResolvedValueOnce({ currency: "eur" } as never);
    await expect(StripeService.checkoutCurrency({ userId: 5 }, "usd")).resolves.toBe("eur");
  });

  it("otherwise uses the currency the screen showed", async () => {
    findOne.mockResolvedValueOnce(null as never);
    await expect(StripeService.checkoutCurrency({ userId: 5 }, "eur")).resolves.toBe("eur");
  });

  it("falls back to USD for anything else", async () => {
    findOne.mockResolvedValueOnce(null as never);
    await expect(StripeService.checkoutCurrency({ userId: 5 }, "gbp")).resolves.toBe("usd");
  });
});

describe("checkout page", () => {
  it("sends the currency, the withdrawal consent and (with tax on) the VAT number field", async () => {
    process.env.STRIPE_AUTOMATIC_TAX = "true";
    const service = StripeService as any;
    vi.spyOn(service, "ownerFor").mockResolvedValue({ userId: 5 });
    vi.spyOn(service, "stripeSubscription").mockResolvedValue(null);
    vi.spyOn(service, "customerFor").mockResolvedValue("cus_5");
    vi.spyOn(service, "priceId").mockResolvedValue("price_premium_month");
    findOne.mockResolvedValue(null as never); // no trial, no earlier currency
    fake.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.stripe.test/x" });

    await expect(StripeService.checkout(5, { plan: "premium", interval: "month", currency: "eur" })).resolves.toEqual({
      url: "https://checkout.stripe.test/x",
    });

    const params = fake.checkout.sessions.create.mock.calls[0][0];
    expect(params.currency).toBe("eur");
    expect(params.consent_collection).toEqual({ terms_of_service: "required" });
    expect(params.custom_text.terms_of_service_acceptance.message).toMatch(/right of withdrawal/);
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.automatic_tax).toEqual({ enabled: true });
    delete process.env.STRIPE_AUTOMATIC_TAX;
  });
});

describe("billing customer", () => {
  const query = vi.spyOn(sequelize, "query") as unknown as ReturnType<typeof vi.fn>;
  const customers = { retrieve: vi.fn(), create: vi.fn() };

  beforeEach(() => {
    StripeService.setClient({ ...fake, customers } as unknown as Stripe);
    vi.spyOn(Subscription, "findOne");
  });

  it("reuses a stored customer that exists in this Stripe account", async () => {
    query.mockResolvedValueOnce([{ stripeCustomerId: "cus_live" }]);
    customers.retrieve.mockResolvedValue({ id: "cus_live" });
    await expect(StripeService.customerFor({ userId: 5 })).resolves.toBe("cus_live");
    expect(customers.create).not.toHaveBeenCalled();
  });

  it("replaces a stored customer from another account or mode (sandbox ids after going live)", async () => {
    query
      .mockResolvedValueOnce([{ stripeCustomerId: "cus_sandbox" }]) // stored
      .mockResolvedValueOnce([]) // cleared
      .mockResolvedValueOnce([]) // new one saved
      .mockResolvedValueOnce([{ stripeCustomerId: "cus_new" }]); // read back
    customers.retrieve.mockRejectedValue(Object.assign(new Error("No such customer"), { code: "resource_missing" }));
    customers.create.mockResolvedValue({ id: "cus_new" });
    vi.spyOn(User, "findByPk").mockResolvedValue({ email: "a@b.test", fullName: "A" } as never);

    await expect(StripeService.customerFor({ userId: 5 })).resolves.toBe("cus_new");
    expect(query.mock.calls[1][0]).toContain(`"stripeCustomerId" = NULL`);
    expect(customers.create.mock.calls[0][1].idempotencyKey).toBe("customer-user-5-after-cus_sandbox");
  });
});

describe("subscription sync", () => {
  const remote = (over: Record<string, unknown>) => ({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    currency: "eur",
    metadata: { userId: "5" },
    cancel_at_period_end: false,
    ended_at: null,
    items: { data: [{ quantity: 1, current_period_end: 2_000_000_000, price: { lookup_key: "premium_year", metadata: {} } }] },
    ...over,
  });
  const local = () => {
    const row: any = { graceEndsAt: null, paymentFailedEmailedAt: null };
    row.set = vi.fn((values: object) => Object.assign(row, values));
    row.save = vi.fn().mockResolvedValue(row);
    row.update = vi.fn();
    return row;
  };

  it("stores the billing currency", async () => {
    const row = local();
    findOne.mockResolvedValueOnce(row as never);
    fake.subscriptions.retrieve.mockResolvedValue(remote({}));
    await StripeService.syncSubscription("sub_1");
    expect(row.currency).toBe("eur");
    expect(row.currentPeriodEnd).toEqual(new Date(2_000_000_000 * 1000));
  });

  it("ends access when a subscription is cancelled straight away, not at the unpaid period's end", async () => {
    const row = local();
    findOne.mockResolvedValueOnce(row as never);
    const endedAt = 1_900_000_000;
    fake.subscriptions.retrieve.mockResolvedValue(remote({ status: "canceled", ended_at: endedAt }));
    await StripeService.syncSubscription("sub_1");
    expect(row.status).toBe("canceled");
    expect(row.currentPeriodEnd).toEqual(new Date(endedAt * 1000));
  });

  it("keeps the paid period when it was cancelled at period end", async () => {
    const row = local();
    findOne.mockResolvedValueOnce(row as never);
    fake.subscriptions.retrieve.mockResolvedValue(remote({ status: "canceled", ended_at: 2_000_000_000 }));
    await StripeService.syncSubscription("sub_1");
    expect(row.currentPeriodEnd).toEqual(new Date(2_000_000_000 * 1000));
  });
});
