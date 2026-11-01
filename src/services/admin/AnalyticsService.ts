import { Op, QueryTypes } from "sequelize";
import sequelize from "../../configs/DB/sequelize";
import MetricsDaily from "../../models/MetricsDaily";
import { utcDate } from "../ActivityService";
import { snapshot, type MetricsDailyRow } from "./MetricsDailyService";

const DAY_MS = 24 * 60 * 60 * 1000;

function num(value: unknown) {
  return Number(value) || 0;
}

function addDays(day: string, delta: number) {
  return utcDate(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * DAY_MS));
}

/** Monday (UTC) of the ISO week containing `day`. */
function weekStart(day: string) {
  const d = new Date(`${day}T00:00:00.000Z`);
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const offset = dow === 0 ? -6 : 1 - dow;
  return addDays(day, offset);
}

async function firstActivityDate(): Promise<string | null> {
  const [row] = await sequelize.query<{ d: string }>(
    `SELECT to_char(MIN("date"), 'YYYY-MM-DD') AS d FROM "user_activity_days"`,
    { type: QueryTypes.SELECT }
  );
  return row?.d || null;
}

export type FunnelStepCounts = {
  signedUp: number;
  firstItem: number;
  extension: number;
  autofill: number;
  activeDay7: number;
  activeDay30: number;
  paying: number;
};

export type FunnelDay = FunnelStepCounts & { date: string };

export type RetentionCell = { cohortSize: number; active: number; rate: number };
export type RetentionRow = { weekStart: string; cohortSize: number; weeks: RetentionCell[]; partial: boolean };

export default class AnalyticsService {
  /** Historical MetricsDaily rows plus a live compute for today when in range. */
  static async daily(from: string, to: string, now = new Date()): Promise<MetricsDailyRow[]> {
    const today = utcDate(now);
    const rows = await MetricsDaily.findAll({
      where: { date: { [Op.between]: [from, to] } },
      order: [["date", "ASC"]],
    });
    const byDate = new Map(rows.map((r) => [r.date, r.get({ plain: true }) as MetricsDailyRow]));

    if (to >= today && from <= today) {
      byDate.set(today, await snapshot(today, now));
    }

    const out: MetricsDailyRow[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const row = byDate.get(d);
      if (row) out.push(row);
      else {
        out.push({
          date: d,
          signups: 0,
          dau: 0,
          wau: 0,
          mau: 0,
          paying: 0,
          trials: 0,
          mrrCents: 0,
          churned: 0,
          activatedFirstItem: 0,
          activatedExtension: 0,
          activatedAutofill: 0,
          mrrByPlan: { premium: 0, family: 0, team: 0 },
        });
      }
    }
    return out;
  }

  /**
   * One row per signup UTC day in [from, to], plus totals.
   * Day-7 window = signup+7 .. signup+13; day-30 = signup+30 .. signup+36.
   */
  static async funnel(from: string, to: string): Promise<{ days: FunnelDay[]; totals: FunnelStepCounts; partial: boolean }> {
    const activityStart = await firstActivityDate();
    const partial = !activityStart || activityStart > from;

    const days = await sequelize.query<{
      date: string;
      signedUp: string;
      firstItem: string;
      extension: string;
      autofill: string;
      activeDay7: string;
      activeDay30: string;
      paying: string;
    }>(
      `WITH cohort AS (
         SELECT id AS "userId",
                to_char(("createdAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
                ("createdAt" AT TIME ZONE 'UTC')::date AS signup_day
         FROM "users"
         WHERE ("createdAt" AT TIME ZONE 'UTC')::date BETWEEN :from::date AND :to::date
       ),
       first_item AS (
         SELECT "userId", MIN(("createdAt" AT TIME ZONE 'UTC')::date) AS d
         FROM "notes" WHERE "deletedAt" IS NULL GROUP BY "userId"
       ),
       first_ext AS (
         SELECT "userId", MIN(("createdAt" AT TIME ZONE 'UTC')::date) AS d
         FROM "user_sessions" WHERE "kind" = 'extension' GROUP BY "userId"
       ),
       first_fill AS (
         SELECT "actorId" AS "userId", MIN(("createdAt" AT TIME ZONE 'UTC')::date) AS d
         FROM "audit_events" WHERE "action" = 'item_autofilled' AND "actorId" IS NOT NULL
         GROUP BY "actorId"
       ),
       paying AS (
         SELECT DISTINCT "userId" FROM "subscriptions"
         WHERE "stripeSubscriptionId" IS NOT NULL AND "userId" IS NOT NULL
         UNION
         SELECT DISTINCT cm."userId" FROM "company_members" cm
         JOIN "subscriptions" s ON s."companyId" = cm."companyId"
         WHERE s."stripeSubscriptionId" IS NOT NULL
       )
       SELECT c.date,
         COUNT(*)::text AS "signedUp",
         COUNT(*) FILTER (WHERE fi.d IS NOT NULL)::text AS "firstItem",
         COUNT(*) FILTER (WHERE fe.d IS NOT NULL)::text AS extension,
         COUNT(*) FILTER (WHERE ff.d IS NOT NULL)::text AS autofill,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM "user_activity_days" a
             WHERE a."userId" = c."userId"
               AND a."date" BETWEEN (c.signup_day + 7) AND (c.signup_day + 13)
           )
         )::text AS "activeDay7",
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM "user_activity_days" a
             WHERE a."userId" = c."userId"
               AND a."date" BETWEEN (c.signup_day + 30) AND (c.signup_day + 36)
           )
         )::text AS "activeDay30",
         COUNT(*) FILTER (WHERE p."userId" IS NOT NULL)::text AS paying
       FROM cohort c
       LEFT JOIN first_item fi ON fi."userId" = c."userId"
       LEFT JOIN first_ext fe ON fe."userId" = c."userId"
       LEFT JOIN first_fill ff ON ff."userId" = c."userId"
       LEFT JOIN paying p ON p."userId" = c."userId"
       GROUP BY c.date
       ORDER BY c.date`,
      { replacements: { from, to }, type: QueryTypes.SELECT }
    );

    const mapped: FunnelDay[] = days.map((d) => ({
      date: d.date,
      signedUp: num(d.signedUp),
      firstItem: num(d.firstItem),
      extension: num(d.extension),
      autofill: num(d.autofill),
      activeDay7: num(d.activeDay7),
      activeDay30: num(d.activeDay30),
      paying: num(d.paying),
    }));

    const totals: FunnelStepCounts = {
      signedUp: 0,
      firstItem: 0,
      extension: 0,
      autofill: 0,
      activeDay7: 0,
      activeDay30: 0,
      paying: 0,
    };
    for (const d of mapped) {
      totals.signedUp += d.signedUp;
      totals.firstItem += d.firstItem;
      totals.extension += d.extension;
      totals.autofill += d.autofill;
      totals.activeDay7 += d.activeDay7;
      totals.activeDay30 += d.activeDay30;
      totals.paying += d.paying;
    }

    return { days: mapped, totals, partial };
  }

