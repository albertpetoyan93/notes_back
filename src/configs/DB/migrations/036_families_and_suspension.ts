import sequelize from "../sequelize";

/**
 * Phase 3 of billing: families, suspended companies, and which billing emails were sent.
 * - family_members: the people an organizer invited (by email) into their Family plan.
 *   One active family per person.
 * - collections.family: the organizer's one shared family collection.
 * - companies: when a company was suspended, how many removal warnings it got, and when
 *   it was marked for removal (nothing is deleted unless removal is switched on).
 * - subscriptions: renewal reminder and payment-failed email markers, so each is sent once.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "family_members" (
      id SERIAL PRIMARY KEY,
      "ownerId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
      "userId" INTEGER REFERENCES "users"(id) ON DELETE CASCADE,
      "email" VARCHAR(255) NOT NULL,
      "status" VARCHAR(16) NOT NULL DEFAULT 'invited',
      "expiresAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT "family_members_not_self" CHECK ("userId" IS NULL OR "userId" <> "ownerId")
    );
  `);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "family_members_owner_email" ON "family_members" ("ownerId", "email");`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "family_members_one_family" ON "family_members" ("userId") WHERE "status" = 'active';`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS "family_members_email" ON "family_members" ("email");`);

  await sequelize.query(`ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "family" BOOLEAN NOT NULL DEFAULT FALSE;`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "collections_one_family" ON "collections" ("userId") WHERE "family" = TRUE;`);

  await sequelize.query(`ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMPTZ;`);
  await sequelize.query(`ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "removalWarnings" INTEGER NOT NULL DEFAULT 0;`);
  await sequelize.query(`ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "markedForRemovalAt" TIMESTAMPTZ;`);

  await sequelize.query(`ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "renewalReminderSentAt" TIMESTAMPTZ;`);
  await sequelize.query(`ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "paymentFailedEmailedAt" TIMESTAMPTZ;`);
}
