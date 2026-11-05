import sequelize from "../sequelize";

/**
 * Separate idle auto-lock for the browser extension. The vault app keeps
 * users.autoLockMinutes; the extension uses extensionAutoLockMinutes so a
 * person can keep the extension open longer while working in the browser.
 * Company maxIdleMinutes still caps both.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "extensionAutoLockMinutes" INTEGER NOT NULL DEFAULT 60`,
  // Existing accounts: keep today's shared behaviour until they change the extension setting.
  `UPDATE "users" SET "extensionAutoLockMinutes" = "autoLockMinutes" WHERE "extensionAutoLockMinutes" = 60 AND "autoLockMinutes" IS DISTINCT FROM 60`,
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
