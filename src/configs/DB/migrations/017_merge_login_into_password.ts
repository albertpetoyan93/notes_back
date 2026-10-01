import sequelize from "../sequelize";

/** Login and password are one category. Stored value stays password; the app label is Login. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(`
    UPDATE "notes"
    SET "category" = 'password'
    WHERE "category" = 'login'
  `);
}
