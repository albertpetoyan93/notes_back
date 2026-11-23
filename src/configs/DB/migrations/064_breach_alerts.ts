import sequelize from "../sequelize";

/**
 * Breach alerts (docs/features/breach-alerts.md, phase 1).
 * breach_feed: the public list of breached websites from Have I Been Pwned, refreshed daily.
 *   No user data. Each vault compares it with its own logins in the browser.
 * users.sealedSettings: per-user settings encrypted in the browser with the user key
 *   (first use: dismissed breach alerts, which would reveal the sites a user has).
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "breach_feed" (
    "name" VARCHAR(150) PRIMARY KEY,
    "title" VARCHAR(200) NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "breachDate" DATE,
    "addedDate" TIMESTAMPTZ NOT NULL,
    "pwnCount" BIGINT NOT NULL DEFAULT 0,
    "dataClasses" JSONB NOT NULL DEFAULT '[]',
    "isVerified" BOOLEAN NOT NULL DEFAULT TRUE,
    "fetchedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "breach_feed_added" ON "breach_feed" ("addedDate" DESC)`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sealedSettings" TEXT`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) await sequelize.query(statement);
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter these tables. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
