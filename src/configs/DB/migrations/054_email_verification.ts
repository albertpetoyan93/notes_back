import sequelize from "../sequelize";

/**
 * Email verification (F15): an account proves it owns its address before the
 * address gives it anything (invites, being found for sharing). Single-use
 * link, only its SHA-256 hash stored, 24 h. Accounts that existed before this
 * count as confirmed (from when they were created), so nobody is locked out.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMPTZ`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifyTokenHash" VARCHAR(64)`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifyExpires" TIMESTAMPTZ`,
  `UPDATE "users" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL AND "emailVerifyTokenHash" IS NULL`,
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
