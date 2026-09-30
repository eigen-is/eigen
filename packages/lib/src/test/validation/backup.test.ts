import { describe, expect, test } from 'bun:test';
import type { BackupManifest, ServerArchiveManifest } from '../../types/backup';
import { incompleteReason, parseServerArchiveManifest, parseServerArchiveName } from '../../validation';

const mount = (id: string, storageType: BackupManifest['mounts'][number]['storageType']) => ({
    id,
    storageType,
    files: 1,
    bytes: 1,
});

describe('incompleteReason', () => {
    test('a complete home has none: full-s3, a manifest from before levels, a Full one with no s3 mount', () => {
        const mounts = [mount('drive', 'local-key'), mount('bucket', 's3')];
        expect(incompleteReason({ level: 'full-s3', mounts })).toBeNull();
        expect(incompleteReason({ mounts })).toBeNull();
        expect(
            incompleteReason({ level: 'full', mounts: [mount('drive', 'local'), mount('flat', 'local-key')] }),
        ).toBeNull();
    });

    test('a Light one is refused by its level', () => {
        expect(incompleteReason({ level: 'light', mounts: [mount('drive', 'local')] })).toBe(
            'is a light backup: it holds no files and no mail, so it cannot restore a home on its own',
        );
    });

    test('a metadata-only mount is refused by name', () => {
        const mounts = [
            mount('drive', 'local'),
            { ...mount('bucket', 's3'), contents: 'metadata' as const },
            { ...mount('other', 's3'), contents: 'metadata' as const },
        ];
        expect(incompleteReason({ level: 'full', mounts })).toBe(
            'holds only the metadata of mount bucket, other, not its files, so it cannot restore a home on its own',
        );
    });
});

describe('parseServerArchiveName', () => {
    test('reads reason, level and stamp, a level with a dash included', () => {
        expect(parseServerArchiveName('server-pre-update-full-s3-20260930-020304.tar')).toEqual({
            reason: 'pre-update',
            level: 'full-s3',
            at: new Date('2026-09-30T02:03:04Z'),
        });
        expect(parseServerArchiveName('server-scheduled-full-20260930-020304.tar')?.level).toBe('full');
        expect(parseServerArchiveName('server-manual-light-20260930-020304.tar')?.reason).toBe('manual');
    });

    test('rejects anything that is not an archive name', () => {
        for (const bad of [
            'server-manual-full-20260930-020304.tar.zst',
            'server-nightly-full-20260930-020304.tar',
            'server-manual-heavy-20260930-020304.tar',
            'server-manual-full-20261330-020304.tar',
            'home-abc-20260930-020304.tar.zst',
            '../server-manual-full-20260930-020304.tar',
        ]) {
            expect(parseServerArchiveName(bad)).toBeNull();
        }
    });
});

describe('parseServerArchiveManifest', () => {
    const valid: ServerArchiveManifest = {
        formatVersion: 1,
        level: 'full',
        reason: 'scheduled',
        createdAt: '2026-09-30T02:03:04.000Z',
        appVersion: '0.3.1',
        domain: 'example.org',
        entries: [{ path: 'server.tar.zst', bytes: 10, sha256: 'a'.repeat(64) }],
        homes: [
            { ownerId: 'u1', kind: 'user', name: 'U', member: 'homes/home-u1-20260930-020304.tar.zst', bytes: 5 },
            { ownerId: 'team_t1', kind: 'team', name: 'T', failed: 'bucket unreadable' },
        ],
        orphans: ['home/gone'],
        envFile: true,
        dkim: false,
        images: { EIGEN_VERSION: '0.3.1' },
    };

    test('round-trips a valid manifest', () => {
        expect(parseServerArchiveManifest(JSON.stringify(valid))).toEqual(valid);
    });

    test('refuses a per-home manifest, a wrong version and a broken field', () => {
        for (const broken of [
            'not json',
            JSON.stringify({ ...valid, formatVersion: 2 }),
            JSON.stringify({ ...valid, reason: 'nightly' }),
            JSON.stringify({ ...valid, entries: undefined }),
            JSON.stringify({ ...valid, homes: [{ ownerId: 'u1', kind: 'org', name: 'O' }] }),
            JSON.stringify({ ...valid, envFile: 'yes' }),
            JSON.stringify({ ...valid, images: { EIGEN_VERSION: 3 } }),
        ]) {
            expect(parseServerArchiveManifest(broken)).toBeNull();
        }
    });
});
