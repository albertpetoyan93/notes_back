import sequelize from "../sequelize";

/**
 * Version history: every save keeps a copy of the item as it was saved.
 * Content is encrypted like items are; saved passkeys are left out (restoring
 * keeps the item's current ones). Old versions are pruned on each save.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "note_versions" (
      id SERIAL PRIMARY KEY,
      "noteId" INTEGER NOT NULL REFERENCES "notes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "title" VARCHAR(255) NOT NULL,
      "category" VARCHAR(50) NOT NULL,
      "tags" JSONB NOT NULL DEFAULT '[]',
      "content" TEXT NOT NULL,
      "changes" JSONB NOT NULL DEFAULT '[]',
      "changedBy" INTEGER REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "note_versions_note_created"
      ON "note_versions" ("noteId", "createdAt" DESC);
  `);
}
