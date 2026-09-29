import sequelize from "../sequelize";

/** Soft-delete column used by Sequelize paranoid mode. */
export const useTransaction = false;

export async function up() {
  await sequelize.query(
    `ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ`
  );
}
