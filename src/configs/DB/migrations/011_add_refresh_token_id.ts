import sequelize from "../sequelize";

/** Stores the current refresh-token id so a used refresh token cannot be reused. */
export const useTransaction = false;

const ADD_COLUMN = `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "refreshTokenId" VARCHAR(255)`;

export async function up() {
  const [rows] = await sequelize.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'refreshTokenId'
    LIMIT 1
  `);

  if ((rows as unknown[]).length > 0) {
    console.log("users.refreshTokenId already exists. Skipping.");
    return;
  }

  try {
    await sequelize.query(ADD_COLUMN);
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(
        `Database user cannot alter table users. As the table owner, run: ${ADD_COLUMN};`
      );
    }
    throw error;
  }
}
