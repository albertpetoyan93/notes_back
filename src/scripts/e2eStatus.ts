import { Op } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import Note from "../models/Note";
import NoteVersion from "../models/NoteVersion";
import User from "../models/User";
import { e2eDeadline } from "../services/E2EAccountService";
import EmailService from "../services/EmailService";

/**
 * How far the move to end-to-end encryption is (E2E_DESIGN.md, stage 10.6),
 * and with --remind, an email to every account that hasn't turned it on.
 *
 * Server-side decryption (ENCRYPTION_KEY, util/encryption) can be removed only
 * when this reports 0 readable items and 0 readable versions.
 *   npm run e2e:status            (NODE_ENV picks the database)
 *   npm run e2e:remind
 */
async function main() {
  const remind = process.argv.includes("--remind");
  const users = await User.count();
  const e2eUsers = await User.count({ where: { e2eEnabled: true } });
  const items = await Note.count({ paranoid: false });
  const sealed = await Note.count({ where: { e2e: true }, paranoid: false });
  const versions = await NoteVersion.count();
  const sealedVersions = await NoteVersion.count({ where: { e2e: true } });
  // Readable items of accounts that have it on: waiting for someone without keys, or for their owner's next sign-in.
  const waiting = await Note.count({
    where: { e2e: false, userId: { [Op.in]: sequelize.literal(`(SELECT id FROM users WHERE "e2eEnabled")`) } },
    paranoid: false,
  });

  console.log(`Accounts:  ${e2eUsers} of ${users} end-to-end`);
  console.log(`Items:     ${sealed} of ${items} end-to-end (${items - sealed} readable, ${waiting} of them owned by end-to-end accounts)`);
  console.log(`Versions:  ${sealedVersions} of ${versions} end-to-end`);
  console.log(`Deadline:  ${e2eDeadline() || "not set (E2E_DEADLINE)"}`);
  console.log(
    items === sealed && versions === sealedVersions
      ? "Nothing readable is left: server-side decryption can be removed."
      : "Readable data is left: keep server-side decryption."
  );

  if (remind) {
    const pending = await User.findAll({ where: { e2eEnabled: false }, attributes: ["id", "email"] });
    let sent = 0;
    for (const user of pending) {
      try {
        await EmailService.sendE2EReminder({ to: user.email, deadline: e2eDeadline() });
        sent += 1;
      } catch (error: any) {
        console.error(`Could not email ${user.email}:`, error?.message || error);
      }
    }
    console.log(`Reminders sent: ${sent} of ${pending.length}`);
  }
}

main()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Status failed:", error);
    await sequelize.close();
    process.exit(1);
  });
