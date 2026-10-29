import Stripe from "stripe";
import { Op, QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import EnvVars from "../common/EnvVars";
import logger from "jet-logger";
import { GRACE_DAYS, PLANS, PlanId, TEAM_MIN_SEATS } from "../common/plans";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import FamilyMember from "../models/FamilyMember";
import Subscription, { SubscriptionStatus } from "../models/Subscription";
import User from "../models/User";
import { BillingError, publicSubscription } from "./BillingService";
import CompanyBilling, { recipient } from "./CompanyBilling";
import EmailService from "./EmailService";
import EntitlementService, { isLive } from "./EntitlementService";

/**
 * Everything that talks to Stripe. Stripe charges, retries and keeps cards; 2keevo
 * keeps a copy of each subscription's state, synced from Stripe on every webhook.
 */

export type Interval = "month" | "year";
export type Owner = { userId: number } | { companyId: number };

const PAID_PLANS: PlanId[] = ["premium", "family", "team"];
const DAY_MS = 24 * 60 * 60 * 1000;
// Stripe needs a free period to end at least 48 hours ahead.
const MIN_DEFERRED_MS = 48 * 60 * 60 * 1000;

/** 50% off Team for nonprofits and schools; created by `npm run stripe:setup`. */
export const DISCOUNT_COUPON = "team-nonprofit-50";
const discountCoupon = () => process.env.STRIPE_COUPON_DISCOUNT || DISCOUNT_COUPON;

/** Prices are found by lookup key (`premium_year`, …), set by `npm run stripe:setup`. */
export const lookupKey = (plan: PlanId, interval: Interval) => `${plan}_${interval}`;

const appUrl = () => (EnvVars.FrontendOrigin || "http://localhost:5173").replace(/\/$/, "");

function ownerWhere(owner: Owner) {
  return "userId" in owner ? { userId: owner.userId } : { companyId: owner.companyId };
}

/** Stripe's subscription status, in 2keevo's words. */
export function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case "active":
    case "trialing": // first charge deferred to the end of a 2keevo trial: already paid for
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      // incomplete, incomplete_expired, paused: nothing unlocked
      return "expired";
  }
}

class StripeService {
  private stripe: Stripe | null = null;
  private prices = new Map<string, string>();

  enabled() {
    return Boolean(process.env.STRIPE_SECRET_KEY);
  }

  /** Tests can hand in a fake client. */
  setClient(client: Stripe | null) {
    this.stripe = client;
    this.prices.clear();
  }

