import sequelize from "../sequelize";

/**
 * The currency a paid subscription is billed in ("usd" or "eur"), copied from Stripe.
 * A Stripe customer stays in one currency, so a later checkout for the same person or
 * company reuses it, and the apps show prices in it. Null for trials and older rows.
 */
export const useTransaction = false;

const STATEMENTS = [`ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(3)`];

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
