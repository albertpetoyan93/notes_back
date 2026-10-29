import sequelize from "../sequelize";

/**
 * Company admin recovery (E2E_DESIGN.md section 6, option 2): an opt-in
 * company policy. The company gets a recovery key pair; its private key is
 * sealed to each owner and admin ("company_recovery_keys"), and each member's
 * browser seals a copy of their user key to its public key
 * ("company_member_recovery"). An owner or admin can then set a temporary
 * master password for a member, who must choose their own at next sign-in.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "recoveryPublicKey" VARCHAR(64)`,
  `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "recoveryKeyVersion" INTEGER`,
  `CREATE TABLE IF NOT EXISTS "company_recovery_keys" (
    "id" SERIAL PRIMARY KEY,
    "companyId" INTEGER NOT NULL REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "keyVersion" INTEGER NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "company_recovery_keys_holder" ON "company_recovery_keys" ("companyId", "userId")`,
  `CREATE TABLE IF NOT EXISTS "company_member_recovery" (
    "id" SERIAL PRIMARY KEY,
    "companyId" INTEGER NOT NULL REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "keyVersion" INTEGER NOT NULL,
    "sealedUserKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "company_member_recovery_member" ON "company_member_recovery" ("companyId", "userId")`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mustChangeMasterPassword" BOOLEAN NOT NULL DEFAULT false`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot change the tables. As the owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
