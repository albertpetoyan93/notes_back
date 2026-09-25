import User from "@src/models/User";
import sequelize from "./sequelize";
import Note from "@src/models/Note";
import NoteShare from "@src/models/NoteShare";
import * as updateNotesForCustomFields from "./migrations/002_update_notes_for_custom_fields";
import * as addSshCategory from "./migrations/003_add_ssh_category";
import * as addDbCategory from "./migrations/004_add_db_category";
import * as createNoteShares from "./migrations/005_create_note_shares";

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

    // Sync NoteShare table
    await NoteShare.sync({ alter: true });
    console.log(`Migrated: NoteShare`);

    // Run custom migrations to convert existing TEXT content to JSONB
    console.log("\n--- Running custom migrations ---");
    await updateNotesForCustomFields.up();

    // Add SSH category to enum
    console.log("\n--- Adding SSH category ---");
    await addSshCategory.default.up(sequelize.getQueryInterface());

    // Add DB category to enum
    console.log("\n--- Adding DB category ---");
    await addDbCategory.default.up(sequelize.getQueryInterface());

    // Create note_shares table (safe if already synced)
    console.log("\n--- Ensuring note_shares table ---");
    try {
      await createNoteShares.default.up(sequelize.getQueryInterface());
    } catch (err: any) {
      // Table may already exist from sync
      if (!String(err?.message || "").includes("already exists")) {
        throw err;
      }
      console.log("note_shares table already exists, skipping create");
    }

    console.log("\nMigration completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

migrate();
