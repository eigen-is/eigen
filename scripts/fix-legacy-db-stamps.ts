#!/usr/bin/env bun
// One-off repair for deployments whose data predates the 2026-04-07 migration squash.
// Pre-squash databases carry migration stamps (e.g. calendar.db at v3 in the __schema_version
// table ManagedDatabase uses — NOT PRAGMA user_version) that are higher than the squashed
// configs declare, and the 2026-08-14 forward-version guard now refuses to open them — which
// fails the whole Home init (503s everywhere). The schema content of those DBs is identical
// to the squashed v1; only the stamp is stale.
//
// Usage (from the repo root on the server, api container stopped):
//   bun scripts/fix-legacy-db-stamps.ts data           # audit only, no writes
//   bun scripts/fix-legacy-db-stamps.ts data --fix     # re-stamp verified calendar.dbs
//
// Only calendar.db is re-stamped, and only after verifying the squashed-v1 markers exist
// (events.icsBlob, events.eventCtag, event_tombstones). Every other managed DB is audited
// and reported, never written.

import { Database } from 'bun:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const EXPECTED: Record<string, number> = {
    'calendar.db': 1,
    'contacts.db': 4,
    'mail.db': 4,
    'metadata.db': 7,
    'notifications.db': 2,
    'data.db': 1,
    'waitlist.db': 1,
};

const root = process.argv[2];
const fix = process.argv.includes('--fix');
if (!root) {
    console.error('Usage: bun scripts/fix-legacy-db-stamps.ts <data-dir> [--fix]');
    process.exit(1);
}
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exit(1);
}

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isDirectory()) yield* walk(full);
        else if (entry.endsWith('.db') && EXPECTED[entry] !== undefined) yield full;
    }
}

// ManagedDatabase tracks its migration stamp in __schema_version (id=1), never PRAGMA user_version.
function readStamp(db: Database): number | null {
    const table = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__schema_version'`).all();
    if (table.length === 0) return null;
    const row = db.query('SELECT version FROM __schema_version WHERE id = 1').get() as {
        version: number;
    } | null;
    return row?.version ?? null;
}

function hasSquashedV1Markers(db: Database): boolean {
    const cols = db.query(`PRAGMA table_info(events)`).all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    const tombstones = db
        .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_tombstones'`)
        .all();
    return names.has('icsBlob') && names.has('eventCtag') && tombstones.length === 1;
}

let scanned = 0;
let skipped = 0;
let unstamped = 0;
let stale = 0;
let fixed = 0;
let refused = 0;

for (const path of walk(root)) {
    const name = basename(path);
    const expected = EXPECTED[name];
    scanned++;
    let db: Database;
    try {
        // readwrite (never create): readonly connections can't create a missing WAL -shm file
        // (SQLITE_CANTOPEN). Audit mode still never issues a write statement.
        db = new Database(path, { readwrite: true, create: false });
    } catch (err) {
        skipped++;
        console.error(`SKIP  ${path} — cannot open: ${err}`);
        continue;
    }
    try {
        const stamp = readStamp(db);
        if (stamp === null) {
            unstamped++;
            continue;
        }
        if (stamp <= expected) continue;

        stale++;
        if (name !== 'calendar.db') {
            console.log(`STALE ${path} — stamped v${stamp} > expected v${expected} (audit only, not touched)`);
            continue;
        }
        if (!hasSquashedV1Markers(db)) {
            refused++;
            console.log(`REFUSED ${path} — stamped v${stamp} but missing squashed-v1 markers; needs manual review`);
            continue;
        }
        if (fix) {
            db.run('UPDATE __schema_version SET version = ? WHERE id = 1', [expected]);
            fixed++;
            console.log(`FIXED ${path} — v${stamp} -> v${expected}`);
        } else {
            console.log(`WOULD FIX ${path} — v${stamp} -> v${expected} (markers verified)`);
        }
    } catch (err) {
        skipped++;
        console.error(`SKIP  ${path} — ${err}`);
    } finally {
        db.close();
    }
}

console.log(
    `\n${fix ? 'Fix' : 'Audit'} complete: ${scanned} database(s) scanned (${unstamped} without a version table), ${skipped} skipped, ${stale} stale stamp(s) found, ${fixed} fixed, ${refused} refused.`,
);
if (scanned === 0) console.log('WARNING: no managed databases found under this directory — wrong data dir?');
if (skipped > 0)
    console.log(
        'WARNING: skipped databases were NOT checked — fix the underlying error (permissions? sudo) and re-run.',
    );
if (!fix && stale > 0) console.log('Re-run with --fix (api container stopped, backup taken) to repair.');
if (refused > 0 || scanned === 0 || skipped > 0) process.exitCode = 1;
