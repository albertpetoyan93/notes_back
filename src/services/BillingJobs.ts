import { Op } from "sequelize";
import { PLANS, RENEWAL_REMINDER_DAYS, TRIAL_REMINDER_DAYS } from "../common/plans";

/** Free access from staff: the ending reminder goes out this many days before. */
export const COMPLIMENTARY_REMINDER_DAYS = 7;
import Subscription from "../models/Subscription";
import CompanyBilling, { recipient } from "./CompanyBilling";
import EmailService from "./EmailService";
import AttachmentService from "./AttachmentService";
import EmergencyAccessService from "./EmergencyAccessService";
import JobService from "./JobService";
import StripeService from "./StripeService";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Trials ending within a few days: one reminder each. Nothing is charged either way. */
export async function remindEndingTrials(now = new Date()) {
  const ending = await Subscription.findAll({
    where: {
      status: "trialing",
      trialReminderSentAt: null,
      trialEndsAt: { [Op.gt]: now, [Op.lte]: new Date(now.getTime() + TRIAL_REMINDER_DAYS * DAY_MS) },
    },
  });
  let sent = 0;
  for (const subscription of ending) {
    const to = await recipient(subscription);
    if (to) {
      await EmailService.sendTrialEnding({
        to: to.email,
        planName: PLANS[subscription.plan].name,
        endsAt: new Date(subscription.trialEndsAt as Date),
        companyName: to.companyName,
      });
      sent += 1;
    }
    await subscription.update({ trialReminderSentAt: now });
  }
  return { reminded: sent };
}

/**
 * Trials that ended: marked expired, with an email. Access already stopped at the end
 * time (EntitlementService checks the date); this only tidies up and tells them.
 */
export async function expireTrials(now = new Date()) {
  const ended = await Subscription.findAll({
    where: { status: "trialing", trialEndsAt: { [Op.lte]: now } },
  });
  for (const subscription of ended) {
    await subscription.update({ status: "expired" });
    // A company's trial ending suspends it; that job sends the company's email.
    if (subscription.companyId) continue;
    const to = await recipient(subscription);
    if (to) {
      await EmailService.sendTrialEnded({
        to: to.email,
        planName: PLANS[subscription.plan].name,
        companyName: to.companyName,
      }).catch(() => undefined);
    }
  }
  return { expired: ended.length };
}

/**
 * Free access from staff ending within a week: one reminder each (trialReminderSentAt
 * doubles as "ending reminder sent"; changing the end date clears it).
 */
export async function remindEndingComplimentary(now = new Date()) {
  const ending = await Subscription.findAll({
    where: {
      status: "complimentary",
      trialReminderSentAt: null,
      currentPeriodEnd: { [Op.gt]: now, [Op.lte]: new Date(now.getTime() + COMPLIMENTARY_REMINDER_DAYS * DAY_MS) },
    },
  });
  let sent = 0;
  for (const subscription of ending) {
    // Already paying for the same plan after it: no need to remind.
    if (await paysAfter(subscription)) {
      await subscription.update({ trialReminderSentAt: now });
      continue;
    }
    const to = await recipient(subscription);
    if (to) {
      await EmailService.sendComplimentaryEnding({
        to: to.email,
        planName: PLANS[subscription.plan].name,
        endsAt: new Date(subscription.currentPeriodEnd as Date),
        companyName: to.companyName,
      }).catch(() => undefined);
      sent += 1;
    }
    await subscription.update({ trialReminderSentAt: now });
  }
  return { reminded: sent };
}

/** Subscribed through Stripe (not set to cancel) while the free access was on. */
async function paysAfter(subscription: Subscription) {
  const owner = subscription.userId ? { userId: subscription.userId } : { companyId: subscription.companyId };
  return (
    (await Subscription.count({
      where: { ...owner, stripeSubscriptionId: { [Op.ne]: null }, cancelAtPeriodEnd: false, status: { [Op.in]: ["trialing", "active"] } },
    })) > 0
  );
}

/**
 * Free access that ended: marked expired; a person gets an email unless they pay now.
 * Access already stopped at the end time; a company's suspension email comes from its job.
 */
export async function expireComplimentary(now = new Date()) {
  const ended = await Subscription.findAll({
    where: { status: "complimentary", currentPeriodEnd: { [Op.lte]: now } },
  });
  for (const subscription of ended) {
    await subscription.update({ status: "expired" });
    if (subscription.companyId || (await paysAfter(subscription))) continue;
    const to = await recipient(subscription);
    if (to) {
      await EmailService.sendComplimentaryEnded({ to: to.email, planName: PLANS[subscription.plan].name }).catch(
        () => undefined
      );
    }
  }
  return { expired: ended.length };
}

/** Yearly plans renewing within a week: one email per renewal. */
export async function remindRenewals(now = new Date()) {
  const renewing = await Subscription.findAll({
    where: {
      interval: "year",
      status: "active",
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: { [Op.ne]: null },
      currentPeriodEnd: { [Op.gt]: now, [Op.lte]: new Date(now.getTime() + RENEWAL_REMINDER_DAYS * DAY_MS) },
    },
  });
  let sent = 0;
  for (const subscription of renewing) {
    const periodEnd = new Date(subscription.currentPeriodEnd as Date);
    // Already reminded for this renewal (a reminder from last year is long before it).
    const last = subscription.renewalReminderSentAt ? new Date(subscription.renewalReminderSentAt).getTime() : 0;
    if (last > periodEnd.getTime() - 30 * DAY_MS) continue;
    const to = await recipient(subscription);
    if (to) {
      await EmailService.sendRenewalReminder({
        to: to.email,
        planName: PLANS[subscription.plan].name,
        companyName: to.companyName,
        renewsAt: periodEnd,
      }).catch(() => undefined);
      sent += 1;
    }
    await subscription.update({ renewalReminderSentAt: now });
  }
  return { reminded: sent };
}

/** In order: trials end first, so companies whose trial just ended are suspended the same day. */
export function registerBillingJobs() {
  JobService.register("billing:trial-reminders", () => remindEndingTrials());
  JobService.register("billing:trial-expiry", () => expireTrials());
  JobService.register("billing:complimentary-reminders", () => remindEndingComplimentary());
  JobService.register("billing:complimentary-expiry", () => expireComplimentary());
  JobService.register("billing:company-trials", () => CompanyBilling.trialsForExisting());
  JobService.register("billing:company-suspension", () => CompanyBilling.suspendUnpaid());
  JobService.register("billing:removal-warnings", () => CompanyBilling.removalWarnings());
  JobService.register("billing:renewal-reminders", () => remindRenewals());
  JobService.register("billing:team-seats", () => StripeService.reconcileSeats());
  // Not billing, but the same daily runner: emergency access requests whose wait ended, and reminders.
  JobService.register("emergency:requests", () => EmergencyAccessService.dailyJob());
  // Files of items deleted for good, and uploads that never finished.
  JobService.register("attachments:cleanup", () => AttachmentService.cleanup());
}
