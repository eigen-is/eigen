import type {Home} from "../home/home";
import type Database from "bun:sqlite";
import {drizzle} from "drizzle-orm/bun-sqlite";
import * as schema from "./sharedschema";

export async function getSharedDatabase(home: Home) {
    const db = await home.openSQLiteDatabase('eigen.drive/shared.db', async (db: Database) => {
        // Execute migration SQL to create tables
        db.exec(`
          -- Create shared_paths table
          CREATE TABLE IF NOT EXISTS shared_paths (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            parentId TEXT,
            size INTEGER DEFAULT 0,
            thumbnail TEXT,
            ownerId TEXT NOT NULL,
            mimeType TEXT NOT NULL,
            acl TEXT,
            createdAt INTEGER DEFAULT (unixepoch()),
            updatedAt INTEGER DEFAULT (unixepoch()),
            FOREIGN KEY (parentId) REFERENCES shared_paths(id) ON DELETE CASCADE
          );
        `);
    });

    return drizzle(db, {schema});
}