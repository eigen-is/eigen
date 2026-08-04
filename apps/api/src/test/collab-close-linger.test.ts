import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { ServerWebSocket } from 'bun';
import CollabDocument from '../lib/collab/collabDocument';
import { getHome } from '../lib/home/get-home';
import type { Home } from '../lib/home/home';
import { driveGet, drivePost, getTestContext } from './setup';

// Teardown linger: the last unsubscribe schedules the close instead of running it
// immediately, so an instant reconnect (tab reload, y-websocket retry loop)
// reattaches to the loaded doc instead of re-paying S3 download + materialization —
// the amplification half of the 2026-08-04 reconnect spiral.

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

    // A directly-constructed doc with a test-sized linger; close calls are counted on
    // the drive seam the linger timer fires into (home-pin test precedent for the
    // method patch).
    async function openLingeringDoc(fileName: string, closeLingerMs: number) {
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

        const doc = await new CollabDocument(home.drive, path, { closeLingerMs }).init();
        return {
            doc,
            calls: () => closeCalls,
            restore: () => {
                home.drive.closeCollabDocument = original;
            },
        };
    }

    test('the last unsubscribe schedules teardown instead of closing immediately', async () => {
        const { doc, calls, restore } = await openLingeringDoc('linger-schedules', 60);
        try {
            const conn = makeSpyConn();
            doc.subscribe(home.user, conn);
            doc.unsubscribe(home.user, conn);

            expect(calls()).toBe(0);
            await Bun.sleep(150);
            expect(calls()).toBe(1);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('a reconnect within the linger window cancels the teardown and reuses the doc', async () => {
        const { doc, calls, restore } = await openLingeringDoc('linger-reuses', 80);
        try {
            const first = makeSpyConn();
            doc.subscribe(home.user, first);
            doc.unsubscribe(home.user, first);
            expect(calls()).toBe(0);

            await Bun.sleep(20);
            const second = makeSpyConn();
            doc.subscribe(home.user, second);
            // The reconnect attached to the live doc and got its sync-step-1.
            expect(doc.connectionCount).toBe(1);
            expect(second.sent.length).toBeGreaterThanOrEqual(1);

            await Bun.sleep(200);
            expect(calls()).toBe(0);

            // The linger re-arms once the reused session ends.
            doc.unsubscribe(home.user, second);
            await Bun.sleep(200);
            expect(calls()).toBe(1);
        } finally {
            restore();
            doc.destruct();
        }
    });

    test('destruct cancels a pending linger teardown', async () => {
        const { doc, calls, restore } = await openLingeringDoc('linger-destruct', 60);
        try {
            const conn = makeSpyConn();
            doc.subscribe(home.user, conn);
            doc.unsubscribe(home.user, conn);
            doc.destruct();

            await Bun.sleep(150);
            expect(calls()).toBe(0);
        } finally {
            restore();
        }
    });
});
