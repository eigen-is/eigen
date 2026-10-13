import { describe, expect, test } from 'bun:test';
import type { NewVectorElement } from '@workspace/lib/vector';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { MAX_GROUP_DEPTH } from '../../../lib/import/slides/shapes';
import {
    box,
    buildPptx,
    cxn,
    graphicFrame,
    groupXfrm,
    grp,
    PIXEL_PNG,
    type PptxFixture,
    PX,
    para,
    pic,
    rel,
    solid,
    sp,
    xfrm,
} from '../../fixtures/pptx';

// A slide's shape tree as canvas elements: geometry, groups, kinds, paint, pictures and what is dropped.

const OPTIONS = { maxMediaBytes: 35 * 1024 * 1024 };

const deckOf = (fixture: PptxFixture) => readPptx(buildPptx(fixture), OPTIONS);
const elementsOf = (shapes: string, fixture: Partial<PptxFixture> = {}): NewVectorElement[] =>
    deckOf({ slides: [{ shapes }], ...fixture }).slides[0].elements;
const element = (shapes: string, fixture: Partial<PptxFixture> = {}) => elementsOf(shapes, fixture)[0];

const FILLED = solid('FF0000');

function expectBox(found: NewVectorElement | undefined, x: number, y: number, width: number, height: number) {
    expect(found?.x).toBeCloseTo(x, 6);
    expect(found?.y).toBeCloseTo(y, 6);
    expect(found?.width).toBeCloseTo(width, 6);
    expect(found?.height).toBeCloseTo(height, 6);
}

