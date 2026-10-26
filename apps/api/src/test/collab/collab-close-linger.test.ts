import { afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'elysia/ws/bun';
import { CLOSE_LINGER_MS, CollabDocument } from '../../lib/collab/collab-document';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { driveGet, drivePost, getTestContext } from '../setup';

// The last unsubscribe schedules the close instead of running it at once. A reconnect right after, such
// as a tab reload or a y-websocket retry, then reattaches to the loaded document instead of downloading
// and loading it again.

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

    // A document built here, whose closes are counted on the drive call the linger timer makes. The
    // timers are fake from the open on, so the test moves the clock past the linger itself.
    async function openLingeringDoc(fileName: string) {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName },
        );
        const { path } = await home.drive.resolveFile(mountId, docPath.id);

        let closeCalls = 0;
        const original = home.drive.closeCollabDocument.bind(home.drive);
        home.drive.closeCollabDocument = async (...args: Parameters<typeof original>) => {
            closeCalls++;
            return original(...args);
        };

        const doc = new CollabDocument(home.drive, path);
        await doc.init();
        jest.useFakeTimers();
        return {
            doc,
            calls: () => closeCalls,
            restore: () => {
                home.drive.closeCollabDocument = original;
            },
        };
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
});
