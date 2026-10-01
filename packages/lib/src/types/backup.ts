import type { MountConfig } from './mount';

// One file inside a backup archive. sha256 is over the exact bytes on disk, so a verify pass can
// re-check an unpacked folder without knowing how it was produced.
export type BackupEntry = {
    path: string;
    bytes: number;
    sha256: string;
};

// How much of a home a capture takes. `full-s3` is complete, what the per-home backup writes. `full`
// leaves an s3 mount's objects to its bucket and keeps its metadata.db and staged uploads. `light`
// keeps the databases and the home outside its mounts and mail: no file bodies, no Maildir.
export const BACKUP_LEVELS = ['light', 'full', 'full-s3'] as const;
export type BackupLevel = (typeof BACKUP_LEVELS)[number];

export const BACKUP_KINDS = ['user', 'team', 'server'] as const;

export type BackupManifest = {
    formatVersion: 1;
    kind: (typeof BACKUP_KINDS)[number];
    ownerId: string;
    email?: string;
    name: string;
    createdAt: string;
    appVersion: string;
    server: { domain: string; orgId: string };
    // databases and files are disjoint, so entries.length === databases + files.
    counts: { databases: number; files: number; bytes: number };
    // Absent in an archive written before levels existed, which was complete.
    level?: BackupLevel;
    // `skipped` is set only for a mount the home has turned off whose storage could not be read: it
    // carries the reason, holds no files, and a restore leaves it disabled and absent. An enabled
    // mount's storage failure fails the whole backup instead. `contents: 'metadata'` marks a mount
    // whose file bodies the archive does not hold (every mount at level light, an s3 one at full).
    mounts: {
        id: string;
        storageType: MountConfig['storageType'];
        files: number;
        bytes: number;
        skipped?: string;
        contents?: 'metadata';
    }[];
    // Every file under the folder except manifest.json itself, relative to the folder root.
    entries: BackupEntry[];
    // What the home lacks that its live drives list: rows that do not reach a drive's root, left out, and files whose
    // object is gone, kept without bytes. The archive restores, and is not complete (isCompleteArchive).
    warnings?: string[];
};

// Why a whole-server archive was made. It is part of the archive's name, so retention and the
// schedule never open an archive to find out.
export const BACKUP_REASONS = ['scheduled', 'manual', 'pre-update'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

// The last member of a whole-server archive. `entries` lists every other member of the outer tar,
// so the archive is checked member by member without unpacking one. A home whose capture failed
// has no `member` and says why in `failed`; `bytes` is its inner manifest's `counts.bytes`.
// `envFile`, `dkim` and `certs` say whether those members are in it: each can be unreadable to the API.
export type ServerArchiveManifest = {
    formatVersion: 1;
    level: BackupLevel;
    reason: BackupReason;
    createdAt: string;
    appVersion: string;
    domain: string;
    entries: BackupEntry[];
    // A home has its member, or says why not: `failed` fails the job, `skipped` (deleted mid-run) does not.
    homes: {
        ownerId: string;
        kind: 'user' | 'team';
        name: string;
        member?: string;
        bytes?: number;
        failed?: string;
        skipped?: string;
        // The home member's own, copied up so retention and the status read them without opening it.
        warnings?: string[];
    }[];
    // Home folders with no row in users3.db, left out of the archive.
    orphans: string[];
    envFile: boolean;
    dkim: boolean;
    certs: boolean;
    // The pinned image references the install ran; retention keeps a rollback's archive by its api image.
    images: Record<string, string>;
};

export const BACKUP_VERIFY_STATUSES = ['unverified', 'verified', 'failed'] as const;

export type BackupVerifyRecord = {
    status: (typeof BACKUP_VERIFY_STATUSES)[number];
    // A Date everywhere it is passed around: the sidecar on disk holds the ISO string (it is a file
    // format), and parseBackupSidecar revives it on the way back in.
    checkedAt?: Date;
    // Human-readable, one per failed check.
    failures: string[];
};

// The last upload of an archive to the backup bucket. `key` is the object's, prefix and server folder included.
// `running` with no job behind it is an upload a restart cut off.
export type ServerArchiveUpload = {
    state: BackupJob['state'];
    at: Date;
    key: string;
    error?: string;
};

// `{archive}.json` beside a whole-server archive, written when its job starts and again when it
// ends, so a crash or a refusal still leaves a dated record for the schedule and the list. `running`
// with no job behind it is an interrupted attempt. `manifest` is the finished archive's, `verify` the
// transport check of it. `upload` is absent until an upload was tried.
export type ServerArchiveSidecar = {
    state: BackupJob['state'];
    startedAt: Date;
    finishedAt?: Date;
    error?: string;
    manifest?: ServerArchiveManifest;
    verify?: BackupVerifyRecord;
    upload?: ServerArchiveUpload;
};

// A whole-server archive in the backups folder as the owner's list shows it, read off its name and
// sidecar and never out of the archive. `bytes` is null for an attempt refused before it wrote one,
// `record` for a sidecar that is missing or does not read.
export type ServerArchive = {
    name: string;
    level: BackupLevel;
    reason: BackupReason;
    createdAt: Date;
    bytes: number | null;
    record: ServerArchiveSidecar | null;
};

// Full + S3 is offered only while `hasS3Mounts`.
export type ServerArchiveList = {
    archives: ServerArchive[];
    hasS3Mounts: boolean;
};

export const BACKUP_JOB_STATES = ['running', 'done', 'failed'] as const;

// A backup, verify or restore running on the server. The job map in the API is the truth; the
// `backup:job-updated` SSE event only tells the admin's browser to refetch this. A server backup's
// `ownerId` is the org's, and it names its archive from the start.
export type BackupJob = {
    id: string;
    // `upload` sends a server archive to the backup bucket, as a server backup ends or on the owner's click.
    kind: 'backup' | 'verify' | 'restore' | 'server-backup' | 'upload';
    ownerId: string;
    // The admin who started it: a home job's notifications go to their home. Absent for the scheduler
    // and the CLI; a server job alerts the org owner. A home job's pokes go to every admin, a server job's to the owner.
    startedBy?: string;
    state: (typeof BACKUP_JOB_STATES)[number];
    progress: { step: string; done: number; total: number };
    // The artifact the job ended on, once it has one: what a backup wrote, what a verify judged,
    // what a restore came from. The admin pane names it in the line the finished job leaves.
    artifact?: string;
    error?: string;
    // A server backup's archive goes up in an upload job of its own, started as it ends: this is its id.
    uploadJobId?: string;
    startedAt: Date;
    finishedAt?: Date;
};

// One artifact in the backups folder as the admin pane sees it. `manifest` is null for an artifact
// with no sidecar (one copied in by hand) — the list never opens an archive to find out.
export type BackupArtifact = {
    name: string;
    bytes: number;
    createdAt: Date;
    manifest: Pick<
        BackupManifest,
        'kind' | 'ownerId' | 'email' | 'name' | 'appVersion' | 'counts' | 'level' | 'mounts' | 'warnings'
    > | null;
    verify: BackupVerifyRecord;
};

// A home folder a restore left beside the live one. Nothing deletes these automatically.
export type BackupSafetyCopy = {
    name: string;
    kind: 'pre-restore' | 'failed-restore';
    createdAt: Date;
    // A floor, not the size: measuring a whole home stops after a cap, and the pane says "at least"
    // rather than showing a partial number as if it were the total.
    bytes: number;
    truncated: boolean;
};
