import sequelize from "../sequelize";

/**
 * Breach alerts, phase 3 (docs/features/breach-alerts.md): an opt-in weekly email listing big
 * new breaches, the same for everyone who asked (the server can't know who is affected).
 * users.breachDigest: opted in (off by default). users.breachDigestAt: when the last one was sent.
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "breachDigest" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "breachDigestAt" TIMESTAMPTZ`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) await sequelize.query(statement);
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter these tables. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
