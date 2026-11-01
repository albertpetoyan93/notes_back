import logger from "jet-logger";
import { QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type ActivityKind = "web" | "extension";

// Fixed statements, one per kind: the column name never comes from a variable.
const UPSERT: Record<ActivityKind, string> = {
  web: `INSERT INTO "user_activity_days" ("userId", "date", "web", "extension")
    VALUES ($1, $2, true, false)
    ON CONFLICT ("userId", "date") DO UPDATE SET "web" = true`,
  extension: `INSERT INTO "user_activity_days" ("userId", "date", "web", "extension")
    VALUES ($1, $2, false, true)
    ON CONFLICT ("userId", "date") DO UPDATE SET "extension" = true`,
};

/** YYYY-MM-DD in UTC. */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Writes already done today, so a busy user costs one query per kind per day.
// It is dropped when the UTC day changes, so it never grows past one day.
let seen = new Set<string>();
let seenDate = "";

export default class ActivityService {
  /** Records that the user was active today. Fire-and-forget: never throws, never waits. */
  static note(userId: number, kind: ActivityKind, now = new Date()): void {
    if (!Number.isInteger(userId) || !Object.prototype.hasOwnProperty.call(UPSERT, kind)) return;
    const date = utcDate(now);
    if (date !== seenDate) {
      seen = new Set();
      seenDate = date;
    }
    const key = `${userId}:${date}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);

    const failed = (error: unknown) => {
      // Forget it so a later request tries again.
      seen.delete(key);
      logger.err(`Could not record activity for user ${userId}: ${error}`);
    };
    try {
      Promise.resolve(sequelize.query(UPSERT[kind], { bind: [userId, date] })).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /** Distinct users with any activity between two UTC days (inclusive, YYYY-MM-DD). */
  static async activeUserIds(from: string, to: string): Promise<number[]> {
    const rows = await sequelize.query<{ userId: number | string }>(
      `SELECT DISTINCT "userId" FROM "user_activity_days" WHERE "date" BETWEEN :from AND :to`,
      { replacements: { from, to }, type: QueryTypes.SELECT }
    );
    return rows.map((row) => Number(row.userId));
  }
}
