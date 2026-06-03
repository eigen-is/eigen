import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import * as Y from 'yjs';
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
    const mk = (offsets: number[]) => offsets.map((ms, i) => ({ id: `s${i}`, name: formatSnapshotTimestamp(ago(ms)) }));

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
        const items = Array.from({ length: 50 }, (_, i) => ({
            id: `s${i}`,
            name: formatSnapshotTimestamp(ago(i * 60_000)),
        }));
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        const pruned = selectSnapshotsToPrune(items, policy, now);
        expect(pruned).toHaveLength(49);
        expect(pruned.map((p) => p.id)).not.toContain('s0');
    });

    test('ignores non-snapshot files', () => {
        const items = [
            { id: 'a', name: formatSnapshotTimestamp(ago(30 * 60_000)) },
            { id: 'b', name: 'garbage.db' },
            { id: 'c', name: formatSnapshotTimestamp(ago(2 * HOUR_MS)) },
        ];
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 1 }] };
        expect(selectSnapshotsToPrune(items, policy, now).map((p) => p.id)).toEqual(['c']);
    });
});

// Local helpers — the /versions surface is small enough that they live here rather
// than getting promoted into setup.ts until a second test file needs them.

async function listVersions(token: string, ownerId: string, mountId: string, pathId: string): Promise<Snapshot[]> {
    return driveGet<Snapshot[]>(token, ownerId, mountId, `file/${pathId}/versions`);
}

