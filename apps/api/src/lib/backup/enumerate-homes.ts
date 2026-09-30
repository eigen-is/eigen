import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchiveManifest } from '@workspace/lib/types/backup';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { type BackupMountSettings, parseHomeMountSettings } from '@workspace/lib/validation';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { team, user } from '../../../auth-schema';
import { getDataRoot, getTeamDataPath, getUserHomePath, TEAM_HOMES_DIR, USER_HOMES_DIR } from '../config/paths';
import { PATHS } from '../core';
import { parseSafetyCopyName } from './paths';

export type ServerHome = Pick<ServerArchiveManifest['homes'][number], 'ownerId' | 'kind' | 'name'>;

// The folders in `data/{dirName}` no row claims, as data-relative paths. A restore's safety copies
// sit there too and are neither a home nor an orphan.
function listOrphans(dirName: string, claimed: Set<string>): string[] {
    const dir = path.join(getDataRoot(), dirName);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !claimed.has(entry.name) && !parseSafetyCopyName(entry.name))
        .map((entry) => `${dirName}/${entry.name}`)
        .sort();
}

// The homes a whole-server archive takes, read from the users3.db its server member captured, so
// the homes and the accounts in the archive are one moment. Guests are left out: their row stays
// in users3.db and their home is disposable. A row whose folder is missing is skipped rather than
// booted, which would create it empty. A folder no row claims is named as an orphan and not taken.
export function enumerateHomes(usersDbPath: string): { homes: ServerHome[]; orphans: string[] } {
    const sqlite = new Database(usersDbPath, { readonly: true });
    try {
        const db = drizzle(sqlite);
        const users = db
            .select({ id: user.id, name: user.name, role: user.role })
            .from(user)
            .orderBy(asc(user.id))
            .all();
        const teams = db.select({ id: team.id, name: team.name }).from(team).orderBy(asc(team.id)).all();
        const homes: ServerHome[] = [
            ...users
                .filter((row) => row.role !== 'guest' && fs.existsSync(getUserHomePath(row.id)))
                .map((row): ServerHome => ({ ownerId: row.id, kind: 'user', name: row.name })),
            ...teams
                .filter((row) => fs.existsSync(getTeamDataPath(row.id)))
                .map((row): ServerHome => ({ ownerId: teamOwnerId(row.id), kind: 'team', name: row.name })),
        ];
        const orphans = [
            ...listOrphans(USER_HOMES_DIR, new Set(users.map((row) => row.id))),
            ...listOrphans(TEAM_HOMES_DIR, new Set(teams.map((row) => row.id))),
        ];
        return { homes, orphans };
    } finally {
        sqlite.close();
    }
}

type HomeMounts = { folder: string; mounts: BackupMountSettings[] | null };

// Every home folder's mounts, safety copies included, read off its settings.json so no home boots. `mounts` is
// null when the file does not read.
export function listHomeMounts(): HomeMounts[] {
    const homes: HomeMounts[] = [];
    for (const dirName of [USER_HOMES_DIR, TEAM_HOMES_DIR]) {
        const dir = path.join(getDataRoot(), dirName);
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const mounts = readHomeMounts(path.join(dir, entry.name));
            homes.push({ folder: entry.name, mounts: mounts && Object.values(mounts) });
        }
    }
    return homes;
}

// Whether some home keeps a drive in a bucket: Full + S3 is offered only then. A safety copy is no home.
export function hasS3Mounts(): boolean {
    return listHomeMounts().some(
        ({ folder, mounts }) => !parseSafetyCopyName(folder) && mounts?.some((mount) => mount.storageType === 's3'),
    );
}

// A home folder's mounts off its settings.json, so no home boots: none without the file, null when it does not read.
export function readHomeMounts(folder: string): Record<string, BackupMountSettings> | null {
    const settingsPath = path.join(folder, PATHS.SETTINGS);
    if (!fs.existsSync(settingsPath)) return {};
    try {
        return parseHomeMountSettings(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
        return null;
    }
}
