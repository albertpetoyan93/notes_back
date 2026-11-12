import sequelize from "../sequelize";

/**
 * Vault recovery history (review M7): a recovery request stays on record when
 * the person who got access, or the vault, is deleted later. Their columns
 * become nullable and the foreign keys SET NULL instead of deleting the row.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "company_recovery_requests" ALTER COLUMN "granteeUserId" DROP NOT NULL`,
  `ALTER TABLE "company_recovery_requests" ALTER COLUMN "collectionId" DROP NOT NULL`,
  `ALTER TABLE "company_recovery_requests" DROP CONSTRAINT IF EXISTS "company_recovery_requests_granteeUserId_fkey"`,
  `ALTER TABLE "company_recovery_requests" ADD CONSTRAINT "company_recovery_requests_granteeUserId_fkey"
    FOREIGN KEY ("granteeUserId") REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE SET NULL`,
  `ALTER TABLE "company_recovery_requests" DROP CONSTRAINT IF EXISTS "company_recovery_requests_collectionId_fkey"`,
  `ALTER TABLE "company_recovery_requests" ADD CONSTRAINT "company_recovery_requests_collectionId_fkey"
    FOREIGN KEY ("collectionId") REFERENCES "collections" ("id") ON UPDATE CASCADE ON DELETE SET NULL`,
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
