import sequelize from "../sequelize";

/** Companies are optional. Personal notes stay on the user. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    DO $$ BEGIN
      CREATE TYPE "enum_companies_status" AS ENUM ('active', 'suspended');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await sequelize.query(`
    DO $$ BEGIN
      CREATE TYPE "enum_company_members_role" AS ENUM ('owner', 'admin', 'member');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await sequelize.query(`
    DO $$ BEGIN
      CREATE TYPE "enum_company_members_status" AS ENUM ('invited', 'active', 'removed');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "companies" (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      status "enum_companies_status" NOT NULL DEFAULT 'active',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "company_members" (
      id SERIAL PRIMARY KEY,
      "companyId" INTEGER NOT NULL REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "userId" INTEGER REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      role "enum_company_members_role" NOT NULL,
      status "enum_company_members_status" NOT NULL DEFAULT 'invited',
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "company_members_company_email_unique"
      ON "company_members" ("companyId", email);
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "company_members_company_user_unique"
      ON "company_members" ("companyId", "userId")
      WHERE "userId" IS NOT NULL;
  `);

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "company_members_user_idx"
      ON "company_members" ("userId")
      WHERE "userId" IS NOT NULL;
  `);
}
