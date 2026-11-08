import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from 'bun:test';
import {
    COLLAB_ACCESS_LOST_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_REASON,
} from '@workspace/lib/constants/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import { evictHome, getHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import type { TestUser } from '../setup';
import { createTestUser, driveDelete, driveGet, drivePost, getTestContext } from '../setup';

// An open collab socket holds the Home of the document's owner, so the Home never goes idle under an editor. A Home
// that closes anyway, such as for a restore or a deletion, closes the socket with the retry close, and the tab
// reconnects to the next one. Needs a real listening server.

const USER_IDLE_MS = 5 * 60_000;

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let user: TestUser;
let url: string;
let socketBase: string;
let rootId: string;
let docId: string;

beforeAll(async () => {
    ctx = await getTestContext();
    user = await createTestUser('collab-home-hold@test.eigen.is', 'testpassword123', 'Home Hold');
    const mountId = 'default';
    const root = await driveGet<DrivePath>(user.sessionToken, user.id, mountId, 'root');
    rootId = root.id;
    const doc = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${root.id}/create/doc`, {
        fileName: 'Home hold probe',
    });
    docId = doc.id;
    const port = ctx.app.listen(0).server?.port;
    socketBase = `ws://localhost:${port}/ws/collab/${user.id}/${mountId}`;
    url = `${socketBase}/${docId}`;
});

afterEach(() => {
    jest.useRealTimers();
});

afterAll(() => {
    ctx.app.stop();
});

// `synced` turns true on the server's sync step 1, which the route sends once the open is done.
function openSocket(sessionToken = user.sessionToken, socketUrl = url) {
    const ws = new WebSocket(socketUrl, {
        headers: { cookie: `better-auth.session_token=${sessionToken}` },
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    let synced = false;
    ws.onmessage = ({ data }) => {
        if (!(data instanceof ArrayBuffer)) return;
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === 0) synced = true;
    };
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    return { ws, synced: () => synced, closed };
}

describe('a collab socket holds its Home', () => {
    test('the Home stays open past the idle with no keepalive tick, and its close closes the socket with 1013', async () => {
        const socket = openSocket();
        await waitFor(socket.synced, 10_000);
        const home = await getHome(user.id);

        jest.useFakeTimers();
        // A request re-arms the idle on the fake clock, and the socket's keepalive is on the real one. So only the
        // socket's hold can keep the Home past the idle.
        home.touch();
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(false);
        jest.useRealTimers();

        await evictHome(user.id);
        expect(await socket.closed).toEqual({
            code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
            reason: COLLAB_STORAGE_UNAVAILABLE_REASON,
        });
    });

    // The document lingers after the last socket leaves, and it holds the Home until the linger ends.
    test('a socket that leaves lets its Home go idle once its document closes', async () => {
        const socket = openSocket();
        await waitFor(socket.synced, 10_000);
        const home = await getHome(user.id);
        const logs = spyOn(console, 'log');
        try {
            socket.ws.close();
            await socket.closed;
            // The route logs the close once it has cleaned up the session, its hold included.
            await waitFor(() => logs.mock.calls.some(([line]) => String(line).startsWith('[collab] close ')), 10_000);
        } finally {
            logs.mockRestore();
        }

        jest.useFakeTimers();
        home.touch();
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(false);
        jest.useRealTimers();

        // The end of the linger, without the wait.
        await home.drive.closeCollabDocument('default', docId);
        jest.useFakeTimers();
        home.touch();
        jest.advanceTimersByTime(USER_IDLE_MS + 60_000);
        expect(home.closing).toBe(true);
        jest.useRealTimers();
        await home.close();
    });

    // A user who may not read the document never holds its owner's Home.
    test('a socket refused for access does not hold the Home', async () => {
        const home = await getHome(user.id);
        const holds = spyOn(home, 'hold');
        try {
            const socket = openSocket(ctx.bob.user.sessionToken);
            expect(await socket.closed).toEqual({ code: COLLAB_ACCESS_LOST_CLOSE, reason: 'Access denied' });
            expect(holds).not.toHaveBeenCalled();
        } finally {
            holds.mockRestore();
        }
    });

    // Only a Home close sends 1013. A document that closes alone, such as a trashed one, lets the tab reconnect
    // quickly and silently.
    test('a trashed document closes its socket without 1013', async () => {
        const doc = await drivePost<DrivePath>(user.sessionToken, user.id, 'default', `folder/${rootId}/create/doc`, {
            fileName: 'Trash probe',
        });
        const socket = openSocket(user.sessionToken, `${socketBase}/${doc.id}`);
        await waitFor(socket.synced, 10_000);

        await driveDelete(user.sessionToken, user.id, 'default', `path/${doc.id}`);

        const { code } = await socket.closed;
        expect(code).not.toBe(COLLAB_STORAGE_UNAVAILABLE_CLOSE);
    });

    // The Home starts to close after getSharedDrive found it and before the socket holds it.
    test('a socket that opens on a closing Home is closed with 1013', async () => {
        const home = await getHome(user.id);
        const touch = home.touch.bind(home);
        let closing: Promise<void> | undefined;
        home.touch = () => {
            closing ??= home.close();
            return touch();
        };

        const socket = openSocket();
        expect(await socket.closed).toEqual({
            code: COLLAB_STORAGE_UNAVAILABLE_CLOSE,
            reason: COLLAB_STORAGE_UNAVAILABLE_REASON,
        });
        await closing;
        expect(socket.synced()).toBe(false);
    });
});
