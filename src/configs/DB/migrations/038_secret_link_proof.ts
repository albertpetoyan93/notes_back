import sequelize from "../sequelize";

/**
 * One-time links with a passphrase: the server checks it instead of the page.
 * "proofHash" is a SHA-256 of a proof the browser makes from the passphrase
 * and the key in the link, so it can't be guessed against without the link;
 * "failedAttempts" counts wrong passphrases (5 destroy the link). Links made
 * before this keep their "check" until they expire (7 days at most).
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "secret_links" ADD COLUMN IF NOT EXISTS "proofHash" VARCHAR(64)`,
  `ALTER TABLE "secret_links" ADD COLUMN IF NOT EXISTS "failedAttempts" INTEGER NOT NULL DEFAULT 0`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter secret_links. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
