import type { BackupLevel } from '../types/backup';

// The largest archive the upload route accepts. Anything bigger is copied into the backups folder
// by hand (scp) — chunked upload is a later phase. The API's own maxRequestBodySize is the backstop.
export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

// The same limit as the messages about it spell it, so the number and the words cannot drift: the
// route's 413 and the admin pane's refusal both read from here.
export const BACKUP_UPLOAD_MAX_LABEL = `${BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3} GB`;

// A level as the owner reads it, in ./eigen backup and the admin pane alike.
export const BACKUP_LEVEL_NAMES: Record<BackupLevel, string> = { light: 'Light', full: 'Full', 'full-s3': 'Full + S3' };
