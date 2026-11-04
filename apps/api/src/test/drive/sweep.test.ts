import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Sheet, SheetImage } from '@workspace/lib/sheets';
import { encodeSheetsSnapshot, sheetsOpLog, sheetsStateMap } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { eigenMediaHref } from '@workspace/lib/vector';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { CLOSE_LINGER_MS } from '../../lib/collab/collab-document';
import { REFERENCE_READER_VERSION } from '../../lib/document/references';
import type { Drive } from '../../lib/drive/drive';
import { isSweepDue, sweepDocument } from '../../lib/drive/sweep';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount/mount';
import { paths } from '../../lib/mount/schema';
import { getVersionReferences, putVersionReferences } from '../../lib/mount/version-references';
import { DAY_MS, HOUR_MS } from '../../lib/versioning/retention';
import type { FakeS3Mount } from '../fault-storage-helpers';
import { createFakeS3Mount, removeFakeS3Mount, waitFor } from '../fault-storage-helpers';
import { seedEigendoc } from '../fixtures/golden-documents';
import { createTestUserOnStorage } from '../setup';

const M = 'default';
// Older than the three days a fresh upload is spared.
const OLD_HOURS = 100;

let home: Home;
let drive: Drive;
let mount: Mount;
let rootId: string;

beforeAll(async () => {
    const user = await createTestUserOnStorage('local-fullnames', 'Sweep');
    home = await getHome(user.id);
    drive = home.drive;
    const root = await drive.getRootFolder(M);
    if (!root) throw new Error('no root folder');
    rootId = root.id;
    ({ mount } = await drive.resolveFile(M, rootId));
});

afterEach(() => {
    jest.useRealTimers();
});

const paragraph = (...content: object[]) => ({ type: 'paragraph', content });
const figure = (mediaName: string) => ({ type: 'figure', attrs: { mediaName } });
const marked = (cardId: string) => ({ type: 'text', text: 'Marked', marks: [{ type: 'comment', attrs: { cardId } }] });

// A comment card as the comment hooks write it.
function addCard(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
    const card = new Y.Map<unknown>();
    card.set('id', id);
    card.set('title', id);
    card.set('description', '');
    for (const [field, value] of Object.entries(fields)) card.set(field, value);
    doc.getMap('comments').set(id, card);
}

// An open doc whose body is the given paragraphs, one block each.
async function openDoc(sweepMount: Mount, mountId: string, name: string, blocks: object[]) {
    const root = await sweepMount.getRootFolder();
    if (!root) throw new Error('no root folder');
    const path = await drive.create(mountId, root.id, `${name}-${crypto.randomUUID()}`, 'doc');
    const collab = await drive.getCollabDocument(mountId, path.id);
    seedEigendoc(collab.doc, { type: 'doc', content: blocks });
    return { path, collab };
}

// A file in the document's media folder, uploaded `ageHours` ago.
async function addMedia(
    sweepMount: Mount,
    containerId: string,
    name: string,
    opts: { ageHours?: number; mimeType?: string; body?: string } = {},
): Promise<string> {
    const media = await sweepMount.getChildByName(containerId, 'media');
    if (!media) throw new Error('no media folder');
    const body = Buffer.from(opts.body ?? `bytes of ${name}`);
    const id = await sweepMount.createFile(media.id, name, opts.mimeType ?? 'image/png', body.length, body);
    const createdAt = new Date(Date.now() - (opts.ageHours ?? OLD_HOURS) * HOUR_MS);
    sweepMount.db.update(paths).set({ createdAt }).where(eq(paths.id, id)).run();
    return id;
}

async function mediaNames(sweepMount: Mount, containerId: string): Promise<string[]> {
    const media = await sweepMount.getChildByName(containerId, 'media');
    if (!media) throw new Error('no media folder');
    return (await sweepMount.listFolder(media.id)).map((file) => file.name).sort();
}

