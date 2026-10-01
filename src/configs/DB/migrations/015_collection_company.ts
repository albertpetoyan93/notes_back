import sequelize from "../sequelize";

/** A collection with companyId belongs to that company. Null stays personal. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    ALTER TABLE "collections"
      ADD COLUMN IF NOT EXISTS "companyId" INTEGER
      REFERENCES "companies" ("id") ON UPDATE CASCADE ON DELETE CASCADE;
  `);

  await sequelize.query(`DROP INDEX IF EXISTS "collections_user_name_unique";`);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "collections_personal_name_unique"
      ON "collections" ("userId", name)
      WHERE "companyId" IS NULL;
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "collections_company_name_unique"
      ON "collections" ("companyId", name)
      WHERE "companyId" IS NOT NULL;
  `);
}
