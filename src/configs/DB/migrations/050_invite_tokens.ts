import sequelize from "../sequelize";

/**
 * Invitations bound to the right person (F15). Accepting a company invite now
 * needs the single-use token from the invite email, so only someone who can read
 * that inbox can join (there is no email verification on sign-up). Only the
 * token's SHA-256 hash is stored; re-inviting replaces it, accepting clears it.
 * Invites made before this have no hash and need to be sent again.
 */
export const useTransaction = false;

const STATEMENTS = [`ALTER TABLE "company_members" ADD COLUMN IF NOT EXISTS "inviteTokenHash" VARCHAR(64)`];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(
        `Database user cannot alter these tables. As the table owner, run: ${STATEMENTS.join("; ")};`
      );
    }
    throw error;
  }
}