// The state as the document closes, then the close, with no version of its own.
async function close(mountId: string, path: DrivePath, doc: Y.Doc): Promise<Uint8Array> {
    const state = Y.encodeStateAsUpdate(doc);
    await drive.closeCollabDocument(mountId, path.id, { skipFinalSnapshot: true });
    return state;
}

async function versionIds(sweepMount: Mount, containerId: string): Promise<string[]> {
    const versions = await sweepMount.getChildByName(containerId, 'versions');
    return versions ? (await sweepMount.listFolder(versions.id)).map((file) => file.id) : [];
}

describe('the media sweep', () => {
    test('a file no state names goes, one the current state names stays', async () => {
        const { path, collab } = await openDoc(mount, M, 'Plain', [paragraph(figure('kept.png'))]);
        await addMedia(mount, path.id, 'kept.png');
        await addMedia(mount, path.id, 'loose.png');

        await sweepDocument(drive, path, await close(M, path, collab.doc));
        expect(await mediaNames(mount, path.id)).toEqual(['kept.png']);
    });

    test('an image deleted before every retained version goes', async () => {
        const { path, collab } = await openDoc(mount, M, 'Deleted', [paragraph(figure('a.png')), paragraph()]);
        await addMedia(mount, path.id, 'a.png');
        collab.doc.getXmlFragment('default').delete(0, 1);
        await drive.saveVersion(M, path.id);

        await sweepDocument(drive, path, await close(M, path, collab.doc));
        expect(await mediaNames(mount, path.id)).toEqual([]);
    });

    test('an image a retained version names stays until that version is deleted', async () => {
        const { path, collab } = await openDoc(mount, M, 'Versioned', [paragraph(figure('a.png')), paragraph()]);
        await addMedia(mount, path.id, 'a.png');
        await drive.saveVersion(M, path.id);
        collab.doc.getXmlFragment('default').delete(0, 1);
        const state = await close(M, path, collab.doc);

        await sweepDocument(drive, path, state);
        expect(await mediaNames(mount, path.id)).toEqual(['a.png']);

        for (const id of await versionIds(mount, path.id)) await mount.deletePath(id);
        await sweepDocument(drive, path, state);
        expect(await mediaNames(mount, path.id)).toEqual([]);
    });

    test('a file under three days old stays', async () => {
        const { path, collab } = await openDoc(mount, M, 'Young', [paragraph()]);
        await addMedia(mount, path.id, 'young.png', { ageHours: 71 });
        await addMedia(mount, path.id, 'old.png', { ageHours: 73 });

        await sweepDocument(drive, path, await close(M, path, collab.doc));
        expect(await mediaNames(mount, path.id)).toEqual(['young.png']);
    });

    test("a card's attachment stays while the card is in use", async () => {
        const { path, collab } = await openDoc(mount, M, 'Card', [paragraph(marked('c1'))]);
        addCard(collab.doc, 'c1', { attachments: ['card.pdf'] });
        addCard(collab.doc, 'c-loose', { attachments: ['loose.pdf'] });
        await addMedia(mount, path.id, 'card.pdf', { mimeType: 'application/pdf' });
        await addMedia(mount, path.id, 'loose.pdf', { mimeType: 'application/pdf' });

        await sweepDocument(drive, path, await close(M, path, collab.doc));
        expect(await mediaNames(mount, path.id)).toEqual(['card.pdf']);
    });

    test("an SVG figure's sibling media stay, to the inline depth", async () => {
        const { path, collab } = await openDoc(mount, M, 'Svg', [paragraph(figure('outer.svg'))]);
        const svg = (...names: string[]) =>
            `<svg xmlns="http://www.w3.org/2000/svg">${names.map((name) => `<image href="${eigenMediaHref(name)}"/>`).join('')}</svg>`;
        const asSvg = (body: string) => ({ mimeType: 'image/svg+xml', body });
        await addMedia(mount, path.id, 'outer.svg', asSvg(svg('inner.svg', 'leaf.png')));
        await addMedia(mount, path.id, 'inner.svg', asSvg(svg('deep.png')));
        await addMedia(mount, path.id, 'leaf.png');
        await addMedia(mount, path.id, 'deep.png');
        await addMedia(mount, path.id, 'loose.png');

        await sweepDocument(drive, path, await close(M, path, collab.doc));
        expect(await mediaNames(mount, path.id)).toEqual(['deep.png', 'inner.svg', 'leaf.png', 'outer.svg']);
    });

    test('an open document is never swept', async () => {
        const { path, collab } = await openDoc(mount, M, 'Open', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');

        await sweepDocument(drive, path, Y.encodeStateAsUpdate(collab.doc));
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        await drive.closeCollabDocument(M, path.id, { skipFinalSnapshot: true });
    });

    // The delete phase takes the container's lock, so a change that lands right before it stands in for one made
    // while the sweep read. The change may take the lock itself, so it runs on the first take only.
    async function changeBeforeDelete(containerId: string, change: () => Promise<void>): Promise<() => void> {
        const original = mount.withPathLock.bind(mount);
        let pending = true;
        const spy = spyOn(mount, 'withPathLock').mockImplementation(async (pathId, fn) => {
            if (pending && pathId === containerId) {
                pending = false;
                await change();
            }
            return original(pathId, fn);
        });
        return () => spy.mockRestore();
    }

    test('a reopen between the read and the delete aborts the delete', async () => {
        const { path, collab } = await openDoc(mount, M, 'Reopened', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        const state = await close(M, path, collab.doc);
        const restore = await changeBeforeDelete(path.id, async () => {
            await drive.getCollabDocument(M, path.id);
        });
        try {
            await sweepDocument(drive, path, state);
        } finally {
            restore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        expect(isSweepDue(path)).toBe(true);
        await drive.closeCollabDocument(M, path.id, { skipFinalSnapshot: true });
    });

    test('a version saved between the read and the delete aborts the delete', async () => {
        const { path, collab } = await openDoc(mount, M, 'Saved', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        const state = await close(M, path, collab.doc);
        const restore = await changeBeforeDelete(path.id, async () => {
            await drive.saveVersion(M, path.id);
        });
        try {
            await sweepDocument(drive, path, state);
        } finally {
            restore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
    });

    test('a version that fails to load sweeps nothing, and the next sweep tries again', async () => {
        const { path, collab } = await openDoc(mount, M, 'Corrupt', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        await drive.saveVersion(M, path.id);
        const [versionId] = await versionIds(mount, path.id);
        if (!versionId) throw new Error('no version');
        await mount.writeFile(versionId, Buffer.from('not a database'));
        const state = await close(M, path, collab.doc);

        await expect(sweepDocument(drive, path, state)).rejects.toThrow();
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        // A failure waits a day, so a version that never reads costs one try a day.
        expect(isSweepDue(path)).toBe(false);

        await mount.deletePath(versionId);
        await sweepDocument(drive, path, state);
        expect(await mediaNames(mount, path.id)).toEqual([]);
    });

    test('a reader that throws sweeps nothing', async () => {
        const { path, collab } = await openDoc(mount, M, 'Unreadable', [paragraph()]);
        addCard(collab.doc, 'c-odd', { chatName: 42 });
        await addMedia(mount, path.id, 'loose.png');

        await expect(sweepDocument(drive, path, await close(M, path, collab.doc))).rejects.toThrow();
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        expect(isSweepDue(path)).toBe(false);
    });

    test("the drive's size drops by the deleted bytes", async () => {
        const { path, collab } = await openDoc(mount, M, 'Size', [paragraph()]);
        const body = 'x'.repeat(5_000);
        await addMedia(mount, path.id, 'loose.png', { body });
        const state = await close(M, path, collab.doc);
        const before = { drive: await drive.size(M), container: (await mount.getPath(path.id))?.size ?? 0 };

        await sweepDocument(drive, path, state);
        expect(await drive.size(M)).toBe(before.drive - body.length);
        expect((await mount.getPath(path.id))?.size).toBe(before.container - body.length);
    });

    test('a version is read once, and again when its row is from an older reader', async () => {
        const { path, collab } = await openDoc(mount, M, 'Scanned', [paragraph()]);
        await drive.saveVersion(M, path.id);
        const [versionId] = await versionIds(mount, path.id);
        if (!versionId) throw new Error('no version');
        const state = await close(M, path, collab.doc);
        const downloads = spyOn(mount, 'downloadToTemp');
        const versionReads = () => downloads.mock.calls.filter(([id]) => id === versionId).length;
        try {
            await sweepDocument(drive, path, state);
            expect(getVersionReferences(mount, [versionId])).toEqual([
                { versionPathId: versionId, readerVersion: REFERENCE_READER_VERSION, names: { media: [], chat: [] } },
            ]);
            await sweepDocument(drive, path, state);
            expect(versionReads()).toBe(1);

            // A row an older reader wrote is no record: its names keep nothing, and the version is read again.
            putVersionReferences(mount, [
                {
                    versionPathId: versionId,
                    readerVersion: REFERENCE_READER_VERSION - 1,
                    names: { media: ['stale.png'], chat: [] },
                },
            ]);
            await addMedia(mount, path.id, 'stale.png');
            await sweepDocument(drive, path, state);
            expect(versionReads()).toBe(2);
            expect(await mediaNames(mount, path.id)).toEqual([]);
            expect(getVersionReferences(mount, [versionId])[0]?.readerVersion).toBe(REFERENCE_READER_VERSION);
        } finally {
            downloads.mockRestore();
        }
    });

    test('a version that fails to load keeps the rows of the versions read before it', async () => {
        const { path, collab } = await openDoc(mount, M, 'Partial', [paragraph()]);
        const older = await drive.saveVersion(M, path.id);
        await mount.writeFile(older.id, Buffer.from('not a database'));
        collab.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
        // Versions are read newest first, so the newer one is read before the older one fails.
        const newer = await drive.saveVersion(M, path.id);

        await expect(sweepDocument(drive, path, await close(M, path, collab.doc))).rejects.toThrow();
        expect(getVersionReferences(mount, [older.id, newer.id]).map((row) => row.versionPathId)).toEqual([newer.id]);
    });

    test('a name that differs from its file only in case or in Unicode form keeps the file', async () => {
        const decomposed = 'Café.png'.normalize('NFD');
        const { path, collab } = await openDoc(mount, M, 'Case', [
            paragraph(figure('Photo.PNG')),
            paragraph(figure(decomposed)),
        ]);
        await addMedia(mount, path.id, 'photo.png');
        await addMedia(mount, path.id, decomposed);

        await sweepDocument(drive, path, await close(M, path, collab.doc));
        expect(await mediaNames(mount, path.id)).toEqual(['Café.png'.normalize('NFC'), 'photo.png']);
    });

    test('a trash under way when the delete starts aborts the delete', async () => {
        const { path, collab } = await openDoc(mount, M, 'Trashed', [paragraph()]);
        const loose = await addMedia(mount, path.id, 'loose.png');
        const state = await close(M, path, collab.doc);
        // The trash waits before it marks the rows, until the sweep is done.
        const started = Promise.withResolvers<void>();
        const swept = Promise.withResolvers<void>();
        const original = mount.trashPath.bind(mount);
        const trashPath = spyOn(mount, 'trashPath').mockImplementation(async (pathId) => {
            started.resolve();
            await swept.promise;
            return original(pathId);
        });
        let trashing: Promise<void> | null = null;
        const restore = await changeBeforeDelete(path.id, async () => {
            trashing = drive.deletePath(M, path.id);
            await started.promise;
        });
        try {
            await sweepDocument(drive, path, state);
        } finally {
            swept.resolve();
            restore();
            await trashing;
            trashPath.mockRestore();
        }
        expect(await mount.getPath(loose)).not.toBeNull();
    });

    test('a data.db replaced between the read and the delete aborts the delete', async () => {
        const other = await openDoc(mount, M, 'Other', [
            paragraph({ type: 'text', text: Array.from({ length: 2_000 }, () => crypto.randomUUID()).join(' ') }),
        ]);
        await close(M, other.path, other.collab.doc);
        const otherDataDb = await mount.getChildByName(other.path.id, 'data.db');
        if (!otherDataDb) throw new Error('no data.db');
        const { path, collab } = await openDoc(mount, M, 'Replaced', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        const state = await close(M, path, collab.doc);
        const tempId = crypto.randomUUID();
        const source = await mount.downloadToTemp(otherDataDb.id, tempId);
        const restore = await changeBeforeDelete(path.id, () => mount.replaceContainerDataDb(path.id, source));
        try {
            await sweepDocument(drive, path, state);
        } finally {
            restore();
            await mount.cleanupTemp(tempId);
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
        expect(isSweepDue(path)).toBe(true);
    });

    test('a restore under way when the delete starts aborts the delete', async () => {
        const { path, collab } = await openDoc(mount, M, 'Restoring', [paragraph()]);
        await addMedia(mount, path.id, 'loose.png');
        const version = await drive.saveVersion(M, path.id);
        const state = await close(M, path, collab.doc);
        // The restore waits at its first step, the download of the version, until the sweep is done. Nothing it does
        // before that step moves the fence.
        const started = Promise.withResolvers<void>();
        const swept = Promise.withResolvers<void>();
        let restoring: Promise<void> | null = null;
        const original = mount.downloadToTemp.bind(mount);
        const download = spyOn(mount, 'downloadToTemp').mockImplementation(async (pathId, tempId) => {
            if (restoring && pathId === version.id) {
                started.resolve();
                await swept.promise;
            }
            return original(pathId, tempId);
        });
        const restore = await changeBeforeDelete(path.id, async () => {
            restoring = Promise.resolve().then(() => drive.restoreContainer(M, path.id, version.name));
            await started.promise;
        });
        try {
            await sweepDocument(drive, path, state);
        } finally {
            swept.resolve();
            restore();
            await restoring;
            download.mockRestore();
        }
        expect(await mediaNames(mount, path.id)).toEqual(['loose.png']);
    });
});

describe('the sweep after a linger close', () => {
    // The open arms the linger on fake timers, and the clock moves past it. A sweep takes a hold on the Home before the
    // close starts, so the holds taken once the linger ran out count the sweeps, and the last release ends one.
    async function lingerClose(path: DrivePath): Promise<{ sweeps: number; swept: Promise<void> }> {
        jest.useFakeTimers();
        await drive.getCollabDocument(M, path.id);
        const original = drive.holdHome.bind(drive);
        const swept = Promise.withResolvers<void>();
        const holds = spyOn(drive, 'holdHome').mockImplementation((onClosing) => {
            const release = original(onClosing);
            return () => {
                release();
                swept.resolve();
            };
        });
        try {
            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            jest.useRealTimers();
            await waitFor(() => !drive.hasCollabDocument(M, path.id), 20_000);
            const sweeps = holds.mock.calls.length;
            return { sweeps, swept: sweeps > 0 ? swept.promise : Promise.resolve() };
        } finally {
            holds.mockRestore();
        }
    }

    test('sweeps once, and a second close the same day does not', async () => {
        const { path, collab } = await openDoc(mount, M, 'Lingered', [paragraph()]);
        await addMedia(mount, path.id, 'first.png');
        await close(M, path, collab.doc);

        const first = await lingerClose(path);
        expect(first.sweeps).toBe(1);
        await first.swept;
        expect(await mediaNames(mount, path.id)).toEqual([]);
        expect(isSweepDue(path)).toBe(false);

        await addMedia(mount, path.id, 'second.png');
        expect((await lingerClose(path)).sweeps).toBe(0);
        expect(await mediaNames(mount, path.id)).toEqual(['second.png']);
    });

    test('a sweep that fails is not tried again that day, but is the next day', async () => {
        const { path, collab } = await openDoc(mount, M, 'Failing', [paragraph()]);
        addCard(collab.doc, 'c-odd', { chatName: 42 });
        await close(M, path, collab.doc);
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const first = await lingerClose(path);
            expect(first.sweeps).toBe(1);
            await first.swept;
            expect(warn).toHaveBeenCalled();
            expect((await lingerClose(path)).sweeps).toBe(0);
        } finally {
            warn.mockRestore();
        }
        const tomorrow = Date.now() + DAY_MS;
        const clock = spyOn(Date, 'now').mockReturnValue(tomorrow);
        try {
            expect(isSweepDue(path)).toBe(true);
        } finally {
            clock.mockRestore();
        }
    });

    test('a workbook whose close folded its op log is swept after it', async () => {
        const created = await drive.create(M, rootId, `Folded-${crypto.randomUUID()}`, 'sheets');
        const { path } = await drive.resolveFile(M, created.id);
        const collab = await drive.getCollabDocument(M, path.id);
        const sheet: Sheet = { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], images: {} };
        const image: SheetImage = { id: 'i1', index: 'a0', x: 0, y: 0, width: 10, height: 10, mediaName: 'op.png' };
        collab.doc.transact(() => {
            sheetsStateMap(collab.doc).set('snapshot', encodeSheetsSnapshot([sheet], { computed: true }));
            sheetsOpLog(collab.doc).push([[{ op: 'add', id: 'sheet-1', path: ['images', 'i1'], value: image }]]);
        });
        await addMedia(mount, path.id, 'op.png');
        await addMedia(mount, path.id, 'loose.png');
        await close(M, path, collab.doc);

        const closed = await lingerClose(path);
        expect(closed.sweeps).toBe(1);
        await closed.swept;
        expect(await mediaNames(mount, path.id)).toEqual(['op.png']);
        const reopened = await drive.getCollabDocument(M, path.id);
        expect(sheetsOpLog(reopened.doc).length).toBe(0);
        await drive.closeCollabDocument(M, path.id, { skipFinalSnapshot: true });
    });
});

describe('the media sweep on s3', () => {
    const TEST_DIR = join(import.meta.dir, `../../../../../data-test/test-sweep-s3-${Date.now()}`);
    const S3_MOUNT = 'sweep-s3';
    let s3: FakeS3Mount;

    beforeAll(async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        s3 = await createFakeS3Mount(home, TEST_DIR, S3_MOUNT);
    });

    afterAll(async () => {
        await removeFakeS3Mount(s3);
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    test('reads a version still staged and deletes what nothing names', async () => {
        const { path, collab } = await openDoc(s3.mount, S3_MOUNT, 'Bucket', [
            paragraph(figure('versioned.png')),
            paragraph(figure('kept.png')),
        ]);
        for (const name of ['versioned.png', 'kept.png', 'loose.png']) await addMedia(s3.mount, path.id, name);
        const { uploadQueue } = s3.mount;
        if (!uploadQueue) throw new Error('no upload queue');
        // The version's upload never starts, so it is read from its staged copy.
        const held = spyOn(uploadQueue, 'drain').mockResolvedValue();
        try {
            await drive.saveVersion(S3_MOUNT, path.id);
            const [versionId] = await versionIds(s3.mount, path.id);
            if (!versionId) throw new Error('no version');
            expect(s3.mount.pendingStagedCopy(await s3.mount.getStorageKey(versionId))).not.toBeNull();
            collab.doc.getXmlFragment('default').delete(0, 1);

            await sweepDocument(drive, path, await close(S3_MOUNT, path, collab.doc));
            expect(await mediaNames(s3.mount, path.id)).toEqual(['kept.png', 'versioned.png']);
        } finally {
            held.mockRestore();
            await uploadQueue.drain({ flushNow: true });
        }
    });
});
