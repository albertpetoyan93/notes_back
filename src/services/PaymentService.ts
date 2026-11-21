import type Stripe from "stripe";
import { QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import StripeService, { type Owner } from "./StripeService";

/**
 * 2keevo's own record of payments, copied from Stripe invoices: what users see as their
 * payment history and what the admin app totals. Stripe stays the source of truth; every
 * write here re-reads the invoice, so late or repeated webhooks leave the same row.
 */

export type PaymentStatus = "paid" | "refunded" | "partially_refunded" | "failed";
export type GroupBy = "week" | "month" | "year";

export interface PaymentRow {
  id: number;
  paidAt: string;
  status: PaymentStatus;
  plan: string | null;
  interval: string | null;
  currency: string;
  amountCents: number;
  taxCents: number;
  discountCents: number;
  refundedCents: number;
  promoCode: string | null;
  invoiceNumber: string | null;
  invoicePdf: string | null;
  hostedInvoiceUrl: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface AdminPaymentRow extends PaymentRow {
  userId: number | null;
  userEmail: string | null;
  userName: string | null;
  companyId: number | null;
  companyName: string | null;
}

export interface PaymentFilter {
  from?: string; // YYYY-MM-DD, inclusive
  to?: string; // YYYY-MM-DD, inclusive
  currency?: string;
  plan?: string;
  status?: PaymentStatus;
  userId?: number;
  companyId?: number;
}

const sum = (items: { amount?: number | null }[] | null | undefined) =>
  (items || []).reduce((total, item) => total + (item?.amount || 0), 0);

const iso = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null);

function paymentIntentOf(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as any).payment_intent;
  if (legacy) return typeof legacy === "string" ? legacy : legacy.id;
  for (const entry of (invoice as any).payments?.data ?? []) {
    const intent = entry.payment?.payment_intent;
    if (intent) return typeof intent === "string" ? intent : intent.id;
  }
  return null;
}

const COLUMNS = `p.id, p."paidAt", p.status, p.plan, p.interval, p.currency, p."amountCents", p."taxCents",
  p."discountCents", p."refundedCents", p."promoCode", p."invoiceNumber", p."invoicePdf",
  p."hostedInvoiceUrl", p."periodStart", p."periodEnd"`;

class PaymentService {
  /* Recording ---------------------------------------------------------------------- */

