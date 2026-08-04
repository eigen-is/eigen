import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { readDeckFromDoc } from '../lib/document/slides';
import { captureCollabSource } from '../lib/document/transform/collab-source';
import { getHome } from '../lib/home/get-home';
import { readPersistedDoc } from './fixtures/transform-results';
import { driveGet, drivePost, getTestContext } from './setup';

describe('document/slides', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    test('reads deck with slides + objects', async () => {
        const slidesPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/slides`,
            { fileName: 'deck-read' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, slidesPath.id);

        collab.doc.transact(() => {
            const slidesMap = collab.doc.getMap('slides');
            const objectsMap = collab.doc.getMap('objects');
            const slideOrderArray = collab.doc.getArray('slideOrder');

            const objYMap = new Y.Map();
            objYMap.set('id', 'obj-1');
            objYMap.set('slideId', 'slide-1');
            objYMap.set('type', 'text');
            objYMap.set('text', 'Hello slides');
            objectsMap.set('obj-1', objYMap);

            const slideYMap = new Y.Map();
            slideYMap.set('id', 'slide-1');
            slideYMap.set('background', { type: 'solid', color: '#112233' });
            const objectIds = new Y.Array();
            objectIds.push(['obj-1']);
            slideYMap.set('objectIds', objectIds);
            slidesMap.set('slide-1', slideYMap);

            slideOrderArray.push(['slide-1']);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, slidesPath.id);
        const persisted = await readPersistedDoc(mount, path);
        const deck = readDeckFromDoc(persisted);

        expect(deck.slideOrder).toEqual(['slide-1']);
        expect(deck.slides['slide-1']).toMatchObject({
            id: 'slide-1',
            objectIds: ['obj-1'],
            background: { type: 'solid', color: '#112233' },
        });
        expect(deck.objects['obj-1']).toMatchObject({
            id: 'obj-1',
            slideId: 'slide-1',
            type: 'text',
            text: 'Hello slides',
        });
        persisted.destroy();
    });

    test('throws when data.db is missing', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName: 'no-data-db.eigenslides' },
        );

        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, folder.id);

        await expect(captureCollabSource(mount, path)).rejects.toThrow('data.db missing');
    });
});
