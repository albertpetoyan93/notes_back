import { QueryInterface } from "sequelize";

export default {
  up: async (queryInterface: QueryInterface) => {
    // Add new value to enum by altering the column
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_notes_category" ADD VALUE IF NOT EXISTS 'db';
    `);
  },

  down: async (queryInterface: QueryInterface) => {
    // Note: PostgreSQL doesn't support removing enum values directly
    // You would need to recreate the enum type to remove a value
    console.log(
      "Cannot remove enum values in PostgreSQL without recreating the type"
    );
  },
};
