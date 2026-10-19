import sequelize from "../sequelize";

/**
 * One row per signed-in device, so signing in on a second device no longer
 * signs the first one out. Only hashes of refresh-token ids are stored.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "user_sessions" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "kind" VARCHAR(20) NOT NULL DEFAULT 'web',
      "tokenHash" VARCHAR(64) NOT NULL,
      "previousTokenHash" VARCHAR(64),
      "rotatedAt" TIMESTAMPTZ,
      "userAgent" VARCHAR(500),
      "ip" VARCHAR(100),
      "lastUsedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "expiresAt" TIMESTAMPTZ NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "user_sessions_user_id" ON "user_sessions" ("userId");
  `);
}
