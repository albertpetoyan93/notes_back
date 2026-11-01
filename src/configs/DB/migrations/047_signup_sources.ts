import sequelize from "../sequelize";

/**
 * Admin app phase 3 — marketing attribution.
 * signup_sources: where an account came from (first website visit's UTM tags, referrer,
 * landing path), written once at sign-up. Users without a row signed up untagged.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "signup_sources" (
    "userId" INTEGER PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
    "source" VARCHAR(100),
    "medium" VARCHAR(100),
    "campaign" VARCHAR(150),
    "content" VARCHAR(150),
    "referrerDomain" VARCHAR(255),
    "landingPath" VARCHAR(255),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export async function up() {
  for (const statement of STATEMENTS) await sequelize.query(statement);
}
