import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { exportDocument } from '../../lib/export/export-document';
import { getHome } from '../../lib/home/get-home';
import { driveGet, drivePost, getTestContext } from '../setup';

// End-to-end guard for the download/print surface: a collaborator can put arbitrary strings
// in the schemaless canvas scene, so the assembled HTML export must neutralize both an attribute-
// breakout color and a script tag — the same guarantee the preview surface already gives.
describe('deck export — assembled HTML surface', () => {
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
            const elements = collab.doc.getMap('elements');
            const frames = collab.doc.getMap('frames');

            const frame = new Y.Map();
            frame.set('id', 'f1');
            frame.set('index', 'a0');
            frame.set('name', '');
            // A breakout attempt in the stored background: the fill codec must refuse it outright.
            frame.set('background', '{"type":"solid","color":"red;\\"><script>alert(2)</script>"}');
            frames.set('f1', frame);

            const box = new Y.Map();
            box.set('id', 'e1');
            box.set('type', 'richtext');
            box.set('index', 'a0');
            box.set('frameId', 'f1');
            box.set('x', 0);
            box.set('y', 0);
            box.set('width', 200);
            box.set('height', 100);
            box.set('fontSize', 24);
            box.set('html', '<p>legit body</p><script>alert(1)</script>');
            box.set('color', 'red;" onload="alert(1)');
            elements.set('e1', box);
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
