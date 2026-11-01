import { Op, QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import { DISCOUNT_PERCENT, PRICES, PlanId } from "../common/plans";
import Company from "../models/Company";
import DiscountRequest from "../models/DiscountRequest";
import Subscription from "../models/Subscription";
import User from "../models/User";
import { utcDate } from "./ActivityService";
import { isLive } from "./EntitlementService";

const DAY_MS = 24 * 60 * 60 * 1000;
type PaidPlan = Exclude<PlanId, "free">;
const PAID: PaidPlan[] = ["premium", "family", "team"];

/**
 * The admin view: subscribers, trials, failed payments, revenue by plan, discount requests.
 * Revenue is estimated from list prices (before tax, after the nonprofit discount);
 * Stripe's dashboard has the exact figures.
 */
class AdminService {
  async overview(now = new Date()) {
    const rows = await Subscription.findAll({
      where: { status: { [Op.in]: ["trialing", "active", "past_due"] } },
    });
    const live = rows.filter((row) => isLive(row, now));

    const userIds = [...new Set(live.map((row) => row.userId).filter(Boolean))] as number[];
    const companyIds = [...new Set(live.map((row) => row.companyId).filter(Boolean))] as number[];
    const users = new Map(
      (await User.findAll({ where: { id: userIds }, attributes: ["id", "email"] })).map((user) => [user.id, user.email])
    );
    const companies = new Map(
      (await Company.findAll({ where: { id: companyIds }, attributes: ["id", "name", "discount"] })).map((company) => [
        company.id,
        company,
      ])
    );
    const ownerOf = (row: Subscription) =>
      row.companyId
        ? { kind: "company" as const, id: row.companyId, label: companies.get(row.companyId)?.name || `Company ${row.companyId}` }
        : { kind: "user" as const, id: row.userId as number, label: users.get(row.userId as number) || `User ${row.userId}` };

    const plans = Object.fromEntries(
      PAID.map((plan) => [plan, { subscribers: 0, monthly: 0, yearly: 0, seats: 0, cancelling: 0, mrrCents: 0, trials: 0 }])
    ) as Record<PaidPlan, { subscribers: number; monthly: number; yearly: number; seats: number; cancelling: number; mrrCents: number; trials: number }>;

    for (const row of live) {
      const plan = row.plan as PaidPlan;
      if (!plans[plan]) continue;
      if (!row.stripeSubscriptionId) {
        if (row.status === "trialing") plans[plan].trials += 1;
        continue;
      }
      const interval = row.interval === "year" ? "year" : "month";
      const seats = plan === "team" ? row.seats || 1 : 1;
      const discounted = row.companyId && companies.get(row.companyId)?.discount;
      const cents = PRICES[plan][interval] * seats * (discounted ? (100 - DISCOUNT_PERCENT) / 100 : 1);
      plans[plan].subscribers += 1;
      plans[plan][interval === "year" ? "yearly" : "monthly"] += 1;
      plans[plan].seats += seats;
      if (row.cancelAtPeriodEnd) plans[plan].cancelling += 1;
      plans[plan].mrrCents += Math.round(cents);
    }

    const trialsEndingSoon = live
      .filter(
        (row) =>
          !row.stripeSubscriptionId &&
          row.status === "trialing" &&
          row.trialEndsAt &&
          new Date(row.trialEndsAt).getTime() - now.getTime() <= 3 * DAY_MS
      )
      .map((row) => ({ id: row.id, plan: row.plan, owner: ownerOf(row), trialEndsAt: row.trialEndsAt }));

    const failedPayments = live
      .filter((row) => row.status === "past_due")
      .map((row) => ({ id: row.id, plan: row.plan, owner: ownerOf(row), graceEndsAt: row.graceEndsAt ?? null }));

    const pending = await DiscountRequest.findAll({ where: { status: "pending" }, order: [["createdAt", "ASC"]] });
    const requestCompanies = new Map(
      (await Company.findAll({ where: { id: pending.map((request) => request.companyId) }, attributes: ["id", "name"] })).map(
        (company) => [company.id, company.name]
      )
    );
    const requesters = new Map(
      (
        await User.findAll({
          where: { id: pending.map((request) => request.userId).filter(Boolean) as number[] },
          attributes: ["id", "email"],
        })
      ).map((user) => [user.id, user.email])
    );

    const discounted = await Company.findAll({
      where: { discount: { [Op.ne]: null } },
      attributes: ["id", "name", "discount"],
      order: [["name", "ASC"]],
    });
    const suspended = await Company.count({ where: { status: "suspended" } });
    const markedForRemoval = await Company.findAll({
      where: { markedForRemovalAt: { [Op.ne]: null } },
      attributes: ["id", "name", "suspendedAt", "markedForRemovalAt"],
      order: [["markedForRemovalAt", "ASC"]],
    });

    const activity = await this.activity(now);
    const suspendedAccounts = await User.count({ where: { suspendedAt: { [Op.ne]: null } } });

    return {
      users: {
        total: await User.count(),
        last30Days: await User.count({ where: { createdAt: { [Op.gte]: new Date(now.getTime() - 30 * DAY_MS) } } }),
      },
      plans,
      mrrCents: PAID.reduce((sum, plan) => sum + plans[plan].mrrCents, 0),
      trialsEndingSoon,
      failedPayments,
      discounts: {
        percent: DISCOUNT_PERCENT,
        pending: pending.map((request) => ({
          id: request.id,
          companyId: request.companyId,
          companyName: requestCompanies.get(request.companyId) || `Company ${request.companyId}`,
          requestedBy: request.userId ? requesters.get(request.userId) || null : null,
          kind: request.kind,
          organization: request.organization,
          website: request.website ?? null,
          note: request.note ?? null,
          createdAt: request.createdAt,
        })),
        active: discounted.map((company) => ({ id: company.id, name: company.name, kind: company.discount })),
      },
      companies: {
        suspended,
        markedForRemoval: markedForRemoval.map((company) => ({
          id: company.id,
          name: company.name,
          suspendedAt: company.suspendedAt ?? null,
          markedForRemovalAt: company.markedForRemovalAt ?? null,
        })),
      },
      suspendedAccounts,
      activity,
    };
  }

  /** Signups and activity as counts only: no names, no item data. */
  private async activity(now: Date) {
    const today = utcDate(now);
    const startOfToday = new Date(`${today}T00:00:00.000Z`);
    const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const dayAgo = (days: number) => utcDate(new Date(startOfToday.getTime() - days * DAY_MS));
    const num = (value: unknown) => Number(value) || 0;

    const [signups] = await sequelize.query<Record<string, string>>(
      `SELECT
        COUNT(*) FILTER (WHERE "createdAt" >= :startOfToday) AS today,
        COUNT(*) FILTER (WHERE "createdAt" >= :d7) AS d7,
        COUNT(*) FILTER (WHERE "createdAt" >= :d30) AS d30,
        COUNT(*) FILTER (WHERE "createdAt" >= :d14 AND "createdAt" < :d7) AS "prevD7",
        COUNT(*) FILTER (WHERE "createdAt" >= :d60 AND "createdAt" < :d30) AS "prevD30"
       FROM "users" WHERE "createdAt" >= :d60`,
      {
        replacements: { startOfToday, d7: ago(7), d14: ago(14), d30: ago(30), d60: ago(60) },
        type: QueryTypes.SELECT,
      }
    );

    // Active days: today, the last 7 and the last 30 UTC days (today included).
    const [active] = await sequelize.query<Record<string, string>>(
      `SELECT
        COUNT(DISTINCT "userId") FILTER (WHERE "date" = :today) AS day,
        COUNT(DISTINCT "userId") FILTER (WHERE "date" >= :week) AS week,
        COUNT(DISTINCT "userId") AS month
       FROM "user_activity_days" WHERE "date" >= :month AND "date" <= :today`,
      { replacements: { today, week: dayAgo(6), month: dayAgo(29) }, type: QueryTypes.SELECT }
    );

    // Rows are only counted: never selected.
    const [activation] = await sequelize.query<Record<string, string>>(
      `SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "notes" WHERE "notes"."userId" = "users"."id")) AS activated
       FROM "users" WHERE "createdAt" >= :d30`,
      { replacements: { d30: ago(30) }, type: QueryTypes.SELECT }
    );

    const from = dayAgo(89);
    const signupDays = await sequelize.query<{ date: string; n: string }>(
      `SELECT to_char(("createdAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date, COUNT(*) AS n
       FROM "users" WHERE "createdAt" >= :from GROUP BY 1`,
      { replacements: { from: new Date(`${from}T00:00:00.000Z`) }, type: QueryTypes.SELECT }
    );
    const activeDays = await sequelize.query<{ date: string; n: string }>(
      `SELECT to_char("date", 'YYYY-MM-DD') AS date, COUNT(DISTINCT "userId") AS n
       FROM "user_activity_days" WHERE "date" >= :from AND "date" <= :today GROUP BY 1`,
      { replacements: { from, today }, type: QueryTypes.SELECT }
    );
    const signupBy = new Map(signupDays.map((row) => [row.date, num(row.n)]));
    const activeBy = new Map(activeDays.map((row) => [row.date, num(row.n)]));
    const daily = Array.from({ length: 90 }, (_, i) => {
      const date = dayAgo(89 - i);
      return { date, signups: signupBy.get(date) ?? 0, active: activeBy.get(date) ?? 0 };
    });

    const total = num(activation?.total);
    return {
      signups: {
        today: num(signups?.today),
        d7: num(signups?.d7),
        d30: num(signups?.d30),
        prevD7: num(signups?.prevD7),
        prevD30: num(signups?.prevD30),
      },
      activeUsers: { day: num(active?.day), week: num(active?.week), month: num(active?.month) },
      activationRate30d: total ? num(activation?.activated) / total : 0,
      daily,
    };
  }
}

export default new AdminService();
