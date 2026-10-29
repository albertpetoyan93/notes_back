import { Response } from "express";
import AuditService from "../services/AuditService";
import BillingService, { BillingError } from "../services/BillingService";
import DiscountService from "../services/DiscountService";
import FamilyService, { FamilyError } from "../services/FamilyService";
import StripeService from "../services/StripeService";

async function respond(res: Response, fallback: string, run: () => Promise<unknown>) {
  try {
    res.json(await run());
  } catch (error: any) {
    if (error instanceof BillingError || error instanceof FamilyError) {
      return res.status(error.status).json({ message: error.message });
    }
    // Stripe said no (card, price, account setup): pass its message on.
    if (error?.type && String(error.type).startsWith("Stripe")) {
      console.error("Stripe error:", error?.message);
      return res.status(502).json({ message: error?.message || fallback });
    }
    console.error(fallback, error);
    res.status(500).json({ message: fallback });
  }
}

export default class BillingController {
  /** The signed-in person's plan, limits, usage, trials, and the companies they manage. */
  static summary = async (req: any, res: Response) => {
    try {
      // Family first: it claims invites sent to this email before the account existed.
      const family = await FamilyService.summary(req.user.id);
      const [summary, payments] = await Promise.all([
        BillingService.summary(req.user.id),
        StripeService.paymentsInfo(req.user.id),
      ]);
      res.json({ ...summary, payments, family });
    } catch (error) {
      console.error("Error loading billing:", error);
      res.status(500).json({ message: "Could not load your plan" });
    }
  };

  /* Family ----------------------------------------------------------------------- */

  /** Body: { email }. The organizer invites someone. */
  static familyInvite = async (req: any, res: Response) => {
    await respond(res, "Could not send the invite", async () => {
      const result = await FamilyService.invite(req.user.id, req.body?.email);
      await AuditService.record({ actorId: req.user.id, action: "family_invited", details: {}, req });
      return result;
    });
  };

  static familyAccept = async (req: any, res: Response) => {
    await respond(res, "Could not join the family", async () => {
      const result = await FamilyService.accept(req.user.id, Number(req.params.id));
      await AuditService.record({ actorId: req.user.id, action: "family_joined", details: {}, req });
      return result;
    });
  };

  static familyDecline = async (req: any, res: Response) => {
    await respond(res, "Could not decline the invite", async () => {
      await FamilyService.decline(req.user.id, Number(req.params.id));
      return { ok: true };
    });
  };

  /** The organizer removes a member or takes back an invite. */
  static familyRemove = async (req: any, res: Response) => {
    await respond(res, "Could not remove that person", async () => {
      await FamilyService.remove(req.user.id, Number(req.params.id));
      return { ok: true };
    });
  };

  static familyLeave = async (req: any, res: Response) => {
    await respond(res, "Could not leave the family", async () => {
      await FamilyService.leave(req.user.id);
      await AuditService.record({ actorId: req.user.id, action: "family_left", details: {}, req });
      return { ok: true };
    });
  };

  /** Body: { collectionId } to use an existing collection, or { name } to create one. */
  static familyCollection = async (req: any, res: Response) => {
    await respond(res, "Could not set the family collection", () =>
      FamilyService.setCollection(req.user.id, req.body || {})
    );
  };

  /** The owner asks for 50% off Team. Body: { kind: "nonprofit" | "school", organization, website?, note? }. */
  static requestDiscount = async (req: any, res: Response) => {
    await respond(res, "Could not send the request", async () => {
      const companyId = Number(req.params.id);
      const result = await DiscountService.request(req.user.id, companyId, req.body || {});
      await AuditService.record({
        actorId: req.user.id,
        action: "discount_requested",
        companyId,
        details: { kind: req.body?.kind },
        req,
      });
      return result;
    });
  };

  /** A Stripe Checkout page. Body: { plan: "premium" | "family" | "team", interval: "month" | "year", companyId? }. */
  static checkout = async (req: any, res: Response) => {
    await respond(res, "Could not open checkout", () => StripeService.checkout(req.user.id, req.body || {}));
  };

  /** Stripe's customer portal (card, invoices, billing details). Body: { companyId? }. */
  static portal = async (req: any, res: Response) => {
    await respond(res, "Could not open billing", () => StripeService.portal(req.user.id, req.body || {}));
  };

  /** Cancel at the end of the paid period. Body: { companyId? }. */
  static cancel = async (req: any, res: Response) => {
    await respond(res, "Could not cancel", () => StripeService.setCancelAtPeriodEnd(req.user.id, req.body || {}, true));
  };

  /** Undo a cancellation before the period ends. Body: { companyId? }. */
  static resume = async (req: any, res: Response) => {
    await respond(res, "Could not resume", () => StripeService.setCancelAtPeriodEnd(req.user.id, req.body || {}, false));
  };

  /** Monthly <-> yearly. Body: { interval, companyId? }. */
  static changeInterval = async (req: any, res: Response) => {
    await respond(res, "Could not change the billing period", () =>
      StripeService.changeInterval(req.user.id, req.body || {})
    );
  };

  /**
   * Stripe webhooks: raw body, signature checked, each event handled once.
   * Answers 500 on a processing error so Stripe retries later.
   */
  static webhook = async (req: any, res: Response) => {
    let event;
    try {
      event = StripeService.verify(req.body, req.get("stripe-signature"));
    } catch (error: any) {
      return res.status(error?.status || 400).json({ message: error?.message || "Invalid webhook" });
    }
    try {
      const handled = await StripeService.handle(event);
      res.json({ received: true, duplicate: !handled });
    } catch (error) {
      console.error(`Stripe webhook ${event.type} (${event.id}) failed:`, error);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  };

  /** Start a 14-day trial (no card). Body: { plan: "premium" | "team", companyId? }. */
  static startTrial = async (req: any, res: Response) => {
    try {
      const subscription = await BillingService.startTrial(
        req.user.id,
        req.body?.plan,
        req.body?.companyId
      );
      await AuditService.record({
        actorId: req.user.id,
        action: "trial_started",
        companyId: req.body?.plan === "team" ? Number(req.body?.companyId) : undefined,
        details: { plan: subscription?.plan, endsAt: subscription?.trialEndsAt },
        req,
      });
      res.status(201).json(subscription);
    } catch (error: any) {
      if (error instanceof BillingError) {
        return res.status(error.status).json({ message: error.message });
      }
      console.error("Error starting trial:", error);
      res.status(500).json({ message: "Could not start the trial" });
    }
  };
}
