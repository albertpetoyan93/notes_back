import type { Request } from "express";
import type Stripe from "stripe";
import sequelize from "../../configs/DB/sequelize";
import Company from "../../models/Company";
import DiscountRequest from "../../models/DiscountRequest";
import Subscription from "../../models/Subscription";
import DiscountService from "../DiscountService";
import StripeService, { Interval } from "../StripeService";
import AdminActionService, { AdminActionName, cleanReason } from "./AdminActionService";
import { actor, Staff } from "./SupportActionService";

export type PaidPlan = "premium" | "family" | "team";

export interface PaymentRow {
  /** The payment intent: what a refund is made against. */
  id: string;
  amountCents: number;
  refundedCents: number;
  currency: string;
  createdAt: string;
  status: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

async function loadSubscription(subscriptionId: number) {
  const subscription = await Subscription.findByPk(subscriptionId);
  if (!subscription) throw fail(404, "Subscription not found.");
  return subscription;
}

/** Cancel, refund and plan changes only work on plans Stripe bills. */
function stripeIdOf(subscription: Subscription) {
  if (!subscription.stripeSubscriptionId) throw fail(409, "This plan isn't paid through Stripe.");
  return subscription.stripeSubscriptionId;
}

const targets = (subscription: Subscription) => ({
  ...(subscription.userId ? { targetUserId: subscription.userId } : {}),
  ...(subscription.companyId ? { targetCompanyId: subscription.companyId } : {}),
});

/** The payment intent an invoice was paid with, on old and new Stripe API versions. */
function paymentIntentOf(invoice: Stripe.Invoice): string | null {
  const legacy = (invoice as any).payment_intent;
  if (legacy) return typeof legacy === "string" ? legacy : legacy.id;
  for (const entry of invoice.payments?.data ?? []) {
    const intent = entry.payment?.payment_intent;
    if (intent) return typeof intent === "string" ? intent : intent.id;
  }
  return null;
}

/**
 * What staff can do to a subscription (personal, family or company alike). Checks come
 * first, so a refused action changes nothing. Once Stripe has accepted a change, the
 * AdminAction is written even if syncing the local copy fails afterwards.
 */
class AdminBillingService {
  static async cancel(staff: Staff, subscriptionId: number, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const subscription = await loadSubscription(subscriptionId);
    const stripeId = stripeIdOf(subscription);
    if (subscription.status === "canceled" || subscription.status === "expired") throw fail(409, "Already ended.");
    if (subscription.cancelAtPeriodEnd) throw fail(409, "Already set to cancel at the end of the period.");

    await StripeService.client().subscriptions.update(stripeId, { cancel_at_period_end: true });
    await this.syncAndRecord(stripeId, staff, "subscription_cancelled", subscription, why, req, {});
  }

