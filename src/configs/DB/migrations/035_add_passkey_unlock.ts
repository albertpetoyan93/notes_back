import sequelize from "../sequelize";

/**
 * End-to-end encryption, stage 10.2b (E2E_DESIGN.md): unlock with a passkey.
 * A passkey that supports the WebAuthn PRF extension gives the browser a
 * secret; the user key, wrapped with a key made from that secret, is kept
 * here per passkey. Only that passkey can open it.
 */
export const useTransaction = false;

const STATEMENTS = [`ALTER TABLE "user_passkeys" ADD COLUMN IF NOT EXISTS "prfUserKey" TEXT`];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter user_passkeys. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
