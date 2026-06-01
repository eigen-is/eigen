import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import {
    DAY_MS,
    DEFAULT_RETENTION,
    HOUR_MS,
    type RetentionPolicy,
    selectSnapshotsToPrune,
} from '../lib/versioning/retention';
import { formatSnapshotTimestamp, parseSnapshotTimestamp } from '../lib/versioning/timestamp';
import { authedRequest, chatGet, chatPost, driveGet, drivePost, getTestContext } from './setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

describe('snapshot timestamp', () => {
    test('formats Date to filename-safe ISO with .db extension', () => {
        expect(formatSnapshotTimestamp(new Date('2026-05-31T13:45:00.123Z'))).toBe('2026-05-31T13-45-00-123Z.db');
    });
    test('round-trips', () => {
        const d = new Date('2026-05-31T13:45:00.123Z');
        expect(parseSnapshotTimestamp(formatSnapshotTimestamp(d))?.toISOString()).toBe(d.toISOString());
    });
    test('returns null for non-snapshot names', () => {
        expect(parseSnapshotTimestamp('data.db')).toBeNull();
        expect(parseSnapshotTimestamp('2026-05-31T13-45-00-123Z')).toBeNull();
    });
});

describe('retention pruning (time-bucketed)', () => {
    const now = new Date('2026-05-31T12:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const fmt = (d: Date) => `${d.toISOString().replace(/[:.]/g, '-')}.db`;
    const mk = (offsets: number[]) => offsets.map((ms, i) => ({ id: `s${i}`, name: fmt(ago(ms)) }));

    test('hourly bucket: keep newest per hour slot', () => {
        const items = mk([10 * 60_000, 20 * 60_000, 30 * 60_000]);
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        expect(
            selectSnapshotsToPrune(items, policy, now)
                .map((p) => p.id)
                .sort(),
        ).toEqual(['s1', 's2']);
    });

    test('multi-bucket: hourly + daily', () => {
        const items = mk([30 * 60_000, 90 * 60_000, 25 * HOUR_MS, 2 * DAY_MS, 8 * DAY_MS]);
        const policy: RetentionPolicy = {
            buckets: [
                { intervalMs: HOUR_MS, count: 24 },
                { intervalMs: DAY_MS, count: 7 },
            ],
        };
        expect(selectSnapshotsToPrune(items, policy, now).map((p) => p.id)).toEqual(['s4']);
    });

    test('overlap: same snapshot kept by multiple buckets, stored once', () => {
        const items = mk([30 * 60_000, 4 * HOUR_MS]);
        const policy: RetentionPolicy = {
            buckets: [
                { intervalMs: HOUR_MS, count: 24 },
                { intervalMs: DAY_MS, count: 7 },
            ],
        };
        expect(selectSnapshotsToPrune(items, policy, now)).toEqual([]);
    });

    test('default policy keeps 300d-old, prunes 400d-old', () => {
        expect(selectSnapshotsToPrune(mk([300 * DAY_MS]), DEFAULT_RETENTION, now)).toEqual([]);
        expect(selectSnapshotsToPrune(mk([400 * DAY_MS]), DEFAULT_RETENTION, now)).toHaveLength(1);
    });

    test('sparse: 1/week is fully kept', () => {
        const items = mk([1 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 21 * DAY_MS]);
        expect(selectSnapshotsToPrune(items, DEFAULT_RETENTION, now)).toEqual([]);
    });

    test('dense: 50 in last hour → 1 kept', () => {
        const items = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: fmt(ago(i * 60_000)) }));
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        const pruned = selectSnapshotsToPrune(items, policy, now);
        expect(pruned).toHaveLength(49);
        expect(pruned.map((p) => p.id)).not.toContain('s0');
    });

    test('ignores non-snapshot files', () => {
        const items = [
            { id: 'a', name: fmt(ago(30 * 60_000)) },
            { id: 'b', name: 'garbage.db' },
            { id: 'c', name: fmt(ago(2 * HOUR_MS)) },
        ];
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 1 }] };
        expect(selectSnapshotsToPrune(items, policy, now).map((p) => p.id)).toEqual(['c']);
    });
});

// Local helpers — the /versions surface is small enough that they live here rather
// than getting promoted into setup.ts until a second test file needs them.

async function listVersions(token: string, ownerId: string, mountId: string, pathId: string): Promise<Snapshot[]> {
    return driveGet<Snapshot[]>(token, ownerId, mountId, `${pathId}/versions`);
}

async function saveVersion(token: string, ownerId: string, mountId: string, pathId: string): Promise<Snapshot> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/${pathId}/versions/save`, {
        method: 'POST',
    });
    if (res.status !== 200) throw new Error(`saveVersion failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as Snapshot;
}

