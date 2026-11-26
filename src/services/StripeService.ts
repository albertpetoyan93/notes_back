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
import PaymentService from "./PaymentService";

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

/** Each price is the same number in USD (tax on top) and EUR (VAT included). */
export const CURRENCIES = ["usd", "eur"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** A subscription on a price that isn't one of 2keevo's plans (something else sold from the same Stripe account). */
/**
 * The card a subscription's next invoice is charged to: its own default payment method,
 * else the customer's. Needs both expanded. Only the brand and last 4 digits, or a wallet.
 */
export function chargedCard(remote: Stripe.Subscription) {
  const customer = typeof remote.customer === "object" && !("deleted" in remote.customer) ? remote.customer : null;
  const method = [remote.default_payment_method, customer?.invoice_settings?.default_payment_method].find(
    (value): value is Stripe.PaymentMethod => !!value && typeof value === "object"
  );
  if (!method?.card) return null;
  return {
    brand: method.card.brand,
    last4: method.card.last4,
    wallet: method.card.wallet?.type ?? null,
  };
}

/**
 * A receipt-style breakdown of an invoice for the confirm dialog: the new plan's price and
 * period (the line reaching furthest), the credit for unused time (negative lines), any
 * discount and tax. Amounts in cents.
 */
export function invoiceBreakdown(invoice: Stripe.Invoice) {
  const lines = invoice.lines?.data || [];
  const plan = [...lines].filter((line) => line.amount > 0).sort((a, b) => (b.period?.end || 0) - (a.period?.end || 0))[0];
  const sum = (list?: { amount: number }[] | null) => (list || []).reduce((total, entry) => total + (entry.amount || 0), 0);
  return {
    priceCents: plan?.amount ?? 0,
    creditCents: -lines.filter((line) => line.amount < 0).reduce((total, line) => total + line.amount, 0),
    discountCents: sum(invoice.total_discount_amounts as { amount: number }[] | null),
    taxCents: sum((invoice as any).total_taxes),
    periodStart: plan?.period?.start ? new Date(plan.period.start * 1000) : null,
    periodEnd: plan?.period?.end ? new Date(plan.period.end * 1000) : null,
  };
}

export class ForeignSubscriptionError extends Error {
  constructor(subscriptionId: string) {
    super(`Subscription ${subscriptionId} has a price 2keevo doesn't know.`);
    this.name = "ForeignSubscriptionError";
  }
}

const appUrl = () => (EnvVars.FrontendOrigin || "http://localhost:5173").replace(/\/$/, "");

/** The Billing page's ?for= value: "me" for a person, the company id for a Team. */
const billingFor = (owner: Owner) => ("companyId" in owner ? String(owner.companyId) : "me");

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
    const [table, id] = "userId" in owner ? ["users", owner.userId] : ["companies", owner.companyId];
    const existing = await this.storedCustomer(owner);
    if (existing) {
      // A customer from another Stripe account or mode (sandbox ids after going live), or a
      // deleted one, can't be charged here: forget it and make a new one.
      const usable = await this.client()
        .customers.retrieve(existing)
        .then((customer) => !(customer as Stripe.DeletedCustomer).deleted)
        .catch((error: any) => {
          if (error?.code === "resource_missing") return false;
          throw error;
        });
      if (usable) return existing;
      await sequelize.query(`UPDATE "${table}" SET "stripeCustomerId" = NULL WHERE id = :id AND "stripeCustomerId" = :old`, {
        replacements: { id, old: existing },
      });
    }

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
      // Two clicks at once must not make two customers. A replacement gets its own key.
      idempotencyKey: `customer-${table === "users" ? "user" : "company"}-${id}${existing ? `-after-${existing}` : ""}`,
    });
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
    // One broken subscription (e.g. one Stripe no longer knows) must not stop the others.
    const failed: number[] = [];
    for (const row of paid) {
      try {
        await this.syncSeats(row.companyId as number);
      } catch (error: any) {
        failed.push(row.companyId as number);
        logger.err(`team seats for company ${row.companyId}: ${error?.message || error}`);
      }
    }
    return { checked: paid.length, failed };
  }

  /* Checkout and the customer portal ------------------------------------------------ */

  /** A Stripe Checkout page for a paid plan. Returns the URL to send the person to. */
  async checkout(userId: number, input: { plan: unknown; interval: unknown; companyId?: unknown; currency?: unknown }) {
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

    // Subscribing during a 2keevo trial, or free access from staff for this plan: the
    // first charge waits until it ends.
    const trial = await Subscription.findOne({
      where: { ...ownerWhere(owner), status: "trialing", stripeSubscriptionId: null },
      order: [["trialEndsAt", "DESC"]],
    });
    const free = await Subscription.findOne({
      where: { ...ownerWhere(owner), plan, status: "complimentary", currentPeriodEnd: { [Op.gt]: new Date() } },
      order: [["currentPeriodEnd", "DESC"]],
    });
    const freeUntil = Math.max(
      trial?.trialEndsAt ? new Date(trial.trialEndsAt).getTime() : 0,
      free?.currentPeriodEnd ? new Date(free.currentPeriodEnd).getTime() : 0
    );
    const trialEnd = freeUntil - Date.now() > MIN_DEFERRED_MS ? Math.floor(freeUntil / 1000) : undefined;

    // An approved nonprofit or school discount; otherwise a promotion code may be typed in.
    // Stripe takes one or the other: one discount at a time.
    const discounted =
      "companyId" in owner && (await Company.findByPk(owner.companyId, { attributes: ["discount"] }))?.discount;

    const tax = process.env.STRIPE_AUTOMATIC_TAX === "true";
    const site = (process.env.WEBSITE_URL || "https://2keevo.com").replace(/\/$/, "");
    const session = await this.client().checkout.sessions.create({
      mode: "subscription",
      customer: await this.customerFor(owner),
      client_reference_id: "userId" in owner ? `user-${owner.userId}` : `company-${owner.companyId}`,
      line_items: [{ price: await this.priceId(plan, interval), quantity }],
      currency: await this.checkoutCurrency(owner, input.currency),
      // Annaniks is the seller and handles VAT itself (Stripe Tax, OSS). Stripe's Managed
      // Payments (Stripe as merchant of record) can be on by default for an account and
      // doesn't allow the consent text below, so it's turned off here explicitly.
      managed_payments: { enabled: false },
      subscription_data: { metadata, ...(trialEnd ? { trial_end: trialEnd } : {}) },
      metadata,
      ...(discounted ? { discounts: [{ coupon: discountCoupon() }] } : { allow_promotion_codes: true }),
      // EU consumers: the plan starts now, so they agree to give up the 14-day withdrawal right.
      // Stripe needs a Terms of Service URL in the account's public details for this. Only a
      // sandbox whose live account isn't activated yet (no public details) turns it off.
      ...(process.env.STRIPE_TERMS_CONSENT === "false"
        ? {}
        : {
            consent_collection: { terms_of_service: "required" as const },
            custom_text: {
              terms_of_service_acceptance: {
                message:
                  `I agree to the [Terms of Service](${site}/terms) and the [Subscription policy](${site}/subscription-policy), ` +
                  "and I ask for my plan to start now. I understand that I lose my 14-day right of withdrawal once it starts.",
              },
            },
          }),
      ...(tax
        ? {
            automatic_tax: { enabled: true },
            billing_address_collection: "required" as const,
            customer_update: { address: "auto" as const, name: "auto" as const },
            // Businesses enter their VAT number (EU reverse charge).
            tax_id_collection: { enabled: true },
          }
        : {}),
      // Back on the Billing view of whoever paid: Personal, or this company.
      success_url: `${appUrl()}/settings/billing?checkout=success&for=${billingFor(owner)}`,
      cancel_url: `${appUrl()}/settings/billing?checkout=cancel&for=${billingFor(owner)}`,
    });
    if (!session.url) throw new BillingError("Stripe didn't return a checkout page.", 502);
    return { url: session.url };
  }

  /**
   * The checkout currency: the one this person or company already pays in (a Stripe
   * customer stays in one currency), else the one their screen showed, else USD.
   */
  async checkoutCurrency(owner: Owner, requested: unknown): Promise<Currency> {
    const earlier = await Subscription.findOne({
      where: { ...ownerWhere(owner), currency: { [Op.in]: [...CURRENCIES] } },
      order: [["updatedAt", "DESC"]],
      attributes: ["currency"],
    });
    if (earlier?.currency) return earlier.currency as Currency;
    return CURRENCIES.includes(requested as Currency) ? (requested as Currency) : "usd";
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
      return_url: `${appUrl()}/settings/billing?for=${billingFor(owner)}`,
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

  /**
   * Subscribed during a trial, so the first charge waits for the trial's end: end the
   * trial now and charge the saved card today. If the card can't be charged, nothing
   * changes (the trial keeps going) and the person sees the card's error.
   */
  async payNow(userId: number, input: { companyId?: unknown }) {
    const subscription = await this.paidOrFail(userId, input.companyId);
    const id = subscription.stripeSubscriptionId as string;
    const remote = await this.client().subscriptions.retrieve(id);
    if (remote.status !== "trialing") throw new BillingError("This plan is already paid.", 409);

    try {
      await this.client().subscriptions.update(id, {
        trial_end: "now",
        proration_behavior: "none",
        payment_behavior: "error_if_incomplete",
      });
    } catch (error: any) {
      if (error?.type === "StripeCardError" || error?.code === "subscription_payment_intent_requires_action") {
        throw new BillingError(
          error?.code === "subscription_payment_intent_requires_action"
            ? "Your bank wants to confirm this payment. Use Manage to update your card, or wait: the plan is charged when the free days end."
            : `${error.message || "The card was declined."} Nothing was charged; your free days continue.`,
          402
        );
      }
      throw error;
    }

    const synced = await this.syncSubscription(id);
    // The webhook records it too; doing it here shows it in the history right away.
    const latest = (await this.client().subscriptions.retrieve(id)).latest_invoice;
    const invoiceId = typeof latest === "string" ? latest : latest?.id;
    if (invoiceId) await PaymentService.recordInvoice(invoiceId, false).catch((error) => logger.err(error));
    return synced;
  }

  /** The subscription's unpaid invoice (a failed renewal or switch), with the card it goes on. */
  private async unpaidInvoice(userId: number, companyId?: unknown) {
    // Not only while live: paying also brings back a plan whose grace period has run out.
    const owner = companyId ? await this.ownerFor(userId, "team", companyId) : ({ userId } as Owner);
    const subscription = await this.stripeSubscription(owner);
    if (!subscription?.stripeSubscriptionId) throw new BillingError("There's no paid plan to pay for.", 404);
    const remote = await this.client().subscriptions.retrieve(subscription.stripeSubscriptionId, {
      expand: ["latest_invoice", "default_payment_method", "customer.invoice_settings.default_payment_method"],
    });
    const invoice = remote.latest_invoice;
    if (!invoice || typeof invoice !== "object" || invoice.status !== "open" || !invoice.amount_due) {
      throw new BillingError("There's no unpaid payment to try again.", 409);
    }
    return { remote, invoice };
  }

  /** What "Try again" charges, shown before the person confirms. */
  async previewRetry(userId: number, input: { companyId?: unknown }) {
    const { remote, invoice } = await this.unpaidInvoice(userId, input.companyId);
    return {
      amountCents: invoice.amount_due,
      currency: invoice.currency,
      card: chargedCard(remote),
      interval: remote.items?.data[0]?.price?.recurring?.interval === "year" ? "year" : "month",
      ...invoiceBreakdown(invoice),
    };
  }

  /**
   * Charge the unpaid invoice again now, on the card on file (update it first if needed).
   * A decline leaves everything as it was and says why.
   */
  async retryPayment(userId: number, input: { companyId?: unknown }) {
    const { remote, invoice } = await this.unpaidInvoice(userId, input.companyId);
    try {
      await this.client().invoices.pay(invoice.id as string, { off_session: true });
    } catch (error: any) {
      if (error?.code === "invoice_payment_intent_requires_action") {
        throw new BillingError("Your bank wants to confirm this payment. Use Update card and pay it there.", 402);
      }
      if (error?.type === "StripeCardError") {
        throw new BillingError(`${error.message || "The card was declined."} Nothing was charged. Update your card and try again.`, 402);
      }
      throw error;
    }
    await PaymentService.recordInvoice(invoice.id as string, false).catch((error) => logger.err(error));
    return this.syncSubscription(remote.id);
  }

  /**
   * What switching monthly ↔ yearly charges today, before the person confirms: Stripe's
   * own preview of the invoice (new price, less the unused part of the current period,
   * less any discount). The same proration moment is then used for the real change.
   */
  async previewInterval(userId: number, input: { companyId?: unknown; interval: unknown }) {
    const interval = input.interval as Interval;
    if (interval !== "month" && interval !== "year") throw new BillingError("Choose monthly or yearly.");
    const subscription = await this.paidOrFail(userId, input.companyId);
    const remote = await this.client().subscriptions.retrieve(subscription.stripeSubscriptionId as string, {
      expand: ["default_payment_method", "customer.invoice_settings.default_payment_method"],
    });
    const item = remote.items.data[0];
    const prorationDate = Math.floor(Date.now() / 1000);
    const invoice = await this.client().invoices.createPreview({
      customer: typeof remote.customer === "string" ? remote.customer : remote.customer.id,
      subscription: remote.id,
      subscription_details: {
        items: [{ id: item.id, price: await this.priceId(subscription.plan, interval), quantity: item.quantity }],
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });
    return {
      amountCents: invoice.amount_due,
      currency: invoice.currency,
      card: chargedCard(remote),
      prorationDate,
      // Still in the free days: nothing today, the first charge stays at the trial's end.
      trialEndsAt: remote.status === "trialing" && remote.trial_end ? new Date(remote.trial_end * 1000) : null,
      ...invoiceBreakdown(invoice),
    };
  }

  /**
   * Monthly ↔ yearly. Charged now for the difference; unused time is credited. Only if
   * that payment goes through: otherwise Stripe keeps the plan as it was (still paid, no
   * unpaid invoice) and the person is told why.
   */
  async changeInterval(userId: number, input: { companyId?: unknown; interval: unknown; prorationDate?: unknown }) {
    const interval = input.interval as Interval;
    if (interval !== "month" && interval !== "year") throw new BillingError("Choose monthly or yearly.");
    const subscription = await this.paidOrFail(userId, input.companyId);
    if (subscription.interval === interval) return publicSubscription(subscription);

    // The moment the confirmed preview was priced at, so the charge matches what was shown.
    const now = Math.floor(Date.now() / 1000);
    const asked = Number(input.prorationDate);
    const prorationDate = Number.isInteger(asked) && asked <= now && now - asked < 3600 ? asked : undefined;

    const remote = await this.client().subscriptions.retrieve(subscription.stripeSubscriptionId as string);
    const item = remote.items.data[0];
    const was = remote.items.data[0]?.price?.recurring?.interval === "year" ? "yearly" : "monthly";
    try {
      await this.client().subscriptions.update(remote.id, {
        items: [{ id: item.id, price: await this.priceId(subscription.plan, interval), quantity: item.quantity }],
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
        ...(prorationDate ? { proration_date: prorationDate } : {}),
        cancel_at_period_end: false,
      });
    } catch (error: any) {
      if (error?.code === "subscription_payment_intent_requires_action") {
        throw new BillingError(
          `Your bank wants to confirm this payment, so nothing changed: you're still on ${was}. Add another card under Card and invoices, then switch again.`,
          402
        );
      }
      if (error?.type === "StripeCardError") {
        throw new BillingError(
          `${error.message || "The card was declined."} Nothing was charged and nothing changed: you're still on ${was}.`,
          402
        );
      }
      throw error;
    }

    const synced = await this.syncSubscription(remote.id);
    // The webhook records it too; doing it here shows it in the history right away.
    const latest = (await this.client().subscriptions.retrieve(remote.id)).latest_invoice;
    const invoiceId = typeof latest === "string" ? latest : latest?.id;
    if (invoiceId) await PaymentService.recordInvoice(invoiceId, false).catch((error) => logger.err(error));
    return synced;
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
      // Not a 2keevo subscription: nothing to do, and retrying won't change that. Done, not failed.
      if (error instanceof ForeignSubscriptionError) {
        logger.warn(`Stripe webhook ${event.type} (${event.id}) ignored: ${error.message}`);
        await sequelize.query(
          `UPDATE "billing_events" SET "processedAt" = NOW(), "error" = :note WHERE id = :id`,
          { replacements: { id: claim.id, note: `ignored: ${error.message}` } }
        );
        return true;
      }
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
        // The payment history: what was charged (or failed), for the user and the admin app.
        if (invoice.id && (event.type === "invoice.paid" || failed)) {
          await PaymentService.recordInvoice(invoice.id, failed);
        }
        return;
      }
      case "charge.refunded":
        await PaymentService.recordRefund(event.data.object as Stripe.Charge);
        return;
      case "invoice.voided": {
        // Cancelled before it was paid (e.g. a failed upgrade undone): it never took money.
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.id) await PaymentService.forgetUnpaid(invoice.id);
        const id = this.invoiceSubscriptionId(invoice);
        if (id) await this.syncSubscription(id);
        return;
      }
      default:
        return;
    }
  }

  invoiceSubscriptionId(invoice: any): string | null {
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
    if (!planned) throw new ForeignSubscriptionError(remote.id);

    const owner = await this.ownerOfRemote(remote);
    if (!owner) throw new Error(`Subscription ${remote.id} has no 2keevo owner.`);

    const status = mapStatus(remote.status);
    let periodEnd: number | null = (item as any)?.current_period_end ?? (remote as any).current_period_end ?? null;
    // Cancelled straight away (by Stripe after failed retries, or by hand) ends access then,
    // not at the end of a period nobody paid for. At-period-end cancellations end there anyway.
    if (remote.status === "canceled" && remote.ended_at && (!periodEnd || remote.ended_at < periodEnd)) {
      periodEnd = remote.ended_at;
    }
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
      currency: remote.currency || null,
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

  async ownerOfRemote(remote: Stripe.Subscription): Promise<Owner | null> {
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
