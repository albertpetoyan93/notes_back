import { describeReport, reencryptAll } from "../../../util/reencrypt";

/**
 * Encrypt items saved as plain text (SSH keys, DB logins, commands, notes,
 * and older passwords) and move stored values to the current key format.
 * Runs in its own transaction.
 */
export const useTransaction = false;

export async function up() {
  const report = await reencryptAll();
  console.log(describeReport(report));
  if (report.failed.length) {
    throw new Error(
      "Some values could not be decrypted with the configured keys. Nothing was lost; fix the keys and run the migration again."
    );
  }
}
