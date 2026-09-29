import fs from "fs";
import path from "path";
import { QueryInterface } from "sequelize";
import sequelize from "./sequelize";

type MigrationModule = {
  up?: (queryInterface: QueryInterface) => Promise<void>;
  useTransaction?: boolean;
  default?: {
    up?: (queryInterface: QueryInterface) => Promise<void>;
    useTransaction?: boolean;
  };
};

function migrationName(file: string) {
  return file.replace(/\.(ts|js)$/, "");
}

function resolveMigration(mod: MigrationModule) {
  const up = mod.up || mod.default?.up;
  if (!up) {
    throw new Error("Migration is missing an up() function");
  }

  const useTransaction =
    mod.useTransaction ?? mod.default?.useTransaction ?? true;

  return { up, useTransaction };
}

async function ensureMigrationsTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedNames() {
  const [rows] = await sequelize.query(
    `SELECT name FROM schema_migrations ORDER BY id ASC`
  );
  return new Set((rows as { name: string }[]).map((row) => row.name));
}

async function recordMigration(name: string) {
  await sequelize.query(
    `INSERT INTO schema_migrations (name) VALUES (:name)`,
    { replacements: { name } }
  );
}

export async function runMigrations() {
  await sequelize.authenticate();
  console.log("Database connection established successfully.");

  await ensureMigrationsTable();
  const applied = await appliedNames();

  const dir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((file) => /^\d+.+\.(ts|js)$/.test(file) && !file.endsWith(".d.ts"))
    .sort();

  const queryInterface = sequelize.getQueryInterface();

  for (const file of files) {
    const name = migrationName(file);
    if (applied.has(name)) {
      console.log(`skip  ${name}`);
      continue;
    }

    const mod = require(path.join(dir, file)) as MigrationModule;
    const { up, useTransaction } = resolveMigration(mod);

    console.log(`apply ${name}`);
    if (useTransaction) {
      await sequelize.transaction(async () => {
        await up(queryInterface);
      });
    } else {
      await up(queryInterface);
    }

    await recordMigration(name);
    console.log(`done  ${name}`);
  }

  console.log("Migrations completed.");
}
