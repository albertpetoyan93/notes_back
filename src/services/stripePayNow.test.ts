import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import PaymentService from "./PaymentService";
import StripeService from "./StripeService";

const fake = { subscriptions: { retrieve: vi.fn(), update: vi.fn() }, invoices: { createPreview: vi.fn() } };
const service = StripeService as any;

afterAll(() => StripeService.setClient(null));

beforeEach(() => {
  vi.restoreAllMocks();
  fake.subscriptions.retrieve.mockReset();
  fake.subscriptions.update.mockReset();
  StripeService.setClient(fake as unknown as Stripe);
  vi.spyOn(service, "paidOrFail").mockResolvedValue({ stripeSubscriptionId: "sub_1" });
  vi.spyOn(service, "syncSubscription").mockResolvedValue({ status: "active" });
});

describe("pay now (end the free days early)", () => {
  it("ends the trial now, charges at once and records the payment", async () => {
    const record = vi.spyOn(PaymentService, "recordInvoice").mockResolvedValue(undefined as never);
    fake.subscriptions.retrieve
      .mockResolvedValueOnce({ id: "sub_1", status: "trialing" })
      .mockResolvedValueOnce({ id: "sub_1", status: "active", latest_invoice: "in_1" });
    fake.subscriptions.update.mockResolvedValue({});

    await expect(StripeService.payNow(5, {})).resolves.toEqual({ status: "active" });
    expect(fake.subscriptions.update).toHaveBeenCalledWith("sub_1", {
      trial_end: "now",
      proration_behavior: "none",
      payment_behavior: "error_if_incomplete",
    });
    expect(record).toHaveBeenCalledWith("in_1", false);
  });

  it("refuses a plan that is already paid", async () => {
    fake.subscriptions.retrieve.mockResolvedValueOnce({ id: "sub_1", status: "active" });
    await expect(StripeService.payNow(5, {})).rejects.toMatchObject({ status: 409 });
    expect(fake.subscriptions.update).not.toHaveBeenCalled();
  });

  it("a declined card changes nothing and says so", async () => {
    fake.subscriptions.retrieve.mockResolvedValueOnce({ id: "sub_1", status: "trialing" });
    fake.subscriptions.update.mockRejectedValue({ type: "StripeCardError", message: "Your card was declined." });
    await expect(StripeService.payNow(5, {})).rejects.toMatchObject({
      status: 402,
      message: expect.stringMatching(/declined\. Nothing was charged/),
    });
    expect(service.syncSubscription).not.toHaveBeenCalled();
  });
});

describe("switching monthly to yearly", () => {
  const item = { id: "si_1", quantity: 1 };

  beforeEach(() => {
    fake.invoices.createPreview.mockReset();
    vi.spyOn(service, "paidOrFail").mockResolvedValue({ stripeSubscriptionId: "sub_1", plan: "premium", interval: "month" });
    vi.spyOn(service, "priceId").mockResolvedValue("price_year");
    vi.spyOn(PaymentService, "recordInvoice").mockResolvedValue("recorded");
  });

  it("previews today's charge before anything changes", async () => {
    fake.subscriptions.retrieve.mockResolvedValue({
      id: "sub_1",
      status: "active",
      items: { data: [item] },
      default_payment_method: null,
      customer: { id: "cus_1", invoice_settings: { default_payment_method: { card: { brand: "visa", last4: "4242", wallet: null } } } },
    });
    fake.invoices.createPreview.mockResolvedValue({ amount_due: 2651, currency: "usd" });

    const preview = await StripeService.previewInterval(5, { interval: "year" });
    expect(preview).toMatchObject({
      amountCents: 2651,
      currency: "usd",
      trialEndsAt: null,
      card: { brand: "visa", last4: "4242", wallet: null },
    });
    expect(fake.invoices.createPreview.mock.calls[0][0].customer).toBe("cus_1");
    const params = fake.invoices.createPreview.mock.calls[0][0];
    expect(params.subscription_details.items).toEqual([{ id: "si_1", price: "price_year", quantity: 1 }]);
    expect(params.subscription_details.proration_date).toBe(preview.prorationDate);
    expect(fake.subscriptions.update).not.toHaveBeenCalled();
  });

  it("charges at the moment the preview was priced at", async () => {
    fake.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", items: { data: [item] } });
    fake.subscriptions.update.mockResolvedValue({});
    const at = Math.floor(Date.now() / 1000) - 30;

    await StripeService.changeInterval(5, { interval: "year", prorationDate: at });
    expect(fake.subscriptions.update.mock.calls[0][1]).toMatchObject({
      proration_date: at,
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
    });
  });

  it("a declined card keeps the plan as it was", async () => {
    fake.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", items: { data: [{ ...item, price: { recurring: { interval: "month" } } }] } });
    fake.subscriptions.update.mockRejectedValue({ type: "StripeCardError", message: "Your card was declined." });
    await expect(StripeService.changeInterval(5, { interval: "year" })).rejects.toMatchObject({
      status: 402,
      message: expect.stringMatching(/still on monthly/),
    });
    expect(service.syncSubscription).not.toHaveBeenCalled();
  });

  it("ignores a stale or future proration moment", async () => {
    fake.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", items: { data: [item] } });
    fake.subscriptions.update.mockResolvedValue({});
    await StripeService.changeInterval(5, { interval: "year", prorationDate: Math.floor(Date.now() / 1000) + 600 });
    expect(fake.subscriptions.update.mock.calls[0][1].proration_date).toBeUndefined();
  });
});

