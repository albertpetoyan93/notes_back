import sequelize from "../sequelize";

/** Stores the current refresh-token id so a used refresh token cannot be reused. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(
    `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "refreshTokenId" VARCHAR(255)`
  );
}
