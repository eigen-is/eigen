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
export type BackupLevel = 'light' | 'full' | 'full-s3';

export type BackupManifest = {
    formatVersion: 1;
    kind: 'user' | 'team' | 'server';
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
};

// Why a whole-server archive was made. It is part of the archive's name, so retention and the
// schedule never open an archive to find out.
export type BackupReason = 'scheduled' | 'manual' | 'pre-update';

// The last member of a whole-server archive. `entries` lists every other member of the outer tar,
// so the archive is checked member by member without unpacking one. A home whose capture failed
// has no `member` and says why in `failed`; `bytes` is its inner manifest's `counts.bytes`.
// `envFile` and `dkim` say whether those members are in it: either can be unreadable to the API.
export type ServerArchiveManifest = {
    formatVersion: 1;
    level: BackupLevel;
    reason: BackupReason;
    createdAt: string;
    appVersion: string;
    domain: string;
    entries: BackupEntry[];
    homes: { ownerId: string; kind: 'user' | 'team'; name: string; member?: string; bytes?: number; failed?: string }[];
    // Home folders with no row in users3.db, left out of the archive.
    orphans: string[];
    envFile: boolean;
    dkim: boolean;
    // The pinned image references the install ran, for display.
    images: Record<string, string>;
};

export type BackupVerifyRecord = {
    status: 'unverified' | 'verified' | 'failed';
    // A Date everywhere it is passed around: the sidecar on disk holds the ISO string (it is a file
    // format), and parseBackupSidecar revives it on the way back in.
    checkedAt?: Date;
    // Human-readable, one per failed check.
    failures: string[];
};

// A backup, verify or restore running on the server. The job map in the API is the truth; the
// `backup:job-updated` SSE event only tells the admin's browser to refetch this.
export type BackupJob = {
    id: string;
    kind: 'backup' | 'verify' | 'restore';
    ownerId: string;
    // The admin who started it: the job's notifications go to their home. Its pokes go to all admins.
    startedBy: string;
    state: 'running' | 'done' | 'failed';
    progress: { step: string; done: number; total: number };
    // The artifact the job ended on, once it has one: what a backup wrote, what a verify judged,
    // what a restore came from. The admin pane names it in the line the finished job leaves.
    artifact?: string;
    error?: string;
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
        'kind' | 'ownerId' | 'email' | 'name' | 'appVersion' | 'counts' | 'level' | 'mounts'
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
