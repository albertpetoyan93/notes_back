import sequelize from "../configs/DB/sequelize";
import { describeReport, reencryptAll } from "../util/reencrypt";

/**
 * Rewrite every stored secret with the current ENCRYPTION_KEY.
 *
 * To change the key:
 * 1. Set ENCRYPTION_OLD_KEYS="<old id>:<old key>", a new ENCRYPTION_KEY and a
 *    new ENCRYPTION_KEY_ID, then restart the server (it reads both keys).
 * 2. Run `npm run reencrypt:prod`.
 * 3. When it reports no failures, remove ENCRYPTION_OLD_KEYS and restart.
 */
reencryptAll()
  .then(async (report) => {
    console.log(describeReport(report));
    await sequelize.close();
    process.exit(report.failed.length ? 1 : 0);
  })
  .catch(async (error) => {
    console.error("Re-encryption failed, nothing was changed:", error);
    await sequelize.close();
    process.exit(1);
  });