describe('geometry', () => {
    test("a 16:9 slide fills the frame: 6,350 EMU a px, or the deck's frame an Import gives", () => {
        const shape = sp({ xfrm: box(100, 50, 400, 200), spPr: FILLED });
        expectBox(element(shape), 100, 50, 400, 200);
        const frame = { width: 960, height: 540 };
        const imported = readPptx(buildPptx({ slides: [{ shapes: shape }] }), { ...OPTIONS, frame });
        expectBox(imported.slides[0].elements[0], 50, 25, 200, 100);
    });

    test('a 4:3 slide is letterboxed into the frame, centred', () => {
        const found = element(sp({ xfrm: xfrm(0, 0, 9144000, 6858000), spPr: FILLED }), {
            sldSz: '<p:sldSz cx="9144000" cy="6858000"/>',
        });
        expectBox(found, 240, 0, 1440, 1080);
    });

    test('a rotation is the angle, and a flip keeps the box: flipH its turn, flipV half a turn more', () => {
        expect(element(sp({ xfrm: box(0, 0, 100, 50, ' rot="5400000"'), spPr: FILLED }))?.angle).toBeCloseTo(90, 6);
        const flippedH = element(sp({ xfrm: box(10, 20, 100, 50, ' rot="1800000" flipH="1"'), spPr: FILLED }));
        expect(flippedH?.angle).toBeCloseTo(30, 6);
        expectBox(flippedH, 10, 20, 100, 50);
        expect(element(sp({ xfrm: box(0, 0, 100, 50, ' rot="1800000" flipV="1"'), spPr: FILLED }))?.angle).toBeCloseTo(
            210,
            6,
        );
    });

    test('a group scales its children from chOff/chExt onto off/ext, and turns them about its centre', () => {
        const child = sp({ xfrm: box(0, 0, 50, 50), spPr: FILLED });
        const scaled = groupXfrm([100 * PX, 100 * PX, 200 * PX, 200 * PX], [0, 0, 100 * PX, 100 * PX]);
        expectBox(element(grp(scaled, child)), 100, 100, 100, 100);
        const turned = groupXfrm(
            [100 * PX, 100 * PX, 200 * PX, 200 * PX],
            [0, 0, 100 * PX, 100 * PX],
            ' rot="5400000"',
        );
        const found = element(grp(turned, child));
        expectBox(found, 200, 100, 100, 100);
        expect(found?.angle).toBeCloseTo(90, 6);
    });

    test('a flipped group mirrors its children about its centre and negates their angles', () => {
        const child = sp({ xfrm: box(0, 0, 100, 50, ' rot="1800000"'), spPr: FILLED });
        const flipped = groupXfrm([0, 0, 400 * PX, 200 * PX], [0, 0, 400 * PX, 200 * PX], ' flipH="1"');
        const found = element(grp(flipped, child));
        expectBox(found, 300, 0, 100, 50);
        expect(found?.angle).toBeCloseTo(330, 6);
    });

    test("a turned child in an unevenly scaled group keeps its turn, its extents scaled along the group's axes", () => {
        const stretched = groupXfrm([0, 0, 400 * PX, 100 * PX], [0, 0, 200 * PX, 100 * PX]);
        const child = (rot: number) => sp({ xfrm: box(0, 0, 100, 50, ` rot="${rot * 60000}"`), spPr: FILLED });
        const turned = element(grp(stretched, child(30)));
        expectBox(turned, 0, 0, 200, 50);
        expect(turned?.angle).toBeCloseTo(30, 6);
        // Turned sideways, the child's width runs along the group's y axis.
        const sideways = element(grp(stretched, child(90)));
        expectBox(sideways, 50, -25, 100, 100);
        expect(sideways?.angle).toBeCloseTo(90, 6);
    });

    test("nested groups compose: an inner group's turn decides which of the outer group's scales a child takes", () => {
        const inner = grp(
            groupXfrm([0, 0, 100 * PX, 100 * PX], [0, 0, 100 * PX, 100 * PX], ' rot="5400000"'),
            sp({ xfrm: box(0, 25, 100, 50), spPr: FILLED }),
        );
        const found = element(grp(groupXfrm([0, 0, 400 * PX, 200 * PX], [0, 0, 200 * PX, 200 * PX]), inner));
        expectBox(found, 50, 0, 100, 100);
        expect(found?.angle).toBeCloseTo(90, 6);
    });

    test('a group flipped vertically mirrors its children and turns them half round; flipped both ways it turns them', () => {
        const child = sp({ xfrm: box(0, 0, 100, 50, ' rot="1800000"'), spPr: FILLED });
        const flipped = (attributes: string) =>
            element(grp(groupXfrm([0, 0, 400 * PX, 200 * PX], [0, 0, 400 * PX, 200 * PX], attributes), child));
        const vertical = flipped(' flipV="1"');
        expectBox(vertical, 0, 150, 100, 50);
        expect(vertical?.angle).toBeCloseTo(150, 6);
        const both = flipped(' flipH="1" flipV="1"');
        expectBox(both, 300, 150, 100, 50);
        expect(both?.angle).toBeCloseTo(210, 6);
    });

    test(`groups nest to ${MAX_GROUP_DEPTH} deep; one more is too large`, () => {
        const nested = (depth: number) => {
            let tree = sp({ xfrm: box(0, 0, 10, 10), spPr: FILLED });
            const identity = groupXfrm([0, 0, 100 * PX, 100 * PX], [0, 0, 100 * PX, 100 * PX]);
            for (let i = 0; i < depth; i++) tree = grp(identity, tree);
            return tree;
        };
        expect(elementsOf(nested(MAX_GROUP_DEPTH))).toHaveLength(1);
        expect(() => elementsOf(nested(MAX_GROUP_DEPTH + 1))).toThrow('This presentation is too large to import');
    });

    test('a negative extent is none, and a coordinate past what a double holds exactly places nothing', () => {
        expectBox(element(sp({ xfrm: xfrm(0, 0, -635000, 635000), spPr: FILLED })), 0, 0, 0, 100);
        expect(elementsOf(sp({ xfrm: xfrm('9'.repeat(30), 0, 10, 10), spPr: FILLED }))).toEqual([]);
    });

    test('a shape wholly outside the frame is not drawn, one overhanging it is, its turn included', () => {
        const at = (x: number, y: number, attributes = '') =>
            sp({ xfrm: box(x, y, 100, 10, attributes), spPr: FILLED });
        const kept = elementsOf(
            at(-200, 0) + at(-50, 0) + at(1920, 1070) + at(2000, 0) + at(0, -11) + at(-60, 0, ' rot="5400000"'),
        );
        expect(kept.map((found) => [found.x, found.y])).toEqual([
            [-50, 0],
            [1920, 1070],
        ]);
    });

    test('a box a group scaled past what a double holds is not drawn', () => {
        let tree = sp({ xfrm: xfrm(0, 0, 1, 1), spPr: FILLED, text: para('far') });
        for (let i = 0; i < 30; i++) tree = grp(groupXfrm([0, 0, 9e15, 9e15], [0, 0, 1, 1]), tree);
        expect(elementsOf(tree)).toEqual([]);
    });

    test('a hidden shape is not drawn, and a shape with no geometry of its own or inherited is skipped', () => {
        expect(elementsOf(sp({ xfrm: box(0, 0, 10, 10), spPr: FILLED, hidden: true }))).toEqual([]);
        expect(elementsOf(sp({ spPr: FILLED }))).toEqual([]);
    });
});

