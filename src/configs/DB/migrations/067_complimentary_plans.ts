import sequelize from "../sequelize";

/**
 * Free access given by 2keevo staff from the admin app (Premium or Family for a person,
 * Team for a company). It is a subscription row with status 'complimentary', no Stripe
 * ids, and an end date in "currentPeriodEnd" (there is no "forever").
 * grantedBy: the staff email that gave it, shown in the admin app.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grantedBy" VARCHAR(255)`,
  `CREATE INDEX IF NOT EXISTS "subscriptions_complimentary_end" ON "subscriptions" ("currentPeriodEnd") WHERE "status" = 'complimentary'`,
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
