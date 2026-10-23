import sequelize from "../sequelize";

/**
 * Company security policies, set by owners and admins: require 2FA, a minimum
 * password length for company logins, a maximum sign-in age and a maximum
 * idle time before auto-lock. Stored as JSON: {} means no policies.
 */
export const useTransaction = false;

const STATEMENT = `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "policies" JSONB NOT NULL DEFAULT '{}'`;

export async function up() {
  try {
    await sequelize.query(STATEMENT);
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter table companies. As the table owner, run: ${STATEMENT};`);
    }
    throw error;
  }
}