describe('kinds', () => {
    test('a rectangle is straight-cornered, a roundRect curved, ellipse and diamond as themselves', () => {
        const kinds = elementsOf(
            ['rect', 'roundRect', 'ellipse', 'diamond']
                .map((geom) => sp({ xfrm: box(0, 0, 10, 10), geom, spPr: FILLED }))
                .join(''),
        ).map((found) => [found.type, found.corners]);
        expect(kinds).toEqual([
            ['rectangle', 'straight'],
            ['rectangle', 'curved'],
            ['ellipse', undefined],
            ['diamond', 'straight'],
        ]);
    });

    test("a pie's visual angles become its box-normalized ones; equal angles are the whole ellipse", () => {
        const pie = (adj1: number, adj2: number) =>
            element(
                sp({
                    xfrm: box(0, 0, 200, 100),
                    spPr: `<a:prstGeom prst="pie"><a:avLst><a:gd name="adj1" fmla="val ${adj1 * 60000}"/><a:gd name="adj2" fmla="val ${adj2 * 60000}"/></a:avLst></a:prstGeom>${FILLED}`,
                }),
            );
        const quarter = pie(0, 90);
        expect(quarter?.type).toBe('pie');
        expect(quarter?.startAngle).toBeCloseTo(0, 6);
        expect(quarter?.sweepAngle).toBeCloseTo(90, 6);
        // 45° on a 2:1 ellipse is atan(2) in the normalized circle.
        expect(pie(0, 45)?.sweepAngle).toBeCloseTo((Math.atan(2) * 180) / Math.PI, 6);
        expect(pie(30, 30)?.sweepAngle).toBe(360);
    });

    test('a mirrored pie runs the other way round its box', () => {
        const found = element(
            sp({
                xfrm: box(0, 0, 100, 100, ' flipH="1"'),
                spPr: `<a:prstGeom prst="pie"><a:avLst><a:gd name="adj1" fmla="val 0"/><a:gd name="adj2" fmla="val 5400000"/></a:avLst></a:prstGeom>${FILLED}`,
            }),
        );
        expect(found?.startAngle).toBeCloseTo(90, 6);
        expect(found?.sweepAngle).toBeCloseTo(90, 6);
    });

    test('a connector is a line between its flipped ends, an arrow when a:ln has a head or a tail', () => {
        const ln = (ends: string) => `<a:ln w="25400">${solid('0000FF')}<a:prstDash val="sysDash"/>${ends}</a:ln>`;
        const line = element(cxn({ xfrm: box(100, 100, 200, 100, ' flipH="1"'), geom: 'line', ln: ln('') }));
        expect(line).toMatchObject({ type: 'line', strokeColor: '#0000ff', strokeStyle: 'dashed', roundness: 'sharp' });
        expectBox(line, 100, 100, 200, 100);
        expect(line?.strokeWidth).toBeCloseTo(4, 6);
        expect(JSON.parse(String(line?.points))).toEqual([
            [200, 0],
            [0, 100],
        ]);
        const arrow = element(
            cxn({ xfrm: box(0, 0, 100, 0), ln: ln('<a:headEnd type="oval"/><a:tailEnd type="triangle"/>') }),
        );
        expect(arrow).toMatchObject({
            type: 'arrow',
            startArrowhead: 'circle',
            endArrowhead: 'triangle',
            elbow: false,
        });
    });

    test('an unstroked line draws nothing', () => {
        expect(elementsOf(cxn({ xfrm: box(0, 0, 100, 0), ln: '<a:ln><a:noFill/></a:ln>' }))).toEqual([]);
    });

    test('a text box is one rich text box with its fill and border; any other shape carries its text on top', () => {
        const [textBox] = elementsOf(
            sp({
                xfrm: box(0, 0, 100, 50),
                txBox: true,
                spPr: `${FILLED}<a:ln w="12700">${solid('00FF00')}</a:ln>`,
                text: para('Hello &amp; &lt;world&gt;'),
            }),
        );
        expect(textBox).toMatchObject({
            type: 'richtext',
            html: '<p>Hello &amp; &lt;world&gt;</p>',
            strokeColor: '#00ff00',
            corners: 'straight',
        });
        expect(JSON.parse(String(textBox.fill))).toMatchObject({ type: 'solid', color: '#ff0000' });
        const [shape, onTop] = elementsOf(
            sp({ xfrm: box(0, 0, 100, 50), geom: 'ellipse', spPr: FILLED, text: para('In it') }),
        );
        expect(shape.type).toBe('ellipse');
        expect(onTop).toMatchObject({ type: 'richtext', html: '<p>In it</p>', strokeColor: 'transparent' });
        expect(JSON.parse(String(onTop.fill))).toMatchObject({ color: 'transparent' });
    });

    test('another preset or a custGeom keeps its text, drops its outline, and says so', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        sp({ xfrm: box(0, 0, 10, 10), geom: 'rightArrow', spPr: FILLED, text: para('Next') }) +
                        sp({ xfrm: box(0, 0, 10, 10), spPr: `<a:custGeom/>${FILLED}` }),
                },
            ],
        });
        expect(deck.slides[0].elements.map((found) => [found.type, found.html])).toEqual([['richtext', '<p>Next</p>']]);
        expect(deck.warnings).toContainEqual({ code: 'shapes-simplified', count: 2 });
    });

    test('a shape with neither fill nor line nor text draws nothing', () => {
        expect(elementsOf(sp({ xfrm: box(0, 0, 10, 10), spPr: '<a:noFill/><a:ln><a:noFill/></a:ln>' }))).toEqual([]);
    });
});

