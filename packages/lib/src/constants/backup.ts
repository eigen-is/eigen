import type { BackupLevel } from '../types/backup';

// The largest archive the upload route accepts. Anything bigger is copied into the backups folder
// by hand (scp) — chunked upload is a later phase. The API's own maxRequestBodySize is the backstop.
export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

// The same limit as the messages about it spell it, so the number and the words cannot drift: the
// route's 413 and the admin pane's refusal both read from here.
export const BACKUP_UPLOAD_MAX_LABEL = `${BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3} GB`;

// A level as the owner reads it, in ./eigen backup and the admin pane alike.
export const BACKUP_LEVEL_NAMES: Record<BackupLevel, string> = { light: 'Light', full: 'Full', 'full-s3': 'Full + S3' };

// Said once, when the owner saves a backup bucket: the archives in it are not encrypted, and its keys
// are inside them, so a restore on a new machine starts from a copy kept elsewhere.
export const BACKUP_DESTINATION_NOTICE =
    "Write down this bucket's endpoint, name and keys, and keep them somewhere other than this server. " +
    'A restore on a new machine starts from them: the only other copy is inside the backups. ' +
    'The backups are not encrypted, so keep the bucket private and its keys scoped to it.';
