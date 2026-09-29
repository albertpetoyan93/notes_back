import sequelize from "../sequelize";

/** Favorites live in note_favorites, one row per user per note. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(
    `ALTER TABLE "notes" DROP COLUMN IF EXISTS "isFavorite"`
  );
}
