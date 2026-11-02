// One grammar for the names in the backups folder: a home archive's and a server archive's, the stamp both carry, and
// the suffixes of the folders a restore leaves beside a home. Every reader of those names reads them with it, such as
// the admin pane, retention or the CLI, so they never disagree about what a file is.

import type { BackupLevel, BackupReason, ServerArchive } from '../types/backup';
import { BACKUP_LEVELS, BACKUP_REASONS } from '../types/backup';

export const BACKUP_ARTIFACT_EXTENSION = '.tar.zst';

export const BACKUP_HOME_PREFIX = 'home-';

// An owner id ends up in an artifact name and in a home folder a route resolves, so `/`, `..` and
// control characters are out of both by construction.
const BACKUP_OWNER_ID_CHARS = '[A-Za-z0-9_-]+';
export const BACKUP_OWNER_ID = new RegExp(`^${BACKUP_OWNER_ID_CHARS}$`);

// Artifact names and the safety copies a restore leaves beside a home folder read the same stamp.
export const BACKUP_STAMP_PATTERN = String.raw`(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})-(?<hours>\d{2})(?<minutes>\d{2})(?<seconds>\d{2})`;

export function parseBackupStamp(groups: Record<string, string | undefined>): Date | null {
    const at = new Date(
        `${groups['year']}-${groups['month']}-${groups['day']}T${groups['hours']}:${groups['minutes']}:${groups['seconds']}Z`,
    );
    return Number.isNaN(at.getTime()) ? null : at;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

// The home folder a restore moved aside (the state before it) and the incomplete folder a failed
// restore left behind; ./eigen restore keeps data/ aside under the first too. Nothing deletes either automatically.
export const PRE_RESTORE_SUFFIX = '.pre-restore-';
export const FAILED_RESTORE_SUFFIX = '.failed-restore-';

// UTC, so parseBackupStamp reads back the moment it was written.
export function buildBackupStamp(at: Date): string {
    return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}

// Owner ids contain dashes, so the stamp is matched from the end and the owner id is what is left.
const ARTIFACT_EXTENSION_PATTERN = BACKUP_ARTIFACT_EXTENSION.replaceAll('.', String.raw`\.`);
const ARTIFACT_NAME = new RegExp(
    `^${BACKUP_HOME_PREFIX}(?<ownerId>${BACKUP_OWNER_ID_CHARS})-${BACKUP_STAMP_PATTERN}${ARTIFACT_EXTENSION_PATTERN}$`,
);

export function parseBackupArtifactName(name: string): { ownerId: string; at: Date } | null {
    const groups = ARTIFACT_NAME.exec(name)?.groups;
    if (!groups?.['ownerId']) return null;
    const at = parseBackupStamp(groups);
    return at ? { ownerId: groups['ownerId'], at } : null;
}

// A whole-server archive: `server-{reason}-{level}-{stamp}.tar`, uncompressed because its members
// already are. Reason and level are in the name, so retention and the schedule read no archive.
export const SERVER_ARCHIVE_PREFIX = 'server-';
export const SERVER_ARCHIVE_EXTENSION = '.tar';

const SERVER_ARCHIVE_EXTENSION_PATTERN = SERVER_ARCHIVE_EXTENSION.replaceAll('.', String.raw`\.`);
const SERVER_ARCHIVE_NAME = new RegExp(
    `^${SERVER_ARCHIVE_PREFIX}(?<reason>${BACKUP_REASONS.join('|')})-(?<level>${BACKUP_LEVELS.join('|')})-${BACKUP_STAMP_PATTERN}${SERVER_ARCHIVE_EXTENSION_PATTERN}$`,
);

// How the name of a Light archive starts. Eigen 0.4.1 and before made them, and this version parses none: a Light
// archive held no files and no mail, and Eigen keeps no backward compatibility before 1.0.
export const LIGHT_SERVER_ARCHIVE = new RegExp(`^${SERVER_ARCHIVE_PREFIX}[a-z-]+-light-`);

export function parseServerArchiveName(name: string): { reason: BackupReason; level: BackupLevel; at: Date } | null {
    const groups = SERVER_ARCHIVE_NAME.exec(name)?.groups;
    const reason = BACKUP_REASONS.find((candidate) => candidate === groups?.['reason']);
    const level = BACKUP_LEVELS.find((candidate) => candidate === groups?.['level']);
    if (!groups || !reason || !level) return null;
    const at = parseBackupStamp(groups);
    return at ? { reason, level, at } : null;
}

// The server archives among `names`, read, newest first. Any other name is left out.
export function parseServerArchiveNames(
    names: Iterable<string>,
): (Pick<ServerArchive, 'name' | 'reason' | 'level'> & { at: Date })[] {
    return [...names]
        .flatMap((name) => {
            const parsed = parseServerArchiveName(name);
            return parsed ? [{ name, ...parsed }] : [];
        })
        .sort((a, b) => b.at.getTime() - a.at.getTime());
}
