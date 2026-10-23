import sequelize from "../sequelize";

/**
 * Passkeys people use to sign in to 2keevo. Only the public key is stored:
 * the private key never leaves the person's device or their passkey provider.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "user_passkeys" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      "credentialId" VARCHAR(1024) NOT NULL UNIQUE,
      "publicKey" TEXT NOT NULL,
      "counter" BIGINT NOT NULL DEFAULT 0,
      "transports" JSONB NOT NULL DEFAULT '[]',
      "deviceType" VARCHAR(32),
      "backedUp" BOOLEAN NOT NULL DEFAULT FALSE,
      "name" VARCHAR(100) NOT NULL,
      "lastUsedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "user_passkeys_userId" ON "user_passkeys" ("userId");
  `);
}
