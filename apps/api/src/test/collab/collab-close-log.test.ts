import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import { evictHome } from '../../lib/home/get-home';
import { waitFor } from '../fault-storage-helpers';
import { createTestUser, driveGet, drivePost, getTestContext, type TestUser } from '../setup';

// A socket the Home's teardown closes reaches the route's close handler after the document has dropped
// every connection. Needs a real listening server.

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let user: TestUser;
let url: string;

beforeAll(async () => {
    ctx = await getTestContext();
    user = await createTestUser('collab-close-log@test.eigen.is', 'testpassword123', 'Close Log');
    const mountId = 'default';
    const root = await driveGet<DrivePath>(user.sessionToken, user.id, mountId, 'root');
    const doc = await drivePost<DrivePath>(user.sessionToken, user.id, mountId, `folder/${root.id}/create/doc`, {
        fileName: 'Close log probe',
    });
    const port = ctx.app.listen(0).server?.port;
    url = `ws://localhost:${port}/ws/collab/${user.id}/${mountId}/${doc.id}`;
});

afterAll(() => {
    ctx.app.stop();
});

describe('collab close log', () => {
    test('a socket closed by the Home teardown logs no negative connection count', async () => {
        const ws = new WebSocket(url, {
            headers: { cookie: `better-auth.session_token=${user.sessionToken}` },
        } as unknown as string[]);
        ws.binaryType = 'arraybuffer';
        let synced = false;
        let closed = false;
        ws.onmessage = ({ data }) => {
            const decoder = decoding.createDecoder(new Uint8Array(data as ArrayBuffer));
            if (decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === 0) synced = true;
        };
        ws.onclose = () => {
            closed = true;
        };
        await waitFor(() => synced, 10_000);

        const logs = spyOn(console, 'log');
        try {
            await evictHome(user.id);
            await waitFor(() => closed, 10_000);
            await waitFor(() => logs.mock.calls.some(([line]) => String(line).startsWith('[collab] close ')), 10_000);
            const closeLines = logs.mock.calls
                .map(([line]) => String(line))
                .filter((l) => l.startsWith('[collab] close '));
            expect(closeLines.some((l) => l.includes('connections=-1'))).toBe(false);
        } finally {
            logs.mockRestore();
        }
    });
});
