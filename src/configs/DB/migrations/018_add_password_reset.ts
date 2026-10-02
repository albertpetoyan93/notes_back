import sequelize from "../sequelize";

/** One active password-reset token per user. Only the hash is stored. */
export const useTransaction = false;

const ADD_HASH = `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordResetTokenHash" VARCHAR(64)`;
const ADD_EXPIRES = `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordResetExpires" TIMESTAMPTZ`;

export async function up() {
  try {
    await sequelize.query(ADD_HASH);
    await sequelize.query(ADD_EXPIRES);
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(
        `Database user cannot alter table users. As the table owner, run: ${ADD_HASH}; ${ADD_EXPIRES};`
      );
    }
    throw error;
  }
}
