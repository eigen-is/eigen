import type {HomeInterface} from "../../types/home";
import * as schema from "./sharedschema";
import {createDatabase} from "../core";

const SHARED_MIGRATION_SQL = `
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
`;

export async function getSharedDatabase(home: HomeInterface) {
    return createDatabase(home, 'mounts/shared.db', schema, SHARED_MIGRATION_SQL);
}