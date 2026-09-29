import sequelize from "../sequelize";

export const useTransaction = false;

export async function up() {
  await sequelize.query(
    `ALTER TABLE "note_shares" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ`
  );

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "notifications" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "noteId" INTEGER REFERENCES "notes" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
      message VARCHAR(500) NOT NULL,
      "readAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