  /** The customer's last 12 invoices that were paid with a payment intent. */
  static async payments(subscriptionId: number): Promise<PaymentRow[]> {
    const subscription = await loadSubscription(subscriptionId);
    const customer = subscription.stripeCustomerId;
    if (!customer) return [];
    const stripe = StripeService.client();
    const invoices = await stripe.invoices.list({ customer, limit: 12, expand: ["data.payments"] });
    const charges = await stripe.charges.list({ customer, limit: 100 });
    const refunded = new Map<string, number>();
    for (const charge of charges.data) {
      const intent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (intent) refunded.set(intent, (refunded.get(intent) || 0) + (charge.amount_refunded || 0));
    }

    const seen = new Set<string>();
    const rows: PaymentRow[] = [];
    for (const invoice of invoices.data) {
      const id = paymentIntentOf(invoice);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        amountCents: invoice.amount_paid,
        refundedCents: refunded.get(id) || 0,
        currency: invoice.currency,
        createdAt: new Date(invoice.created * 1000).toISOString(),
        status: invoice.status,
      });
    }
    return rows;
  }

  /** The whole payment, or `amountCents` of it. */
  static async refund(
    staff: Staff,
    subscriptionId: number,
    paymentIntentId: unknown,
    amountCents: unknown,
    reason: unknown,
    req: Request
  ) {
    const why = cleanReason(reason);
    if (typeof paymentIntentId !== "string" || !paymentIntentId.trim()) throw fail(400, "Choose a payment.");
    const amount = amountCents === undefined || amountCents === null ? undefined : Number(amountCents);
    if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0)) {
      throw fail(400, "Enter the amount in cents.");
    }
    const subscription = await loadSubscription(subscriptionId);
    const stripe = StripeService.client();

    // Only a payment made by this subscription's customer can be refunded from here.
    let intent: Stripe.PaymentIntent | null = null;
    try {
      intent = await stripe.paymentIntents.retrieve(paymentIntentId.trim(), { expand: ["latest_charge"] });
    } catch (error: any) {
      if (error?.code !== "resource_missing") throw error;
    }
    const customer = typeof intent?.customer === "string" ? intent.customer : intent?.customer?.id;
    if (!intent || !customer || !subscription.stripeCustomerId || customer !== subscription.stripeCustomerId) {
      throw fail(409, "That payment isn't on this subscription's account.");
    }

    // A double submit or a retry collapses into one refund; a deliberate second refund
    // after the first landed gets a new key, since the refunded total has moved.
    const charge = intent.latest_charge && typeof intent.latest_charge !== "string" ? intent.latest_charge : null;
    const refund = await stripe.refunds.create(
      {
        payment_intent: intent.id,
        ...(amount !== undefined ? { amount } : {}),
      },
      { idempotencyKey: `admin-refund-${intent.id}-${amount ?? "full"}-${charge?.amount_refunded ?? 0}` }
    );
    await AdminActionService.record({
      staff: actor(staff),
      action: "payment_refunded",
      ...targets(subscription),
      reason: why,
      details: {
        subscriptionId: subscription.id,
        paymentIntentId: intent.id,
        refundId: refund.id,
        amountCents: refund.amount ?? amount ?? null,
      },
      req,
    });
  }

  /** Charged or credited now for the difference. */
  static async changePlan(
    staff: Staff,
    subscriptionId: number,
    input: { plan: unknown; interval: unknown },
    reason: unknown,
    req: Request
  ) {
    const why = cleanReason(reason);
    const plan = input.plan as PaidPlan;
    const interval = input.interval as Interval;
    if (plan !== "premium" && plan !== "family" && plan !== "team") throw fail(400, "Choose Premium, Family or Team.");
    if (interval !== "month" && interval !== "year") throw fail(400, "Choose monthly or yearly.");

    const subscription = await loadSubscription(subscriptionId);
    const stripeId = stripeIdOf(subscription);
    if (subscription.status === "canceled" || subscription.status === "expired") throw fail(409, "This plan has ended.");
    // Team is paid by a company, Premium and Family by a person.
    if (plan === "team" && !subscription.companyId) throw fail(409, "Only a company can have Team.");
    if (plan !== "team" && !subscription.userId) throw fail(409, "A company's plan can only be Team.");

    const stripe = StripeService.client();
    const price = await StripeService.priceId(plan, interval);
    const remote = await stripe.subscriptions.retrieve(stripeId);
    const item = remote.items.data[0];
    if (!item) throw fail(409, "This subscription has no plan in Stripe.");
    // Team seats always follow the member count — staff can't set them by hand.
    const quantity = plan === "team" ? await StripeService.seatsFor(subscription.companyId as number) : 1;

    await stripe.subscriptions.update(stripeId, {
      items: [{ id: item.id, price, quantity }],
      proration_behavior: "always_invoice",
    });
    await this.syncAndRecord(stripeId, staff, "plan_changed", subscription, why, req, {
      fromPlan: subscription.plan,
      fromInterval: subscription.interval ?? null,
      toPlan: plan,
      toInterval: interval,
      seats: quantity,
    });
  }

  /** A 2keevo trial gets a later end; a Stripe trial (deferred first charge) a later first charge. */
  static async extendTrial(staff: Staff, subscriptionId: number, days: unknown, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const count = Number(days);
    if (!Number.isInteger(count) || count < 1 || count > 30) throw fail(400, "Extend by 1 to 30 days.");
    const subscription = await loadSubscription(subscriptionId);

    if (!subscription.stripeSubscriptionId) {
      const end = subscription.trialEndsAt ? new Date(subscription.trialEndsAt).getTime() : 0;
      if (subscription.status !== "trialing" || end <= Date.now()) throw fail(409, "Not in a trial.");
      const trialEndsAt = new Date(end + count * DAY_MS);
      // One transaction: no extension without its AdminAction row.
      await sequelize.transaction(async (transaction) => {
        // A fresh reminder goes out before the new end.
        const [changed] = await Subscription.update(
          { trialEndsAt, trialReminderSentAt: null },
          { where: { id: subscription.id, status: "trialing", trialEndsAt: subscription.trialEndsAt }, transaction }
        );
        if (!changed) throw fail(409, "The trial changed meanwhile. Reload and try again.");
        await AdminActionService.record({
          staff: actor(staff),
          action: "trial_extended",
          ...targets(subscription),
          reason: why,
          details: { subscriptionId: subscription.id, days: count, trialEndsAt: trialEndsAt.toISOString(), stripe: false },
          req,
          transaction,
        });
      });
      return;
    }

    const stripeId = subscription.stripeSubscriptionId;
    const stripe = StripeService.client();
    const remote = await stripe.subscriptions.retrieve(stripeId);
    if (remote.status !== "trialing" || !remote.trial_end) throw fail(409, "Not in a trial.");
    const trialEnd = remote.trial_end + count * 24 * 60 * 60;
    await stripe.subscriptions.update(stripeId, { trial_end: trialEnd, proration_behavior: "none" });
    await this.syncAndRecord(stripeId, staff, "trial_extended", subscription, why, req, {
      days: count,
      trialEndsAt: new Date(trialEnd * 1000).toISOString(),
      stripe: true,
    });
  }

  static async decideDiscount(staff: Staff, requestId: number, approve: boolean, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const request = await DiscountRequest.findByPk(requestId, { attributes: ["id", "companyId", "status", "kind"] });
    if (!request) throw fail(404, "Discount request not found.");
    if (request.status !== "pending") throw fail(409, "That request was already decided.");

    let saved = false;
    try {
      await DiscountService.decide(request.id, approve);
      saved = true;
    } catch (error: any) {
      // The decision is saved before Stripe is updated: log it even if Stripe failed.
      // A 404 means someone else decided it first; that one isn't ours to log.
      if (error?.status !== 404) {
        saved = (await DiscountRequest.findByPk(request.id, { attributes: ["status"] }))?.status !== "pending";
      }
      throw error;
    } finally {
      if (saved) {
        await AdminActionService.record({
          staff: actor(staff),
          action: approve ? "discount_approved" : "discount_declined",
          targetCompanyId: request.companyId,
          reason: why,
          details: { requestId: request.id, kind: request.kind ?? null },
          req,
        });
      }
    }
  }

  /** From the next invoice. */
  static async removeDiscount(staff: Staff, companyId: number, reason: unknown, req: Request) {
    const why = cleanReason(reason);
    const company = await Company.findByPk(companyId, { attributes: ["id", "discount"] });
    if (!company) throw fail(404, "Company not found.");
    if (!company.discount) throw fail(409, "This company has no discount.");

    let removed = false;
    try {
      await DiscountService.remove(company.id);
      removed = true;
    } catch (error) {
      // The discount is cleared before Stripe is updated: log it even if Stripe failed.
      removed = !(await Company.findByPk(company.id, { attributes: ["id", "discount"] }))?.discount;
      throw error;
    } finally {
      if (removed) {
        await AdminActionService.record({
          staff: actor(staff),
          action: "discount_removed",
          targetCompanyId: company.id,
          reason: why,
          details: { kind: company.discount },
          req,
        });
      }
    }
  }

  /** Stripe already accepted the change: the action is logged even if the local sync fails. */
  private static async syncAndRecord(
    stripeId: string,
    staff: Staff,
    action: AdminActionName,
    subscription: Subscription,
    reason: string,
    req: Request,
    details: Record<string, string | number | boolean | null>
  ) {
    try {
      await StripeService.syncSubscription(stripeId);
    } finally {
      await AdminActionService.record({
        staff: actor(staff),
        action,
        ...targets(subscription),
        reason,
        details: { subscriptionId: subscription.id, ...details },
        req,
      });
    }
  }
}

export default AdminBillingService;
