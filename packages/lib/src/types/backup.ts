import type { MountConfig } from './mount';

// One file inside a backup archive. sha256 is over the exact bytes on disk, so a verify pass can
// re-check an unpacked folder without knowing how it was produced.
export type BackupEntry = {
    path: string;
    bytes: number;
    sha256: string;
};

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
    mounts: { id: string; storageType: MountConfig['storageType']; files: number; bytes: number }[];
    // Every file under the folder except manifest.json itself, relative to the folder root.
    entries: BackupEntry[];
    // Server archives only (phase ③): one row per home folder, each keeping its own manifest.
    homes?: { ownerId: string; kind: 'user' | 'team'; name: string }[];
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
    // The admin who started it: the job's SSE pokes and notifications go to their home.
    startedBy: string;
    state: 'running' | 'done' | 'failed';
    progress: { step: string; done: number; total: number };
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
    manifest: Pick<BackupManifest, 'kind' | 'ownerId' | 'email' | 'name' | 'appVersion' | 'counts' | 'mounts'> | null;
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
