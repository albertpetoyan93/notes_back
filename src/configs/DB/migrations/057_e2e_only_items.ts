import { QueryTypes } from "sequelize";
import sequelize from "../sequelize";

/**
 * Stage 10.6: the server no longer encrypts or decrypts items. End-to-end items
 * still hold an empty placeholder the server used to encrypt (`content`) and blank
 * readable fields; they're cleared here so nothing server-encrypted is left.
 *
 * Refuses to run while any readable item or version exists (trashed ones too):
 * once the decrypt path is gone those could never be opened again. Turn
 * encryption on for those accounts, or delete the items, then run it again.
 */
export const useTransaction = false;

const count = async (sql: string) => {
  const rows = (await sequelize.query(sql, { type: QueryTypes.SELECT })) as { count: string | number }[];
  return Number(rows[0]?.count || 0);
};

export async function up() {
  const items = await count(`SELECT COUNT(*) AS count FROM "notes" WHERE "e2e" IS NOT TRUE`);
  const versions = await count(`SELECT COUNT(*) AS count FROM "note_versions" WHERE "e2e" IS NOT TRUE`);
  if (items || versions) {
    throw new Error(
      `${items} items and ${versions} versions are still readable (not end-to-end). ` +
        "Turn encryption on for their accounts or delete them (npm run e2e:status lists them), then run the migration again."
    );
  }
  await sequelize.query(
    `UPDATE "notes" SET "content" = '{}'::jsonb, "title" = '', "comment" = '', "project" = NULL, "tags" = '[]'::json
     WHERE "e2e" = true`
  );
}
