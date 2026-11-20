import sequelize from "../sequelize";

/**
 * Emergency access: the contact's public key as the owner checked it at confirm
 * time (or first saw it, for contacts confirmed before 058), encrypted by the
 * owner's browser with their user key. The owner's browser seals a new emergency
 * key only to that key, so a changed `users.publicKey` can't redirect it.
 */
export const useTransaction = false;

const STATEMENTS = [`ALTER TABLE "emergency_contacts" ADD COLUMN IF NOT EXISTS "pinnedKey" TEXT`];

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
