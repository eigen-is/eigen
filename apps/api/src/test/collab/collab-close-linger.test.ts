import { afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'elysia/ws/bun';
import { CollabDocument } from '../../lib/collab/collab-document';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { driveGet, drivePost, getTestContext } from '../setup';

// The last unsubscribe schedules the close instead of running it at once. A reconnect right after, such
// as a tab reload or a y-websocket retry, then reattaches to the loaded document instead of downloading
// and loading it again.

// How long a document with no socket stays open.
const CLOSE_LINGER_MS = 60_000;

type SpyConn = ServerWebSocket<undefined> & { readyState: number; sent: Uint8Array[] };

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        sent: [] as Uint8Array[],
        send(data: Uint8Array) {
            conn.sent.push(data);
        },
        close() {
            conn.readyState = 3;
        },
    };
    return conn as unknown as SpyConn;
}

describe('CollabDocument close linger', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let home: Home;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        home = await getHome(ctx.alice.user.id);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // A new doc, whose closes are counted on the drive call the linger timer makes. `closing` is the last
    // close that call started, so a test can wait for its teardown to end.
    async function createCountedDoc(fileName: string) {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName },
        );
        const { path } = await home.drive.resolveFile(mountId, docPath.id);

        let closeCalls = 0;
        let lastClose = Promise.resolve();
        const original = home.drive.closeCollabDocument.bind(home.drive);
        home.drive.closeCollabDocument = async (...args: Parameters<typeof original>) => {
            closeCalls++;
            lastClose = original(...args);
            return lastClose;
        };
        return {
            path,
            calls: () => closeCalls,
            closing: () => lastClose,
            restore: () => {
                home.drive.closeCollabDocument = original;
            },
        };
    }

    // The timers are fake before the open, so the linger that init arms is fake too, and the test moves
    // the clock past it itself.
    async function openLingeringDoc(fileName: string) {
        const counted = await createCountedDoc(fileName);
        jest.useFakeTimers();
        const doc = await CollabDocument.open(home.drive, counted.path);
        return { doc, ...counted };
    }

    test('the last unsubscribe schedules teardown instead of closing immediately', async () => {
        const { doc, calls, restore } = await openLingeringDoc('linger-schedules');
        try {
            const conn = makeSpyConn();
            doc.subscribe(home.user, conn);
            doc.unsubscribe(conn);

            jest.advanceTimersByTime(CLOSE_LINGER_MS - 1);
            expect(calls()).toBe(0);
            jest.advanceTimersByTime(1);
            expect(calls()).toBe(1);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('a reconnect within the linger window cancels the teardown and reuses the doc', async () => {
        const { doc, calls, restore } = await openLingeringDoc('linger-reuses');
        try {
            const first = makeSpyConn();
            doc.subscribe(home.user, first);
            doc.unsubscribe(first);
            expect(calls()).toBe(0);

            jest.advanceTimersByTime(CLOSE_LINGER_MS / 2);
            const second = makeSpyConn();
            doc.subscribe(home.user, second);
            // The reconnect attached to the live doc and got its sync-step-1.
            expect(doc.connectionCount).toBe(1);
            expect(second.sent.length).toBeGreaterThanOrEqual(1);

            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(calls()).toBe(0);

            // The linger re-arms once the reused session ends.
            doc.unsubscribe(second);
            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(calls()).toBe(1);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('destruct cancels a pending linger teardown', async () => {
        const { doc, calls, restore } = await openLingeringDoc('linger-destruct');
        try {
            const conn = makeSpyConn();
            doc.subscribe(home.user, conn);
            doc.unsubscribe(conn);
            doc.destruct();

            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(calls()).toBe(0);
        } finally {
            restore();
        }
    });

    // A server-side writer, such as an import or a convert, opens a document no socket subscribes to.
    test('a document opened with no socket closes after the linger', async () => {
        const { path, closing, restore } = await createCountedDoc('linger-no-socket');
        try {
            jest.useFakeTimers();
            await home.drive.getCollabDocument(mountId, path.id);

            jest.advanceTimersByTime(CLOSE_LINGER_MS - 1);
            expect(home.drive.hasCollabDocument(mountId, path.id)).toBe(true);
            jest.advanceTimersByTime(1);
            expect(home.drive.hasCollabDocument(mountId, path.id)).toBe(false);
            await closing();
        } finally {
            restore();
            jest.useRealTimers();
            await home.drive.closeCollabDocument(mountId, path.id);
        }
    });

    test('a socket that subscribes to a document nobody had open keeps it open', async () => {
        const { path, calls, closing, restore } = await createCountedDoc('linger-socket-cancels');
        try {
            jest.useFakeTimers();
            const doc = await home.drive.getCollabDocument(mountId, path.id);
            const conn = makeSpyConn();
            doc.subscribe(home.user, conn);

            jest.advanceTimersByTime(CLOSE_LINGER_MS * 3);
            expect(calls()).toBe(0);
            expect(home.drive.hasCollabDocument(mountId, path.id)).toBe(true);

            doc.unsubscribe(conn);
            jest.advanceTimersByTime(CLOSE_LINGER_MS);
            expect(calls()).toBe(1);
            await closing();
        } finally {
            restore();
            jest.useRealTimers();
            await home.drive.closeCollabDocument(mountId, path.id);
        }
    });
});
