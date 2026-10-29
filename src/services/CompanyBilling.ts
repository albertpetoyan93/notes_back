import logger from "jet-logger";
import { Op } from "sequelize";
import { REMOVAL_DAYS, REMOVAL_WARNING_DAYS, TRIAL_DAYS } from "../common/plans";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import Subscription from "../models/Subscription";
import TrialUsed from "../models/TrialUsed";
import User from "../models/User";
import BillingService from "./BillingService";
import EmailService from "./EmailService";
import EntitlementService from "./EntitlementService";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Who hears about a subscription: the person, or the company's owner. */
export async function recipient(owner: { userId?: number | null; companyId?: number | null }) {
  if (owner.userId) {
    const user = await User.findByPk(owner.userId, { attributes: ["email"] });
    return user ? { email: user.email, companyName: null } : null;
  }
  if (!owner.companyId) return null;
  const company = await Company.findByPk(owner.companyId, { attributes: ["name"] });
  const member = await CompanyMember.findOne({
    where: { companyId: owner.companyId, role: "owner", status: "active" },
    attributes: ["userId"],
  });
  const user = member?.userId ? await User.findByPk(member.userId, { attributes: ["email"] }) : null;
  return user ? { email: user.email, companyName: company?.name || null } : null;
}

/** The daily jobs run for every company; `onlyIds` narrows one run (tests, one company). */
const only = (ids?: number[]) => (ids ? { id: { [Op.in]: ids } } : {});

/** Deleting marked companies is off unless this is set (and isn't built yet: see the plan). */
export const removalEnabled = () => process.env.COMPANY_REMOVAL_ENABLED === "true";

/**
 * A company's life on the Team plan: a free 14-day trial when it starts, suspended when
 * Team ends unpaid (items hidden, kept), reopened when it pays again.
 */
class CompanyBilling {
  /** Every company starts with a Team trial. Quietly does nothing if it already had one. */
  async startTrial(companyId: number) {
    if (await TrialUsed.count({ where: { companyId, plan: "team" } })) return null;
    try {
      return await BillingService.createTrial({ companyId }, "team", new Date(Date.now() + TRIAL_DAYS * DAY_MS));
    } catch {
      return null;
    }
  }

  /**
   * Companies from before Team was required: each gets its trial once, and the owner is
   * told. Companies made since got theirs when they were created.
   */
  async trialsForExisting(onlyIds?: number[]) {
    const companies = await Company.findAll({ where: { status: "active", ...only(onlyIds) }, attributes: ["id", "name"] });
    let started = 0;
    for (const company of companies) {
      if (await Subscription.count({ where: { companyId: company.id } })) continue;
      const trial = await this.startTrial(company.id);
      if (!trial) continue;
      started += 1;
      const to = await recipient({ companyId: company.id });
      if (to) {
        await EmailService.sendCompanyTrialStarted({
          to: to.email,
          companyName: company.name,
          endsAt: new Date(trial.trialEndsAt as Date),
        }).catch(() => undefined);
      }
    }
    return { started };
  }

  /** Team ended unpaid: hide the company's items (kept), tell the owner. */
  async suspend(companyId: number, now = new Date()) {
    const company = await Company.findByPk(companyId);
    if (!company || company.status === "suspended") return false;
    await company.update({ status: "suspended", suspendedAt: now, removalWarnings: 0, markedForRemovalAt: null });
    const to = await recipient({ companyId });
    if (to) await EmailService.sendCompanySuspended({ to: to.email, companyName: company.name }).catch(() => undefined);
    logger.info(`company ${companyId} suspended`);
    return true;
  }

  /** Paid again: everything is back as it was. */
  async reopen(companyId: number) {
    const [changed] = await Company.update(
      { status: "active", suspendedAt: null, removalWarnings: 0, markedForRemovalAt: null },
      { where: { id: companyId, status: "suspended" } }
    );
    if (changed) logger.info(`company ${companyId} reopened`);
    return changed > 0;
  }

  /** Open companies whose Team ended (trial over, grace over, cancelled period over). */
  async suspendUnpaid(now = new Date(), onlyIds?: number[]) {
    const companies = await Company.findAll({ where: { status: "active", ...only(onlyIds) }, attributes: ["id"] });
    let suspended = 0;
    for (const company of companies) {
      // Never had Team at all: trialsForExisting gives it a trial first.
      if (!(await Subscription.count({ where: { companyId: company.id } }))) continue;
      if (await EntitlementService.forCompany(company.id, now)) continue;
      if (await this.suspend(company.id, now)) suspended += 1;
    }
    return { suspended };
  }

  /**
   * Suspended companies: warnings at 60 and 83 days, marked for removal at 90. Nothing
   * is deleted here; removal stays a separate, switched-off step.
   */
  async removalWarnings(now = new Date(), onlyIds?: number[]) {
    const companies = await Company.findAll({
      where: { status: "suspended", suspendedAt: { [Op.ne]: null }, ...only(onlyIds) },
    });
    let warned = 0;
    let marked = 0;
    for (const company of companies) {
      const since = new Date(company.suspendedAt as Date).getTime();
      const days = (now.getTime() - since) / DAY_MS;
      const removalOn = new Date(since + REMOVAL_DAYS * DAY_MS);
      const due = REMOVAL_WARNING_DAYS.filter((day) => days >= day).length;
      if (due > company.removalWarnings) {
        const to = await recipient({ companyId: company.id });
        if (to) {
          await EmailService.sendRemovalWarning({
            to: to.email,
            companyName: company.name,
            removalOn,
            final: due >= REMOVAL_WARNING_DAYS.length,
          }).catch(() => undefined);
        }
        await company.update({ removalWarnings: due });
        warned += 1;
      }
      // At least two warnings before anything can be removed.
      if (days >= REMOVAL_DAYS && company.removalWarnings >= REMOVAL_WARNING_DAYS.length && !company.markedForRemovalAt) {
        await company.update({ markedForRemovalAt: now });
        marked += 1;
        logger.warn(
          `company ${company.id} marked for removal${removalEnabled() ? "" : " (removal is off: nothing deleted)"}`
        );
      }
    }
    return { warned, marked };
  }
}

export default new CompanyBilling();
