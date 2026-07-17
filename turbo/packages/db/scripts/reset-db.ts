#!/usr/bin/env tsx

import { drizzle } from "drizzle-orm/postgres-js";
import { sql as rawSql } from "drizzle-orm";
import postgres from "postgres";

import { migrateWithoutGlobalTransaction } from "./migration-runner";

async function resetDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });
  const db = drizzle(sql);

  try {
    console.log("Dropping all tables...");
    await db.execute(rawSql`DROP SCHEMA public CASCADE`);
    await db.execute(rawSql`CREATE SCHEMA public`);
    await db.execute(rawSql`DROP SCHEMA IF EXISTS drizzle CASCADE`);

    console.log("Running migrations...");
    await migrateWithoutGlobalTransaction(sql);

    console.log("Database reset complete");
  } finally {
    await sql.end();
  }
}

await resetDatabase();
