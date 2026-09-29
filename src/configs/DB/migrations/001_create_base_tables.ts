import User from "../../../models/User";
import Note from "../../../models/Note";
import sequelize from "../sequelize";

/**
 * Create users and notes when the database is empty.
 * Does not alter tables that already exist.
 */
export const useTransaction = false;

export async function up() {
  const tables = await sequelize.getQueryInterface().showAllTables();
  const names = tables.map((table) => String(table));

  if (!names.includes("users")) {
    await User.sync();
    console.log("created users");
  }

  if (!names.includes("notes")) {
    await Note.sync();
    console.log("created notes");
  }
}
