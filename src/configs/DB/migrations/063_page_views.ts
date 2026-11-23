import sequelize from "../sequelize";

/**
 * Website traffic (2keevo.com only, never the vault app), counted without cookies.
 * page_views: one row per page view. "visitor" is a hash of a daily random salt, the IP
 *   address and the user agent; the IP itself is never stored, and each day's salt is
 *   deleted after the day ends, so a visitor can't be followed from one day to the next.
 * traffic_salts: today's (and yesterday's) salt; older ones are removed by a daily job.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "page_views" (
    "id" BIGSERIAL PRIMARY KEY,
    "day" DATE NOT NULL,
    "visitor" CHAR(16) NOT NULL,
    "path" VARCHAR(255) NOT NULL,
    "referrerDomain" VARCHAR(255),
    "source" VARCHAR(100),
    "medium" VARCHAR(100),
    "campaign" VARCHAR(150),
    "content" VARCHAR(150),
    "country" CHAR(2),
    "device" VARCHAR(10),
    "browser" VARCHAR(20),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "page_views_day" ON "page_views" ("day", "visitor")`,
  `CREATE TABLE IF NOT EXISTS "traffic_salts" (
    "day" DATE PRIMARY KEY,
    "salt" CHAR(64) NOT NULL
  )`,
];

export async function up() {
  for (const statement of STATEMENTS) await sequelize.query(statement);
}
