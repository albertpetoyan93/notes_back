import { QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import { decrypt, encrypt, isEncryptedValue, needsReencrypt } from "./encryption";

export interface ReencryptReport {
  secretsRekeyed: number;
  labelsRekeyed: number;
  failed: string[];
}

/**
 * Bring what the server still encrypts onto the current ENCRYPTION_KEY: 2FA
 * secrets and secret-link labels. Items aren't here: since stage 10.6 they're
 * sealed in the browser and the server never holds their keys.
 * Rows that no configured key can open are left as they are and reported.
 */
export async function reencryptAll(): Promise<ReencryptReport> {
  const report: ReencryptReport = { secretsRekeyed: 0, labelsRekeyed: 0, failed: [] };

  await sequelize.transaction(async (transaction) => {
    const users = await sequelize.query<{ id: number; secret: string }>(
      `SELECT id, "twoFactorSecret" AS secret FROM "users" WHERE "twoFactorSecret" IS NOT NULL`,
      { type: QueryTypes.SELECT, transaction }
    );
    for (const user of users || []) {
      if (!isEncryptedValue(user.secret) || !needsReencrypt(user.secret)) continue;
      try {
        await sequelize.query(`UPDATE "users" SET "twoFactorSecret" = :secret WHERE id = :id`, {
          replacements: { id: user.id, secret: encrypt(decrypt(user.secret)) },
          transaction,
        });
        report.secretsRekeyed += 1;
      } catch {
        report.failed.push(`2FA secret of user ${user.id}`);
      }
    }

    // Migration 023 runs this before secret_links exists (029) on a fresh database.
    const [table] = await sequelize.query<{ exists: boolean }>(
      `SELECT to_regclass('public.secret_links') IS NOT NULL AS exists`,
      { type: QueryTypes.SELECT, transaction }
    );
    const links = table?.exists
      ? await sequelize.query<{ id: string; label: string }>(
          `SELECT id, label FROM "secret_links" WHERE label IS NOT NULL`,
          { type: QueryTypes.SELECT, transaction }
        )
      : [];
    for (const link of links || []) {
      if (!isEncryptedValue(link.label) || !needsReencrypt(link.label)) continue;
      try {
        await sequelize.query(`UPDATE "secret_links" SET label = :label WHERE id = :id`, {
          replacements: { id: link.id, label: encrypt(decrypt(link.label)) },
          transaction,
        });
        report.labelsRekeyed += 1;
      } catch {
        report.failed.push(`label of secret link ${link.id}`);
      }
    }
  });

  return report;
}

export function describeReport(report: ReencryptReport) {
  const lines = [
    `Re-encrypted ${report.secretsRekeyed} 2FA secret(s) and ${report.labelsRekeyed} secret-link label(s) with the current key.`,
  ];
  if (report.failed.length) {
    lines.push(
      `Could not decrypt (left unchanged): ${report.failed.join(", ")}. Add the missing key to ENCRYPTION_OLD_KEYS and run again.`
    );
  }
  return lines.join("\n");
}
