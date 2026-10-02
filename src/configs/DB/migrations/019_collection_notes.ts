import sequelize from "../sequelize";

export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "collection_notes" (
      id SERIAL PRIMARY KEY,
      "collectionId" INTEGER NOT NULL REFERENCES "collections" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "noteId" INTEGER NOT NULL REFERENCES "notes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "collection_notes_collection_note_unique"
      ON "collection_notes" ("collectionId", "noteId");
  `);

  await sequelize.query(`
    INSERT INTO "collection_notes" ("collectionId", "noteId", "createdAt", "updatedAt")
    SELECT "collectionId", id, NOW(), NOW()
    FROM "notes"
    WHERE "collectionId" IS NOT NULL
    ON CONFLICT ("collectionId", "noteId") DO NOTHING;
  `);
}
