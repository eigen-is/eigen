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
    checkedAt?: string;
    // Human-readable, one per failed check.
    failures: string[];
};
