import { createHmac, timingSafeEqual } from "crypto";
import logger from "jet-logger";
import { QueryTypes } from "sequelize";
import EnvVars from "../common/EnvVars";
import sequelize from "../configs/DB/sequelize";
import EmailService from "./EmailService";

/**
 * Product announcements to existing users, sent in small daily batches.
 * App email goes through Gmail (about 500 a day for everything, with up to 150 breach digests),
 * so at most DAILY_LIMIT announcements leave per day; the rest wait for the next run.
 * Only confirmed addresses, only users who didn't turn product news off, never twice.
 *
 * Off until the server's ANNOUNCEMENT env var names a campaign (e.g. ANNOUNCEMENT=breach-alerts);
 * when everyone has it, the job finds nobody and sends nothing. Unset it afterwards.
 */

export const DAILY_LIMIT = 120;
export const CAMPAIGNS = ["breach-alerts"] as const;
export type Campaign = (typeof CAMPAIGNS)[number];

const unsubscribeKey = () => createHmac("sha256", EnvVars.Jwt.Secret || "dev").update("2keevo/product-news/unsubscribe").digest();

/** A token that lets the email's link turn product news off for this user, and nothing else. */
export function newsToken(userId: number): string {
  return createHmac("sha256", unsubscribeKey()).update(String(userId)).digest("base64url");
}

export function checkNewsToken(userId: number, token: string): boolean {
  if (!Number.isInteger(userId) || userId <= 0 || typeof token !== "string") return false;
  const expected = Buffer.from(newsToken(userId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function newsUnsubscribeUrl(userId: number): string {
  const origin = (EnvVars.FrontendOrigin || "http://localhost:5173").split(",")[0].trim().replace(/\/$/, "");
  return `${origin}/api/product-news/unsubscribe?u=${userId}&t=${newsToken(userId)}`;
}

export function activeCampaign(value = process.env.ANNOUNCEMENT ?? ""): Campaign | null {
  const name = value.trim();
  return (CAMPAIGNS as readonly string[]).includes(name) ? (name as Campaign) : null;
}

class AnnouncementService {
  async setProductNews(userId: number, on: boolean): Promise<void> {
    await sequelize.query(`UPDATE "users" SET "productNews" = :on WHERE "id" = :userId`, { replacements: { userId, on } });
  }

  /** Daily job: the next batch of the active campaign. */
  async run(campaign = activeCampaign(), limit = DAILY_LIMIT): Promise<{ campaign: string | null; sent: number; more: boolean }> {
    if (!campaign || !EmailService.isConfigured()) return { campaign, sent: 0, more: false };
    const users = await sequelize.query<{ id: number; email: string }>(
      `SELECT u."id", u."email" FROM "users" u
       WHERE u."emailVerifiedAt" IS NOT NULL AND u."productNews" = TRUE
         AND NOT EXISTS (SELECT 1 FROM "announcement_sends" s WHERE s."campaign" = :campaign AND s."userId" = u."id")
       ORDER BY u."id" ASC
       LIMIT :limit`,
      { replacements: { campaign, limit: limit + 1 }, type: QueryTypes.SELECT }
    );
    const batch = users.slice(0, limit);
    let sent = 0;
    for (const user of batch) {
      try {
        await EmailService.sendAnnouncement({ campaign, to: user.email, unsubscribeUrl: newsUnsubscribeUrl(user.id) });
      } catch (error) {
        // Probably the daily sending limit: stop here so account emails keep working.
        logger.err(`announcement ${campaign} stopped after ${sent}: ${error}`);
        break;
      }
      await sequelize.query(
        `INSERT INTO "announcement_sends" ("campaign", "userId") VALUES (:campaign, :id) ON CONFLICT DO NOTHING`,
        { replacements: { campaign, id: user.id } }
      );
      sent += 1;
    }
    // "more": someone is still waiting (a full batch went out, or sending stopped early).
    return { campaign, sent, more: users.length > sent };
  }
}

export default new AnnouncementService();
