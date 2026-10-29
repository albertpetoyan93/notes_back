import sequelize from "../sequelize";

/**
 * Plans and trials. A subscription belongs to one person (Premium, Family) or one
 * company (Team). Stripe columns stay empty until payments arrive (trials need no card).
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "subscriptions" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "companyId" INTEGER REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "plan" VARCHAR(20) NOT NULL,
      "interval" VARCHAR(10),
      "status" VARCHAR(20) NOT NULL,
      "seats" INTEGER,
      "trialEndsAt" TIMESTAMPTZ,
      "trialReminderSentAt" TIMESTAMPTZ,
      "currentPeriodEnd" TIMESTAMPTZ,
      "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT FALSE,
      "graceEndsAt" TIMESTAMPTZ,
      "stripeCustomerId" VARCHAR(255),
      "stripeSubscriptionId" VARCHAR(255) UNIQUE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "subscriptions_one_owner" CHECK (("userId" IS NULL) <> ("companyId" IS NULL))
    );
  `);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS "subscriptions_userId" ON "subscriptions" ("userId");`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS "subscriptions_companyId" ON "subscriptions" ("companyId");`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS "subscriptions_trialEndsAt" ON "subscriptions" ("trialEndsAt") WHERE "status" = 'trialing';`);

  // One trial per plan per person or company, kept even after the subscription row goes.
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "trials_used" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "companyId" INTEGER REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "plan" VARCHAR(20) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "trials_used_one_owner" CHECK (("userId" IS NULL) <> ("companyId" IS NULL))
    );
  `);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "trials_used_user_plan" ON "trials_used" ("userId", "plan") WHERE "userId" IS NOT NULL;`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "trials_used_company_plan" ON "trials_used" ("companyId", "plan") WHERE "companyId" IS NOT NULL;`);

  // Daily jobs: the day each last ran, claimed with one UPDATE so a job never runs twice.
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "job_runs" (
      "name" VARCHAR(100) PRIMARY KEY,
      "lastRunDay" DATE,
      "lastRunAt" TIMESTAMPTZ,
      "lastError" TEXT
    );
  `);
}