  /** Weekly signup cohorts × weeks since signup. */
  static async retention(weeks = 12, now = new Date()): Promise<{ rows: RetentionRow[]; maxWeek: number }> {
    const n = Math.min(52, Math.max(1, Math.floor(weeks)));
    const today = utcDate(now);
    const oldest = addDays(weekStart(today), -(n - 1) * 7);
    const activityStart = await firstActivityDate();

    const cohorts = await sequelize.query<{ week: string; userId: string }>(
      `SELECT to_char(date_trunc('week', "createdAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS week,
              id::text AS "userId"
       FROM "users"
       WHERE ("createdAt" AT TIME ZONE 'UTC')::date >= :oldest`,
      { replacements: { oldest }, type: QueryTypes.SELECT }
    );

    const byWeek = new Map<string, number[]>();
    for (const row of cohorts) {
      const list = byWeek.get(row.week) || [];
      list.push(Number(row.userId));
      byWeek.set(row.week, list);
    }

    const activity = await sequelize.query<{ userId: string; date: string }>(
      `SELECT "userId"::text AS "userId", to_char("date", 'YYYY-MM-DD') AS date
       FROM "user_activity_days" WHERE "date" >= :oldest`,
      { replacements: { oldest }, type: QueryTypes.SELECT }
    );
    const activeByUser = new Map<number, Set<string>>();
    for (const row of activity) {
      const id = Number(row.userId);
      if (!activeByUser.has(id)) activeByUser.set(id, new Set());
      activeByUser.get(id)!.add(row.date);
    }

    const weekStarts: string[] = [];
    for (let i = 0; i < n; i++) weekStarts.push(addDays(oldest, i * 7));

    const rows: RetentionRow[] = weekStarts.map((ws) => {
      const ids = byWeek.get(ws) || [];
      const cohortSize = ids.length;
      const partial = !activityStart || activityStart > ws;
      const cells: RetentionCell[] = [];
      for (let w = 0; w < n; w++) {
        const from = addDays(ws, w * 7);
        const to = addDays(from, 6);
        if (from > today) {
          cells.push({ cohortSize, active: 0, rate: 0 });
          continue;
        }
        let active = 0;
        for (const id of ids) {
          const days = activeByUser.get(id);
          if (!days) continue;
          for (const d of days) {
            if (d >= from && d <= to) {
              active += 1;
              break;
            }
          }
        }
        cells.push({
          cohortSize,
          active,
          rate: cohortSize ? active / cohortSize : 0,
        });
      }
      return { weekStart: ws, cohortSize, weeks: cells, partial };
    });

    return { rows, maxWeek: n };
  }

  static async extensionVersions(): Promise<{ version: string | null; sessions: number }[]> {
    const rows = await sequelize.query<{ version: string | null; sessions: string }>(
      `SELECT "extensionVersion" AS version, COUNT(*)::text AS sessions
       FROM "user_sessions"
       WHERE "kind" = 'extension' AND "expiresAt" > NOW()
       GROUP BY "extensionVersion"
       ORDER BY COUNT(*) DESC, "extensionVersion" NULLS LAST`,
      { type: QueryTypes.SELECT }
    );
    return rows.map((r) => ({ version: r.version, sessions: num(r.sessions) }));
  }
}
