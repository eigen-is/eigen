import type Database from 'bun:sqlite';
import {drizzle, BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import type {HomeInterface} from '../home/types';

export type SchemaType = Record<string, unknown>;

export async function createDatabase<S extends SchemaType>(
    home: HomeInterface,
    dbPath: string,
    schema: S,
    migrationSQL: string
): Promise<BunSQLiteDatabase<S>> {
    const db = await home.openSQLiteDatabase(dbPath, async (db: Database) => {
        db.exec(migrationSQL);
    });
    return drizzle(db, {schema}) as BunSQLiteDatabase<S>;
}
