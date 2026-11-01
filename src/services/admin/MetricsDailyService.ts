import { Op, QueryTypes } from "sequelize";
import sequelize from "../../configs/DB/sequelize";
import { DISCOUNT_PERCENT, PRICES, PlanId } from "../../common/plans";
import Company from "../../models/Company";
import MetricsDaily, { MrrByPlan } from "../../models/MetricsDaily";
import Subscription from "../../models/Subscription";
import { utcDate } from "../ActivityService";
import { isLive } from "../EntitlementService";

const DAY_MS = 24 * 60 * 60 * 1000;
type PaidPlan = Exclude<PlanId, "free">;
const PAID: PaidPlan[] = ["premium", "family", "team"];
const EMPTY_MRR: MrrByPlan = { premium: 0, family: 0, team: 0 };

function num(value: unknown) {
  return Number(value) || 0;
}

function endOfDay(day: string) {
  return new Date(`${day}T23:59:59.999Z`);
}

function addDays(day: string, delta: number) {
  return utcDate(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * DAY_MS));
}

export type MetricsDailyRow = {
  date: string;
  signups: number;
  dau: number;
  wau: number;
  mau: number;
  paying: number;
  trials: number;
  mrrCents: number;
  churned: number;
  activatedFirstItem: number;
  activatedExtension: number;
  activatedAutofill: number;
  mrrByPlan: MrrByPlan;
};

/** Computes one UTC day's snapshot and upserts it. */
export async function snapshot(day: string, now = endOfDay(day)): Promise<MetricsDailyRow> {
  const weekFrom = addDays(day, -6);
  const monthFrom = addDays(day, -29);
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const dayEnd = endOfDay(day);

  const [[counts], [act]] = await Promise.all([
    sequelize.query<Record<string, string>>(
      `SELECT
        (SELECT COUNT(*) FROM "users" WHERE "createdAt" >= :dayStart AND "createdAt" <= :dayEnd) AS signups,
        (SELECT COUNT(*) FROM "subscriptions"
          WHERE "status" IN ('canceled', 'expired')
            AND "updatedAt" >= :dayStart AND "updatedAt" <= :dayEnd) AS churned,
        (SELECT COUNT(*) FROM (
           SELECT "userId", MIN("createdAt") AS first_at FROM "notes"
           WHERE "deletedAt" IS NULL GROUP BY "userId"
         ) t WHERE first_at >= :dayStart AND first_at <= :dayEnd) AS "activatedFirstItem",
        (SELECT COUNT(*) FROM (
           SELECT "userId", MIN("createdAt") AS first_at FROM "user_sessions"
           WHERE "kind" = 'extension' GROUP BY "userId"
         ) t WHERE first_at >= :dayStart AND first_at <= :dayEnd) AS "activatedExtension",
        (SELECT COUNT(*) FROM (
           SELECT "actorId" AS "userId", MIN("createdAt") AS first_at FROM "audit_events"
           WHERE "action" = 'item_autofilled' AND "actorId" IS NOT NULL GROUP BY "actorId"
         ) t WHERE first_at >= :dayStart AND first_at <= :dayEnd) AS "activatedAutofill"`,
      { replacements: { dayStart, dayEnd }, type: QueryTypes.SELECT }
    ),
    sequelize.query<Record<string, string>>(
      `SELECT
        COUNT(DISTINCT "userId") FILTER (WHERE "date" = :day) AS dau,
        COUNT(DISTINCT "userId") FILTER (WHERE "date" >= :weekFrom AND "date" <= :day) AS wau,
        COUNT(DISTINCT "userId") FILTER (WHERE "date" >= :monthFrom AND "date" <= :day) AS mau
       FROM "user_activity_days" WHERE "date" >= :monthFrom AND "date" <= :day`,
      { replacements: { day, weekFrom, monthFrom }, type: QueryTypes.SELECT }
    ),
  ]);

  const rows = await Subscription.findAll({
    where: { status: { [Op.in]: ["trialing", "active", "past_due"] } },
  });
  const live = rows.filter((row) => isLive(row, now));
  const companyIds = [...new Set(live.map((row) => row.companyId).filter(Boolean))] as number[];
  const companies = new Map(
    (
      await Company.findAll({
        where: { id: companyIds },
        attributes: ["id", "discount"],
      })
    ).map((c) => [c.id, c])
  );

  const mrrByPlan: MrrByPlan = { ...EMPTY_MRR };
  let paying = 0;
  let trials = 0;
  let mrrCents = 0;

  for (const row of live) {
    const plan = row.plan as PaidPlan;
    if (!PAID.includes(plan)) continue;
    if (!row.stripeSubscriptionId) {
      if (row.status === "trialing") trials += 1;
      continue;
    }
    paying += 1;
    const interval = row.interval === "year" ? "year" : "month";
    const seats = plan === "team" ? row.seats || 1 : 1;
    const discounted = row.companyId && companies.get(row.companyId)?.discount;
    const cents = Math.round(PRICES[plan][interval] * seats * (discounted ? (100 - DISCOUNT_PERCENT) / 100 : 1));
    mrrByPlan[plan] += cents;
    mrrCents += cents;
  }

  const row: MetricsDailyRow = {
    date: day,
    signups: num(counts?.signups),
    dau: num(act?.dau),
    wau: num(act?.wau),
    mau: num(act?.mau),
    paying,
    trials,
    mrrCents,
    churned: num(counts?.churned),
    activatedFirstItem: num(counts?.activatedFirstItem),
    activatedExtension: num(counts?.activatedExtension),
    activatedAutofill: num(counts?.activatedAutofill),
    mrrByPlan,
  };

  await MetricsDaily.upsert({ ...row, createdAt: new Date() });
  return row;
}

/** Yesterday in UTC — what the nightly job freezes. */
export function yesterdayUtc(now = new Date()) {
  return addDays(utcDate(now), -1);
}

export default { snapshot, yesterdayUtc };
