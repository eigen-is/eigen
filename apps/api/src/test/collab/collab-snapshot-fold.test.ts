import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import { docSnapshots, docUpdates } from '../../lib/collab/schema';
import { loadYjsState } from '../../lib/collab/yjs-loader';
import { getHome } from '../../lib/home/get-home';
import type { Home } from '../../lib/home/home';
import { driveGet, drivePost, getTestContext } from '../setup';

// Every 100 stored updates fold into one snapshot. data.db then keeps that snapshot and the updates after it.
describe('a collab document folds its updates into one snapshot', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let home: Home;
    let rootId: string;
    const mountId = 'default';

    beforeAll(async () => {
        ctx = await getTestContext();
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        home = await getHome(ctx.alice.user.id);
    });

    test('250 updates leave the newest snapshot and the 50 updates after it', async () => {
        const created = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'snapshot-fold' },
        );
        const collab = await home.drive.getCollabDocument(mountId, created.id);
        try {
            const map = collab.doc.getMap('fold');
            for (let i = 0; i < 250; i++) map.set('n', i);

            const managedDb = await home.drive.openDatabase(mountId, COLLAB_DB_CONFIG, collab.dataDbPathId!);
            const snapshots = managedDb.db.select().from(docSnapshots).all();
            const updates = managedDb.db.select().from(docUpdates).all();
            expect(snapshots).toHaveLength(1);
            expect(updates).toHaveLength(50);
            expect(updates.every((update) => update.id > snapshots[0].lastUpdateId)).toBe(true);

            const { doc: loaded } = loadYjsState(managedDb);
            expect(loaded.getMap('fold').get('n')).toBe(249);
        } finally {
            await home.drive.closeCollabDocument(mountId, created.id);
        }
    });
});
