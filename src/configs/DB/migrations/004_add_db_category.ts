import { QueryInterface } from "sequelize";

async function enumHasLabel(queryInterface: QueryInterface, label: string) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1
     FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'enum_notes_category'
       AND e.enumlabel = :label
     LIMIT 1`,
    { replacements: { label } }
  );
  return (rows as unknown[]).length > 0;
}

export default {
  useTransaction: false,
  up: async (queryInterface: QueryInterface) => {
    if (await enumHasLabel(queryInterface, "db")) {
      console.log("Category db already exists. Skipping.");
      return;
    }

    try {
      await queryInterface.sequelize.query(`
        ALTER TYPE "enum_notes_category" ADD VALUE IF NOT EXISTS 'db';
      `);
    } catch (error: any) {
      if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
        throw new Error(
          `Database user cannot alter enum_notes_category. As the type owner, run: ALTER TYPE "enum_notes_category" ADD VALUE IF NOT EXISTS 'db';`
        );
      }
      throw error;
    }
  },

  down: async () => {
    console.log(
      "Cannot remove enum values in PostgreSQL without recreating the type"
    );
  },
};
