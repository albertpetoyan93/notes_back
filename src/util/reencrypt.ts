import { QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import {
  decrypt,
  encrypt,
  encryptContent,
  isEncryptedValue,
  needsReencrypt,
} from "./encryption";

export interface ReencryptReport {
  notesEncrypted: number;
  notesRekeyed: number;
  secretsRekeyed: number;
  versionsRekeyed: number;
  failed: string[];
}

/**
 * Bring every stored secret onto the current ENCRYPTION_KEY:
 * - note content that was saved as plain text is encrypted;
 * - values written with an old key or the old format are rewritten;
 * - 2FA secrets are rewritten the same way.
 * Rows that no configured key can open are left as they are and reported.
 * Raw queries: trashed notes are included and updatedAt does not change.
 */
export async function reencryptAll(): Promise<ReencryptReport> {
  const report: ReencryptReport = {
    notesEncrypted: 0,
    notesRekeyed: 0,
    secretsRekeyed: 0,
    versionsRekeyed: 0,
    failed: [],
  };

  await sequelize.transaction(async (transaction) => {
    const notes = await sequelize.query<{ id: number; content: unknown }>(
      `SELECT id, content FROM "notes" ORDER BY id`,
      { type: QueryTypes.SELECT, transaction }
    );

    for (const note of notes) {
      let next: string;
      if (isEncryptedValue(note.content)) {
        if (!needsReencrypt(note.content)) continue;
        try {
          next = encrypt(decrypt(note.content));
        } catch {
          report.failed.push(`note ${note.id}`);
          continue;
        }
        report.notesRekeyed += 1;
      } else {
        next = encryptContent(note.content ?? {});
        report.notesEncrypted += 1;
      }

      await sequelize.query(
        `UPDATE "notes" SET content = CAST(:content AS jsonb) WHERE id = :id`,
        {
          replacements: { id: note.id, content: JSON.stringify(next) },
          transaction,
        }
      );
    }

    // Every item is encrypted now, including ones that were never flagged.
    await sequelize.query(
      `UPDATE "notes" SET "isEncrypted" = true WHERE "isEncrypted" = false`,
      { transaction }
    );

    const users = await sequelize.query<{ id: number; secret: string }>(
      `SELECT id, "twoFactorSecret" AS secret FROM "users" WHERE "twoFactorSecret" IS NOT NULL`,
      { type: QueryTypes.SELECT, transaction }
    );
    for (const user of users) {
      if (!isEncryptedValue(user.secret) || !needsReencrypt(user.secret)) {
        continue;
      }
      try {
        await sequelize.query(
          `UPDATE "users" SET "twoFactorSecret" = :secret WHERE id = :id`,
          {
            replacements: { id: user.id, secret: encrypt(decrypt(user.secret)) },
            transaction,
          }
        );
        report.secretsRekeyed += 1;
      } catch {
        report.failed.push(`2FA secret of user ${user.id}`);
      }
    }

    // Version history (migration 028) holds item content too.
    const [{ exists }] = await sequelize.query<{ exists: boolean }>(
      `SELECT to_regclass('public.note_versions') IS NOT NULL AS exists`,
      { type: QueryTypes.SELECT, transaction }
    );
    if (exists) {
      const versions = await sequelize.query<{ id: number; content: string }>(
        `SELECT id, content FROM "note_versions" ORDER BY id`,
        { type: QueryTypes.SELECT, transaction }
      );
      for (const version of versions) {
        if (!isEncryptedValue(version.content) || !needsReencrypt(version.content)) continue;
        try {
          await sequelize.query(`UPDATE "note_versions" SET content = :content WHERE id = :id`, {
            replacements: { id: version.id, content: encrypt(decrypt(version.content)) },
            transaction,
          });
          report.versionsRekeyed += 1;
        } catch {
          report.failed.push(`version ${version.id}`);
        }
      }
    }
  });

  return report;
}

export function describeReport(report: ReencryptReport) {
  const lines = [
    `Encrypted ${report.notesEncrypted} item(s) that were stored as plain text.`,
    `Re-encrypted ${report.notesRekeyed} item(s), ${report.versionsRekeyed} saved version(s) and ${report.secretsRekeyed} 2FA secret(s) with the current key.`,
  ];
  if (report.failed.length) {
    lines.push(
      `Could not decrypt (left unchanged): ${report.failed.join(", ")}. Add the missing key to ENCRYPTION_OLD_KEYS and run again.`
    );
  }
  return lines.join("\n");
}
