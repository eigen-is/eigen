import type { BackupLevel } from '../types/backup';
import { MAX_REQUEST_BODY_BYTES } from './mount';

// The largest archive the upload route accepts: the most the API reads in one request. Anything
// bigger is copied into the backups folder by hand (scp).
export const BACKUP_UPLOAD_MAX_BYTES = MAX_REQUEST_BODY_BYTES;

// The same limit as the messages about it spell it, so the number and the words cannot drift: the
// route's 413 and the admin pane's refusal both read from here.
export const BACKUP_UPLOAD_MAX_LABEL = `${BACKUP_UPLOAD_MAX_BYTES / 1024 ** 3} GB`;

// The most archives the owner can keep, on this server and in the bucket alike.
export const BACKUP_KEEP_MAX = 365;

// A level as the owner reads it, in ./eigen backup and the admin pane alike.
export const BACKUP_LEVEL_NAMES: Record<BackupLevel, string> = { light: 'Light', full: 'Full', 'full-s3': 'Full + S3' };
