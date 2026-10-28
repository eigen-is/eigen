import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { teamOwnerId } from '@workspace/lib/types';
import type { ServerWebSocket } from 'elysia/ws/bun';
import { CollabDocument } from '../../lib/collab/collab-document';
import { ApiError } from '../../lib/core/errors';
import { getSyntheticTeamUser, TeamHome } from '../../lib/home/team-home';
import { waitFor } from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// Each test builds a team Home of its own, with one document on a team mount.
const homeDirs: string[] = [];

beforeAll(async () => {
    await getTestContext();
});

afterAll(() => {
    for (const dir of homeDirs) rmSync(dir, { recursive: true, force: true });
});

async function homeWithDoc(): Promise<{ home: TeamHome; mountId: string; docId: string }> {
    const owner = teamOwnerId(crypto.randomUUID().replace(/-/g, ''));
    const home = new TeamHome(getSyntheticTeamUser(owner, 'Teardown Team'));
    homeDirs.push(home.homeDir);
    await home.init();
    const { id: mountId } = await home.addMount({ name: 'Teardown' });
    const root = await home.drive.getRootFolder(mountId);
    const doc = await home.drive.create(mountId, root!.id, 'teardown', 'doc');
    return { home, mountId, docId: doc.id };
}

type SpyConn = ServerWebSocket<undefined> & { readyState: number };

function makeSpyConn(): SpyConn {
    const conn = {
        readyState: 1, // OPEN
        send() {},
        close() {
            conn.readyState = 3; // CLOSED
        },
    };
    return conn as unknown as SpyConn;
}

// A Home's teardown destructs every open collab document, then closes the mounts' databases.
describe('collab documents at Home teardown', () => {
    test('an open that starts after the documents are destructed is refused', async () => {
        const { home, mountId, docId } = await homeWithDoc();
        const [mount] = home.drive.getMounts();
        const closeAllDatabases = mount.closeAllDatabases.bind(mount);
        let lateOpen: unknown = null;
        spyOn(mount, 'closeAllDatabases').mockImplementationOnce(async () => {
            lateOpen = await home.drive.getCollabDocument(mountId, docId).catch((e: unknown) => e);
            return closeAllDatabases();
        });

        await home.close();

        expect(lateOpen).toBeInstanceOf(ApiError);
        expect(home.drive.hasCollabDocument(mountId, docId)).toBe(false);
    });

    test('an open the teardown aborts is not logged as a failed close', async () => {
        const { home, mountId, docId } = await homeWithDoc();
        let failLoad: ((error: unknown) => void) | undefined;
        const init = spyOn(CollabDocument.prototype, 'init').mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    failLoad = reject;
                }),
        );
        const opening = home.drive.getCollabDocument(mountId, docId).catch(() => {});
        await waitFor(() => failLoad !== undefined);
        const errors = spyOn(console, 'error');
        try {
            const shutdown = home.close();
            failLoad!(new ApiError(503, 'Storage unavailable'));
            await shutdown;
            await opening;
            expect(errors.mock.calls.some(([message]) => String(message).includes('Failed to close document'))).toBe(
                false,
            );
        } finally {
            errors.mockRestore();
            init.mockRestore();
        }
    });
});

