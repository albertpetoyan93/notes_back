import sequelize from "../sequelize";

export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    DO $$ BEGIN
      CREATE TYPE "enum_collection_shares_permission" AS ENUM ('view', 'edit');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "collections" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "collections_user_name_unique"
      ON "collections" ("userId", name);
  `);

  await sequelize.query(`
    ALTER TABLE "notes"
      ADD COLUMN IF NOT EXISTS "collectionId" INTEGER
      REFERENCES "collections" ("id") ON UPDATE CASCADE ON DELETE SET NULL;
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "collection_shares" (
      id SERIAL PRIMARY KEY,
      "collectionId" INTEGER NOT NULL REFERENCES "collections" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "sharedByUserId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "sharedWithUserId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      permission "enum_collection_shares_permission" NOT NULL DEFAULT 'view',
      "expiresAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "collection_shares_collection_user_unique"
      ON "collection_shares" ("collectionId", "sharedWithUserId");
  `);

  await sequelize.query(`
    INSERT INTO "collections" ("userId", name, "createdAt", "updatedAt")
    SELECT "userId", btrim(project), NOW(), NOW()
    FROM "notes"
    WHERE project IS NOT NULL AND btrim(project) <> ''
    GROUP BY "userId", btrim(project)
    ON CONFLICT ("userId", name) DO NOTHING;
  `);

  await sequelize.query(`
    UPDATE "notes" AS n
    SET "collectionId" = c.id
    FROM "collections" AS c
    WHERE n."userId" = c."userId"
      AND btrim(n.project) = c.name
      AND n."collectionId" IS NULL
      AND n.project IS NOT NULL
      AND btrim(n.project) <> '';
  `);
}
