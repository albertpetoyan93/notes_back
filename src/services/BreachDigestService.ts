import { createHmac, timingSafeEqual } from "crypto";
import logger from "jet-logger";
import { QueryTypes } from "sequelize";
import EnvVars from "../common/EnvVars";
import sequelize from "../configs/DB/sequelize";
import type { FeedBreach } from "./BreachFeedService";
import BreachFeedService from "./BreachFeedService";
import EmailService from "./EmailService";

/**
 * Breach alerts, phase 3: an opt-in weekly email with the big breaches added since the last one.
 * The same list for everyone (the server can't know who is affected); the vault shows the match.
 * App email goes through Gmail (about 500 a day for everything), so at most DAILY_LIMIT digests
 * leave per day and the rest wait for the next run; sign-up and reset emails always come first.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DAILY_LIMIT = 150;
const BIG = 1_000_000;
const MAX_IN_EMAIL = 8;

/** Breaches worth an email: big, verified, added after `since`; newest first. */
export function pickBreaches(feed: FeedBreach[], since: Date): FeedBreach[] {
  return feed
    .filter((b) => b.isVerified && b.pwnCount >= BIG && new Date(b.addedDate).getTime() > since.getTime())
    .sort((a, b) => b.addedDate.localeCompare(a.addedDate))
    .slice(0, MAX_IN_EMAIL);
}

const unsubscribeKey = () => createHmac("sha256", EnvVars.Jwt.Secret || "dev").update("2keevo/breach-digest/unsubscribe").digest();

/** A token that lets the email's link turn the digest off for this user, and nothing else. */
export function unsubscribeToken(userId: number): string {
  return createHmac("sha256", unsubscribeKey()).update(String(userId)).digest("base64url");
}

export function checkUnsubscribeToken(userId: number, token: string): boolean {
  if (!Number.isInteger(userId) || userId <= 0 || typeof token !== "string") return false;
  const expected = Buffer.from(unsubscribeToken(userId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function unsubscribeUrl(userId: number): string {
  const origin = (EnvVars.FrontendOrigin || "http://localhost:5173").split(",")[0].trim().replace(/\/$/, "");
  return `${origin}/api/breach-digest/unsubscribe?u=${userId}&t=${unsubscribeToken(userId)}`;
}

class BreachDigestService {
  async isOn(userId: number): Promise<boolean> {
    const rows = await sequelize.query<{ breachDigest: boolean }>(
      `SELECT "breachDigest" FROM "users" WHERE "id" = :userId`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    );
    return !!rows[0]?.breachDigest;
  }

  async set(userId: number, on: boolean) {
    // Turning it on starts the clock now, so the first email only lists breaches from now on
    // (the vault already shows older ones that matter).
    await sequelize.query(
      `UPDATE "users" SET "breachDigest" = :on, "breachDigestAt" = CASE WHEN :on THEN COALESCE("breachDigestAt", NOW()) ELSE "breachDigestAt" END WHERE "id" = :userId`,
      { replacements: { userId, on } }
    );
  }

  /** Daily job: send the digests that are due (a week since the last), up to DAILY_LIMIT. */
  async run(now = new Date()): Promise<{ due: number; sent: number; empty: number }> {
    if (!EmailService.isConfigured()) return { due: 0, sent: 0, empty: 0 };
    const users = await sequelize.query<{ id: number; email: string; breachDigestAt: string | null }>(
      `SELECT "id", "email", "breachDigestAt" FROM "users"
       WHERE "breachDigest" = TRUE AND "emailVerifiedAt" IS NOT NULL
         AND ("breachDigestAt" IS NULL OR "breachDigestAt" <= :due)
       ORDER BY "breachDigestAt" ASC NULLS FIRST
       LIMIT :limit`,
      { replacements: { due: new Date(now.getTime() - WEEK_MS).toISOString(), limit: DAILY_LIMIT }, type: QueryTypes.SELECT }
    );
    if (!users.length) return { due: 0, sent: 0, empty: 0 };
    const feed = await BreachFeedService.list(new Date(now.getTime() - 5 * WEEK_MS).toISOString());
    let sent = 0;
    let empty = 0;
    for (const user of users) {
      const since = user.breachDigestAt ? new Date(user.breachDigestAt) : new Date(now.getTime() - WEEK_MS);
      const breaches = pickBreaches(feed, since);
      if (!breaches.length) {
        // Nothing big since the last one: no email, and the next check is a week from now.
        await sequelize.query(`UPDATE "users" SET "breachDigestAt" = :now WHERE "id" = :id`, {
          replacements: { now: now.toISOString(), id: user.id },
        });
        empty += 1;
        continue;
      }
      try {
        await EmailService.sendBreachDigest({ to: user.email, breaches, unsubscribeUrl: unsubscribeUrl(user.id) });
      } catch (error) {
        // Probably the daily sending limit: stop here so account emails keep working.
        logger.err(`breach digest stopped after ${sent}: ${error}`);
        break;
      }
      await sequelize.query(`UPDATE "users" SET "breachDigestAt" = :now WHERE "id" = :id`, {
        replacements: { now: now.toISOString(), id: user.id },
      });
      sent += 1;
    }
    return { due: users.length, sent, empty };
  }
}

export default new BreachDigestService();
