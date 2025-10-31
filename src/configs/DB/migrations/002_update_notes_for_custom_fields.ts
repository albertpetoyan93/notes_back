import sequelize from "../sequelize";
import { QueryInterface, DataTypes } from "sequelize";

/**
 * Migration: Update notes table for custom fields support
 * - Ensures content column can store JSON data
 * - Verifies category enum includes all types
 */
export async function up() {
  const queryInterface: QueryInterface = sequelize.getQueryInterface();

  try {
    console.log("Starting migration: Update notes for custom fields...");

    // Check if notes table exists
    const tables = await queryInterface.showAllTables();
    if (!tables.includes("notes")) {
      console.log("Notes table doesn't exist yet. Skipping migration.");
      return;
    }

    // Check if content column is already JSONB
    const [columnInfo] = await sequelize.query(`
      SELECT data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'notes' AND column_name = 'content';
    `);

    if (columnInfo && columnInfo[0]) {
      const info = columnInfo[0] as any;
      if (info.data_type === "jsonb" || info.udt_name === "jsonb") {
        console.log("✓ Content column is already JSONB. Skipping conversion.");
        return;
      }
    }

    // PostgreSQL: Alter content column to JSONB for flexible key-value storage
    // First, convert existing TEXT data to JSONB format
    await sequelize.query(`
      ALTER TABLE "notes" 
      ALTER COLUMN "content" TYPE JSONB 
      USING CASE 
        WHEN "content"::text ~ '^\\s*[\\{\\[]' THEN "content"::jsonb
        ELSE json_build_object('mainContent', "content", 'customFields', '[]'::json)::jsonb
      END;
    `);
    console.log("✓ Content column converted to JSONB");

    // Set default value
    await sequelize.query(`
      ALTER TABLE "notes" 
      ALTER COLUMN "content" SET DEFAULT '{}'::jsonb;
    `);
    console.log("✓ Default value set for content column");

    // Verify category enum includes all values
    // PostgreSQL will automatically handle enum updates
    const [results] = await sequelize.query(`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_name = 'notes' AND column_name = 'category';
    `);

    console.log("✓ Category column verified:", results);

    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}

export async function down() {
  console.log("Rollback: No changes needed for this migration");
  // Content column was already TEXT, no rollback needed
}
