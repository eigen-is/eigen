// The one lifecycle rule Eigen authors on an S3 bucket. Matched by ID on re-read, so a repeat
// harden updates our rule instead of adding a second one — and a config without it is foreign,
// which we never overwrite. Mirrored by the manual snippet in docs/SYNC.md § Ops.
export const S3_LIFECYCLE_RULE_ID = 'eigen-expire-noncurrent';

// Recovery window for noncurrent versions; the pipeline re-PUTs whole files, so this trades
// recovery depth against storage cost.
export const S3_NONCURRENT_DAYS_DEFAULT = 30;

// Ten years: a retention this long is already a mistake, and it keeps the route's input bounded.
export const S3_NONCURRENT_DAYS_MAX = 3650;

export const S3_ABORT_INCOMPLETE_UPLOAD_DAYS = 7;
