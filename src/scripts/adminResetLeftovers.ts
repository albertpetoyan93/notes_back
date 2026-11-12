import sequelize from "../configs/DB/sequelize";
import AdminResetLeftovers from "../services/AdminResetLeftovers";

/**
 * Accounts still on a master password a company admin set under the old
 * admin recovery (see services/AdminResetLeftovers).
 *   npm run recovery:leftovers            (development: list only)
 *   npm run recovery:leftovers -- --notify (development: also tell them)
 *   npm run recovery:leftovers:prod [-- --notify]
 */
async function main() {
  const notify = process.argv.includes("--notify");
  const people = await AdminResetLeftovers.list();
  people.forEach((person) => console.log(`${person.id}\t${person.email}`));
  const result = await AdminResetLeftovers.run({ notify });
  console.log(`Found: ${result.found}. Told: ${result.notified}${notify ? "" : " (dry run; add --notify to tell them)"}.`);
}

main()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("Failed:", error);
    await sequelize.close();
    process.exit(1);
  });
