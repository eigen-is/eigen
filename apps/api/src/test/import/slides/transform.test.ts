import { describe, expect, spyOn, test } from 'bun:test';
import {
    DEFAULT_SCENE_META,
    parseBackgroundFill,
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    type VectorElement,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import * as Y from 'yjs';
import { appendSlidesUpdateToYjs, writeSlidesUpdateToYjs } from '../../../lib/document/slides';
import { type SlidesImportJob, toTransferableBuffer } from '../../../lib/document/transform/protocol';
import { runImportToSlidesUpdate } from '../../../lib/document/transform/run-transform';
import { importPptxToSlidesUpdate } from '../../../lib/import/slides/transform';
import { box, buildPptx, cxn, graphicFrame, PIXEL_PNG, para, pic, rel, solid, sp, xfrm } from '../../fixtures/pptx';

// pptx bytes → the transform's update → the deck writer: what a deck holds after a Convert and after an Import.

const JOB = { frame: { width: 1920, height: 1080 }, maxMediaBytes: 35 * 1024 * 1024 };

const PPTX = buildPptx({
    masters: [
        {
            bg: `<p:bgPr>${solid('102030')}</p:bgPr>`,
            shapes: sp({ xfrm: box(1800, 0, 120, 60), spPr: solid('00FF00') }),
        },
    ],
    slides: [
        {
            shapes:
                sp({ ph: '<p:ph type="title"/>', xfrm: box(100, 50, 1000, 100), text: para('Welcome') }) +
                sp({ xfrm: box(100, 300, 400, 200), geom: 'roundRect', spPr: solid('FF0000') }) +
                cxn({
                    xfrm: box(600, 300, 300, 0),
                    ln: `<a:ln w="12700">${solid('0000FF')}<a:tailEnd type="arrow"/></a:ln>`,
                }),
        },
        {
            bg: `<p:bgPr>${solid('FFFFFF')}</p:bgPr>`,
            shapes:
                pic({ xfrm: box(0, 0, 960, 540), embed: 'rId2' }) +
                graphicFrame('http://schemas.openxmlformats.org/drawingml/2006/table', 0, 0, 635000, 635000),
            rels: rel('rId2', 'image', '../media/image1.png'),
        },
    ],
    files: { 'ppt/media/image1.png': PIXEL_PNG },
});

const byFrame = (elements: VectorElement[], frameId: string) => elements.filter((el) => el.frameId === frameId);

describe('a pptx converted to a deck', () => {
    test('holds its slides as frames and its shapes as validated elements, the master beneath', () => {
        const { update, images, warnings } = importPptxToSlidesUpdate(toTransferableBuffer(PPTX), JOB);
        const doc = new Y.Doc();
        writeSlidesUpdateToYjs(doc, new Uint8Array(update));
        const scene = readVectorFromDoc(doc);

        expect(scene.frames.map((frame) => frame.name)).toEqual(['Welcome', '']);
        expect(scene.frames.map((frame) => parseBackgroundFill(frame.background))).toEqual([
            { type: 'solid', color: '#102030' },
            { type: 'solid', color: '#ffffff' },
        ]);
        const [one, two] = scene.frames;
        expect(byFrame(scene.elements, one.id).map((el) => el.type)).toEqual([
            'rectangle',
            'richtext',
            'rectangle',
            'arrow',
        ]);
        const [logo, title, shape, arrow] = byFrame(scene.elements, one.id);
        expect(logo).toMatchObject({ x: 1800, y: 0, width: 120, height: 60, corners: 'straight', roughness: 0 });
        expect(title).toMatchObject({
            type: 'richtext',
            html: '<p>Welcome</p>',
            strokeColor: 'transparent',
            corners: 'straight',
            roughness: 0,
            fontFamily: 'Inter',
        });
        expect(shape).toMatchObject({
            corners: 'curved',
            strokeColor: 'transparent',
            fill: expect.stringContaining('#ff0000'),
        });
        expect(arrow).toMatchObject({
            endArrowhead: 'arrow',
            startArrowhead: 'none',
            strokeColor: '#0000ff',
            strokeWidth: 2,
        });

        const [secondLogo, image, table] = byFrame(scene.elements, two.id);
        expect(secondLogo).toMatchObject({ type: 'rectangle', x: 1800, y: 0, width: 120, height: 60 });
        expect(image).toMatchObject({
            type: 'image',
            mediaName: images[0].name,
            objectFit: 'fill',
            width: 960,
            height: 540,
        });
        expect(table).toMatchObject({ type: 'richtext', html: '<p>Table not imported</p>' });
        expect(new Uint8Array(images[0].data)).toEqual(PIXEL_PNG);
        expect(warnings).toEqual([{ code: 'tables-dropped', count: 1 }]);
    });

    test("given no frame, fits the slides to the frame the file's slide size picks, and the deck takes the scene's meta", () => {
        const fourThree = buildPptx({
            sldSz: '<p:sldSz cx="9144000" cy="6858000"/>',
            slides: [{ shapes: sp({ xfrm: xfrm(0, 0, 9144000, 6858000), spPr: solid('FF0000') }) }],
        });
        const { update } = importPptxToSlidesUpdate(toTransferableBuffer(fourThree), {
            maxMediaBytes: JOB.maxMediaBytes,
        });
        const doc = new Y.Doc();
        writeSlidesUpdateToYjs(doc, new Uint8Array(update));
        expect(readVectorFromDoc(doc).elements[0]).toMatchObject({ x: 240, y: 0, width: 1440, height: 1080 });
        expect(doc.getMap('meta').get('background')).toBe(DEFAULT_SCENE_META.background);
    });

    test('appended to a deck, it lands after its slides and leaves them as they were', () => {
        const doc = new Y.Doc();
        writeFrameInDoc(doc, { id: 'mine', index: 'a0', name: 'Mine' });
        writeElementInDoc(
            doc,
            { type: 'ellipse', frameId: 'mine', x: 1, y: 2, width: 3, height: 4 },
            'a0',
            SLIDES_STYLE_DEFAULTS,
            'own',
        );
        const { update } = importPptxToSlidesUpdate(toTransferableBuffer(PPTX), JOB);
        appendSlidesUpdateToYjs(doc, new Uint8Array(update));
        const scene = readVectorFromDoc(doc);
        expect(scene.frames.map((frame) => frame.name)).toEqual(['Mine', 'Welcome', '']);
        expect(scene.elements[0]).toMatchObject({ id: 'own', frameId: 'mine' });
        expect(scene.elements).toHaveLength(8);
    });

    test('a hostile extent is held to the canvas range by the deck writer', () => {
        const far = buildPptx({
            slides: [
                {
                    shapes: sp({
                        xfrm: `<a:xfrm><a:off x="0" y="0"/><a:ext cx="9000000000000000" cy="635000"/></a:xfrm>`,
                        spPr: solid('FF0000'),
                    }),
                },
            ],
        });
        const doc = new Y.Doc();
        writeSlidesUpdateToYjs(doc, new Uint8Array(importPptxToSlidesUpdate(toTransferableBuffer(far), JOB).update));
        expect(readVectorFromDoc(doc).elements[0].width).toBe(1_000_000);
    });

    test('runs in the transform process, its warnings and refusals crossing the boundary', async () => {
        spyOn(console, 'log').mockImplementation(() => {});
        const job: SlidesImportJob = { kind: 'import', sourceFormat: 'pptx', targetType: 'eigenslides', ...JOB };
        const { update, images } = await runImportToSlidesUpdate(job, toTransferableBuffer(PPTX), {});
        const doc = new Y.Doc();
        writeSlidesUpdateToYjs(doc, new Uint8Array(update));
        expect(readVectorFromDoc(doc).frames).toHaveLength(2);
        expect(images).toHaveLength(1);
        const pptm = buildPptx({
            slides: [{}],
            mainType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
        });
        const refused = await runImportToSlidesUpdate(job, toTransferableBuffer(pptm), {}).catch(
            (error: unknown) => error,
        );
        expect(refused).toMatchObject({ status: 400 });
    });
});
