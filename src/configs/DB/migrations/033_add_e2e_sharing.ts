import sequelize from "../sequelize";

/**
 * End-to-end encryption, stage 10.4 (E2E_DESIGN.md): shared items and collections.
 *
 * - "item_keys": an item's key for one more way in. For a person (a direct
 *   share) it's sealed to their public key; for a collection it's wrapped with
 *   the collection key of that version.
 * - "collection_keys": a collection's key, sealed to each person who may open
 *   it, per key version. A new version replaces the old after someone loses access.
 * - "collections"."e2eKeyVersion": null while the collection is readable.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "item_keys" (
    "id" SERIAL PRIMARY KEY,
    "noteId" INTEGER NOT NULL REFERENCES "notes" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "containerType" VARCHAR(16) NOT NULL,
    "containerId" INTEGER NOT NULL,
    "keyVersion" INTEGER,
    "wrappedKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "item_keys_container" ON "item_keys" ("noteId", "containerType", "containerId")`,
  `CREATE INDEX IF NOT EXISTS "item_keys_lookup" ON "item_keys" ("containerType", "containerId")`,
  `CREATE TABLE IF NOT EXISTS "collection_keys" (
    "id" SERIAL PRIMARY KEY,
    "collectionId" INTEGER NOT NULL REFERENCES "collections" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "userId" INTEGER NOT NULL REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    "keyVersion" INTEGER NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "grantedBy" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "collection_keys_holder" ON "collection_keys" ("collectionId", "userId")`,
  `ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "e2eKeyVersion" INTEGER`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot change the tables. As the owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
