import sequelize from "../sequelize";

/**
 * Vault recovery (ADR-001 option A, docs/superpowers/plans/2026-11-10-vault-recovery.md).
 * Company recovery no longer holds members' user keys (which also opened their
 * personal items): each company collection key is sealed to the company
 * recovery key instead, whose private part only named custodians hold.
 * - company_recovery_custodians: who holds the recovery key (owners/admins).
 * - company_vault_recovery: one collection key per collection, sealed to the recovery key.
 * - company_recovery_requests: request → second custodian's approval → waiting period → done.
 * - companies.recoveryWaitHours: the waiting period (0, 24, 48 or 72; default 24).
 * Existing key holders become the custodians. Members whose user key was held are told
 * once, then company_member_recovery is dropped.
 */
export const useTransaction = false;

const NOTICE =
  "Your company can no longer reset your master password. Keep your recovery key safe: it is the only way back if you forget it.";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "company_recovery_custodians" (
    "id" SERIAL PRIMARY KEY,
    "companyId" INTEGER NOT NULL REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "addedBy" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "company_recovery_custodians_one" ON "company_recovery_custodians" ("companyId", "userId")`,
  `CREATE TABLE IF NOT EXISTS "company_vault_recovery" (
    "id" SERIAL PRIMARY KEY,
    "companyId" INTEGER NOT NULL REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "collectionId" INTEGER NOT NULL REFERENCES "collections" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "keyVersion" INTEGER NOT NULL,
    "recoveryKeyVersion" INTEGER NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "company_vault_recovery_collection" ON "company_vault_recovery" ("collectionId")`,
  `CREATE TABLE IF NOT EXISTS "company_recovery_requests" (
    "id" SERIAL PRIMARY KEY,
    "companyId" INTEGER NOT NULL REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "collectionId" INTEGER NOT NULL REFERENCES "collections" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "granteeUserId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "permission" VARCHAR(10) NOT NULL DEFAULT 'view',
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "requestedBy" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL,
    "approvedBy" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL,
    "approvedAt" TIMESTAMPTZ,
    "availableAt" TIMESTAMPTZ NOT NULL,
    "completedBy" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL,
    "completedAt" TIMESTAMPTZ,
    "cancelledBy" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "company_recovery_requests_company" ON "company_recovery_requests" ("companyId", "status")`,
  `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "recoveryWaitHours" INTEGER NOT NULL DEFAULT 24`,
  // Today every owner and admin holding the key: they stay custodians; the owner can narrow it.
  `INSERT INTO "company_recovery_custodians" ("companyId", "userId", "createdAt", "updatedAt")
    SELECT "companyId", "userId", NOW(), NOW() FROM "company_recovery_keys"
    ON CONFLICT DO NOTHING`,
];

// Only while the old table still exists (the migration may run twice).
const NOTIFY_AND_DROP = [
  `INSERT INTO "notifications" ("userId", "message", "createdAt", "updatedAt")
    SELECT DISTINCT "userId", '${NOTICE.replace(/'/g, "''")}', NOW(), NOW() FROM "company_member_recovery"`,
  `DROP TABLE "company_member_recovery"`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
    const [rows] = await sequelize.query(`SELECT to_regclass('public.company_member_recovery') AS "table"`);
    if ((rows as { table: string | null }[])[0]?.table) {
      // Together: a failed drop must not leave members notified twice on the next run.
      await sequelize.transaction(async (transaction) => {
        for (const statement of NOTIFY_AND_DROP) {
          await sequelize.query(statement, { transaction });
        }
      });
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(
        `Database user cannot alter these tables. As the table owner, run: ${[...STATEMENTS, ...NOTIFY_AND_DROP].join("; ")};`
      );
    }
    throw error;
  }
}
