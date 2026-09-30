import { describe, expect, test } from 'bun:test';
import type {
    BackupJob,
    BackupManifest,
    ServerArchive,
    ServerArchiveManifest,
    ServerArchiveSidecar,
} from '../../types/backup';
import {
    canUploadServerArchive,
    incompleteReason,
    parseServerArchiveManifest,
    parseServerArchiveName,
    parseServerArchiveSidecar,
} from '../../validation';

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
            'is a light backup: it holds no files and no mail, so it cannot restore an account on its own',
        );
    });

    test('a metadata-only mount is refused by name', () => {
        const mounts = [
            mount('drive', 'local'),
            { ...mount('bucket', 's3'), contents: 'metadata' as const },
            { ...mount('other', 's3'), contents: 'metadata' as const },
        ];
        expect(incompleteReason({ level: 'full', mounts })).toBe(
            'holds only the metadata of mount bucket, other, not its files, so it cannot restore an account on its own',
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
    const userId = 'u'.repeat(32);
    const member = `homes/home-${userId}-20260930-020304.tar.zst`;
    const valid: ServerArchiveManifest = {
        formatVersion: 1,
        level: 'full',
        reason: 'scheduled',
        createdAt: '2026-09-30T02:03:04.000Z',
        appVersion: '0.3.1',
        domain: 'example.org',
        entries: [
            { path: 'server.tar.zst', bytes: 10, sha256: 'a'.repeat(64) },
            { path: member, bytes: 20, sha256: 'b'.repeat(64) },
        ],
        homes: [
            { ownerId: userId, kind: 'user', name: 'U', member, bytes: 5 },
            { ownerId: `team_${'t'.repeat(32)}`, kind: 'team', name: 'T', failed: 'bucket unreadable' },
            { ownerId: 'v'.repeat(32), kind: 'user', name: 'V', skipped: 'deleted during the backup' },
        ],
        orphans: ['home/gone'],
        envFile: true,
        dkim: false,
        certs: true,
        images: { EIGEN_VERSION: '0.3.1' },
    };

    test('round-trips a valid manifest', () => {
        expect(parseServerArchiveManifest(JSON.stringify(valid))).toEqual(valid);
    });

    test('reads a manifest without certs, as archives made before them are', () => {
        const { certs: _, ...older } = valid;
        expect(parseServerArchiveManifest(JSON.stringify(older))).toEqual(older);
    });

    test('refuses a per-home manifest, a wrong version and a broken field', () => {
        for (const broken of [
            'not json',
            JSON.stringify({ ...valid, formatVersion: 2 }),
            JSON.stringify({ ...valid, reason: 'nightly' }),
            JSON.stringify({ ...valid, entries: undefined }),
            JSON.stringify({ ...valid, homes: [{ ownerId: 'u1', kind: 'org', name: 'O' }] }),
            JSON.stringify({ ...valid, envFile: 'yes' }),
            JSON.stringify({ ...valid, certs: 'yes' }),
            JSON.stringify({ ...valid, images: { EIGEN_VERSION: 3 } }),
        ]) {
            expect(parseServerArchiveManifest(broken)).toBeNull();
        }
    });

    test('refuses a home whose ownerId is not an owner of its kind, or whose member is not an entry', () => {
        const [user, team] = valid.homes;
        for (const homes of [
            [{ ...user, ownerId: '../etc' }],
            [{ ...user, ownerId: team.ownerId }],
            [{ ...team, ownerId: user.ownerId }],
            [{ ...user, member: 'homes/elsewhere.tar.zst' }],
            [{ ...user, skipped: true }],
        ]) {
            expect(parseServerArchiveManifest(JSON.stringify({ ...valid, homes }))).toBeNull();
        }
    });

    describe('parseServerArchiveSidecar', () => {
        const startedAt = new Date('2026-09-30T02:00:00.000Z');
        const finishedAt = new Date('2026-09-30T02:10:00.000Z');

        test('reads a running record and a finished one, dates revived', () => {
            expect(parseServerArchiveSidecar(JSON.stringify({ state: 'running', startedAt }))).toEqual({
                state: 'running',
                startedAt,
            });
            const done: ServerArchiveSidecar = {
                state: 'failed',
                startedAt,
                finishedAt,
                error: 'Bob failed',
                manifest: valid,
                verify: { status: 'verified', checkedAt: finishedAt, failures: [] },
            };
            expect(parseServerArchiveSidecar(JSON.stringify(done))).toEqual(done);
            const uploaded: ServerArchiveSidecar = {
                state: 'done',
                startedAt,
                upload: { state: 'failed', at: finishedAt, key: 'nightly/server.tar', error: 'refused' },
            };
            expect(parseServerArchiveSidecar(JSON.stringify(uploaded))).toEqual(uploaded);
        });

        test('refuses an unknown state, a missing or broken date, and a broken manifest or verify record', () => {
            for (const broken of [
                'not json',
                JSON.stringify({ state: 'paused', startedAt }),
                JSON.stringify({ state: 'running' }),
                JSON.stringify({ state: 'done', startedAt, finishedAt: 'yesterday' }),
                JSON.stringify({ state: 'done', startedAt, manifest: { ...valid, formatVersion: 2 } }),
                JSON.stringify({ state: 'done', startedAt, verify: { status: 'fine', failures: [] } }),
                JSON.stringify({ state: 'done', startedAt, upload: { state: 'queued', at: finishedAt, key: 'k' } }),
                JSON.stringify({ state: 'done', startedAt, upload: { state: 'done', key: 'k' } }),
                JSON.stringify({ state: 'done', startedAt, upload: { state: 'done', at: finishedAt } }),
            ]) {
                expect(parseServerArchiveSidecar(broken)).toBeNull();
            }
        });
    });
});

describe('canUploadServerArchive', () => {
    const name = 'server-scheduled-full-20260930-020000.tar';
    const archive = (
        reason: ServerArchive['reason'],
        record: Partial<ServerArchiveSidecar> | null,
    ): Pick<ServerArchive, 'name' | 'reason' | 'record'> => ({
        name,
        reason,
        record: record && {
            state: 'done',
            startedAt: new Date('2026-09-30T02:00:00Z'),
            verify: { status: 'verified', failures: [] },
            ...record,
        },
    });
    const uploaded = (state: 'running' | 'done' | 'failed') => ({
        upload: { state, at: new Date(), key: `k/${name}` },
    });
    const job = (state: BackupJob['state'], artifact: string) => ({ state, artifact });
    const up = (jobs: ReturnType<typeof job>[]) => ({ uploadEnabled: true, jobs });

    test('offers a verified archive, uploaded before or not, as the Upload route accepts it', () => {
        expect(canUploadServerArchive(archive('scheduled', {}), up([]))).toBe(true);
        expect(canUploadServerArchive(archive('manual', uploaded('failed')), up([]))).toBe(true);
        expect(canUploadServerArchive(archive('scheduled', uploaded('done')), up([]))).toBe(true);
        expect(canUploadServerArchive(archive('scheduled', {}), up([job('done', name), job('running', 'other')]))).toBe(
            true,
        );
    });

    test('never offers one a job is still writing or uploading', () => {
        expect(canUploadServerArchive(archive('scheduled', uploaded('running')), up([job('running', name)]))).toBe(
            false,
        );
    });

    test('never offers one while no backup bucket is set', () => {
        expect(canUploadServerArchive(archive('scheduled', {}), { uploadEnabled: false, jobs: [] })).toBe(false);
    });

    test('never offers a pre-update archive, one that did not verify, or one without a record', () => {
        expect(canUploadServerArchive(archive('pre-update', {}), up([]))).toBe(false);
        expect(
            canUploadServerArchive(archive('manual', { verify: { status: 'failed', failures: ['x'] } }), up([])),
        ).toBe(false);
        expect(canUploadServerArchive(archive('manual', { state: 'failed', verify: undefined }), up([]))).toBe(false);
        expect(canUploadServerArchive(archive('manual', null), up([]))).toBe(false);
    });
});