// A mount that gets new storage, or is turned off, closes its databases. Its open documents close
// first, so every edit they hold is saved, and the tabs reconnect to the new mount.
describe('collab documents when a team mount changes', () => {
    async function openAndEdit(home: TeamHome, mountId: string, docId: string) {
        const doc = await home.drive.getCollabDocument(mountId, docId);
        const conn = makeSpyConn();
        doc.subscribe(home.user, conn);
        doc.doc.getText('body').insert(0, 'kept');
        return { doc, conn };
    }

    test('new storage closes the open document, and a reopen edits through the new mount', async () => {
        const { home, mountId, docId } = await homeWithDoc();
        const errors = spyOn(console, 'error');
        try {
            const { doc, conn } = await openAndEdit(home, mountId, docId);

            // A local mount with an s3Config has a new storage identity, so the mount is built again.
            await home.updateMount(mountId, {
                s3Config: {
                    endpoint: 'https://s3.example.com',
                    bucket: 'b',
                    prefix: '',
                    accessKeyId: 'AK',
                    secretAccessKey: 'SK',
                },
            });

            expect(conn.readyState).toBe(3);
            expect(home.drive.hasCollabDocument(mountId, docId)).toBe(false);
            const reopened = await home.drive.getCollabDocument(mountId, docId);
            expect(reopened).not.toBe(doc);
            expect(reopened.doc.getText('body').toString()).toBe('kept');

            reopened.doc.getText('body').insert(4, ' too');
            await home.drive.closeCollabDocument(mountId, docId);
            const again = await home.drive.getCollabDocument(mountId, docId);
            expect(again.doc.getText('body').toString()).toBe('kept too');
            expect(errors.mock.calls.some(([message]) => String(message).includes('[DbProvider]'))).toBe(false);
        } finally {
            errors.mockRestore();
            await home.close();
        }
    });

    test('turning the mount off closes the open document, and its edits are there when it comes back', async () => {
        const { home, mountId, docId } = await homeWithDoc();
        const errors = spyOn(console, 'error');
        try {
            const { doc, conn } = await openAndEdit(home, mountId, docId);

            await home.updateMount(mountId, { enabled: false });

            expect(conn.readyState).toBe(3);
            expect(home.drive.hasCollabDocument(mountId, docId)).toBe(false);

            await home.updateMount(mountId, { enabled: true });
            const reopened = await home.drive.getCollabDocument(mountId, docId);
            expect(reopened).not.toBe(doc);
            expect(reopened.doc.getText('body').toString()).toBe('kept');
            expect(errors.mock.calls.some(([message]) => String(message).includes('[DbProvider]'))).toBe(false);
        } finally {
            errors.mockRestore();
            await home.close();
        }
    });

    test('a socket that waited for a document the mount closed meanwhile is refused', async () => {
        const { home, mountId, docId } = await homeWithDoc();
        const { promise: loaded, resolve: finishLoad } = Promise.withResolvers<void>();
        const realInit = CollabDocument.prototype.init;
        let loading = false;
        const init = spyOn(CollabDocument.prototype, 'init').mockImplementationOnce(async function (
            this: CollabDocument,
        ) {
            loading = true;
            await loaded;
            return realInit.call(this);
        });
        try {
            const opening = home.drive.getCollabDocument(mountId, docId);
            await waitFor(() => loading);
            const turnedOff = home.updateMount(mountId, { enabled: false });
            finishLoad();
            await turnedOff;

            const doc = await opening;
            const refusal = (() => {
                try {
                    doc.subscribe(home.user, makeSpyConn());
                } catch (error) {
                    return error;
                }
            })();
            expect(refusal).toBeInstanceOf(ApiError);
            expect(refusal instanceof ApiError && refusal.status).toBe(503);
        } finally {
            init.mockRestore();
            await home.close();
        }
    });

    test('an open that starts while the mount closes is refused', async () => {
        const { home, mountId, docId } = await homeWithDoc();
        const [mount] = home.drive.getMounts();
        const closeAllDatabases = mount.closeAllDatabases.bind(mount);
        let lateOpen: unknown = null;
        spyOn(mount, 'closeAllDatabases').mockImplementationOnce(async () => {
            lateOpen = await home.drive.getCollabDocument(mountId, docId).catch((e: unknown) => e);
            return closeAllDatabases();
        });
        try {
            await home.updateMount(mountId, { enabled: false });

            expect(lateOpen).toBeInstanceOf(ApiError);
            expect(home.drive.hasCollabDocument(mountId, docId)).toBe(false);
        } finally {
            await home.close();
        }
    });
});
