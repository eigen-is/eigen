import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { parseBackupAuthRows, parseBackupShares } from '@workspace/lib/validation';
import { eq, getTableColumns } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { user as userTable } from '../../../auth-schema';
import { getAuthDrizzleDb } from '../auth/auth';
import { getAvatarsDir } from '../config/paths';
import { getPublicConfig } from '../config/server-config';
import { ApiError } from '../core';
import { getEigenDb } from '../share/db';
import { shareRegistry } from '../share/schema';
import { AUTH_TABLES, ownerKeyOf, RESTORED_MEMBER_ROLE, RESTORED_USER_ROLE } from './auth-tables';
import { ARCHIVE_AUTH_FILE, ARCHIVE_AVATAR_DIR, ARCHIVE_SHARES_FILE } from './paths';

// What a restore of one home writes outside its folder: the identity the archive carries. The mounts are
// materialize-mount.ts's; the orchestration around both (the lock, the move-aside, the rollback) is in restore.ts.

// JSON.stringify wrote every timestamp column as an ISO string and Drizzle wants a Date back. Which
// columns those are comes from the schema itself, so a new better-auth column needs no edit here.
function reviveDates(row: Record<string, unknown>, table: SQLiteTable): void {
    for (const [name, column] of Object.entries(getTableColumns(table))) {
        const value = row[name];
        if (column.dataType !== 'date') continue;
        if (typeof value === 'string' || typeof value === 'number') row[name] = new Date(value);
    }
}

// Re-insert the identity the archive carries, for a user the server no longer has. A user that IS
// still here keeps every row it has: a restore puts a home's data back, it never rewrites who
// somebody is — and an id whose email no longer matches the archive is a different person.
export function restoreAuthRows(ownerId: string, manifest: BackupManifest, folder: string): void {
    const authPath = path.join(folder, ARCHIVE_AUTH_FILE);
    if (!fs.existsSync(authPath)) return;
    const db = getAuthDrizzleDb();

    const existing = db.select().from(userTable).where(eq(userTable.id, ownerId)).get();
    if (existing) {
        if (manifest.email && existing.email !== manifest.email) {
            throw new ApiError(409, `${ownerId} is now ${existing.email}; the archive holds ${manifest.email}`);
        }
        return;
    }

    const archive = parseBackupAuthRows(fs.readFileSync(authPath, 'utf8'));
    if (!archive) throw new ApiError(400, `${ARCHIVE_AUTH_FILE} is not a set of users3.db rows`);

    // The identity itself: exactly one user row, this owner's id, the email the manifest was written
    // with. Anything else and not a row goes in — an archive carrying a second user row is carrying
    // somebody it invented.
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

    // One transaction for the whole identity: a clash on a later row would otherwise leave a user
    // that exists but cannot sign in — and the next attempt would take the branch above and return.
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
                    // named — so a second row would be a second membership of the same org.
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
                    // better-auth's listMembers chokes on those (see user/delete-user.ts).
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

// Insert missing only: a registry row that is already there describes a live share.
export async function restoreShares(ownerId: string, folder: string): Promise<void> {
    const sharesPath = path.join(folder, ARCHIVE_SHARES_FILE);
    if (!fs.existsSync(sharesPath)) return;
    const rows = parseBackupShares(fs.readFileSync(sharesPath, 'utf8'));
    if (!rows) throw new ApiError(400, `${ARCHIVE_SHARES_FILE} is not a set of share-registry rows`);
    const db = await getEigenDb();
    for (const row of rows) {
        db.insert(shareRegistry)
            .values({ fromUserId: ownerId, targetIdentifier: row.targetIdentifier })
            .onConflictDoNothing()
            .run();
    }
}

// The avatar is server data, not home data: put it back only where the server has none, so a picture
// the user changed after the backup is not quietly reverted. The name comes out of the archive and
// lands in the server-wide avatars folder, so it has to BE this user's: `{ownerId}.{ext}` and
// nothing else, or a hostile archive would plant a picture for somebody who has none.
export async function restoreAvatar(ownerId: string, folder: string): Promise<void> {
    const avatarDir = path.join(folder, ARCHIVE_AVATAR_DIR);
    if (!fs.existsSync(avatarDir)) return;
    for (const name of fs.readdirSync(avatarDir)) {
        if (path.parse(name).name !== ownerId) {
            console.warn(`[backup] ${ownerId}: ${name} in the archive is not this user's avatar, not restored`);
            continue;
        }
        const target = path.join(getAvatarsDir(), name);
        if (fs.existsSync(target)) continue;
        await Bun.write(target, Bun.file(path.join(avatarDir, name)));
    }
}
