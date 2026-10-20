import sequelize from "../sequelize";

/**
 * Who did what, and when: sign-ins, item changes, shares, and secrets being
 * revealed or copied. Never stores secret values, only field names.
 */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "audit_events" (
      id BIGSERIAL PRIMARY KEY,
      "actorId" INTEGER REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
      "action" VARCHAR(50) NOT NULL,
      "noteId" INTEGER,
      "collectionId" INTEGER,
      "companyId" INTEGER,
      "targetUserId" INTEGER REFERENCES "users" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
      "details" JSONB NOT NULL DEFAULT '{}',
      "ip" VARCHAR(100),
      "userAgent" VARCHAR(500),
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // No foreign keys on note/collection/company: history outlives the item.
  for (const column of ["actorId", "noteId", "companyId"]) {
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS "audit_events_${column}"
        ON "audit_events" ("${column}", "createdAt" DESC);
    `);
  }
}
