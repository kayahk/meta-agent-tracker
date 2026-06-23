import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@meta-agent/config";
import { openDatabase } from "./index.js";

const config = loadConfig();
const database = openDatabase(config.databaseUrl);
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

migrate(database.db, { migrationsFolder });
console.log(`migrated ${database.path}`);
