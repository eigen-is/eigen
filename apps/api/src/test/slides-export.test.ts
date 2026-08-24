import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { exportDocument } from '../lib/export/export-document';
import { getHome } from '../lib/home/get-home';
import { driveGet, drivePost, getTestContext } from './setup';

// End-to-end guard for the download/print surface: a collaborator can put arbitrary strings
// in the schemaless deck, so the assembled HTML export must neutralize both an attribute-
// breakout color and a script tag — the same guarantee the preview surface already gives.
describe('slides export — assembled HTML surface', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, 'default', 'root');
        rootId = root.id;
    });

    test('neutralizes an injected script and breakout color in the exported HTML', async () => {
        const deckPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            'default',
            `folder/${rootId}/create/slides`,
            { fileName: 'xss-deck' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument('default', deckPath.id);
        collab.doc.transact(() => {
            const slidesMap = collab.doc.getMap('slides');
            const objectsMap = collab.doc.getMap('objects');
            const slideOrder = collab.doc.getArray('slideOrder');

            const obj = new Y.Map();
            obj.set('id', 'o1');
            obj.set('slideId', 's1');
            obj.set('type', 'text');
            obj.set('x', 0);
            obj.set('y', 0);
            obj.set('width', 200);
            obj.set('height', 100);
            obj.set('fontSize', 24);
            obj.set('text', '<p>legit body</p><script>alert(1)</script>');
            obj.set('color', 'red;" onload="alert(1)');
            objectsMap.set('o1', obj);

            const slide = new Y.Map();
            slide.set('id', 's1');
            slide.set('background', { type: 'solid', color: 'red;"><script>alert(2)</script>' });
            const objectIds = new Y.Array();
            objectIds.push(['o1']);
            slide.set('objectIds', objectIds);
            slidesMap.set('s1', slide);

            slideOrder.push(['s1']);
        });

        const { mount, path } = await home.drive.resolveFile('default', deckPath.id);
        const html = (await exportDocument(mount, path, 'html')).data.toString('utf-8');

        // No live script tag and no attribute breakout survive into the download.
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/"\s*onload/i);
        // Legitimate body content still renders.
        expect(html).toContain('legit body');
    });
});
