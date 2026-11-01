import sequelize from "../sequelize";

/**
 * Groups in companies (plans/vault-features.md, phase B).
 * - company_groups: named groups of members ("Engineering"). Names are readable by the
 *   server, like company names and member emails.
 * - company_group_members: who is in each group (by user; only active members count).
 * - collection_group_shares: a company collection shared with a group, view or edit.
 * - group_requests: a member asking to join a group; an owner or admin decides.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "company_groups" (
    id SERIAL PRIMARY KEY,
    "companyId" INTEGER NOT NULL REFERENCES "companies"(id) ON DELETE CASCADE,
    "name" VARCHAR(80) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "company_groups_name" ON "company_groups" ("companyId", LOWER("name"))`,
  `CREATE TABLE IF NOT EXISTS "company_group_members" (
    "groupId" INTEGER NOT NULL REFERENCES "company_groups"(id) ON DELETE CASCADE,
    "userId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "addedBy" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("groupId", "userId")
  )`,
  `CREATE INDEX IF NOT EXISTS "company_group_members_user" ON "company_group_members" ("userId")`,
  `CREATE TABLE IF NOT EXISTS "collection_group_shares" (
    "collectionId" INTEGER NOT NULL REFERENCES "collections"(id) ON DELETE CASCADE,
    "groupId" INTEGER NOT NULL REFERENCES "company_groups"(id) ON DELETE CASCADE,
    "permission" VARCHAR(8) NOT NULL DEFAULT 'view',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("collectionId", "groupId")
  )`,
  `CREATE INDEX IF NOT EXISTS "collection_group_shares_group" ON "collection_group_shares" ("groupId")`,
  `CREATE TABLE IF NOT EXISTS "group_requests" (
    id SERIAL PRIMARY KEY,
    "groupId" INTEGER NOT NULL REFERENCES "company_groups"(id) ON DELETE CASCADE,
    "userId" INTEGER NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
    "note" VARCHAR(500),
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "decidedBy" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "decidedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "group_requests_one_open" ON "group_requests" ("groupId", "userId") WHERE "status" = 'open'`,
];

export async function up() {
  for (const statement of STATEMENTS) await sequelize.query(statement);
}
