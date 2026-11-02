// Brings an older users3.db up to the columns today's better-auth expects. That database has no versioned
// migrations: setup creates its tables once, with every column of its day. So each column added since is added
// here, at boot, before better-auth reads the database. A new auth column goes here, in the schema and in setup's
// DDL together.

import type { Database } from 'bun:sqlite';

export function ensureAuthSchemaColumns(db: Database): void {
    // A table that does not exist yet is skipped, because setup's CREATE TABLE has every column.
    const missing = (table: string, column: string): boolean => {
        const columns = db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all();
        return columns.length > 0 && !columns.some((existing) => existing.name === column);
    };
    if (missing('user', 'last_login_at')) {
        db.run(`ALTER TABLE "user" ADD COLUMN "last_login_at" integer`);
    }
    // better-auth 1.7 keeps a member count per team, so it is seeded from the rows that exist.
    if (missing('team', 'member_count')) {
        db.run(`ALTER TABLE "team" ADD COLUMN "member_count" integer NOT NULL DEFAULT 0`);
        db.run(
            `UPDATE "team" SET "member_count" = (SELECT count(*) FROM "team_member" WHERE "team_member"."team_id" = "team"."id")`,
        );
    }
    // SQLite cannot add a UNIQUE column, so a unique index stands in. Old rows stay NULL, and better-auth then
    // falls back to the team and user pair.
    if (missing('team_member', 'membership_key')) {
        db.run(`ALTER TABLE "team_member" ADD COLUMN "membership_key" text`);
        db.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS "team_member_membership_key_unique" ON "team_member" ("membership_key")`,
        );
    }
    // Both were in the 1.5 model but never in the DDL, and 1.7's startup schema check refuses the gap.
    if (missing('invitation', 'team_id')) {
        db.run(`ALTER TABLE "invitation" ADD COLUMN "team_id" text`);
        db.run(`ALTER TABLE "invitation" ADD COLUMN "created_at" integer`);
    }
    if (missing('two_factor', 'verified')) {
        db.run(`ALTER TABLE "two_factor" ADD COLUMN "verified" integer`);
        db.run(`ALTER TABLE "two_factor" ADD COLUMN "failed_verification_count" integer`);
        db.run(`ALTER TABLE "two_factor" ADD COLUMN "locked_until" integer`);
    }
}
