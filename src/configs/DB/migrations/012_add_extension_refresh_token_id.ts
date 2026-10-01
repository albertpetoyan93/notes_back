import sequelize from "../sequelize";

/** Separate refresh token for the browser extension, so it does not replace the website session. */
export const useTransaction = false;

const ADD_COLUMN = `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "extensionRefreshTokenId" VARCHAR(255)`;

export async function up() {
  const [rows] = await sequelize.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'users'
      AND column_name = 'extensionRefreshTokenId'
    LIMIT 1
  `);

  if ((rows as unknown[]).length > 0) {
    console.log("users.extensionRefreshTokenId already exists. Skipping.");
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
