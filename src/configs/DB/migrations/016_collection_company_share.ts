import sequelize from "../sequelize";

/** companyShare is view or edit when the collection is shared with every active member. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    ALTER TABLE "collections"
      ADD COLUMN IF NOT EXISTS "companyShare" VARCHAR(4);
  `);
}
