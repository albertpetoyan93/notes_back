import logger from "jet-logger";
import { QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import SignupSource from "../models/SignupSource";

export interface CleanSource {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  referrerDomain: string | null;
  landingPath: string | null;
}

/** Columns the "Sign-ups by source" page may group by (also the SQL column names). */
export const GROUP_BY = ["source", "medium", "campaign", "content", "referrerDomain", "landingPath"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export interface SourceRow {
  /** null: signed up without that tag. */
  key: string | null;
  signups: number;
  activated: number;
  paying: number;
}

export interface SourceReport {
  rows: SourceRow[];
  totals: { signups: number; activated: number; paying: number };
  /** Sign-ups in the period with no value for the grouped column. */
  untagged: number;
}

const OWN_DOMAIN = /(^|\.)2keevo\.com$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase().slice(0, max).trim();
  return cleaned || null;
}

function domainOf(referrer: unknown, referrerDomain: unknown): string | null {
  let host: string | null = null;
  if (typeof referrer === "string" && referrer.includes("://")) {
    try {
      host = new URL(referrer).hostname;
    } catch {
      host = null;
    }
  } else {
    host = text(referrerDomain, 255);
  }
  if (!host) return null;
  host = host.toLowerCase().replace(/^www\./, "");
  if (!DOMAIN.test(host) || OWN_DOMAIN.test(host)) return null;
  return host.slice(0, 255);
}

function pathOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  const path = value.split(/[?#]/)[0].slice(0, 255);
  return path || null;
}

/**
 * What the browser sent at sign-up, reduced to safe, comparable values.
 * Extension sign-ups are marked as such; null when nothing useful is left.
 */
export function cleanSource(raw: unknown, fromExtension: boolean): CleanSource | null {
  if (fromExtension) {
    return { source: "extension", medium: null, campaign: null, content: null, referrerDomain: null, landingPath: null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: CleanSource = {
    source: text(r.source, 100),
    medium: text(r.medium, 100),
    campaign: text(r.campaign, 150),
    content: text(r.content, 150),
    referrerDomain: domainOf(r.referrer, r.referrerDomain),
    landingPath: pathOf(r.landingPath),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

const num = (value: unknown) => Number(value) || 0;

class SignupSourceService {
  /** Called right after an account is created. Never throws: sign-up must not fail over this. */
  static async capture(userId: number, raw: unknown, fromExtension: boolean): Promise<void> {
    const clean = cleanSource(raw, fromExtension);
    if (!clean) return;
    try {
      await SignupSource.create({ userId, ...clean });
    } catch (error) {
      logger.err(error, true);
    }
  }

  /** Sign-ups in [from, to] (UTC dates) grouped by one source column, with activation and paying. */
  static async bySource(from: string, to: string, groupBy: GroupBy): Promise<SourceReport> {
    // groupBy comes from GROUP_BY only, so it is safe to place in the SQL.
    const rows = await sequelize.query<{ key: string | null; signups: string; activated: string; paying: string }>(
      `WITH cohort AS (
         SELECT u.id AS "userId", s."${groupBy}" AS key
         FROM "users" u
         LEFT JOIN "signup_sources" s ON s."userId" = u.id
         WHERE (u."createdAt" AT TIME ZONE 'UTC')::date BETWEEN :from::date AND :to::date
       ),
       paying AS (
         SELECT DISTINCT "userId" FROM "subscriptions"
         WHERE "stripeSubscriptionId" IS NOT NULL AND "userId" IS NOT NULL
         UNION
         SELECT DISTINCT cm."userId" FROM "company_members" cm
         JOIN "subscriptions" s ON s."companyId" = cm."companyId"
         WHERE s."stripeSubscriptionId" IS NOT NULL
       )
       SELECT c.key,
         COUNT(*)::text AS signups,
         COUNT(*) FILTER (
           WHERE EXISTS (SELECT 1 FROM "notes" n WHERE n."userId" = c."userId" AND n."deletedAt" IS NULL)
         )::text AS activated,
         COUNT(*) FILTER (WHERE p."userId" IS NOT NULL)::text AS paying
       FROM cohort c
       LEFT JOIN paying p ON p."userId" = c."userId"
       GROUP BY c.key
       ORDER BY COUNT(*) DESC, c.key NULLS LAST`,
      { replacements: { from, to }, type: QueryTypes.SELECT }
    );

    const mapped: SourceRow[] = rows.map((r) => ({
      key: r.key,
      signups: num(r.signups),
      activated: num(r.activated),
      paying: num(r.paying),
    }));
    const totals = mapped.reduce(
      (t, r) => ({ signups: t.signups + r.signups, activated: t.activated + r.activated, paying: t.paying + r.paying }),
      { signups: 0, activated: 0, paying: 0 }
    );
    const untagged = mapped.find((r) => r.key === null)?.signups ?? 0;
    return { rows: mapped, totals, untagged };
  }
}

export default SignupSourceService;
