import sequelize from "../sequelize";

/**
 * F15: a company invite link proves the invitee owns the address only when it
 * was emailed to them. Without email the inviter gets the link to pass on, so
 * it proves nothing. Existing invites count as not emailed (the person
 * confirms their address the usual way).
 */
export const useTransaction = false;

const STATEMENTS = [
  `ALTER TABLE "company_members" ADD COLUMN IF NOT EXISTS "inviteEmailed" BOOLEAN NOT NULL DEFAULT false`,
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
