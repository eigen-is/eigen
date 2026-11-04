// The names of the databases an Eigen document keeps in its container folder: its own state in data.db,
// and for a collab document its comment index in comments.db. Code that must tell them apart from a
// user's own files reads the names here, such as the drive's guard on user writes and the backup. A
// backup restore stages an archive while the API runs, so this file imports nothing.

export const CONTAINER_DATA_DB = 'data.db';
export const CONTAINER_COMMENTS_DB = 'comments.db';
export const CONTAINER_DB_NAMES: ReadonlySet<string> = new Set([CONTAINER_DATA_DB, CONTAINER_COMMENTS_DB]);
