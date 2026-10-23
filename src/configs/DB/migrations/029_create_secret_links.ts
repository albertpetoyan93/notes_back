import sequelize from "../sequelize";

/**
 * One-time secret links. The browser encrypts the secret; the key lives only
 * in the link's #fragment, which never reaches the server. Stored here:
 * ciphertext (wiped when the last view is used), the IV, and with a passphrase
 * its salt and a small check value, so a wrong passphrase doesn't use a view.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "secret_links" (
      "id" VARCHAR(32) PRIMARY KEY,
      "ciphertext" TEXT,
      "iv" VARCHAR(32) NOT NULL,
      "salt" VARCHAR(64),
      "check" TEXT,
      "label" TEXT,
      "maxViews" INTEGER NOT NULL DEFAULT 1,
      "viewCount" INTEGER NOT NULL DEFAULT 0,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      "revokedAt" TIMESTAMPTZ,
      "openedAt" TIMESTAMPTZ,
      "createdBy" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "noteId" INTEGER REFERENCES "notes" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "secret_links_creator" ON "secret_links" ("createdBy", "createdAt" DESC);
  `);
}
