import User from "@src/models/User";
import sequelize from "./sequelize";
import Note from "@src/models/Note";
import * as updateNotesForCustomFields from "./migrations/002_update_notes_for_custom_fields";
import * as addSshCategory from "./migrations/003_add_ssh_category";
import * as addDbCategory from "./migrations/004_add_db_category";

async function migrate() {
  try {
    // Test connection
    await sequelize.authenticate();
    console.log("Database connection established successfully.");

    // Sync User model first
    await User.sync({ alter: true });
    console.log(`Migrated: User`);

    // Sync Note table (alter to add new columns like comment)
    await Note.sync({ alter: true });
    console.log(`Migrated: Note`);

    // Run custom migrations to convert existing TEXT content to JSONB
    console.log("\n--- Running custom migrations ---");
    await updateNotesForCustomFields.up();

    // Add SSH category to enum
    console.log("\n--- Adding SSH category ---");
    await addSshCategory.default.up(sequelize.getQueryInterface());

    // Add DB category to enum
    console.log("\n--- Adding DB category ---");
    await addDbCategory.default.up(sequelize.getQueryInterface());

    console.log("\nMigration completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

migrate();
