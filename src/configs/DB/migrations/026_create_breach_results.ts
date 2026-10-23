import sequelize from "../sequelize";

/**
 * Results of the leaked-password check, one row per login. The check runs in
 * the browser against Have I Been Pwned; only the outcome is stored here:
 * how many times the password appeared in leaks, and when it was checked.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "breach_results" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "noteId" INTEGER NOT NULL REFERENCES "notes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "count" INTEGER NOT NULL DEFAULT 0,
      "checkedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "breach_results_user_note"
      ON "breach_results" ("userId", "noteId");
  `);
}
