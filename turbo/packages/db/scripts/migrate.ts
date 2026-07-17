#!/usr/bin/env tsx

import postgres from "postgres";

import { migrateWithoutGlobalTransaction } from "./migration-runner";

async function runMigrations() {
  if (!process.env.DATABASE_URL) {
    throw new Error("invalid DATABASE_URL");
  }

  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    await migrateWithoutGlobalTransaction(sql);
    console.log("Migrations complete");
  } finally {
    await sql.end();
  }
}

await runMigrations();
