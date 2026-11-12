import sequelize from "../sequelize";

/**
 * Vault recovery (ADR-001), final review C1: replacing the recovery key must not
 * make vaults nobody holds unrecoverable. Their recovery copies stay sealed to
 * the earlier key, and custodians who remain keep their copy of that earlier
 * key (one row per key version). Each vault copy records the public key it is
 * sealed to, which a custodian's browser needs to open it.
 */
export const useTransaction = false;

const STATEMENTS = [
  `DROP INDEX IF EXISTS "company_recovery_keys_holder"`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "company_recovery_keys_version" ON "company_recovery_keys" ("companyId", "userId", "keyVersion")`,
  `ALTER TABLE "company_vault_recovery" ADD COLUMN IF NOT EXISTS "recoveryPublicKey" VARCHAR(64)`,
  `UPDATE "company_vault_recovery" v SET "recoveryPublicKey" = c."recoveryPublicKey"
    FROM "companies" c
    WHERE c.id = v."companyId" AND v."recoveryPublicKey" IS NULL AND v."recoveryKeyVersion" = c."recoveryKeyVersion"`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter these tables. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