  /**
   * Record a paid (or failed) invoice. Invoices that charge nothing (a trial start) and
   * invoices for other products in the same Stripe account are skipped.
   */
  async recordInvoice(invoiceId: string, failed = false): Promise<"recorded" | "skipped"> {
    const stripe = StripeService.client();
    const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["payments", "discounts"] });
    const amount = failed ? invoice.amount_due : invoice.amount_paid;
    if (!amount) return "skipped";

    const subscriptionId = StripeService.invoiceSubscriptionId(invoice);
    if (!subscriptionId) return "skipped";
    const remote = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
    const price = remote.items.data[0]?.price as Stripe.Price | undefined;
    const planned = price ? StripeService.planOf(price) : null;
    if (!planned) return "skipped";
    const owner: Owner | null = await StripeService.ownerOfRemote(remote);
    if (!owner) return "skipped";

    const line = invoice.lines?.data?.[0];
    const paidAt =
      iso(invoice.status_transitions?.paid_at) || iso(invoice.status_transitions?.finalized_at) || iso(invoice.created)!;

    await sequelize.query(
      `INSERT INTO "payments" ("stripeInvoiceId", "stripePaymentIntentId", "userId", "companyId", plan, interval,
         status, currency, "amountCents", "taxCents", "discountCents", "promoCode", "invoiceNumber", "invoicePdf",
         "hostedInvoiceUrl", "periodStart", "periodEnd", "paidAt")
       VALUES (:invoiceId, :intent, :userId, :companyId, :plan, :interval, :status, :currency, :amount, :tax,
         :discount, :promoCode, :number, :pdf, :hosted, :periodStart, :periodEnd, :paidAt)
       ON CONFLICT ("stripeInvoiceId") DO UPDATE SET
         "stripePaymentIntentId" = EXCLUDED."stripePaymentIntentId",
         "amountCents" = EXCLUDED."amountCents", "taxCents" = EXCLUDED."taxCents",
         "discountCents" = EXCLUDED."discountCents", "promoCode" = EXCLUDED."promoCode",
         "invoiceNumber" = EXCLUDED."invoiceNumber", "invoicePdf" = EXCLUDED."invoicePdf",
         "hostedInvoiceUrl" = EXCLUDED."hostedInvoiceUrl", "paidAt" = EXCLUDED."paidAt",
         -- A refund recorded earlier keeps its status; a failure later paid becomes paid.
         status = CASE WHEN "payments"."refundedCents" > 0 THEN "payments".status ELSE EXCLUDED.status END,
         "updatedAt" = NOW()`,
      {
        replacements: {
          invoiceId: invoice.id,
          intent: paymentIntentOf(invoice),
          userId: "userId" in owner ? owner.userId : null,
          companyId: "companyId" in owner ? owner.companyId : null,
          plan: planned.plan,
          interval: planned.interval,
          status: failed ? "failed" : "paid",
          currency: invoice.currency,
          amount,
          tax: sum((invoice as any).total_taxes) || (invoice as any).tax || 0,
          discount: sum(invoice.total_discount_amounts as any),
          promoCode: await this.promoCodeOf(invoice),
          number: invoice.number || null,
          pdf: invoice.invoice_pdf || null,
          hosted: invoice.hosted_invoice_url || null,
          periodStart: iso(line?.period?.start),
          periodEnd: iso(line?.period?.end),
          paidAt,
        },
      }
    );
    return "recorded";
  }

  /** A refund (full or partial) on a recorded payment. */
  async recordRefund(charge: Stripe.Charge): Promise<"recorded" | "skipped"> {
    const intent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    if (!intent) return "skipped";
    const [rows] = (await sequelize.query(
      `UPDATE "payments" SET "refundedCents" = :refunded,
         status = CASE WHEN :refunded >= "amountCents" THEN 'refunded' WHEN :refunded > 0 THEN 'partially_refunded' ELSE status END,
         "updatedAt" = NOW()
       WHERE "stripePaymentIntentId" = :intent RETURNING id`,
      { replacements: { refunded: charge.amount_refunded || 0, intent } }
    )) as [unknown[], unknown];
    return rows.length ? "recorded" : "skipped";
  }

  private async promoCodeOf(invoice: Stripe.Invoice): Promise<string | null> {
    for (const discount of (invoice.discounts || []) as (string | Stripe.Discount)[]) {
      if (typeof discount === "string") continue;
      const promo = discount.promotion_code;
      if (!promo) continue;
      if (typeof promo !== "string") return promo.code;
      try {
        return (await StripeService.client().promotionCodes.retrieve(promo)).code;
      } catch {
        return null;
      }
    }
    return null;
  }

  /* Reading ------------------------------------------------------------------------ */

  /** A person's or a company's payments, newest first. */
  async forOwner(owner: Owner, limit = 50): Promise<PaymentRow[]> {
    const where = "userId" in owner ? `p."userId" = :id` : `p."companyId" = :id`;
    return sequelize.query<PaymentRow>(
      `SELECT ${COLUMNS} FROM "payments" p WHERE ${where} ORDER BY p."paidAt" DESC LIMIT :limit`,
      {
        replacements: { id: "userId" in owner ? owner.userId : owner.companyId, limit },
        type: QueryTypes.SELECT,
      }
    );
  }

  private where(filter: PaymentFilter) {
    const parts: string[] = [];
    const replacements: Record<string, unknown> = {};
    if (filter.from) {
      parts.push(`p."paidAt" >= :from::date`);
      replacements.from = filter.from;
    }
    if (filter.to) {
      parts.push(`p."paidAt" < (:to::date + INTERVAL '1 day')`);
      replacements.to = filter.to;
    }
    for (const key of ["currency", "plan", "status"] as const) {
      if (filter[key]) {
        parts.push(`p.${key} = :${key}`);
        replacements[key] = filter[key];
      }
    }
    if (filter.userId) {
      parts.push(`p."userId" = :userId`);
      replacements.userId = filter.userId;
    }
    if (filter.companyId) {
      parts.push(`p."companyId" = :companyId`);
      replacements.companyId = filter.companyId;
    }
    return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", replacements };
  }

  /**
   * Admin report: totals per currency (EUR and USD are never added together), the same
   * grouped by week, month or year, and one page of rows.
   */
  async report(filter: PaymentFilter, groupBy: GroupBy, page = 1, pageSize = 50) {
    const { sql, replacements } = this.where(filter);
    // Money in: paid and refunded payments (refunds are subtracted separately). Failed ones only count.
    const money = `p.status <> 'failed'`;

    const totals = await sequelize.query<{
      currency: string;
      payments: number;
      grossCents: number;
      refundedCents: number;
      taxCents: number;
      failed: number;
    }>(
      `SELECT p.currency,
         COUNT(*) FILTER (WHERE ${money})::int AS payments,
         COALESCE(SUM(p."amountCents") FILTER (WHERE ${money}), 0)::int AS "grossCents",
         COALESCE(SUM(p."refundedCents"), 0)::int AS "refundedCents",
         COALESCE(SUM(p."taxCents") FILTER (WHERE ${money}), 0)::int AS "taxCents",
         COUNT(*) FILTER (WHERE p.status = 'failed')::int AS failed
       FROM "payments" p ${sql} GROUP BY p.currency ORDER BY p.currency`,
      { replacements, type: QueryTypes.SELECT }
    );

    const series = await sequelize.query<{ period: string; currency: string; grossCents: number; refundedCents: number; payments: number }>(
      `SELECT to_char(date_trunc(:groupBy, p."paidAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS period, p.currency,
         COALESCE(SUM(p."amountCents") FILTER (WHERE ${money}), 0)::int AS "grossCents",
         COALESCE(SUM(p."refundedCents"), 0)::int AS "refundedCents",
         COUNT(*) FILTER (WHERE ${money})::int AS payments
       FROM "payments" p ${sql} GROUP BY 1, 2 ORDER BY 1, 2`,
      { replacements: { ...replacements, groupBy }, type: QueryTypes.SELECT }
    );

    const [{ count }] = await sequelize.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "payments" p ${sql}`,
      { replacements, type: QueryTypes.SELECT }
    );
    const rows = await this.rows(sql, replacements, pageSize, (page - 1) * pageSize);

    return {
      totals: totals.map((t) => ({ ...t, netCents: t.grossCents - t.refundedCents })),
      series: series.map((s) => ({ ...s, netCents: s.grossCents - s.refundedCents })),
      rows,
      total: count,
      page,
      pageSize,
    };
  }

  /** Every row matching the filter (up to 10 000), for CSV export. */
  async exportRows(filter: PaymentFilter) {
    const { sql, replacements } = this.where(filter);
    return this.rows(sql, replacements, 10000, 0);
  }

  private rows(sql: string, replacements: Record<string, unknown>, limit: number, offset: number) {
    return sequelize.query<AdminPaymentRow>(
      `SELECT ${COLUMNS}, p."userId", u.email AS "userEmail", COALESCE(NULLIF(u."fullName", ''), u.username) AS "userName",
         p."companyId", c.name AS "companyName"
       FROM "payments" p
       LEFT JOIN "users" u ON u.id = p."userId"
       LEFT JOIN "companies" c ON c.id = p."companyId"
       ${sql} ORDER BY p."paidAt" DESC LIMIT :limit OFFSET :offset`,
      { replacements: { ...replacements, limit, offset }, type: QueryTypes.SELECT }
    );
  }
}

/** CSV for spreadsheets: one line per payment, amounts in major units (e.g. 3.49). */
export function paymentsCsv(rows: AdminPaymentRow[]): string {
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    // Quote everything that needs it; a leading = + - @ is neutralised for spreadsheet safety.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const major = (cents: number) => (cents / 100).toFixed(2);
  const header = [
    "date", "status", "user_email", "user_name", "company", "plan", "interval", "currency",
    "amount", "tax", "discount", "refunded", "net", "promo_code", "invoice_number",
  ];
  const lines = rows.map((r) =>
    [
      new Date(r.paidAt).toISOString(), r.status, r.userEmail, r.userName, r.companyName, r.plan, r.interval,
      r.currency.toUpperCase(), major(r.amountCents), major(r.taxCents), major(r.discountCents),
      major(r.refundedCents), major(r.status === "failed" ? 0 : r.amountCents - r.refundedCents), r.promoCode,
      r.invoiceNumber,
    ].map(cell).join(",")
  );
  return [header.join(","), ...lines].join("\n") + "\n";
}

export default new PaymentService();
