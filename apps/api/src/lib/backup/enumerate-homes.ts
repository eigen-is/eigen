import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerArchiveManifest } from '@workspace/lib/types/backup';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { team, user } from '../../../auth-schema';
import { getDataRoot, getTeamDataPath, getUserHomePath, TEAM_HOMES_DIR, USER_HOMES_DIR } from '../config/paths';
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
