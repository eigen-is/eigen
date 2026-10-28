// Which users3.db rows belong to one user's home archive, and how a restore puts them back. One list of tables
// serves both directions, so a table added to it is archived and restored alike. The home snapshot reads the rows
// with readAuthRows, and a per-home restore inserts them with restoreAuthRows, with the roles fixed here and never
// the archive's.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { parseBackupAuthRows } from '@workspace/lib/validation';
import { eq, getTableColumns } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { account, apikey, member, organization, team, teamMember, twoFactor, user } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';
import { getPublicConfig } from '../config/server-config';
import { ApiError } from '../core';
import { ARCHIVE_AUTH_FILE } from './paths';

// The keys auth.json is written and read under. A union, not a string: restore branches on the key
// (`user` gets a role, `member` a single membership), and a typo would read as a table nobody
// archived.
type AuthArchiveKey = 'user' | 'account' | 'two_factor' | 'apikey' | 'member' | 'team_member';

// A users3.db table one user's archive carries: the key it has in auth.json, the column that scopes
// its rows to that user, and for a membership the parent row it would be an orphan without.
type AuthTableSpec = {
    key: AuthArchiveKey;
    table: SQLiteTable;
    owner: SQLiteColumn;
    parent?: { table: SQLiteTable; id: SQLiteColumn; column: string };
};

// In insert order: the user row first, then the rows that reference it. Sessions and verification rows are left
// out on purpose, because a restore re-inserts identity and does not hand out logins. Every column of the rest
// rides along, so the insert on restore is complete.
const AUTH_TABLES: AuthTableSpec[] = [
    { key: 'user', table: user, owner: user.id },
    { key: 'account', table: account, owner: account.userId },
    { key: 'two_factor', table: twoFactor, owner: twoFactor.userId },
    { key: 'apikey', table: apikey, owner: apikey.referenceId },
    {
        key: 'member',
        table: member,
        owner: member.userId,
        parent: { table: organization, id: organization.id, column: 'organizationId' },
    },
    {
        key: 'team_member',
        table: teamMember,
        owner: teamMember.userId,
        parent: { table: team, id: team.id, column: 'teamId' },
    },
];

// What a restored identity comes back as, whatever the archive says. `user.role` is better-auth's
// own admin flag and a `member` row of the default org is what requireAdmin reads, so neither is
// carried in from a file an admin uploaded: a restore puts a home's data back, it never hands out
// privilege. An admin who was one before their restore is made one again by hand.
const RESTORED_USER_ROLE = 'user';
const RESTORED_MEMBER_ROLE = 'member';

// The rows auth.json holds for one user, keyed the way the file spells them.
export function readAuthRows(userId: string): Record<string, unknown[]> {
    const db = getAuthDrizzleDb();
    const rows: Record<string, unknown[]> = {};
    for (const spec of AUTH_TABLES) {
        rows[spec.key] = db.select().from(spec.table).where(eq(spec.owner, userId)).all();
    }
    return rows;
}

// Re-inserts the identity the archive carries, for a user the server no longer has. A user who is still
// here keeps every row they have: a restore puts a home's data back and never rewrites who somebody is.
// An id whose email no longer matches the archive is a different person, so the restore stops.
export function restoreAuthRows(ownerId: string, manifest: BackupManifest, folder: string): void {
    const authPath = path.join(folder, ARCHIVE_AUTH_FILE);
    if (!fs.existsSync(authPath)) return;
    const db = getAuthDrizzleDb();

    const existing = db.select().from(user).where(eq(user.id, ownerId)).get();
    if (existing) {
        if (manifest.email && existing.email !== manifest.email) {
            throw new ApiError(409, `${ownerId} is now ${existing.email}; the archive holds ${manifest.email}`);
        }
        return;
    }

    const archive = parseBackupAuthRows(fs.readFileSync(authPath, 'utf8'));
    if (!archive) throw new ApiError(400, `${ARCHIVE_AUTH_FILE} is not a set of users3.db rows`);

    // The identity itself is exactly one user row, with this owner's id and the email the manifest was
    // written with. Anything else and no row goes in: a second user row is somebody the archive invented.
    const identity = (archive['user'] ?? []).filter((row) => row['id'] === ownerId);
    if (identity.length !== 1 || (manifest.email && identity[0]['email'] !== manifest.email)) {
        throw new ApiError(
            400,
            `${ARCHIVE_AUTH_FILE} does not hold exactly one ${ownerId} row for ${manifest.email ?? 'this home'}`,
        );
    }
    const orgId = getPublicConfig().orgId;
    const drop = (table: string, reason: string): void => {
        console.warn(`[backup] ${ownerId}: a ${table} row was not restored — ${reason}`);
    };

    // One transaction for the whole identity. A clash on a later row would otherwise leave a user who exists
    // but cannot sign in, and the next attempt would find that user and return early.
    db.transaction((tx) => {
        for (const spec of AUTH_TABLES) {
            const ownerKey = ownerKeyOf(spec);
            let membership = false;
            for (const row of archive[spec.key] ?? []) {
                // Every row names its own owner, and only this home's own come back.
                if (row[ownerKey] !== ownerId) {
                    drop(spec.key, `it belongs to ${String(row[ownerKey])}`);
                    continue;
                }
                if (spec.key === 'user') row['role'] = RESTORED_USER_ROLE;
                if (spec.key === 'member') {
                    // A user belongs to this server's one organization, whichever one the archive
                    // named, so a second row would be a second membership of the same org.
                    if (membership) {
                        drop(spec.key, 'this server gives a user one organization');
                        continue;
                    }
                    membership = true;
                    row['organizationId'] = orgId;
                    row['role'] = RESTORED_MEMBER_ROLE;
                }
                // `team_member` needs no rewrite of its own: it carries no role, and the parent check
                // below is what keeps a membership of a team this server does not have out.
                if (spec.parent) {
                    // A membership whose organization or team is gone would be an orphan, and
                    // better-auth's listMembers fails on those.
                    const parentId = row[spec.parent.column];
                    const found =
                        typeof parentId === 'string' &&
                        tx
                            .select({ id: spec.parent.id })
                            .from(spec.parent.table)
                            .where(eq(spec.parent.id, parentId))
                            .get();
                    if (!found) {
                        drop(spec.key, `its parent ${String(parentId)} is gone`);
                        continue;
                    }
                }
                reviveDates(row, spec.table);
                tx.insert(spec.table).values(row).run();
            }
        }
    });
}

// The key auth.json spells the owner column under: a Drizzle select keys its rows by the schema's
// property name, not by the SQL column name, and a restore filters the archive's rows on that key.
function ownerKeyOf(spec: AuthTableSpec): string {
    const found = Object.entries(getTableColumns(spec.table)).find(([, column]) => column === spec.owner);
    if (!found) throw new Error(`${spec.key}: its owner column is not one of its own`);
    return found[0];
}

// JSON.stringify wrote every timestamp column as an ISO string and Drizzle wants a Date back. Which
// columns those are comes from the schema itself, so a new better-auth column needs no edit here.
function reviveDates(row: Record<string, unknown>, table: SQLiteTable): void {
    for (const [name, column] of Object.entries(getTableColumns(table))) {
        if (column.dataType !== 'date') continue;
        const value = row[name];
        if (typeof value === 'string' || typeof value === 'number') row[name] = new Date(value);
    }
}
