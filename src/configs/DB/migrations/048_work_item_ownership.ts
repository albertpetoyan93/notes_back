import { QueryTypes } from "sequelize";
import sequelize from "../sequelize";

/**
 * Company-owned work items + offboarding (docs/superpowers/plans/2026-11-04-work-item-ownership.md).
 * - notes.companyId: the one company that owns a work item (NULL = personal item).
 * - company_members: 'suspended' status, removedAt.
 * - company_offboardings / offboarding_tasks: one offboarding per person leaving, and its to-do list.
 * Backfill: a note in collections of exactly one company gets that company. Notes touching two or
 * more companies stay NULL (a person fixes them). Work items lose their personal-collection links,
 * and their creator's key copy once every collection holds its own.
 * ALTER TYPE ... ADD VALUE cannot run inside a transaction on older Postgres, so no transaction.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TYPE "enum_company_members_status" ADD VALUE IF NOT EXISTS 'suspended'`,
  `ALTER TABLE "company_members" ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMPTZ`,
  `ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "companyId" INTEGER REFERENCES "companies"(id) ON DELETE RESTRICT`,
  `CREATE INDEX IF NOT EXISTS "notes_company" ON "notes" ("companyId")`,
  `CREATE TABLE IF NOT EXISTS "company_offboardings" (
    id SERIAL PRIMARY KEY,
    "companyId" INTEGER NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
    "userId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "memberEmail" VARCHAR(255) NOT NULL,
    "startedBy" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'in_progress',
    "startedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "completedAt" TIMESTAMPTZ
  )`,
  // Two managers removing the same person at once end up with one open offboarding.
  `CREATE UNIQUE INDEX IF NOT EXISTS "company_offboardings_open"
    ON "company_offboardings" ("companyId", "userId") WHERE "status" = 'in_progress'`,
  `CREATE TABLE IF NOT EXISTS "offboarding_tasks" (
    id SERIAL PRIMARY KEY,
    "offboardingId" INTEGER NOT NULL REFERENCES "company_offboardings"(id) ON DELETE CASCADE,
    "kind" VARCHAR(30) NOT NULL DEFAULT 'rotate_credential',
    "noteId" INTEGER REFERENCES "notes"(id) ON DELETE SET NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "actorId" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "reference" VARCHAR(200),
    "note" VARCHAR(500),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "offboarding_tasks_status" ON "offboarding_tasks" ("offboardingId", "status")`,
];

// Every (note, company) pair, from the link table and the legacy notes.collectionId column.
const NOTE_COMPANIES = `
  SELECT cn."noteId" AS "noteId", c."companyId" AS "companyId"
    FROM "collection_notes" cn JOIN "collections" c ON c.id = cn."collectionId"
   WHERE c."companyId" IS NOT NULL
  UNION
  SELECT n.id, c."companyId"
    FROM "notes" n JOIN "collections" c ON c.id = n."collectionId"
   WHERE c."companyId" IS NOT NULL`;

// An end-to-end work item that still holds its creator's copy of the key.
const CREATOR_COPY = `n."e2e" = TRUE AND n."companyId" IS NOT NULL AND n."itemKey" IS NOT NULL`;

// The company collections a note is in (link table or legacy column).
const LINKED = `
  SELECT c.id, c."e2eKeyVersion" FROM "collections" c
   WHERE c."companyId" IS NOT NULL
     AND (c.id = n."collectionId"
          OR c.id IN (SELECT cn."collectionId" FROM "collection_notes" cn WHERE cn."noteId" = n.id))`;

// In at least one company collection, and each one holds a key copy at its current version.
const COVERED = `
  EXISTS (${LINKED})
  AND NOT EXISTS (
    SELECT 1 FROM (${LINKED}) linked
     WHERE NOT EXISTS (
       SELECT 1 FROM "item_keys" k
        WHERE k."noteId" = n.id AND k."containerType" = 'collection'
          AND k."containerId" = linked.id AND k."keyVersion" = linked."e2eKeyVersion"
     )
  )`;

export async function up() {
  for (const statement of STATEMENTS) await sequelize.query(statement);

  // Safe to run twice: only notes still without a company are touched.
  const [given] = await sequelize.query(
    `WITH pairs AS (${NOTE_COMPANIES}),
     single AS (
       SELECT "noteId", MIN("companyId") AS "companyId" FROM pairs
        GROUP BY "noteId" HAVING COUNT(DISTINCT "companyId") = 1
     )
     UPDATE "notes" n SET "companyId" = single."companyId"
       FROM single WHERE n.id = single."noteId" AND n."companyId" IS NULL
     RETURNING n.id`
  );
  console.log(`[048] notes given a companyId: ${given.length}`);

  const ambiguous = await sequelize.query<{ noteId: number }>(
    `WITH pairs AS (${NOTE_COMPANIES})
     SELECT "noteId" FROM pairs GROUP BY "noteId"
      HAVING COUNT(DISTINCT "companyId") >= 2 ORDER BY "noteId"`,
    { type: QueryTypes.SELECT }
  );
  console.log(
    `[048] notes left with companyId NULL (in 2+ companies, fix by hand): ${
      ambiguous.length ? ambiguous.map((r) => r.noteId).join(", ") : "none"
    }`
  );

  // A work item sits only in its company's collections: drop its personal-collection links.
  // Notes left with companyId NULL (2+ companies) are not touched; a person fixes those.
  const [removedLinks] = await sequelize.query(
    `DELETE FROM "collection_notes" cn
      USING "collections" c
      WHERE c.id = cn."collectionId" AND c."companyId" IS NULL
        AND cn."noteId" IN (SELECT id FROM "notes" WHERE "companyId" IS NOT NULL)
     RETURNING cn."noteId"`
  );
  // Same for the legacy column.
  const [removedLegacy] = await sequelize.query(
    `UPDATE "notes" n SET "collectionId" = NULL
       FROM "collections" c
      WHERE c.id = n."collectionId" AND c."companyId" IS NULL
        AND n."companyId" IS NOT NULL
     RETURNING n.id`
  );
  console.log(
    `[048] personal-collection links removed from work items: ${removedLinks.length + removedLegacy.length}`
  );

  // A work item opens through its collections: its creator's copy of the key goes, but only
  // where every company collection it is in holds a copy at that collection's current key version.
  const [dropped] = await sequelize.query(
    `UPDATE "notes" n SET "itemKey" = NULL WHERE ${CREATOR_COPY} AND ${COVERED} RETURNING n.id`
  );
  console.log(`[048] creator key copies removed from work items: ${dropped.length}`);
  // The rest keep theirs (without it nobody could open them) and are left as they are.
  const kept = await sequelize.query<{ id: number }>(
    `SELECT n.id FROM "notes" n WHERE ${CREATOR_COPY}`,
    { type: QueryTypes.SELECT }
  );
  console.log(`[048] work items keeping a creator key copy (a collection copy is missing): ${kept.length}`);
}