async function saveVersion(token: string, ownerId: string, mountId: string, pathId: string): Promise<Snapshot> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${pathId}/versions/save`, {
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
        `/drive/${ownerId}/${mountId}/file/${pathId}/versions/${encodeURIComponent(snapshotName)}/restore`,
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

    test('eigendoc: restore applies snapshot to the live Y.Doc — no data.db swap', async () => {
        // Yjs restore should NOT replace data.db (that approach loses to CRDT merge
        // when clients reconnect). Instead the server reads the snapshot's Yjs
        // state and applies it to the live CollabDocument's Y.Doc — the
        // transaction's single update broadcasts to all connected WebSockets
        // and persists via DbProvider. This test drives Drive directly (no WS)
        // and asserts that:
        //   1. The live Y.Doc's state matches the snapshot's content after restore.
        //   2. data.db retains its identity (same path id) — only doc_updates grows.
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const drive = home.drive;

        const sheetsPath = await drive.create(aliceMountId, aliceRootId, 'versions-yjs-surgery', 'sheets');

        const collab = await drive.getCollabDocument(aliceMountId, sheetsPath.id);
        collab.doc.getMap('state').set('marker', 'V1');

        const savedV1 = await drive.saveVersion(aliceMountId, sheetsPath.id);
        const dataDbBefore = await drive.getChildByName(aliceMountId, sheetsPath.id, 'data.db');

        collab.doc.getMap('state').set('marker', 'V2');
        expect(collab.doc.getMap('state').get('marker')).toBe('V2');

        await drive.restoreContainer(aliceMountId, sheetsPath.id, savedV1.name);

        // Same live Y.Doc instance, now with V1's content — no eviction.
        expect(collab.doc.getMap('state').get('marker')).toBe('V1');

        // data.db row identity preserved (no file swap).
        const dataDbAfter = await drive.getChildByName(aliceMountId, sheetsPath.id, 'data.db');
        expect(dataDbAfter?.id).toBe(dataDbBefore?.id);
    });

    test('eigendoc: restore from the file list does not leak an open collab doc', async () => {
        // Restoring from the drive file list (editor closed) opens the
        // CollabDocument singleton purely to run the surgery. With no subscriber,
        // nothing calls unsubscribe → closeCollabDocument, so the doc + its
        // data.db would leak in Drive.documents until the Home is destructed.
        // restoreYjsContainer must close the doc it opened. Observe Drive.documents
        // directly (private — no production accessor exists just for this).
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const drive = home.drive;
        const documents = (drive as unknown as { documents: Map<string, unknown> }).documents;

        // Create + save through the HTTP surface so no CollabDocument is opened
        // in-process before the restore — restore is the first (and only) opener.
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const sheets = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/sheets`, {
            fileName: 'versions-no-leak',
        });
        const saved = await saveVersion(token, ownerId, aliceMountId, sheets.id);

        expect(drive.hasCollabDocument(aliceMountId, sheets.id)).toBe(false);
        const openBefore = documents.size;

        await restoreVersion(token, ownerId, aliceMountId, sheets.id, saved.name);

        expect(drive.hasCollabDocument(aliceMountId, sheets.id)).toBe(false);
        expect(documents.size).toBe(openBefore);
    });

    test('eigendoc: doc (Tiptap XmlFragment) restore applies to the live Y.Doc', async () => {
        // The headline "docs no longer reload" path: a doc restores by replaying
        // the snapshot into the live Y.Doc's XmlFragment root, not a data.db swap.
        // Sheets (Y.Map) is covered above; this exercises the XmlFragment root —
        // the type the pre-surgery restore couldn't handle — end to end.
        const { getHome } = await import('../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const drive = home.drive;

        const docPath = await drive.create(aliceMountId, aliceRootId, 'versions-doc-surgery', 'doc');
        const collab = await drive.getCollabDocument(aliceMountId, docPath.id);

        const fragment = () => collab.doc.getXmlFragment('default');
        const paragraph = (text: string) => {
            const p = new Y.XmlElement('paragraph');
            p.insert(0, [new Y.XmlText(text)]);
            return p;
        };

        fragment().insert(0, [paragraph('V1')]);
        const savedV1 = await drive.saveVersion(aliceMountId, docPath.id);

        fragment().insert(fragment().length, [paragraph('V2')]);
        expect(fragment().toString()).toContain('V2');

        await drive.restoreContainer(aliceMountId, docPath.id, savedV1.name);

        // Same live Y.Doc instance, back to V1's XML, V2 gone — no reload.
        const restored = fragment().toString();
        expect(restored).toContain('V1');
        expect(restored).not.toContain('V2');
    });

    test('chat: restore survives the close-time snapshot fire during evict', async () => {
        // Regression: the chat restore path used to close data.db without
        // skipFinalSnapshot, so ManagedDatabase.close took its close-time
        // snapshot during eviction. That snapshot ran with no preserve hint
        // and could prune the target between restoreContainerDataDb's lookup
        // and copy — leaving data.db deleted but not replaced, bricking the
        // container.
        //
        // The close-time snapshot only fires when there are unsnapshotted
        // writes, so the trailing chatPost provides them; the prior save + save
        // pair puts the target in the same hourly slot as a newer snapshot, so
        // retention WOULD prune it if the eviction snapshot reached the prune
        // step. The restore now closes data.db with skipFinalSnapshot to prevent it.
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;

        const chat = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/chat`, {
            fileName: 'versions-restore-evict-race',
        });

        await chatPost(token, ownerId, aliceMountId, `${chat.id}/messages`, { content: 'v1' });
        const target = await saveVersion(token, ownerId, aliceMountId, chat.id);
        await chatPost(token, ownerId, aliceMountId, `${chat.id}/messages`, { content: 'v2' });
        await saveVersion(token, ownerId, aliceMountId, chat.id);
        await chatPost(token, ownerId, aliceMountId, `${chat.id}/messages`, { content: 'v3' });

        await restoreVersion(token, ownerId, aliceMountId, chat.id, target.name);

        // Container must still hold a data.db row and the restored content.
        const contents = await driveGet<DrivePath[]>(token, ownerId, aliceMountId, `folder/${chat.id}`);
        expect(contents.filter((c) => c.name === 'data.db')).toHaveLength(1);
        const messages = await chatGet<{ content: string }[]>(token, ownerId, aliceMountId, `${chat.id}/messages`);
        expect(messages.map((m) => m.content)).toEqual(['v1']);
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
        const res = await authedRequest(bobToken, `/drive/${aliceId}/${aliceMountId}/file/${chat.id}/versions/save`, {
            method: 'POST',
        });
        expect(res.status).toBe(403);
    });
});