describe('paint', () => {
    test('a scheme colour goes through the theme, its transforms applied, and alpha into the hex', () => {
        const found = element(
            sp({
                xfrm: box(0, 0, 10, 10),
                spPr: '<a:solidFill><a:schemeClr val="accent1"><a:alpha val="50000"/></a:schemeClr></a:solidFill>',
            }),
        );
        expect(JSON.parse(String(found?.fill))).toEqual({ type: 'solid', color: '#4f81bd80', style: 'solid' });
    });

    test("grpFill shows the group's fill", () => {
        const group = grp(
            `${groupXfrm([0, 0, 100 * PX, 100 * PX], [0, 0, 100 * PX, 100 * PX])}${solid('123456')}`,
            sp({ xfrm: box(0, 0, 10, 10), spPr: '<a:grpFill/>' }),
        );
        expect(JSON.parse(String(element(group)?.fill))).toMatchObject({ color: '#123456' });
    });

    test('dots and dashes map to the dotted and dashed strokes', () => {
        const stroke = (dash: string) =>
            element(sp({ xfrm: box(0, 0, 10, 10), spPr: `<a:ln>${solid('000000')}<a:prstDash val="${dash}"/></a:ln>` }))
                ?.strokeStyle;
        expect(['solid', 'sysDot', 'dot', 'dash', 'lgDashDot'].map(stroke)).toEqual([
            'solid',
            'dotted',
            'dotted',
            'dashed',
            'dashed',
        ]);
    });
});

