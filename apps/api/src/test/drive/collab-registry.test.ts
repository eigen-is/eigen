import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { teamOwnerId } from '@workspace/lib/types';
import CollabDocument from '../../lib/collab/collabDocument';
import { ApiError } from '../../lib/core/errors';
import { getSyntheticTeamUser, TeamHome } from '../../lib/home/team-home';
import { waitFor } from '../fault-storage-helpers';
import { getTestContext } from '../setup';

// A Home's teardown destructs every open collab document, then closes the mounts' databases. Each test
// tears down a Home of its own.
describe('collab documents at Home teardown', () => {
    const homeDirs: string[] = [];

    beforeAll(async () => {
        await getTestContext();
    });

    afterAll(() => {
        for (const dir of homeDirs) rmSync(dir, { recursive: true, force: true });
    });

    async function homeWithDoc(): Promise<{ home: TeamHome; mountId: string; docId: string }> {
        const owner = teamOwnerId(randomUUID().replace(/-/g, ''));
        const home = new TeamHome(getSyntheticTeamUser(owner, 'Teardown Team'));
        homeDirs.push(home.homeDir);
        await home.init();
        const { id: mountId } = await home.addMount({ name: 'Teardown' });
        const root = await home.drive.getRootFolder(mountId);
        const doc = await home.drive.create(mountId, root!.id, 'teardown', 'doc');
        return { home, mountId, docId: doc.id };
    }

    test('an open that starts after the documents are destructed is refused', async () => {
        const { home, mountId, docId } = await homeWithDoc();
        const [mount] = home.drive.getMounts();
        const closeAllDatabases = mount.closeAllDatabases.bind(mount);
        let lateOpen: unknown = null;
        spyOn(mount, 'closeAllDatabases').mockImplementationOnce(async () => {
            lateOpen = await home.drive.getCollabDocument(mountId, docId).catch((e: unknown) => e);
            return closeAllDatabases();
        });

        await home.shutdown();

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
            const shutdown = home.shutdown();
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
