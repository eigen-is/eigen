import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    baseDefaultsFor,
    ELEMENT_KINDS,
    FRAME_HEIGHT,
    FRAME_WIDTH,
    SLIDES_STYLE_DEFAULTS,
    serializeBackgroundFill,
    solidFill,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { exportDocument } from '../../lib/export/export-document';
import { getHome } from '../../lib/home/get-home';
import { seedVectorDoc } from '../fixtures/golden-documents';
import { driveGet, drivePost, getTestContext } from '../setup';

// End-to-end guard for the download/print surface: a collaborator can put arbitrary strings
// in the schemaless canvas scene, so the assembled HTML export must neutralize an attribute-breakout
// color, a script tag and a rich-text body's own hostile markup (a javascript: link, an onerror
// handler) — the same guarantee the preview surface already gives.
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
            // A rich-text body is stored as raw HTML, so it is the widest hostile surface here.
            box.set(
                'html',
                '<p>legit body</p><script>alert(1)</script>' +
                    '<a href="javascript:alert(3)">click</a><img src="x" onerror="alert(4)">',
            );
            box.set('color', 'red;" onload="alert(1)');
            elements.set('e1', box);
        });

        const { mount, path } = await home.drive.resolveFile('default', deckPath.id);
        const html = (await exportDocument(mount, path, 'html')).data.toString('utf-8');

        // No live script tag and no attribute breakout survive into the download.
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/"\s*onload/i);
        expect(html).not.toMatch(/javascript:/i);
        expect(html).not.toMatch(/onerror/i);
        // Legitimate body content still renders.
        expect(html).toContain('legit body');
    });

    // A deck is flat by virtue of its style table's roughness 0, not by a kind that refuses to sketch:
    // the backdrop a drawing paints as a jittered drawable is the crisp box here.
    test('a rich-text box created with the deck style renders a flat backdrop', async () => {
        const deckPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            'default',
            `folder/${rootId}/create/slides`,
            { fileName: 'flat-deck' },
        );

        const box: VectorRichTextElement = {
            ...baseDefaultsFor('richtext', SLIDES_STYLE_DEFAULTS),
            ...ELEMENT_KINDS.richtext.defaults(SLIDES_STYLE_DEFAULTS),
            id: 'flat-box',
            type: 'richtext',
            index: 'a0',
            frameId: 'f1',
            x: 160,
            y: 120,
            width: 800,
            height: 300,
            angle: 0,
            seed: 7,
            html: '<p>Flat</p>',
            // The paint a user picks on a fresh box: the kind creates unfilled and unbordered.
            corners: 'straight',
            fill: solidFill('#eef2ff'),
            strokeColor: '#1e1e1e',
        };
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument('default', deckPath.id);
        seedVectorDoc(collab.doc, {
            elements: [box],
            frames: [
                {
                    id: 'f1',
                    index: 'a0',
                    name: '',
                    width: FRAME_WIDTH,
                    height: FRAME_HEIGHT,
                    background: serializeBackgroundFill({ type: 'solid', color: '#ffffff' }),
                },
            ],
            meta: { background: 'transparent' },
        });

        const { mount, path } = await home.drive.resolveFile('default', deckPath.id);
        const html = (await exportDocument(mount, path, 'html')).data.toString('utf-8');

        const backdrop = html.match(/<g stroke-linecap="round">(.*?)<\/g>/)?.[1] ?? '';
        // The fill is the box corner to corner, where a sketched one starts off the corner.
        expect(backdrop).toContain('<path d="M0 0 L800 0 L800 300 L0 300" fill="#eef2ff" stroke="none">');
        // And the border traces that same box: every point sits on it, none wanders past an edge.
        const border = backdrop.match(/<path d="([^"]+)" stroke="#1e1e1e"/)?.[1] ?? '';
        const points = [...border.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
        expect(points.length).toBeGreaterThan(0);
        expect(points.every(([x, y]) => x >= 0 && x <= 800 && y >= 0 && y <= 300)).toBe(true);
    });

    // A deck with no frames has no page to size the document from, so the export refuses rather
    // than serving an empty sheet (the drawing export does the same for an empty drawing).
    test('exporting a frameless deck is rejected with 400', async () => {
        const deckPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            'default',
            `folder/${rootId}/create/slides`,
            { fileName: 'empty-deck' },
        );
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile('default', deckPath.id);
        await expect(exportDocument(mount, path, 'html')).rejects.toThrow('The deck is empty');
    });
});
