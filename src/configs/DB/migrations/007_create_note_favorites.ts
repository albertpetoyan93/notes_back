import sequelize from "../sequelize";

/** One favorite flag per user per note, including notes shared with them. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "note_favorites" (
      id SERIAL PRIMARY KEY,
      "noteId" INTEGER NOT NULL REFERENCES "notes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "note_favorites_note_user_unique"
      ON "note_favorites" ("noteId", "userId");
  `);

  // Copy the old per-note flag. A new database never had that column.
  const [rows] = await sequelize.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'notes'
      AND column_name = 'isFavorite'
    LIMIT 1
  `);
  if ((rows as unknown[]).length === 0) return;

  await sequelize.query(`
    INSERT INTO "note_favorites" ("noteId", "userId", "createdAt", "updatedAt")
    SELECT id, "userId", NOW(), NOW()
    FROM "notes"
    WHERE "isFavorite" = true
    ON CONFLICT ("noteId", "userId") DO NOTHING;
  `);
}