describe('pictures', () => {
    const files = { 'ppt/media/a.png': PIXEL_PNG, 'ppt/media/b.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' };

    test('a picture is an image that fills its box, uncropped, its bytes read raw', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes: pic({ xfrm: box(10, 20, 30, 40), embed: 'rId2' }),
                    rels: rel('rId2', 'image', '../media/a.png'),
                },
            ],
            files,
        });
        const [image] = deck.slides[0].elements;
        expect(image).toMatchObject({
            type: 'image',
            objectFit: 'fill',
            corners: 'straight',
            strokeColor: 'transparent',
        });
        expectBox(image, 10, 20, 30, 40);
        expect(deck.media).toHaveLength(1);
        expect(deck.media[0].name).toBe(String(image.mediaName));
        expect(new Uint8Array(deck.media[0].data)).toEqual(PIXEL_PNG);
    });

    test('the svgBlip is preferred over its png fallback, which is then not read', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes: pic({ xfrm: box(0, 0, 10, 10), embed: 'rId2', svg: 'rId3' }),
                    rels: rel('rId2', 'image', '../media/a.png') + rel('rId3', 'image', '../media/b.svg'),
                },
            ],
            files,
        });
        expect(deck.media.map((media) => media.contentType)).toEqual(['image/svg+xml']);
        expect(String(deck.slides[0].elements[0].mediaName)).toEndWith('.svg');
    });

    test('a picture shown twice is one media file; a linked picture is a placeholder; an empty picture placeholder nothing', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        pic({ xfrm: box(0, 0, 10, 10), embed: 'rId2' }) +
                        pic({ xfrm: box(0, 0, 10, 10), embed: 'rId2' }) +
                        pic({ xfrm: box(0, 0, 10, 10), link: 'rId4' }) +
                        pic({ xfrm: box(0, 0, 10, 10), ph: '<p:ph type="pic" idx="1"/>' }),
                    rels:
                        rel('rId2', 'image', '../media/a.png') +
                        rel('rId4', 'image', 'https://example.com/a.png', true),
                },
            ],
            files,
        });
        expect(deck.media).toHaveLength(1);
        expect(deck.slides[0].elements.map((found) => found.html ?? found.mediaName)).toEqual([
            deck.media[0].name,
            deck.media[0].name,
            '<p>Picture not imported</p>',
        ]);
        expect(deck.warnings).toEqual([{ code: 'images-dropped', count: 1 }]);
    });

    test('a mirrored picture keeps its box and counts its lost mirror; flipped back by its group it is none', () => {
        const mirrored = (shapes: string) =>
            deckOf({ slides: [{ shapes, rels: rel('rId2', 'image', '../media/a.png') }], files }).warnings;
        const flipped = pic({ xfrm: box(0, 0, 10, 10, ' flipH="1"'), embed: 'rId2' });
        expect(mirrored(flipped + pic({ xfrm: box(0, 0, 10, 10, ' flipV="1"'), embed: 'rId2' }))).toEqual([
            { code: 'mirrors-dropped', count: 2 },
        ]);
        const group = groupXfrm([0, 0, 100 * PX, 100 * PX], [0, 0, 100 * PX, 100 * PX], ' flipH="1"');
        expect(mirrored(grp(group, flipped))).toEqual([]);
    });
});

describe('dropped objects', () => {
    test('a table, a chart, a SmartArt, an OLE object and anything else leave a box saying what was there', () => {
        const uris = [
            'http://schemas.openxmlformats.org/drawingml/2006/table',
            'http://schemas.openxmlformats.org/drawingml/2006/chart',
            'http://schemas.openxmlformats.org/drawingml/2006/diagram',
            'http://schemas.openxmlformats.org/presentationml/2006/ole',
            'urn:something-else',
            'http://schemas.openxmlformats.org/drawingml/2006/table',
        ];
        const deck = deckOf({
            slides: [{ shapes: uris.map((uri) => graphicFrame(uri, 0, 0, 635000, 317500)).join('') }],
        });
        const boxes = deck.slides[0].elements;
        expect(boxes.map((found) => found.html)).toEqual([
            '<p>Table not imported</p>',
            '<p>Chart not imported</p>',
            '<p>SmartArt not imported</p>',
            '<p>Embedded object not imported</p>',
            '<p>Object not imported</p>',
            '<p>Table not imported</p>',
        ]);
        expect(boxes[0]).toMatchObject({
            type: 'richtext',
            strokeStyle: 'dashed',
            textAlign: 'center',
            verticalAlign: 'center',
        });
        expectBox(boxes[0], 0, 0, 100, 50);
        expect(deck.warnings).toEqual(
            expect.arrayContaining([
                { code: 'tables-dropped', count: 2 },
                { code: 'charts-dropped', count: 1 },
                { code: 'diagrams-dropped', count: 1 },
                { code: 'objects-dropped', count: 2 },
            ]),
        );
    });

    test("markup compatibility takes the fallback of a choice PowerPoint's reader can't read", () => {
        const choice = (requires: string, inner: string) =>
            `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="${requires}">${inner}</mc:Choice><mc:Fallback>${sp({ xfrm: box(0, 0, 10, 10), txBox: true, text: para('fallback') })}</mc:Fallback></mc:AlternateContent>`;
        const choiceShape = sp({ xfrm: box(0, 0, 10, 10), txBox: true, text: para('choice') });
        expect(elementsOf(choice('a14', choiceShape)).map((found) => found.html)).toEqual(['<p>fallback</p>']);
        expect(elementsOf(choice('p', choiceShape)).map((found) => found.html)).toEqual(['<p>choice</p>']);
    });
});
