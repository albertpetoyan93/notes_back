import sequelize from "../sequelize";

/**
 * End-to-end encryption, stage 10.2 (E2E_DESIGN.md): accounts that use a
 * master password. The server keeps only locked (wrapped) keys and the
 * Argon2 settings; the master password and the keys it opens never reach it.
 * For these accounts "password" holds a bcrypt hash of the derived sign-in key.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "e2eEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "e2eSince" TIMESTAMPTZ`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kdfSalt" VARCHAR(64)`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kdfParams" JSONB`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "protectedUserKey" TEXT`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "publicKey" VARCHAR(64)`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "protectedPrivateKey" TEXT`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recoveryProtectedUserKey" TEXT`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recoveryAuthHash" VARCHAR(100)`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter table users. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
