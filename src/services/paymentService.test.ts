import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import sequelize from "../configs/DB/sequelize";
import PaymentService, { paymentsCsv, type AdminPaymentRow } from "./PaymentService";
import StripeService from "./StripeService";

const row = (over: Partial<AdminPaymentRow> = {}): AdminPaymentRow => ({
  id: 1,
  paidAt: "2026-11-21T10:00:00.000Z",
  status: "paid",
  plan: "premium",
  interval: "month",
  currency: "eur",
  amountCents: 349,
  taxCents: 58,
  discountCents: 0,
  refundedCents: 0,
  promoCode: null,
  invoiceNumber: "INV-1",
  invoicePdf: null,
  hostedInvoiceUrl: null,
  periodStart: null,
  periodEnd: null,
  userId: 5,
  userEmail: "a@b.test",
  userName: "Ann",
  companyId: null,
  companyName: null,
  ...over,
});

describe("payments CSV", () => {
  it("writes amounts in major units with net after refunds", () => {
    const csv = paymentsCsv([row({ refundedCents: 100, status: "partially_refunded" })]);
    const [header, line] = csv.trim().split("\n");
    expect(header).toContain("amount,tax,discount,refunded,net");
    expect(line).toContain(",EUR,3.49,0.58,0.00,1.00,2.49,");
  });

  it("counts nothing as net for a failed payment", () => {
    expect(paymentsCsv([row({ status: "failed" })])).toContain(",3.49,0.58,0.00,0.00,0.00,");
  });

  it("quotes commas and neutralises spreadsheet formulas", () => {
    const csv = paymentsCsv([row({ userName: "=HYPERLINK(1)", companyName: "Acme, Inc" })]);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain('"Acme, Inc"');
  });
});

describe("refund webhook", () => {
  const query = vi.spyOn(sequelize, "query") as unknown as ReturnType<typeof vi.fn>;
  const refund = vi.spyOn(PaymentService, "recordRefund");

  afterAll(() => StripeService.setClient(null));
  beforeEach(() => {
    vi.resetAllMocks();
    StripeService.setClient({} as Stripe);
  });

  it("records charge.refunded on the payment", async () => {
    query.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValue([]);
    refund.mockResolvedValue("recorded");
    const charge = { id: "ch_1", payment_intent: "pi_1", amount_refunded: 100 };
    const event = { id: "evt_r", type: "charge.refunded", data: { object: charge } } as unknown as Stripe.Event;

    await expect(StripeService.handle(event)).resolves.toBe(true);
    expect(refund).toHaveBeenCalledWith(charge);
  });

  it("marks a full refund as refunded", async () => {
    refund.mockRestore();
    query.mockResolvedValueOnce([[{ id: 1 }], 1]);
    await expect(
      PaymentService.recordRefund({ payment_intent: "pi_1", amount_refunded: 349 } as Stripe.Charge)
    ).resolves.toBe("recorded");
    const [sql, options] = query.mock.calls[0];
    expect(sql).toContain("'refunded'");
    expect(options.replacements).toEqual({ refunded: 349, intent: "pi_1" });
  });
});
