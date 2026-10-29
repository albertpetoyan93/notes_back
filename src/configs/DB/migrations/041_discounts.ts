import sequelize from "../sequelize";

/**
 * Phase 4 of billing: 50% off Team for nonprofits and schools.
 * - discount_requests: what a company owner sent in, and what 2keevo decided.
 *   One open request per company.
 * - companies.discount: the discount a company has now ('nonprofit' or 'school'), if any.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "discount_requests" (
      id SERIAL PRIMARY KEY,
      "companyId" INTEGER NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
      "userId" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
      "kind" VARCHAR(16) NOT NULL,
      "organization" VARCHAR(200) NOT NULL,
      "website" VARCHAR(255),
      "note" TEXT,
      "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
      "decidedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "discount_requests_one_open" ON "discount_requests" ("companyId") WHERE "status" = 'pending';`
  );
  await sequelize.query(`ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "discount" VARCHAR(16);`);
}