  client() {
    if (this.stripe) return this.stripe;
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new BillingError("Payments aren't set up yet.", 503);
    }
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    return this.stripe;
  }

  /* Prices ------------------------------------------------------------------- */

  async priceId(plan: PlanId, interval: Interval) {
    const key = lookupKey(plan, interval);
    const override = process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`];
    if (override) return override;
    if (this.prices.has(key)) return this.prices.get(key) as string;
    const found = await this.client().prices.list({ lookup_keys: [key], active: true, limit: 1 });
    const price = found.data[0];
    if (!price) throw new BillingError(`The ${plan} ${interval}ly price isn't set up in Stripe.`, 503);
    this.prices.set(key, price.id);
    return price.id;
  }

  /** Which plan and interval a Stripe price is. */
  planOf(price: Stripe.Price): { plan: PlanId; interval: Interval } | null {
    const [plan, interval] = String(price.lookup_key || price.metadata?.lookup_key || "").split("_");
    if (!PAID_PLANS.includes(plan as PlanId) || (interval !== "month" && interval !== "year")) return null;
    return { plan: plan as PlanId, interval };
  }

  /* Customers ----------------------------------------------------------------- */

  private async storedCustomer(owner: Owner): Promise<string | null> {
    const [table, id] = "userId" in owner ? ["users", owner.userId] : ["companies", owner.companyId];
    const rows = await sequelize.query<{ stripeCustomerId: string | null }>(
      `SELECT "stripeCustomerId" FROM "${table}" WHERE id = :id`,
      { replacements: { id }, type: QueryTypes.SELECT }
    );
    return rows[0]?.stripeCustomerId || null;
  }

  async customerFor(owner: Owner) {
    const existing = await this.storedCustomer(owner);
    if (existing) return existing;

    let details: Stripe.CustomerCreateParams;
    if ("userId" in owner) {
      const user = await User.findByPk(owner.userId, { attributes: ["email", "fullName", "username"] });
      if (!user) throw new BillingError("Account not found.", 404);
      details = { email: user.email, name: user.fullName || user.username, metadata: { userId: String(owner.userId) } };
    } else {
      const company = await Company.findByPk(owner.companyId, { attributes: ["name"] });
      if (!company) throw new BillingError("Company not found.", 404);
      const ownerMember = await CompanyMember.findOne({
        where: { companyId: owner.companyId, role: "owner", status: "active" },
        attributes: ["userId"],
      });
      const ownerUser = ownerMember?.userId
        ? await User.findByPk(ownerMember.userId, { attributes: ["email"] })
        : null;
      details = { name: company.name, email: ownerUser?.email, metadata: { companyId: String(owner.companyId) } };
    }

    const customer = await this.client().customers.create(details, {
      // Two clicks at once must not make two customers.
      idempotencyKey: `customer-${"userId" in owner ? `user-${owner.userId}` : `company-${owner.companyId}`}`,
    });
    const [table, id] = "userId" in owner ? ["users", owner.userId] : ["companies", owner.companyId];
    await sequelize.query(`UPDATE "${table}" SET "stripeCustomerId" = :customer WHERE id = :id AND "stripeCustomerId" IS NULL`, {
      replacements: { customer: customer.id, id },
    });
    return (await this.storedCustomer(owner)) || customer.id;
  }

  /* Who pays for what ------------------------------------------------------------ */

  /** The owner a request is about: the person, or a company they own. */
  async ownerFor(userId: number, plan: PlanId, companyId?: unknown): Promise<Owner> {
    if (plan !== "team") return { userId };
    const id = Number(companyId);
    const member = Number.isInteger(id)
      ? await CompanyMember.findOne({ where: { companyId: id, userId, status: "active" } })
      : null;
    if (!member || member.role !== "owner") {
      throw new BillingError("Only the company's owner can manage its plan.", 403);
    }
    return { companyId: id };
  }

  /** The owner's subscription paid through Stripe, if any (latest first). */
  async stripeSubscription(owner: Owner) {
    return Subscription.findOne({
      where: { ...ownerWhere(owner), stripeSubscriptionId: { [Op.ne]: null } },
      order: [["updatedAt", "DESC"]],
    });
  }

  async seatsFor(companyId: number) {
    const active = await CompanyMember.count({ where: { companyId, status: "active" } });
    return Math.max(TEAM_MIN_SEATS, active);
  }

  /**
   * Team seats follow accepted members (invited people are never billed, minimum 2).
   * A new member is charged pro rata on the next invoice; a freed seat stops being
   * billed at the next renewal (no refund for the time already paid).
   */
  async syncSeats(companyId: number) {
    if (!this.enabled()) return null;
    const subscription = await this.stripeSubscription({ companyId });
    if (!subscription?.stripeSubscriptionId || !isLive(subscription) || subscription.status === "canceled") return null;
    const seats = await this.seatsFor(companyId);
    const remote = await this.client().subscriptions.retrieve(subscription.stripeSubscriptionId);
    const item = remote.items.data[0];
    if (!item || item.quantity === seats) return publicSubscription(subscription);
    await this.client().subscriptions.update(remote.id, {
      items: [{ id: item.id, quantity: seats }],
      proration_behavior: seats > (item.quantity || 0) ? "create_prorations" : "none",
    });
    return this.syncSubscription(remote.id);
  }

  /** Seat changes run after the membership change; a Stripe hiccup is fixed by the daily reconcile. */
  syncSeatsLater(companyId: number) {
    void this.syncSeats(companyId).catch((error) =>
      logger.err(`seats for company ${companyId}: ${error?.message || error}`)
    );
  }

  /** Daily: every paid Team matches its member count. */
  async reconcileSeats() {
    if (!this.enabled()) return { checked: 0 };
    const paid = await Subscription.findAll({
      where: { plan: "team", companyId: { [Op.ne]: null }, stripeSubscriptionId: { [Op.ne]: null }, status: { [Op.in]: ["active", "past_due"] } },
      attributes: ["companyId"],
    });
    for (const row of paid) await this.syncSeats(row.companyId as number);
    return { checked: paid.length };
  }

  /* Checkout and the customer portal ------------------------------------------------ */

  /** A Stripe Checkout page for a paid plan. Returns the URL to send the person to. */
  async checkout(userId: number, input: { plan: unknown; interval: unknown; companyId?: unknown }) {
    const plan = input.plan as PlanId;
    const interval = input.interval as Interval;
    if (plan !== "premium" && plan !== "family" && plan !== "team") {
      throw new BillingError("Choose Premium, Family or Team.");
    }
    if (plan === "family" && (await FamilyMember.count({ where: { userId, status: "active" } }))) {
      throw new BillingError("You are in someone's family. Leave it to start your own.", 409);
    }
    if (interval !== "month" && interval !== "year") throw new BillingError("Choose monthly or yearly.");

    const owner = await this.ownerFor(userId, plan, input.companyId);
    const current = await this.stripeSubscription(owner);
    if (current && isLive(current) && current.status !== "canceled") {
      throw new BillingError("This plan is already paid. Use Manage billing to change it.", 409);
    }

    const quantity = "companyId" in owner ? await this.seatsFor(owner.companyId) : 1;
    const metadata: Record<string, string> =
      "userId" in owner ? { userId: String(owner.userId), plan } : { companyId: String(owner.companyId), plan };

    // Subscribing during a 2keevo trial: the first charge waits until the trial ends.
    const trial = await Subscription.findOne({
      where: { ...ownerWhere(owner), status: "trialing", stripeSubscriptionId: null },
      order: [["trialEndsAt", "DESC"]],
    });
    const trialEnd =
      trial?.trialEndsAt && new Date(trial.trialEndsAt).getTime() - Date.now() > MIN_DEFERRED_MS
        ? Math.floor(new Date(trial.trialEndsAt).getTime() / 1000)
        : undefined;

    // An approved nonprofit or school discount; otherwise a promotion code may be typed in.
    // Stripe takes one or the other: one discount at a time.
    const discounted =
      "companyId" in owner && (await Company.findByPk(owner.companyId, { attributes: ["discount"] }))?.discount;

    const tax = process.env.STRIPE_AUTOMATIC_TAX === "true";
    const session = await this.client().checkout.sessions.create({
      mode: "subscription",
      customer: await this.customerFor(owner),
      client_reference_id: "userId" in owner ? `user-${owner.userId}` : `company-${owner.companyId}`,
      line_items: [{ price: await this.priceId(plan, interval), quantity }],
      subscription_data: { metadata, ...(trialEnd ? { trial_end: trialEnd } : {}) },
      metadata,
      ...(discounted ? { discounts: [{ coupon: discountCoupon() }] } : { allow_promotion_codes: true }),
      ...(tax
        ? {
            automatic_tax: { enabled: true },
            billing_address_collection: "required" as const,
            customer_update: { address: "auto" as const, name: "auto" as const },
          }
        : {}),
      success_url: `${appUrl()}/settings/billing?checkout=success`,
      cancel_url: `${appUrl()}/settings/billing?checkout=cancel`,
    });
    if (!session.url) throw new BillingError("Stripe didn't return a checkout page.", 502);
    return { url: session.url };
  }

  /** Stripe's customer portal: card, invoices, billing details. */
  async portal(userId: number, input: { companyId?: unknown }) {
    const owner = input.companyId
      ? await this.ownerFor(userId, "team", input.companyId)
      : ({ userId } as Owner);
    const customer = await this.storedCustomer(owner);
    if (!customer) throw new BillingError("There's no billing account yet. Subscribe first.", 404);
    // The portal set up by `npm run stripe:setup` (cancel at period end), else Stripe's default.
    const configs = await this.client().billingPortal.configurations.list({ limit: 100, active: true });
    const configuration = configs.data.find((config) => config.metadata?.app === "2keevo")?.id;
    const session = await this.client().billingPortal.sessions.create({
      customer,
      return_url: `${appUrl()}/settings/billing`,
      ...(configuration ? { configuration } : {}),
    });
    return { url: session.url };
  }

  /* Changes ------------------------------------------------------------------------- */

  private async paidOrFail(userId: number, companyId?: unknown) {
    const owner = companyId ? await this.ownerFor(userId, "team", companyId) : ({ userId } as Owner);
    const subscription = await this.stripeSubscription(owner);
    if (!subscription?.stripeSubscriptionId || !isLive(subscription)) {
      throw new BillingError("There's no paid plan to change.", 404);
    }
    return subscription;
  }

  /** Cancel at the end of the paid period (or undo that). Paid features stay until then. */
  async setCancelAtPeriodEnd(userId: number, input: { companyId?: unknown }, cancel: boolean) {
    const subscription = await this.paidOrFail(userId, input.companyId);
    await this.client().subscriptions.update(subscription.stripeSubscriptionId as string, {
      cancel_at_period_end: cancel,
    });
    return this.syncSubscription(subscription.stripeSubscriptionId as string);
  }

  /** Monthly ↔ yearly. Charged now for the difference; unused time is credited. */
  async changeInterval(userId: number, input: { companyId?: unknown; interval: unknown }) {
    const interval = input.interval as Interval;
    if (interval !== "month" && interval !== "year") throw new BillingError("Choose monthly or yearly.");
    const subscription = await this.paidOrFail(userId, input.companyId);
    if (subscription.interval === interval) return publicSubscription(subscription);

    const remote = await this.client().subscriptions.retrieve(subscription.stripeSubscriptionId as string);
    const item = remote.items.data[0];
    await this.client().subscriptions.update(remote.id, {
      items: [{ id: item.id, price: await this.priceId(subscription.plan, interval), quantity: item.quantity }],
      proration_behavior: "always_invoice",
      cancel_at_period_end: false,
    });
    return this.syncSubscription(remote.id);
  }

  /**
   * Put a company's paid Team in line with its discount: the coupon on, or every discount
   * off. Without a paid Team there's nothing to change; checkout adds it later.
   */
  async applyDiscount(companyId: number) {
    if (!this.enabled()) return;
    const subscription = await this.stripeSubscription({ companyId });
    if (!subscription?.stripeSubscriptionId || !isLive(subscription)) return;
    const company = await Company.findByPk(companyId, { attributes: ["discount"] });
    await this.client().subscriptions.update(subscription.stripeSubscriptionId, {
      discounts: company?.discount ? [{ coupon: discountCoupon() }] : [],
    });
  }

  /* Webhooks --------------------------------------------------------------------------- */

  verify(rawBody: Buffer, signature: string | undefined) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new BillingError("Webhooks aren't set up.", 503);
    try {
      return this.client().webhooks.constructEvent(rawBody, String(signature || ""), secret);
    } catch {
      throw new BillingError("Invalid signature.", 400);
    }
  }

  /** Handle one event once. Returns false when it was already handled. */
  async handle(event: Stripe.Event) {
    const object = event.data.object as { id?: string };
    const [claim] = await sequelize.query<{ id: number }>(
      `INSERT INTO "billing_events" ("stripeEventId", "type", "objectId")
       VALUES (:id, :type, :objectId)
       ON CONFLICT ("stripeEventId") DO UPDATE SET "type" = EXCLUDED."type"
         WHERE "billing_events"."processedAt" IS NULL
       RETURNING id`,
      { replacements: { id: event.id, type: event.type, objectId: object?.id || null }, type: QueryTypes.SELECT }
    );
    if (!claim) return false;

    try {
      await this.process(event);
      await sequelize.query(`UPDATE "billing_events" SET "processedAt" = NOW(), "error" = NULL WHERE id = :id`, {
        replacements: { id: claim.id },
      });
      return true;
    } catch (error: any) {
      await sequelize.query(`UPDATE "billing_events" SET "error" = :error WHERE id = :id`, {
        replacements: { id: claim.id, error: String(error?.message || error).slice(0, 2000) },
      });
      throw error;
    }
  }

  private async process(event: Stripe.Event) {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          await this.syncSubscription(String(typeof session.subscription === "string" ? session.subscription : session.subscription.id));
        }
        return;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await this.syncSubscription((event.data.object as Stripe.Subscription).id);
        return;
      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice & { subscription?: string | { id: string } | null };
        const id = this.invoiceSubscriptionId(invoice);
        if (!id) return;
        let failed = event.type === "invoice.payment_failed";
        // A failure reported after a retry already went through changes nothing.
        if (failed && invoice.id) {
          const fresh = await this.client().invoices.retrieve(invoice.id);
          failed = fresh.status !== "paid";
        }
        await this.syncSubscription(id, failed);
        return;
      }
      default:
        return;
    }
  }

  private invoiceSubscriptionId(invoice: any): string | null {
    const direct = invoice.subscription;
    if (direct) return typeof direct === "string" ? direct : direct.id;
    const nested = invoice.parent?.subscription_details?.subscription;
    if (nested) return typeof nested === "string" ? nested : nested.id;
    return null;
  }

  /**
   * Copy a subscription's current state from Stripe. Always fetched fresh, so events
   * arriving late or out of order can't leave an old status behind.
   */
  async syncSubscription(stripeSubscriptionId: string, paymentFailed = false) {
    const remote = await this.client().subscriptions.retrieve(stripeSubscriptionId, {
      expand: ["items.data.price"],
    });
    const item = remote.items.data[0];
    const price = item?.price as Stripe.Price | undefined;
    const planned = price ? this.planOf(price) : null;
    if (!planned) throw new Error(`Subscription ${remote.id} has a price 2keevo doesn't know.`);

    const owner = await this.ownerOfRemote(remote);
    if (!owner) throw new Error(`Subscription ${remote.id} has no 2keevo owner.`);

    const status = mapStatus(remote.status);
    const periodEnd = (item as any)?.current_period_end ?? (remote as any).current_period_end ?? null;
    const local =
      (await Subscription.findOne({ where: { stripeSubscriptionId: remote.id } })) ||
      Subscription.build({ ...owner, plan: planned.plan, status, stripeSubscriptionId: remote.id });

    // Grace starts with the first failed payment and ends when one goes through.
    let graceEndsAt = local.graceEndsAt ?? null;
    if (status === "past_due" && !graceEndsAt) graceEndsAt = new Date(Date.now() + GRACE_DAYS * DAY_MS);
    if (status !== "past_due") graceEndsAt = null;
    if (paymentFailed && status !== "past_due" && remote.status !== "canceled") {
      // Stripe hasn't moved it to past_due yet; the failed invoice still starts the grace.
      graceEndsAt = graceEndsAt || new Date(Date.now() + GRACE_DAYS * DAY_MS);
    }

    local.set({
      ...owner,
      plan: planned.plan,
      interval: planned.interval,
      status: paymentFailed && status === "active" ? "past_due" : status,
      seats: item?.quantity ?? null,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      cancelAtPeriodEnd: Boolean(remote.cancel_at_period_end),
      // A deferred first charge (subscribed during a trial): shown as "first payment on".
      trialEndsAt: remote.status === "trialing" && remote.trial_end ? new Date(remote.trial_end * 1000) : null,
      graceEndsAt,
      stripeCustomerId: typeof remote.customer === "string" ? remote.customer : remote.customer.id,
    });
    await local.save();

    // A paid plan replaces the 2keevo trial: no "your trial ends" email after paying.
    if (isLive(local)) {
      await Subscription.update(
        { status: "expired" },
        { where: { ...ownerWhere(owner), status: "trialing", stripeSubscriptionId: null } }
      );
    }

    // A company opens again when it pays, and is suspended once nothing covers it.
    if ("companyId" in owner) {
      if (isLive(local)) await CompanyBilling.reopen(owner.companyId);
      else if (!(await EntitlementService.forCompany(owner.companyId))) await CompanyBilling.suspend(owner.companyId);
    }

    // One "payment failed" email per grace period.
    if (local.graceEndsAt && !local.paymentFailedEmailedAt) {
      const to = await recipient(owner);
      if (to) {
        await EmailService.sendPaymentFailed({
          to: to.email,
          planName: PLANS[local.plan].name,
          companyName: to.companyName,
          graceEndsAt: new Date(local.graceEndsAt),
        }).catch(() => undefined);
      }
      await local.update({ paymentFailedEmailedAt: new Date() });
    } else if (!local.graceEndsAt && local.paymentFailedEmailedAt) {
      await local.update({ paymentFailedEmailedAt: null });
    }
    return publicSubscription(local);
  }

  private async ownerOfRemote(remote: Stripe.Subscription): Promise<Owner | null> {
    const meta = remote.metadata || {};
    if (meta.userId && Number(meta.userId)) return { userId: Number(meta.userId) };
    if (meta.companyId && Number(meta.companyId)) return { companyId: Number(meta.companyId) };
    const customer = typeof remote.customer === "string" ? remote.customer : remote.customer.id;
    const [user] = await sequelize.query<{ id: number }>(`SELECT id FROM "users" WHERE "stripeCustomerId" = :customer`, {
      replacements: { customer },
      type: QueryTypes.SELECT,
    });
    if (user) return { userId: user.id };
    const [company] = await sequelize.query<{ id: number }>(
      `SELECT id FROM "companies" WHERE "stripeCustomerId" = :customer`,
      { replacements: { customer }, type: QueryTypes.SELECT }
    );
    return company ? { companyId: company.id } : null;
  }

  /** For the Billing page: may this person pay now? */
  async paymentsInfo(userId: number) {
    const entitlement = await EntitlementService.forUser(userId);
    const own = await this.stripeSubscription({ userId });
    return {
      enabled: this.enabled(),
      tax: process.env.STRIPE_AUTOMATIC_TAX === "true",
      managedByStripe: !!own && isLive(own),
      hasBillingAccount: !!(await this.storedCustomer({ userId })),
      plan: entitlement.plan,
    };
  }
}

export default new StripeService();
