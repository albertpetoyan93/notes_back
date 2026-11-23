import { createHash, randomBytes } from "crypto";
import logger from "jet-logger";
import { QueryTypes } from "sequelize";
import { getCountryForTimezone } from "countries-and-timezones";
import sequelize from "../configs/DB/sequelize";
import { utcDate } from "./ActivityService";
import { domainOf, text } from "./SignupSourceService";

/**
 * Website traffic for 2keevo.com, counted by us without cookies or third parties.
 * The IP address is used only to make today's anonymous visitor hash and is never stored;
 * each day's random salt is deleted once the day is over. Country comes from the browser's
 * time zone, not from the IP address.
 */

export interface PageView {
  day: string;
  visitor: string;
  path: string;
  referrerDomain: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  country: string | null;
  device: Device;
  browser: string;
}

export type Device = "mobile" | "tablet" | "desktop";

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|meta-externalagent|whatsapp|telegram|curl|wget|python|axios|node-fetch|go-http|java\/|monitor|uptime/i;

export function isBot(userAgent: string): boolean {
  return !userAgent || BOT.test(userAgent);
}

export function deviceOf(userAgent: string): Device {
  if (/ipad|tablet|kindle|silk/i.test(userAgent) || (/android/i.test(userAgent) && !/mobi/i.test(userAgent))) {
    return "tablet";
  }
  if (/mobi|iphone|ipod|android/i.test(userAgent)) return "mobile";
  return "desktop";
}

/** Browser family. Instagram's and Facebook's in-app browsers are named, since ads open there. */
export function browserOf(userAgent: string): string {
  if (/instagram/i.test(userAgent)) return "Instagram app";
  if (/FBAN|FBAV|FB_IAB/.test(userAgent)) return "Facebook app";
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/SamsungBrowser/.test(userAgent)) return "Samsung";
  if (/Firefox|FxiOS/.test(userAgent)) return "Firefox";
  if (/Chrome|CriOS|Chromium/.test(userAgent)) return "Chrome";
  if (/Safari/.test(userAgent)) return "Safari";
  return "Other";
}

export function countryOf(timeZone: unknown): string | null {
  if (typeof timeZone !== "string" || timeZone.length > 64) return null;
  try {
    return getCountryForTimezone(timeZone)?.id ?? null;
  } catch {
    return null;
  }
}

function pathOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  return text(value.split(/[?#]/)[0], 255);
}

function utmOf(search: unknown) {
  const out = { source: null, medium: null, campaign: null, content: null } as Record<
    "source" | "medium" | "campaign" | "content",
    string | null
  >;
  if (typeof search !== "string" || !search.startsWith("?") || search.length > 2000) return out;
  const params = new URLSearchParams(search);
  out.source = text(params.get("utm_source"), 100);
  out.medium = text(params.get("utm_medium"), 100);
  out.campaign = text(params.get("utm_campaign"), 150);
  out.content = text(params.get("utm_content"), 150);
  return out;
}

export function visitorHash(salt: string, ip: string, userAgent: string): string {
  return createHash("sha256").update(`${salt}|${ip}|${userAgent}`).digest("hex").slice(0, 16);
}

/**
 * What the page sent, reduced to safe values; null when it should not be counted.
 * body: { p: pathname, q: location.search, r: document.referrer (first view only), tz: time zone }
 */
export function cleanPageView(
  body: unknown,
  ctx: { day: string; salt: string; ip: string; userAgent: string }
): PageView | null {
  if (isBot(ctx.userAgent)) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const path = pathOf(b.p);
  if (!path) return null;
  return {
    day: ctx.day,
    visitor: visitorHash(ctx.salt, ctx.ip, ctx.userAgent),
    path,
    referrerDomain: domainOf(b.r, null),
    ...utmOf(b.q),
    country: countryOf(b.tz),
    device: deviceOf(ctx.userAgent),
    browser: browserOf(ctx.userAgent),
  };
}

// ---- Report ----

export interface TrafficRow {
  key: string | null;
  visitors: number;
  pageviews: number;
}

export interface ConversionRow {
  key: string;
  visitors: number;
  signups: number;
}

export interface TrafficReport {
  totals: { visitors: number; pageviews: number; signups: number };
  daily: { day: string; visitors: number; pageviews: number }[];
  pages: TrafficRow[];
  sources: TrafficRow[];
  countries: TrafficRow[];
  devices: TrafficRow[];
  browsers: TrafficRow[];
  /** Visitors who arrived with the campaign tag, and sign-ups whose first visit carried it. */
  campaigns: ConversionRow[];
  /** Same, by utm_content (one ad or post). */
  contents: ConversionRow[];
}

// Grouping expressions. Fixed strings only, so they are safe to place in the SQL.
const GROUPS = {
  pages: `"path"`,
  countries: `"country"`,
  devices: `"device"`,
  browsers: `"browser"`,
} as const;

const num = (v: unknown) => Number(v) || 0;

/** Joins visitor counts and sign-up counts by key; keys with neither are dropped. */
export function mergeConversions(
  visits: { key: string | null; visitors: number }[],
  signups: { key: string | null; signups: number }[]
): ConversionRow[] {
  const rows = new Map<string, ConversionRow>();
  for (const v of visits) {
    if (v.key === null) continue;
    rows.set(v.key, { key: v.key, visitors: v.visitors, signups: 0 });
  }
  for (const s of signups) {
    if (s.key === null) continue;
    const row = rows.get(s.key) ?? { key: s.key, visitors: 0, signups: 0 };
    row.signups = s.signups;
    rows.set(s.key, row);
  }
  return [...rows.values()].sort((a, b) => b.visitors - a.visitors || b.signups - a.signups || a.key.localeCompare(b.key));
}

class TrafficService {
  private salt: { day: string; value: string } | null = null;

  /** Today's salt, shared by every process through the database. */
  private async saltFor(day: string): Promise<string> {
    if (this.salt?.day === day) return this.salt.value;
    await sequelize.query(`INSERT INTO "traffic_salts" ("day", "salt") VALUES (:day, :salt) ON CONFLICT ("day") DO NOTHING`, {
      replacements: { day, salt: randomBytes(32).toString("hex") },
    });
    const rows = await sequelize.query<{ salt: string }>(`SELECT "salt" FROM "traffic_salts" WHERE "day" = :day`, {
      replacements: { day },
      type: QueryTypes.SELECT,
    });
    this.salt = { day, value: rows[0].salt };
    return this.salt.value;
  }

  /** Stores one page view. Never throws: the website must not notice failures. */
  async record(body: unknown, ip: string, userAgent: string): Promise<boolean> {
    try {
      if (isBot(userAgent)) return false;
      const day = utcDate(new Date());
      const view = cleanPageView(body, { day, salt: await this.saltFor(day), ip, userAgent });
      if (!view) return false;
      await sequelize.query(
        `INSERT INTO "page_views"
           ("day", "visitor", "path", "referrerDomain", "source", "medium", "campaign", "content", "country", "device", "browser")
         VALUES (:day, :visitor, :path, :referrerDomain, :source, :medium, :campaign, :content, :country, :device, :browser)`,
        { replacements: { ...view } }
      );
      return true;
    } catch (error) {
      logger.err(error, true);
      return false;
    }
  }

  /** Daily job: forget old salts (so old hashes can't be matched again) and very old page views. */
  async cleanup() {
    const yesterday = utcDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const [, salts] = await sequelize.query(`DELETE FROM "traffic_salts" WHERE "day" < :yesterday`, {
      replacements: { yesterday },
    });
    const [, views] = await sequelize.query(
      `DELETE FROM "page_views" WHERE "day" < (CURRENT_DATE - INTERVAL '25 months')`
    );
    return { salts: (salts as any)?.rowCount ?? 0, pageViews: (views as any)?.rowCount ?? 0 };
  }

  private async select<T extends object>(sql: string, from: string, to: string): Promise<T[]> {
    return sequelize.query<T>(sql, { replacements: { from, to }, type: QueryTypes.SELECT });
  }

  private async breakdown(expr: string, from: string, to: string, limit = 20): Promise<TrafficRow[]> {
    const rows = await this.select<{ key: string | null; visitors: string; pageviews: string }>(
      `SELECT ${expr} AS key, COUNT(DISTINCT ("day", "visitor"))::text AS visitors, COUNT(*)::text AS pageviews
       FROM "page_views" WHERE "day" BETWEEN :from::date AND :to::date
       GROUP BY 1 ORDER BY COUNT(DISTINCT ("day", "visitor")) DESC, 1 NULLS LAST LIMIT ${limit}`,
      from,
      to
    );
    return rows.map((r) => ({ key: r.key, visitors: num(r.visitors), pageviews: num(r.pageviews) }));
  }

  /** Visitors by where their day's first page view came from (campaign source, else referrer, else direct). */
  private async entrySources(from: string, to: string, limit = 20): Promise<TrafficRow[]> {
    const rows = await this.select<{ key: string | null; visitors: string; pageviews: string }>(
      `WITH entry AS (
         SELECT DISTINCT ON ("day", "visitor") "day", "visitor", COALESCE("source", "referrerDomain") AS key
         FROM "page_views" WHERE "day" BETWEEN :from::date AND :to::date
         ORDER BY "day", "visitor", "id"
       ),
       views AS (
         SELECT "day", "visitor", COUNT(*) AS n
         FROM "page_views" WHERE "day" BETWEEN :from::date AND :to::date
         GROUP BY 1, 2
       )
       SELECT e.key, COUNT(*)::text AS visitors, SUM(v.n)::text AS pageviews
       FROM entry e JOIN views v ON v."day" = e."day" AND v."visitor" = e."visitor"
       GROUP BY 1 ORDER BY COUNT(*) DESC, 1 NULLS LAST LIMIT ${limit}`,
      from,
      to
    );
    return rows.map((r) => ({ key: r.key, visitors: num(r.visitors), pageviews: num(r.pageviews) }));
  }

  private async conversions(column: "campaign" | "content", from: string, to: string): Promise<ConversionRow[]> {
    const visits = await this.select<{ key: string | null; visitors: string }>(
      `SELECT "${column}" AS key, COUNT(DISTINCT ("day", "visitor"))::text AS visitors
       FROM "page_views" WHERE "day" BETWEEN :from::date AND :to::date AND "${column}" IS NOT NULL
       GROUP BY 1`,
      from,
      to
    );
    const signups = await this.select<{ key: string | null; signups: string }>(
      `SELECT s."${column}" AS key, COUNT(*)::text AS signups
       FROM "signup_sources" s JOIN "users" u ON u.id = s."userId"
       WHERE (u."createdAt" AT TIME ZONE 'UTC')::date BETWEEN :from::date AND :to::date AND s."${column}" IS NOT NULL
       GROUP BY 1`,
      from,
      to
    );
    return mergeConversions(
      visits.map((v) => ({ key: v.key, visitors: num(v.visitors) })),
      signups.map((s) => ({ key: s.key, signups: num(s.signups) }))
    ).slice(0, 30);
  }

  async report(from: string, to: string): Promise<TrafficReport> {
    const [totals] = await this.select<{ visitors: string; pageviews: string }>(
      `SELECT COUNT(DISTINCT ("day", "visitor"))::text AS visitors, COUNT(*)::text AS pageviews
       FROM "page_views" WHERE "day" BETWEEN :from::date AND :to::date`,
      from,
      to
    );
    const [signups] = await this.select<{ signups: string }>(
      `SELECT COUNT(*)::text AS signups FROM "users"
       WHERE ("createdAt" AT TIME ZONE 'UTC')::date BETWEEN :from::date AND :to::date`,
      from,
      to
    );
    const daily = await this.select<{ day: string; visitors: string; pageviews: string }>(
      `SELECT d::date::text AS day,
         COALESCE(COUNT(DISTINCT (v."day", v."visitor")) FILTER (WHERE v."id" IS NOT NULL), 0)::text AS visitors,
         COUNT(v."id")::text AS pageviews
       FROM generate_series(:from::date, :to::date, INTERVAL '1 day') d
       LEFT JOIN "page_views" v ON v."day" = d::date
       GROUP BY 1 ORDER BY 1`,
      from,
      to
    );
    return {
      totals: { visitors: num(totals?.visitors), pageviews: num(totals?.pageviews), signups: num(signups?.signups) },
      daily: daily.map((d) => ({ day: d.day, visitors: num(d.visitors), pageviews: num(d.pageviews) })),
      pages: await this.breakdown(GROUPS.pages, from, to),
      sources: await this.entrySources(from, to),
      countries: await this.breakdown(GROUPS.countries, from, to),
      devices: await this.breakdown(GROUPS.devices, from, to),
      browsers: await this.breakdown(GROUPS.browsers, from, to),
      campaigns: await this.conversions("campaign", from, to),
      contents: await this.conversions("content", from, to),
    };
  }
}

export default new TrafficService();
