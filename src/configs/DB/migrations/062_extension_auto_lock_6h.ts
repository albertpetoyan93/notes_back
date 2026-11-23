import sequelize from "../sequelize";

/**
 * The browser extension now locks after 6 hours without activity by default
 * (it was 1 hour). Accounts still on the old default move to 6 hours; anyone
 * who picked an extension lock time themselves (an auto_lock_changed audit
 * event with extensionMinutes) keeps it. Company maxIdleMinutes still caps it.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "users" ALTER COLUMN "extensionAutoLockMinutes" SET DEFAULT 360`,
  `UPDATE "users" SET "extensionAutoLockMinutes" = 360
     WHERE "extensionAutoLockMinutes" = 60
       AND NOT EXISTS (
         SELECT 1 FROM "audit_events"
          WHERE "audit_events"."actorId" = "users"."id"
            AND "audit_events"."action" = 'auto_lock_changed'
            AND "audit_events"."details" ? 'extensionMinutes'
       )`,
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
