import sequelize from "../sequelize";

/**
 * Encrypted file attachments (plans/vault-features.md, phase C).
 * - attachments: one row per file. The file itself is in object storage (StorageService),
 *   encrypted in the browser; `wrappedKey` is the file's key wrapped with the item's key and
 *   `encMeta` its name and type, encrypted. `size` is the stored (encrypted) size.
 *   `ownerUserId` / `companyId` say whose storage it counts against.
 *   `noteId` becomes NULL when the item is deleted for good; the daily cleanup then removes
 *   the stored file and the row.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "attachments" (
    id VARCHAR(32) PRIMARY KEY,
    "noteId" INTEGER REFERENCES "notes"(id) ON DELETE SET NULL,
    "uploadedBy" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "ownerUserId" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "companyId" INTEGER REFERENCES "companies"(id) ON DELETE SET NULL,
    "size" BIGINT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'uploading',
    "encMeta" TEXT,
    "wrappedKey" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "attachments_note" ON "attachments" ("noteId")`,
  `CREATE INDEX IF NOT EXISTS "attachments_owner" ON "attachments" ("ownerUserId")`,
  `CREATE INDEX IF NOT EXISTS "attachments_company" ON "attachments" ("companyId")`,
];

export async function up() {
  for (const statement of STATEMENTS) await sequelize.query(statement);
}
