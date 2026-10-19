import sequelize from "../sequelize";

/**
 * TOTP two-factor sign-in. The secret is stored encrypted, recovery codes as
 * sha256 hashes, and the last accepted time step so a code cannot be reused.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twoFactorSecret" TEXT`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twoFactorRecoveryCodes" JSONB`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twoFactorLastStep" BIGINT`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(
        `Database user cannot alter table users. As the table owner, run: ${STATEMENTS.join("; ")};`
      );
    }
    throw error;
  }
}
