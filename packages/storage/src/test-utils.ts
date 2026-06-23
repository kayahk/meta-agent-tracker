import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDatabase, type OpenedDatabase } from "./index.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));

/** Absolute path to drizzle migrations (portable across macOS/Linux and ESM). */
export function migrationsFolder(): string {
  return join(packageRoot, "../drizzle");
}

/** Open an isolated SQLite database with all migrations applied. */
export function createTestDatabase(prefix = "meta-agent-test-"): OpenedDatabase {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = openDatabase(join(dir, "test.sqlite"));
  migrate(db.db, { migrationsFolder: migrationsFolder() });
  return db;
}
