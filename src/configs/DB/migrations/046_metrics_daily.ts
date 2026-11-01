import sequelize from "../sequelize";

/**
 * Admin app phase 2 — product analytics.
 * - metrics_daily: nightly snapshots for charts (DAU/WAU/MAU, signups, MRR, activation).
 * - user_sessions.extensionVersion: last reported extension build for that session.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "metrics_daily" (
    "date" DATE PRIMARY KEY,
    "signups" INTEGER NOT NULL DEFAULT 0,
    "dau" INTEGER NOT NULL DEFAULT 0,
    "wau" INTEGER NOT NULL DEFAULT 0,
    "mau" INTEGER NOT NULL DEFAULT 0,
    "paying" INTEGER NOT NULL DEFAULT 0,
    "trials" INTEGER NOT NULL DEFAULT 0,
    "mrrCents" INTEGER NOT NULL DEFAULT 0,
    "churned" INTEGER NOT NULL DEFAULT 0,
    "activatedFirstItem" INTEGER NOT NULL DEFAULT 0,
    "activatedExtension" INTEGER NOT NULL DEFAULT 0,
    "activatedAutofill" INTEGER NOT NULL DEFAULT 0,
    "mrrByPlan" JSONB NOT NULL DEFAULT '{"premium":0,"family":0,"team":0}',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "extensionVersion" VARCHAR(32)`,
];

export async function up() {
  for (const statement of STATEMENTS) await sequelize.query(statement);
}
