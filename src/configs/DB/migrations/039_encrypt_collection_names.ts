import sequelize from "../sequelize";

/**
 * Collection names encrypted in the browser (E2E_DESIGN.md, after stage 10.6).
 * "encName" is the name, encrypted; "nameKey" says with what: "user" (the
 * owner's user key: a collection only they can see) or "v<N>" (the collection
 * key of version N). While encrypted, "name" holds a unique placeholder (the
 * per-owner unique index needs one) that is never shown.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "encName" TEXT`,
  `ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "nameKey" VARCHAR(16)`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter collections. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