async function restoreVersion(
    token: string,
    ownerId: string,
    mountId: string,
    pathId: string,
    snapshotName: string,
): Promise<void> {
    const res = await authedRequest(
        token,
        `/drive/${ownerId}/${mountId}/${pathId}/versions/${encodeURIComponent(snapshotName)}/restore`,
        { method: 'POST' },
    );
    if (res.status !== 200) throw new Error(`restoreVersion failed: ${res.status} ${await res.text()}`);
}

describe('versions HTTP routes', () => {
    let ctx: TestCtx;
    let aliceMountId: string;
    let aliceRootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        aliceMountId = mounts![0].id;
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, aliceMountId, 'root');
        aliceRootId = root.id;
    });

    test('chat: save → restore round-trips messages', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;

        const chat = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/chat`, {
            fileName: 'versions-roundtrip',
        });

        // Post v1.
        await chatPost(token, ownerId, aliceMountId, `${chat.id}/messages`, { content: 'v1' });

        // No versions yet — single write is well under writesPerSnapshot (100).
        expect(await listVersions(token, ownerId, aliceMountId, chat.id)).toEqual([]);

        // Save explicitly.
        const saved = await saveVersion(token, ownerId, aliceMountId, chat.id);
        expect(saved.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/);

        // Post v2 after the snapshot.
        await chatPost(token, ownerId, aliceMountId, `${chat.id}/messages`, { content: 'v2' });

        // Restore the saved version.
        await restoreVersion(token, ownerId, aliceMountId, chat.id, saved.name);

        // After restore: only v1 visible.
        const messages = await chatGet<{ content: string }[]>(token, ownerId, aliceMountId, `${chat.id}/messages`);
        expect(messages.map((m) => m.content)).toEqual(['v1']);

        // Two versions now: the manual save + the pre-restore auto-snapshot.
        const after = await listVersions(token, ownerId, aliceMountId, chat.id);
        expect(after.length).toBe(2);
    });

    test('eigendoc: save + list returns parsed snapshot metadata', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;

        const doc = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/doc`, {
            fileName: 'versions-eigendoc',
        });

        const saved = await saveVersion(token, ownerId, aliceMountId, doc.id);
        expect(saved.name).toMatch(/\.db$/);
        expect(saved.size).toBeGreaterThan(0);

        const list = await listVersions(token, ownerId, aliceMountId, doc.id);
        expect(list.length).toBe(1);
        expect(list[0].name).toBe(saved.name);
        // Raw res.json() leaves `createdAt` as the ISO string the server sent; Date wrapping
        // tolerates either string (here) or Date (Eden Treaty's reviver) at runtime.
        expect(new Date(list[0].createdAt).getTime()).toBeGreaterThan(0);
    });

    test('eigendoc: restoring an older snapshot when a newer one shares its retention slot', async () => {
        // Regression: with default retention every snapshot taken within the same
        // hour falls in slot 0 of every bucket, so only the newest survives. The
        // pre-restore snapshot taken by restoreContainer becomes that newest entry
        // — and without the preserve hook the target the user clicked gets pruned
        // *before* restoreContainerDataDb reads it. The route then 404s on the
        // very snapshot that listVersions just returned.
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;

        const doc = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/sheets`, {
            fileName: 'versions-restore-older',
        });

        const older = await saveVersion(token, ownerId, aliceMountId, doc.id);
        // A second save survives the first one's prune (the freshly-written one is
        // excluded) but puts both snapshots in slot 0 — the configuration that
        // would otherwise sacrifice `older` on the next snapshot.
        await saveVersion(token, ownerId, aliceMountId, doc.id);

        await restoreVersion(token, ownerId, aliceMountId, doc.id, older.name);
    });

    test('versions list is empty for a brand-new container with no save', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;

        const doc = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/doc`, {
            fileName: 'versions-empty',
        });

        expect(await listVersions(token, ownerId, aliceMountId, doc.id)).toEqual([]);
    });

    test('unauthorized cross-owner save is denied', async () => {
        const aliceToken = ctx.alice.user.sessionToken;
        const bobToken = ctx.bob.user.sessionToken;
        const aliceId = ctx.alice.user.id;

        const chat = await drivePost<DrivePath>(
            aliceToken,
            aliceId,
            aliceMountId,
            `folder/${aliceRootId}/create/chat`,
            { fileName: 'versions-acl' },
        );

        // Bob has no permission to alice's chat.
        const res = await authedRequest(bobToken, `/drive/${aliceId}/${aliceMountId}/${chat.id}/versions/save`, {
            method: 'POST',
        });
        expect(res.status).toBe(403);
    });
});
