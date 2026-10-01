import sequelize from "../sequelize";

/** Invites expire. Active members keep a null expiresAt. */
export const useTransaction = false;

const ADD_COLUMN = `ALTER TABLE "company_members" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ`;

export async function up() {
  const [rows] = await sequelize.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'company_members'
      AND column_name = 'expiresAt'
    LIMIT 1
  `);

  if ((rows as unknown[]).length > 0) {
    console.log("company_members.expiresAt already exists. Skipping.");
    return;
  }

  try {
    await sequelize.query(ADD_COLUMN);
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(
        `Database user cannot alter table company_members. As the table owner, run: ${ADD_COLUMN};`
      );
    }
    throw error;
  }
}
