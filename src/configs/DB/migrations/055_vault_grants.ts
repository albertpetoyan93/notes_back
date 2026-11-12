import sequelize from "../sequelize";

/**
 * ADR-002 phase 1: owners and admins open company vaults through grants, not
 * by role. A grant stays a collection_shares row with two new columns:
 * "manages" (a vault manager: shares the vault and hands its key on) and
 * "source" (direct, admin_legacy, self, recovery).
 *
 * Nothing is narrowed: every active owner/admin of a company (any status) gets an
 * "admin_legacy" edit + manager grant on each of its vaults (an existing share
 * is raised to edit + manager, keeping its source and losing any expiry).
 */
export const useTransaction = false;

const COLUMNS = [
  `ALTER TABLE "collection_shares" ADD COLUMN IF NOT EXISTS "manages" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "collection_shares" ADD COLUMN IF NOT EXISTS "source" VARCHAR(20) NOT NULL DEFAULT 'direct'`,
  // What an existing share was before it was raised for an admin, put back if they're made member.
  `ALTER TABLE "collection_shares" ADD COLUMN IF NOT EXISTS "priorPermission" VARCHAR(10)`,
  `ALTER TABLE "collection_shares" ADD COLUMN IF NOT EXISTS "priorManages" BOOLEAN`,
];

// Active owners/admins of every company (also suspended ones: a grant opens nothing until the
// company is active again, and then their access must still be there), against each of its vaults.
const ADMINS_BY_VAULT = `
  SELECT c."id" AS "collectionId", m."userId" AS "userId"
  FROM "collections" c
  JOIN "company_members" m ON m."companyId" = c."companyId"
   AND m."status" = 'active' AND m."role" IN ('owner', 'admin') AND m."userId" IS NOT NULL
  WHERE c."companyId" IS NOT NULL`;

const BACKFILL = [
  `UPDATE "collection_shares" s
      SET "priorPermission" = CASE WHEN s."source" <> 'admin_legacy' AND s."priorPermission" IS NULL THEN s."permission"::text ELSE s."priorPermission" END,
          "priorManages" = CASE WHEN s."source" <> 'admin_legacy' AND s."priorPermission" IS NULL THEN s."manages" ELSE s."priorManages" END,
          "permission" = 'edit', "manages" = true, "expiresAt" = NULL, "updatedAt" = NOW()
     FROM (${ADMINS_BY_VAULT}) a
    WHERE s."collectionId" = a."collectionId" AND s."sharedWithUserId" = a."userId"`,
  `INSERT INTO "collection_shares"
          ("collectionId", "sharedByUserId", "sharedWithUserId", "permission", "expiresAt", "manages", "source", "createdAt", "updatedAt")
   SELECT a."collectionId", a."userId", a."userId", 'edit', NULL, true, 'admin_legacy', NOW(), NOW()
     FROM (${ADMINS_BY_VAULT}) a
    WHERE NOT EXISTS (
      SELECT 1 FROM "collection_shares" s
       WHERE s."collectionId" = a."collectionId" AND s."sharedWithUserId" = a."userId")
   ON CONFLICT ("collectionId", "sharedWithUserId") DO NOTHING`,
];

export async function up() {
  try {
    for (const statement of COLUMNS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter these tables. As the table owner, run: ${COLUMNS.join("; ")};`);
    }
    throw error;
  }
  await sequelize.transaction(async (transaction) => {
    for (const statement of BACKFILL) {
      await sequelize.query(statement, { transaction });
    }
  });
}
