import sequelize from "../sequelize";

/**
 * One-off product announcements to existing users (first one: "New: free breach alerts",
 * docs/plans/promotion.md, 24 Nov 2026).
 * announcement_sends: who already got which announcement, so batches over several days never
 *   send twice. users.productNews: product-news emails (on by default, off from the email's link).
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "announcement_sends" (
     "campaign" VARCHAR(64) NOT NULL,
     "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
     "sentAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY ("campaign", "userId")
   )`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "productNews" BOOLEAN NOT NULL DEFAULT TRUE`,
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
