// The largest archive the upload route accepts. Anything bigger is copied into the backups folder
// by hand (scp) — chunked upload is a later phase. The API's own maxRequestBodySize is the backstop.
export const BACKUP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
