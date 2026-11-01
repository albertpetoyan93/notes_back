import sequelize from "../sequelize";

/**
 * Emergency access (plans/vault-features.md, phase A): a trusted contact can ask for
 * read-only access to someone's personal vault, and gets it if the owner doesn't refuse
 * within the waiting time they chose.
 * - emergency_contacts: one row per (owner, contact). `sealedUserKey` is the owner's user
 *   key sealed by the owner's browser to the contact's public key; the server hands it
 *   out only once access is granted.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "emergency_contacts" (
      id SERIAL PRIMARY KEY,
      "grantorId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
      "contactId" INTEGER REFERENCES "users"(id) ON DELETE CASCADE,
      "email" VARCHAR(255) NOT NULL,
      "waitDays" INTEGER NOT NULL DEFAULT 7,
      "status" VARCHAR(16) NOT NULL DEFAULT 'invited',
      "sealedUserKey" TEXT,
      "requestedAt" TIMESTAMPTZ,
      "grantedAt" TIMESTAMPTZ,
      "remindersSent" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "emergency_contacts_grantor_email" ON "emergency_contacts" ("grantorId", "email");`
  );
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS "emergency_contacts_contact" ON "emergency_contacts" ("contactId");`
  );
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS "emergency_contacts_requested" ON "emergency_contacts" ("status") WHERE "status" = 'requested';`
  );
}
