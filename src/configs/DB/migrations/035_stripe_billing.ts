import sequelize from "../sequelize";

/**
 * Stripe: the customer that pays (a person or a company), and every webhook event
 * received, so each one is handled once. Only ids and outcomes are kept, not payloads
 * (they hold names, emails and addresses).
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripeCustomerId" VARCHAR(255);`);
  await sequelize.query(`ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "stripeCustomerId" VARCHAR(255);`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "users_stripeCustomerId" ON "users" ("stripeCustomerId") WHERE "stripeCustomerId" IS NOT NULL;`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "companies_stripeCustomerId" ON "companies" ("stripeCustomerId") WHERE "stripeCustomerId" IS NOT NULL;`);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "billing_events" (
      id SERIAL PRIMARY KEY,
      "stripeEventId" VARCHAR(255) NOT NULL UNIQUE,
      "type" VARCHAR(100) NOT NULL,
      "objectId" VARCHAR(255),
      "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "processedAt" TIMESTAMPTZ,
      "error" TEXT
    );
  `);
}
