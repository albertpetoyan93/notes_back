import sequelize from "../sequelize";

/**
 * End-to-end encryption, stage 10.3 (E2E_DESIGN.md): personal items encrypted
 * in the browser. For an "e2e" item the server keeps only:
 * - "itemKey": the item's own key, wrapped with the owner's user key;
 * - "encData": title, notes, fields and tags, encrypted with the item key;
 * - "e2eId": a random id the ciphertext is bound to.
 * Category, dates and collections stay readable. Versions of these items hold
 * encrypted states too ("note_versions"."e2e").
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "e2e" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "e2eId" VARCHAR(32)`,
  `ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "itemKey" TEXT`,
  `ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "encData" TEXT`,
  `ALTER TABLE "note_versions" ADD COLUMN IF NOT EXISTS "e2e" BOOLEAN NOT NULL DEFAULT false`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter the notes tables. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
