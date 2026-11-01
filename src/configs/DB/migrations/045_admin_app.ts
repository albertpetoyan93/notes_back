import sequelize from "../sequelize";

/**
 * Admin app (docs/superpowers/specs/2026-10-31-admin-app-design.md), phase 1.
 * - admin_staff: who may use the admin app and with which role.
 * - admin_actions: audit trail of staff actions. Emails are snapshots so rows outlive user changes.
 * - user_activity_days: one row per user per UTC day, flags for web / extension use.
 * - support_requests: staff-started requests the account owner must confirm (e.g. remove 2FA).
 * - users.suspendedAt: set while staff have suspended the account.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "admin_staff" (
    "userId" INTEGER PRIMARY KEY REFERENCES "users"(id) ON DELETE CASCADE,
    "role" VARCHAR(20) NOT NULL,
    "addedBy" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "disabledAt" TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS "admin_actions" (
    id BIGSERIAL PRIMARY KEY,
    "staffUserId" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "staffEmail" VARCHAR(255) NOT NULL,
    "role" VARCHAR(20),
    "action" VARCHAR(60) NOT NULL,
    "targetUserId" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "targetEmail" VARCHAR(255),
    "targetCompanyId" INTEGER REFERENCES "companies"(id) ON DELETE SET NULL,
    "reason" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip" VARCHAR(100),
    "userAgent" VARCHAR(500),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "admin_actions_created" ON "admin_actions" ("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "admin_actions_target" ON "admin_actions" ("targetUserId")`,
  `CREATE TABLE IF NOT EXISTS "user_activity_days" (
    "userId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "date" DATE NOT NULL,
    "web" BOOLEAN NOT NULL DEFAULT FALSE,
    "extension" BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY ("userId", "date")
  )`,
  `CREATE INDEX IF NOT EXISTS "user_activity_days_date" ON "user_activity_days" ("date")`,
  `CREATE TABLE IF NOT EXISTS "support_requests" (
    id SERIAL PRIMARY KEY,
    "kind" VARCHAR(30) NOT NULL,
    "userId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "requestedBy" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "support_requests_user_status" ON "support_requests" ("userId", "status")`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMPTZ`,
];

export async function up() {
  for (const statement of STATEMENTS) await sequelize.query(statement);
}
