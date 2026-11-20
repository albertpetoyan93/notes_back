import sequelize from "../sequelize";

/**
 * Emergency access with its own key (plan 2026-11-20-emergency-key.md).
 *
 * - emergency_keys: one per owner. `wrappedKey` is the owner's emergency key,
 *   wrapped by their browser with their user key; `rotate` asks the owner's
 *   browser for a new one (access that had been granted ended).
 * - emergency_item_keys: each personal item's key wrapped with the emergency key.
 * - emergency_collection_names: each personal collection's name encrypted with it.
 * - emergency_contacts.sealedEmergencyKey: the emergency key sealed to the contact.
 *   It replaces `sealedUserKey`, which is cleared once the owner's browser upgrades the row.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "emergency_keys" (
    "userId" INTEGER PRIMARY KEY REFERENCES "users"(id) ON DELETE CASCADE,
    "keyVersion" INTEGER NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "rotate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS "emergency_item_keys" (
    id SERIAL PRIMARY KEY,
    "grantorId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "noteId" INTEGER NOT NULL REFERENCES "notes"(id) ON DELETE CASCADE,
    "keyVersion" INTEGER NOT NULL,
    "wrappedKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "emergency_item_keys_note_version" ON "emergency_item_keys" ("noteId", "keyVersion")`,
  `CREATE INDEX IF NOT EXISTS "emergency_item_keys_grantor" ON "emergency_item_keys" ("grantorId")`,
  `CREATE TABLE IF NOT EXISTS "emergency_collection_names" (
    id SERIAL PRIMARY KEY,
    "grantorId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "collectionId" INTEGER NOT NULL REFERENCES "collections"(id) ON DELETE CASCADE,
    "keyVersion" INTEGER NOT NULL,
    "encName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "emergency_collection_names_collection_version" ON "emergency_collection_names" ("collectionId", "keyVersion")`,
  `CREATE INDEX IF NOT EXISTS "emergency_collection_names_grantor" ON "emergency_collection_names" ("grantorId")`,
  `ALTER TABLE "emergency_contacts" ADD COLUMN IF NOT EXISTS "sealedEmergencyKey" TEXT`,
  `ALTER TABLE "emergency_contacts" ADD COLUMN IF NOT EXISTS "emergencyKeyVersion" INTEGER`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter these tables. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
