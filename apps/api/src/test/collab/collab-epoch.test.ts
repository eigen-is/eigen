import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    COLLAB_EPOCH_MESSAGE,
    COLLAB_HOME_REPLACED_CLOSE,
    COLLAB_HOME_REPLACED_REASON,
} from '@workspace/lib/constants/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as decoding from 'lib0/decoding';
import { COLLAB_EPOCH_FILE, getCollabEpoch } from '../../lib/collab/epoch';
import { driveGet, drivePost, getTestContext, TEST_DATA_DIR } from '../setup';

// A tab that loaded a document before ./eigen restore holds state the restored data lacks, and its sync would merge it
// back. The epoch tells such a tab from one that was only offline: the open hands it out, and a reconnect that names
// another one is closed like a home replaced, so the tab reloads instead. Needs a real listening server.

type Opened = { epoch: string | null; synced: boolean; close: { code: number; reason: string } | null };

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let port: number;
let url: string;

// Reads frames until the server's sync step 1 or a close, noting the epoch frame and whether it came first.
function open(query = ''): Promise<Opened> {
    const ws = new WebSocket(`${url}${query}`, {
        headers: { cookie: `better-auth.session_token=${ctx.alice.user.sessionToken}` },
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const opened: Opened = { epoch: null, synced: false, close: null };
    return new Promise((resolve, reject) => {
        ws.onmessage = ({ data }) => {
            const decoder = decoding.createDecoder(new Uint8Array(data as ArrayBuffer));
            const type = decoding.readVarUint(decoder);
            if (type === COLLAB_EPOCH_MESSAGE && !opened.synced) opened.epoch = decoding.readVarString(decoder);
            if (type === 0 && decoding.readVarUint(decoder) === 0) {
                opened.synced = true;
                ws.close();
                resolve(opened);
            }
        };
        ws.onclose = ({ code, reason }) => {
            opened.close = { code, reason };
            resolve(opened);
        };
        ws.onerror = (event) => reject(event);
    });
}

beforeAll(async () => {
    ctx = await getTestContext();
    const ownerId = ctx.alice.user.id;
    const token = ctx.alice.user.sessionToken;
    const { data: mounts } = await ctx.alice.api.drive({ ownerId }).mounts.get();
    const mountId = mounts![0].id;
    const root = await driveGet<DrivePath>(token, ownerId, mountId, 'root');
    const doc = await drivePost<DrivePath>(token, ownerId, mountId, `folder/${root.id}/create/doc`, {
        fileName: 'Epoch probe',
    });
    const listenPort = ctx.app.listen(0).server?.port;
    expect(listenPort).toBeDefined();
    port = listenPort!;
    url = `ws://localhost:${port}/ws/collab/${ownerId}/${mountId}/${doc.id}`;
});

afterAll(() => {
    ctx.app.stop();
});

describe('Collab data epoch', () => {
    test('is kept in data/server/, so it outlives a restart', () => {
        const epoch = getCollabEpoch();
        expect(readFileSync(join(TEST_DATA_DIR, 'server', COLLAB_EPOCH_FILE), 'utf8')).toBe(epoch);
    });

    test('an open hands it out before the sync', async () => {
        const opened = await open();
        expect(opened.synced).toBe(true);
        expect(opened.epoch).toBe(getCollabEpoch());
    });

    test('a reconnect with the same epoch syncs, so an offline edit survives a restart', async () => {
        const opened = await open(`?epoch=${getCollabEpoch()}`);
        expect(opened.synced).toBe(true);
        expect(opened.close?.code).not.toBe(COLLAB_HOME_REPLACED_CLOSE);
    });

    test('a reconnect with another epoch is closed 1012 home-replaced before any sync', async () => {
        const opened = await open('?epoch=before-the-restore');
        expect(opened.synced).toBe(false);
        expect(opened.close).toEqual({ code: COLLAB_HOME_REPLACED_CLOSE, reason: COLLAB_HOME_REPLACED_REASON });
    });
});
