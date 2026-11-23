import logger from "jet-logger";
import { QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/**
 * The public list of breached websites (Have I Been Pwned, CC BY 4.0), refreshed once a day by
 * our server. Browsers never call HIBP for this and the server never learns which sites a user
 * has: each vault matches the list against its own decrypted logins (docs/features/breach-alerts.md).
 */

const FEED_URL = "https://haveibeenpwned.com/api/v3/breaches";
const BIG = 1_000_000;

export interface FeedBreach {
  name: string;
  title: string;
  domain: string;
  breachDate: string | null;
  addedDate: string;
  pwnCount: number;
  dataClasses: string[];
  isVerified: boolean;
}

/**
 * The site part people sign in to: "www.shop.example.co.uk" -> "example.co.uk".
 * Same rule as notes_extension/background.js and notes_front/src/utils/rootHost.ts: keep them in step.
 */
export function rootHost(host: string): string {
  const name = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#:]/)[0]
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  const multi = ["co.uk", "com.au", "co.jp", "com.br", "co.nz", "com.tr", "co.za"];
  for (const suffix of multi) {
    if (name.endsWith(`.${suffix}`)) {
      const brand = name.slice(0, -(suffix.length + 1)).split(".").pop();
      return brand ? `${brand}.${suffix}` : name;
    }
  }
  const parts = name.split(".");
  return parts.length <= 2 ? name : parts.slice(-2).join(".");
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * HIBP breaches worth an alert: a website domain, and passwords exposed, or a big breach with
 * email addresses. Spam lists, fabricated, retired and malware entries are skipped.
 */
export function cleanBreaches(raw: unknown): FeedBreach[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedBreach[] = [];
  for (const b of raw as Record<string, any>[]) {
    if (!b || typeof b !== "object") continue;
    if (b.IsSpamList || b.IsFabricated || b.IsRetired || b.IsMalware) continue;
    const domain = rootHost(String(b.Domain || ""));
    if (!DOMAIN.test(domain)) continue;
    const classes: string[] = Array.isArray(b.DataClasses) ? b.DataClasses.map(String).slice(0, 40) : [];
    const pwnCount = Number(b.PwnCount) || 0;
    const passwords = classes.includes("Passwords");
    const bigWithEmails = pwnCount >= BIG && classes.includes("Email addresses");
    if (!passwords && !bigWithEmails) continue;
    const name = String(b.Name || "").slice(0, 150);
    const added = new Date(String(b.AddedDate || ""));
    if (!name || Number.isNaN(added.getTime())) continue;
    out.push({
      name,
      title: String(b.Title || name).slice(0, 200),
      domain,
      breachDate: /^\d{4}-\d{2}-\d{2}$/.test(String(b.BreachDate)) ? String(b.BreachDate) : null,
      addedDate: added.toISOString(),
      pwnCount,
      dataClasses: classes,
      isVerified: b.IsVerified !== false,
    });
  }
  return out;
}

class BreachFeedService {
  /** Daily job: download the list and upsert it. Returns counts for the job log. */
  async refresh(fetchImpl: typeof fetch = fetch): Promise<{ fetched: number; kept: number }> {
    const response = await fetchImpl(FEED_URL, {
      headers: { "user-agent": "2keevo-breach-alerts (+https://2keevo.com)", accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HIBP breaches answered ${response.status}`);
    const raw = await response.json();
    const kept = cleanBreaches(raw);
    for (const b of kept) {
      await sequelize.query(
        `INSERT INTO "breach_feed" ("name", "title", "domain", "breachDate", "addedDate", "pwnCount", "dataClasses", "isVerified", "fetchedAt")
         VALUES (:name, :title, :domain, :breachDate, :addedDate, :pwnCount, CAST(:dataClasses AS JSONB), :isVerified, NOW())
         ON CONFLICT ("name") DO UPDATE SET
           "title" = EXCLUDED."title", "domain" = EXCLUDED."domain", "breachDate" = EXCLUDED."breachDate",
           "addedDate" = EXCLUDED."addedDate", "pwnCount" = EXCLUDED."pwnCount",
           "dataClasses" = EXCLUDED."dataClasses", "isVerified" = EXCLUDED."isVerified", "fetchedAt" = NOW()`,
        { replacements: { ...b, dataClasses: JSON.stringify(b.dataClasses) } }
      );
    }
    return { fetched: Array.isArray(raw) ? raw.length : 0, kept: kept.length };
  }

  /** Breaches added since a date (default: the last 2 years), newest first. */
  async list(since?: string): Promise<FeedBreach[]> {
    const from = since && !Number.isNaN(new Date(since).getTime())
      ? new Date(since).toISOString()
      : new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await sequelize.query<any>(
      `SELECT "name", "title", "domain", "breachDate"::text AS "breachDate", "addedDate", "pwnCount", "dataClasses", "isVerified"
       FROM "breach_feed" WHERE "addedDate" >= :from ORDER BY "addedDate" DESC LIMIT 500`,
      { replacements: { from }, type: QueryTypes.SELECT }
    );
    return rows.map((r) => ({
      name: r.name,
      title: r.title,
      domain: r.domain,
      breachDate: r.breachDate,
      addedDate: new Date(r.addedDate).toISOString(),
      pwnCount: Number(r.pwnCount) || 0,
      dataClasses: Array.isArray(r.dataClasses) ? r.dataClasses : [],
      isVerified: !!r.isVerified,
    }));
  }

  /** For JobService: never throws past here; the job runner records failures. */
  async job() {
    try {
      return await this.refresh();
    } catch (error) {
      logger.err(error, true);
      throw error;
    }
  }
}

export default new BreachFeedService();
