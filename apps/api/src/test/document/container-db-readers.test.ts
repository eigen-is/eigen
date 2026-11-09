import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { readChatContent } from '../../lib/document/chat';
import { readStickiesContent } from '../../lib/document/stickies';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import type { Mount } from '../../lib/mount';
import { IDLE_CLOSE_MS } from '../../lib/mount/document-db';
import { chatPost, driveGet, drivePost, getTestContext } from '../setup';

// A reader, such as the content reindex, holds a container's data.db only while it reads. Once it lets
// go, the database closes after the idle window, unless an open collab document still holds it.

describe('container database readers', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let home: Home;
    const mountId = 'default';
    let rootId: string;
    let releaseHome: () => void;

    beforeAll(async () => {
        ctx = await getTestContext();
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        home = await getHome(ctx.alice.user.id);
        // The Home idles out as fast as a database does, so the fake clock below would close it too.
        releaseHome = home.hold();
    });

    afterAll(() => releaseHome());

    afterEach(() => {
        jest.useRealTimers();
    });

    async function dataDbOf(containerId: string): Promise<{ mount: Mount; path: DrivePath; dataDbId: string }> {
        const { mount, path } = await home.drive.resolveFile(mountId, containerId);
        const dataDb = await mount.getChildByName(path.id, 'data.db');
        if (!dataDb) throw new Error(`${path.name} has no data.db`);
        return { mount, path, dataDbId: dataDb.id };
    }

    // The idle close runs on the slot's chain, so waiting for the chain waits for the close.
    async function passIdleWindow(mount: Mount, dataDbId: string): Promise<void> {
        const slot = mount.documentDbs.get(dataDbId);
        jest.advanceTimersByTime(IDLE_CLOSE_MS);
        await slot?.tail;
    }

    test('a new board that nobody reads closes after the idle window', async () => {
        jest.useFakeTimers();
        const board = await home.drive.create(mountId, rootId, 'created-never-read', 'stickies', home.user);
        const { mount, dataDbId } = await dataDbOf(board.id);

        expect(mount.documentDbs.get(dataDbId)?.db).toBeTruthy();
        await passIdleWindow(mount, dataDbId);
        expect(mount.documentDbs.get(dataDbId)?.db ?? null).toBeNull();
    });

    test('readStickiesContent leaves the board closed after the idle window', async () => {
        const board = await home.drive.create(mountId, rootId, 'reader-closes-board', 'stickies', home.user);
        const { mount, path, dataDbId } = await dataDbOf(board.id);
        jest.useFakeTimers();

        await readStickiesContent(mount, path);
        expect(mount.documentDbs.get(dataDbId)?.db).toBeTruthy();
        await passIdleWindow(mount, dataDbId);
        expect(mount.documentDbs.get(dataDbId)?.db ?? null).toBeNull();
    });

    test('readChatContent leaves the chat closed after the idle window', async () => {
        const chat = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/chat`,
            { fileName: 'reader-closes-chat' },
        );
        await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
            content: 'read me once',
        });
        const { mount, path, dataDbId } = await dataDbOf(chat.id);
        jest.useFakeTimers();

        expect(await readChatContent(mount, path, 10_000)).toContain('read me once');
        await passIdleWindow(mount, dataDbId);
        expect(mount.documentDbs.get(dataDbId)?.db ?? null).toBeNull();
    });

    test('a reader of an open board does not close the database the board writes to', async () => {
        const board = await home.drive.create(mountId, rootId, 'reader-open-board', 'stickies', home.user);
        const { mount, path, dataDbId } = await dataDbOf(board.id);
        // The document arms its own close linger on real timers, so the fake clock below moves only the
        // reader's idle close.
        const collab = await home.drive.getCollabDocument(mountId, board.id);
        try {
            jest.useFakeTimers();
            await readStickiesContent(mount, path);
            await passIdleWindow(mount, dataDbId);
            jest.useRealTimers();

            // An edit after the window still reaches data.db.
            collab.doc.transact(() => {
                const card = new Y.Map();
                card.set('title', 'written after the reader');
                collab.doc.getMap('tasks').set('t1', card);
            });
            await home.drive.flushContainerDb(mountId, board.id);
            const content = await readStickiesContent(mount, path);
            expect(content.tasks.map((task) => task.title)).toEqual(['written after the reader']);
        } finally {
            await home.drive.closeCollabDocument(mountId, board.id);
        }
    });
});
