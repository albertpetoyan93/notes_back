import sequelize from "../sequelize";

/**
 * Auto-lock after idle time. Each user picks the idle minutes (0 = never).
 * A web session records the last real input from the person (mouse, keyboard,
 * touch, sent by the vault app) and whether it is locked; a locked session
 * can't read the vault until it is unlocked with the password or a passkey.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "autoLockMinutes" INTEGER NOT NULL DEFAULT 15`,
  `ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMPTZ`,
  `ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMPTZ`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(
        `Database user cannot alter these tables. As the table owner, run: ${STATEMENTS.join("; ")};`
      );
    }
    throw error;
  }
}