describe("try a failed payment again", () => {
  const open = { id: "in_9", status: "open", amount_due: 2950, currency: "usd" };
  const remote = {
    id: "sub_1",
    latest_invoice: open,
    default_payment_method: { card: { brand: "mastercard", last4: "3081", wallet: null } },
    customer: { id: "cus_1", invoice_settings: {} },
  };
  const invoices = { pay: vi.fn() };

  beforeEach(() => {
    invoices.pay.mockReset();
    StripeService.setClient({ ...fake, invoices: { ...fake.invoices, ...invoices } } as unknown as Stripe);
    vi.spyOn(service, "stripeSubscription").mockResolvedValue({ stripeSubscriptionId: "sub_1" });
    fake.subscriptions.retrieve.mockResolvedValue(remote);
  });

  it("shows the amount and the card before charging", async () => {
    await expect(StripeService.previewRetry(5, {})).resolves.toMatchObject({
      amountCents: 2950,
      currency: "usd",
      card: { brand: "mastercard", last4: "3081", wallet: null },
    });
    expect(invoices.pay).not.toHaveBeenCalled();
  });

  it("charges the unpaid invoice and records it", async () => {
    const record = vi.spyOn(PaymentService, "recordInvoice").mockResolvedValue("recorded");
    invoices.pay.mockResolvedValue({});
    await StripeService.retryPayment(5, {});
    expect(invoices.pay).toHaveBeenCalledWith("in_9", { off_session: true });
    expect(record).toHaveBeenCalledWith("in_9", false);
  });

  it("a declined card says so and changes nothing", async () => {
    invoices.pay.mockRejectedValue({ type: "StripeCardError", message: "Your card has insufficient funds." });
    await expect(StripeService.retryPayment(5, {})).rejects.toMatchObject({ status: 402 });
    expect(service.syncSubscription).not.toHaveBeenCalled();
  });

  it("nothing to retry when the last invoice is paid", async () => {
    fake.subscriptions.retrieve.mockResolvedValue({ ...remote, latest_invoice: { ...open, status: "paid" } });
    await expect(StripeService.previewRetry(5, {})).rejects.toMatchObject({ status: 409 });
  });
});

describe("invoice breakdown for the confirm dialog", () => {
  it("splits the new plan, the credit for unused time and the discount", async () => {
    const { invoiceBreakdown } = await import("./StripeService");
    const result = invoiceBreakdown({
      lines: {
        data: [
          { amount: -349, period: { start: 1795000000, end: 1797600000 } },
          { amount: 3000, period: { start: 1795000000, end: 1826500000 } },
        ],
      },
      total_discount_amounts: [{ amount: 299 }],
      total_taxes: [],
    } as any);
    expect(result).toMatchObject({ priceCents: 3000, creditCents: 349, discountCents: 299, taxCents: 0 });
    expect(result.periodEnd?.getTime()).toBe(1826500000 * 1000);
  });
});
