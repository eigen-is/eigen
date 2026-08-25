import { Database } from 'bun:sqlite';
import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
import { sql } from 'drizzle-orm';
import * as Y from 'yjs';
import type { Mount } from '../../lib/mount/mount';
import {
    DAY_MS,
    DEFAULT_RETENTION,
    HOUR_MS,
    type RetentionPolicy,
    selectSnapshotsToPrune,
} from '../../lib/versioning/retention';
import { formatSnapshotTimestamp, parseSnapshotTimestamp } from '../../lib/versioning/timestamp';
import { authedRequest, chatGet, chatPost, driveGet, drivePost, getTestContext } from '../setup';

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

describe('retention pruning (absolute time buckets)', () => {
    // Absolute bucketing is now-independent, so tests use concrete timestamps.
    const at = (iso: string, id: string) => ({ id, name: formatSnapshotTimestamp(new Date(iso)) });
    const prune = (items: { id: string; name: string }[], policy: RetentionPolicy) =>
        selectSnapshotsToPrune(items, policy)
            .map((s) => s.id)
            .sort();

    test('same hour bucket: keep only the newest', () => {
        const items = [
            at('2026-05-31T10:05:00.000Z', 'a'),
            at('2026-05-31T10:35:00.000Z', 'b'),
            at('2026-05-31T10:55:00.000Z', 'c'),
        ];
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        expect(prune(items, policy)).toEqual(['a', 'b']); // keep c
    });

    test('distinct hour buckets: keep the newest of each', () => {
        const items = [
            at('2026-05-31T08:30:00.000Z', 'a'),
            at('2026-05-31T08:50:00.000Z', 'b'),
            at('2026-05-31T09:10:00.000Z', 'c'),
            at('2026-05-31T09:40:00.000Z', 'd'),
        ];
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        expect(prune(items, policy)).toEqual(['a', 'c']); // keep b (08:00), d (09:00)
    });

    test('keeps only the `count` most recent buckets', () => {
        const items = [
            at('2026-05-31T08:30:00.000Z', 'a'),
            at('2026-05-31T09:30:00.000Z', 'b'),
            at('2026-05-31T10:30:00.000Z', 'c'),
        ];
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 2 }] };
        expect(prune(items, policy)).toEqual(['a']); // keep the two newest hours (b, c)
    });

    test('rolls off beyond the `count` most recent buckets', () => {
        const base = Date.parse('2026-05-31T00:00:00.000Z');
        const items = Array.from({ length: 13 }, (_, i) => at(new Date(base + i * HOUR_MS).toISOString(), `h${i}`));
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 12 }] };
        expect(selectSnapshotsToPrune(items, policy).map((p) => p.id)).toEqual(['h0']); // oldest hour drops
    });

    test('multi-tier union: daily keeps what the hourly window dropped', () => {
        const items = [
            at('2026-05-30T12:00:00.000Z', 'yesterday'),
            at('2026-05-31T09:00:00.000Z', 'today-am'),
            at('2026-05-31T10:00:00.000Z', 'today-late'),
        ];
        // hourly keeps only the most recent hour (today-late); daily keeps the newest
        // of each day (today-late + yesterday). Union drops today-am.
        const policy: RetentionPolicy = {
            buckets: [
                { intervalMs: HOUR_MS, count: 1 },
                { intervalMs: DAY_MS, count: 7 },
            ],
        };
        expect(prune(items, policy)).toEqual(['today-am']);
    });

    test('default policy: a dense hour collapses to one snapshot', () => {
        const base = Date.parse('2026-05-31T10:00:00.000Z');
        const items = Array.from({ length: 50 }, (_, i) => at(new Date(base + i * 60_000).toISOString(), `s${i}`));
        const pruned = selectSnapshotsToPrune(items, DEFAULT_RETENTION);
        expect(pruned).toHaveLength(49);
        expect(pruned.map((p) => p.id)).not.toContain('s49'); // s49 (newest) is kept
    });

    test('ignores names that are not snapshots', () => {
        const items = [
            at('2026-05-31T10:05:00.000Z', 'a'),
            { id: 'junk', name: 'garbage.db' },
            at('2026-05-31T10:55:00.000Z', 'b'),
        ];
        const policy: RetentionPolicy = { buckets: [{ intervalMs: HOUR_MS, count: 24 }] };
        expect(prune(items, policy)).toEqual(['a']); // junk ignored; keep b (newest)
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

        // The restored data.db row's hash must be the sha256 of the restored snapshot's bytes —
        // pins the hasher in replaceContainerDataDb (opening the chat above updates size, never hash).
        const { getHome } = await import('../../lib/home');
        const home = await getHome(ownerId);
        const mount = (home.drive as unknown as { getMount(id: string): Mount }).getMount(aliceMountId);
        const versionsFolder = await mount.getChildByName(chat.id, 'versions');
        const versionFile = await mount.getChildByName(versionsFolder!.id, saved.name);
        const snapshotBytes = await (await mount.readFile(versionFile!.id))!.arrayBuffer();
        const expectedHash = new Bun.CryptoHasher('sha256').update(new Uint8Array(snapshotBytes)).digest('hex');
        const dataDb = await mount.getChildByName(chat.id, 'data.db');
        expect(dataDb?.hash).toBe(expectedHash);
    });

    // replaceContainerDataDb recreates data.db without an onSync, so the chat restore must mark the
    // container contentDirty itself — otherwise body search serves pre-restore content until the
    // next write. (The Yjs restore path converges via DbProvider → sync → onSync; chat has no Y.Doc.)
    test('chat: restore marks the container for content reindex (body search follows the restore)', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;

        const chat = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/chat`, {
            fileName: 'versions-restore-reindex',
        });
        await chatPost(token, ownerId, aliceMountId, `${chat.id}/messages`, { content: 'grobblev1 body' });
        const saved = await saveVersion(token, ownerId, aliceMountId, chat.id);

        const { getHome } = await import('../../lib/home');
        const home = await getHome(ownerId);
        // The save's flush auto-indexed v1; the 2-min cap would defer every later re-extract, so
        // age the index stamp before each drain. Settle the in-flight drain first so it can't
        // overwrite the aged stamp mid-test.
        const mount = (home.drive as unknown as { getMount(id: string): Mount }).getMount(aliceMountId);
        const ageIndexStamp = () => mount.db.run(sql`UPDATE paths SET contentIndexedAt = 0 WHERE id = ${chat.id}`);
        await home.drive.flushContentReindex();

        // Index the pre-restore body (v1 + v2).
        await chatPost(token, ownerId, aliceMountId, `${chat.id}/messages`, { content: 'grobblev2 body' });
        ageIndexStamp();
        await home.drive.flushContainerDb(aliceMountId, chat.id);
        await home.drive.flushContentReindex();
        expect(home.drive.search({ q: 'grobblev2', limit: 20 }).some((h) => h.id === chat.id)).toBe(true);

        await restoreVersion(token, ownerId, aliceMountId, chat.id, saved.name);

        ageIndexStamp();
        await home.drive.flushContentReindex();
        expect(home.drive.search({ q: 'grobblev2', limit: 20 }).some((h) => h.id === chat.id)).toBe(false);
        expect(home.drive.search({ q: 'grobblev1', limit: 20 }).some((h) => h.id === chat.id)).toBe(true);
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
        // hour falls in slot 0, so the pre-restore snapshot taken during restore
        // becomes the newest entry and prunes the older snapshot the user clicked.
        // restoreContainer reads the target's content out up front (before the
        // pre-restore snapshot), so the restore still succeeds even though that
        // prune removes the target from versions/.
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
        const { getHome } = await import('../../lib/home');
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

    test('eigendoc: restore from a corrupt snapshot fails 422 and leaves the live doc untouched', async () => {
        // Seam F (PROPOSAL_DATA_INTEGRITY; collab/Yjs audit #6): replayYjsState
        // skips unreadable blobs, so a restore from a corrupt version file used to
        // "succeed" into a half-empty doc. The restore path must fail loud instead:
        // a clean 422 before any state touches the live Y.Doc.
        const { getHome } = await import('../../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const drive = home.drive;

        const sheetsPath = await drive.create(aliceMountId, aliceRootId, 'versions-corrupt-blob', 'sheets');
        const collab = await drive.getCollabDocument(aliceMountId, sheetsPath.id);
        collab.doc.getMap('state').set('marker', 'V1');
        const saved = await drive.saveVersion(aliceMountId, sheetsPath.id);
        collab.doc.getMap('state').set('marker', 'V2');

        // Corrupt every Yjs blob inside the saved version file on storage.
        const mount = (drive as unknown as { getMount(id: string): Mount }).getMount(aliceMountId);
        const versionsFolder = await mount.getChildByName(sheetsPath.id, 'versions');
        const versionFile = await mount.getChildByName(versionsFolder!.id, saved.name);
        const versionLocalPath = mount.storage.getPath!(await mount.getStorageKey(versionFile!.id));
        const rawDb = new Database(versionLocalPath);
        try {
            rawDb.run(`UPDATE doc_updates SET updateData = X'DEADBEEF'`);
            rawDb.run(`UPDATE doc_snapshots SET stateData = X'DEADBEEF'`);
        } finally {
            rawDb.close();
        }

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${aliceMountId}/file/${sheetsPath.id}/versions/${encodeURIComponent(saved.name)}/restore`,
            { method: 'POST' },
        );
        expect(res.status).toBe(422);

        // The live doc must be untouched — not half-emptied by a "successful" restore.
        expect(collab.doc.getMap('state').get('marker')).toBe('V2');
    });

    test('eigendoc: concurrent restores of the same snapshot do not share a temp file', async () => {
        // P3-1 of the collab/Yjs audit: restore used to key its temp download by the
        // snapshot's path id, so two concurrent restores of the same snapshot shared one
        // temp file — the first's cleanup deleted it under the second's read, which then
        // materialised an empty db and failed with "no such table". Unique per-invocation
        // temp ids make concurrent restores independent: both must succeed. One round
        // only: each restore's pre-restore snapshot prunes the same-hour target (the
        // documented retention behavior), so the saved name doesn't survive a second one.
        const { getHome } = await import('../../lib/home');
        const home = await getHome(ctx.alice.user.id);
        const drive = home.drive;

        const sheetsPath = await drive.create(aliceMountId, aliceRootId, 'versions-concurrent-restore', 'sheets');
        // Hold the doc open for the whole test so restores never open/close it themselves.
        const collab = await drive.getCollabDocument(aliceMountId, sheetsPath.id);
        collab.doc.getMap('state').set('marker', 'V1');
        const saved = await drive.saveVersion(aliceMountId, sheetsPath.id);

        collab.doc.getMap('state').set('marker', 'V2');
        const results = await Promise.allSettled([
            drive.restoreContainer(aliceMountId, sheetsPath.id, saved.name),
            drive.restoreContainer(aliceMountId, sheetsPath.id, saved.name),
        ]);
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(collab.doc.getMap('state').get('marker')).toBe('V1');
    });

    test('eigendoc: restore from the file list does not leak an open collab doc', async () => {
        // Restoring from the drive file list (editor closed) opens the
        // CollabDocument singleton purely to run the surgery. With no subscriber,
        // nothing calls unsubscribe → closeCollabDocument, so the doc + its
        // data.db would leak in Drive.documents until the Home is destructed.
        // restoreYjsContainer must close the doc it opened. Observe Drive.documents
        // directly (private — no production accessor exists just for this).
        const { getHome } = await import('../../lib/home');
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
        const { getHome } = await import('../../lib/home');
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
        // Regression: a chat restore overwrites data.db's bytes from the snapshot.
        // replaceContainerDataDb closes the live db with skipFinalSnapshot — without
        // it ManagedDatabase.close would take a close-time snapshot during eviction
        // which, sharing replaceContainerDataDb's container lock, would deadlock.
        //
        // The close-time snapshot only fires when there are unsnapshotted writes, so
        // the trailing chatPost provides them; save + save puts the target in the same
        // hourly slot as a newer snapshot, so retention would prune it if that
        // eviction snapshot reached the prune step.
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

    test('restore rejects a malformed snapshot name', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const doc = await drivePost<DrivePath>(token, ownerId, aliceMountId, `folder/${aliceRootId}/create/doc`, {
            fileName: 'versions-badname',
        });
        // Not a snapshot filename → rejected by the route's param schema, not a deep 404.
        const res = await authedRequest(
            token,
            `/drive/${ownerId}/${aliceMountId}/file/${doc.id}/versions/not-a-snapshot/restore`,
            { method: 'POST' },
        );
        expect(res.status).toBe(422);
    });
});
