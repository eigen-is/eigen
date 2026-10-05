import type { BackupLevel } from '../types/backup';

// The largest archive the upload route accepts. Anything bigger is copied into the backups folder
// by hand (scp). The API's own maxRequestBodySize is the backstop.
export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;

// The same limit as the messages about it spell it, so the number and the words cannot drift: the
// route's 413 and the admin pane's refusal both read from here.
export const BACKUP_UPLOAD_MAX_LABEL = `${BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3} GB`;

// The highest per-file upload cap the server can honour. The API's maxRequestBodySize is this same
// bound for every route, and a multipart body carries framing past the file, so the cap stays 1 MB under.
export const UPLOAD_CAP_MAX_MB = BACKUP_UPLOAD_MAX_BYTES / 1024 ** 2 - 1;

// The most archives the owner can keep, on this server and in the bucket alike.
export const BACKUP_KEEP_MAX = 365;

// A level as the owner reads it, in ./eigen backup and the admin pane alike.
export const BACKUP_LEVEL_NAMES: Record<BackupLevel, string> = { light: 'Light', full: 'Full', 'full-s3': 'Full + S3' };
