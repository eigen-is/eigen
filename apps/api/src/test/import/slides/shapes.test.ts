import { describe, expect, spyOn, test } from 'bun:test';
import type { NewVectorElement, Point, SlidePage } from '@workspace/lib/vector';
import {
    arrowCurveBeziers,
    MAX_PATH_BYTES,
    parseFixedSegments,
    parsePoints,
    TRANSPARENT_COLOR,
} from '@workspace/lib/vector';
import * as customGeometryModule from '../../../lib/import/slides/custom-geometry';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { presetGeometry } from '../../../lib/import/slides/preset-geometry';
import { MAX_GROUP_DEPTH } from '../../../lib/import/slides/shapes';
import type { PptxFixture } from '../../fixtures/pptx';
import {
    box,
    buildPptx,
    buildPptxWithBadPictures,
    cxn,
    dspSp,
    graphicFrame,
    groupXfrm,
    grp,
    PIXEL_PNG,
    PX,
    para,
    pic,
    rel,
    run,
    scheme,
    smartArt,
    solid,
    sp,
    styleRef,
    styleRefs,
    THEME,
    textBox,
    xfrm,
} from '../../fixtures/pptx';

// A slide's shape tree as canvas elements: geometry, groups, kinds, paint, pictures and what is dropped.

const OPTIONS = { maxMediaBytes: 35 * 1024 * 1024 };
// The page of a 16:9 and a 4:3 deck a file is imported into.
const WIDE: SlidePage = { slideSize: '16:9', slideWidth: 720 };
const STANDARD: SlidePage = { slideSize: '4:3', slideWidth: 720 };

const deckOf = (fixture: PptxFixture) => readPptx(buildPptx(fixture), OPTIONS);
const elementsOf = (shapes: string, fixture: Partial<PptxFixture> = {}): NewVectorElement[] =>
    deckOf({ slides: [{ shapes }], ...fixture }).slides[0].elements;
const element = (shapes: string, fixture: Partial<PptxFixture> = {}) => elementsOf(shapes, fixture)[0];

const FILLED = solid('FF0000');

const custGeom = (paths: string) => `<a:custGeom><a:avLst/><a:gdLst/><a:pathLst>${paths}</a:pathLst></a:custGeom>`;
const TRIANGLE =
    '<a:path w="2" h="2"><a:moveTo><a:pt x="1" y="0"/></a:moveTo><a:lnTo><a:pt x="2" y="2"/></a:lnTo><a:lnTo><a:pt x="0" y="2"/></a:lnTo><a:close/></a:path>';

function expectBox(found: NewVectorElement | undefined, x: number, y: number, width: number, height: number) {
    expect(found?.x).toBeCloseTo(x, 6);
    expect(found?.y).toBeCloseTo(y, 6);
    expect(found?.width).toBeCloseTo(width, 6);
    expect(found?.height).toBeCloseTo(height, 6);
}

// A linear element's points on the slide, to the hundredth.
const scenePoints = (found: NewVectorElement): [number, number][] =>
    parsePoints(String(found.points)).map((point) => [
        Math.round(((found.x ?? 0) + point.x) * 100) / 100,
        Math.round(((found.y ?? 0) + point.y) * 100) / 100,
    ]);

const pinned = (found: NewVectorElement) =>
    parseFixedSegments(String(found.fixedSegments)).segments.map((segment) => segment.index);

// A cubic Bézier sampled densely, to measure a curve against.
function cubic(...[p0, p1, p2, p3]: [number, number][]): Point[] {
    return Array.from({ length: 1001 }, (_, i) => {
        const t = i / 1000;
        const weights = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
        const along = (axis: 0 | 1) => [p0, p1, p2, p3].reduce((sum, p, j) => sum + p[axis] * weights[j], 0);
        return { x: along(0), y: along(1) };
    });
}

const nearest = (point: Point, curve: Point[]) =>
    Math.min(...curve.map((on) => Math.hypot(on.x - point.x, on.y - point.y)));

describe('geometry', () => {
    test('a 16:9 slide fills the frame: 6,350 EMU a px', () => {
        expectBox(element(sp({ xfrm: box(100, 50, 400, 200), spPr: FILLED })), 100, 50, 400, 200);
    });

    test("a 4:3 slide is letterboxed into a 16:9 deck's frame, centered, and fills a frame its own size", () => {
        const pptx = buildPptx({
            sldSz: '<p:sldSz cx="9144000" cy="6858000"/>',
            slides: [{ shapes: sp({ xfrm: xfrm(0, 0, 9144000, 6858000), spPr: FILLED }) }],
        });
        expectBox(readPptx(pptx, { ...OPTIONS, deck: WIDE }).slides[0].elements[0], 240, 0, 1440, 1080);
        expectBox(readPptx(pptx, OPTIONS).slides[0].elements[0], 0, 0, 1920, 1440);
    });

    test("a 16:9 slide is letterboxed into a 4:3 deck's frame, centered", () => {
        const pptx = buildPptx({ slides: [{ shapes: sp({ xfrm: xfrm(0, 0, 12192000, 6858000), spPr: FILLED }) }] });
        expectBox(readPptx(pptx, { ...OPTIONS, deck: STANDARD }).slides[0].elements[0], 0, 180, 1920, 1080);
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

    test('a group scales its children from chOff/chExt onto off/ext, and turns them about its center', () => {
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

    test('a flipped group mirrors its children about its center and negates their angles', () => {
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

    test("a letterboxed slide's off-slide shapes, a layout's guides, are not drawn in the bands beside it", () => {
        // 4:3 in 16:9: the slide spans x 240 to 1680, 1080 / 6,858,000 px an EMU.
        const line = (x: number) =>
            cxn({ xfrm: xfrm(x, 0, 0, 6858000), geom: 'line', ln: `<a:ln>${solid('FF0000')}</a:ln>` });
        const deck = readPptx(
            buildPptx({
                sldSz: '<p:sldSz cx="9144000" cy="6858000"/>',
                layouts: [{ shapes: line(-200000) + line(9300000) + line(100000) }],
                slides: [{ shapes: sp({ xfrm: xfrm(9000000, 0, 400000, 100000), spPr: FILLED }) }],
            }),
            { ...OPTIONS, deck: WIDE },
        );
        expect(deck.slides[0].elements.map((found) => [found.type, Math.round(found.x ?? Number.NaN)])).toEqual([
            ['line', 256],
            ['rectangle', 1657],
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

    test('a text box is one rich text box with its fill and border', () => {
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
    });

    test('a straight rect with text is a text box by txBox or any placeholder, and otherwise a rectangle holding it', () => {
        const rect = (options: { txBox?: boolean; ph?: string }) =>
            sp({ xfrm: box(0, 0, 200, 100), geom: 'rect', spPr: FILLED, text: para('Label'), ...options });
        const found = elementsOf(
            rect({ txBox: true }) +
                rect({ ph: '<p:ph type="title"/>' }) +
                rect({ ph: '<p:ph type="ftr" sz="quarter" idx="11"/>' }) +
                rect({}),
        );
        expect(found.map((element) => [element.type, element.html, element.corners])).toEqual([
            ['richtext', '<p>Label</p>', 'straight'],
            ['richtext', '<p>Label</p>', 'straight'],
            ['richtext', '<p>Label</p>', 'straight'],
            ['rectangle', '<p>Label</p>', 'straight'],
        ]);
        expect(JSON.parse(String(found[3].fill))).toMatchObject({ color: '#ff0000' });
    });

    test("a preset kind, a pie and a one-path preset hold their text, with the file's inset less the border", () => {
        const bordered = `${FILLED}<a:ln w="${4 * PX}">${solid('00FF00')}</a:ln>`;
        const shape = (geom: string, spPr = bordered) =>
            sp({ xfrm: box(0, 0, 200, 100), geom, spPr, text: para('Inside') }).replace(
                '<a:bodyPr/>',
                `<a:bodyPr lIns="${20 * PX}" rIns="${20 * PX}" anchor="ctr"/>`,
            );
        const found = elementsOf(
            ['ellipse', 'roundRect', 'diamond', 'pie', 'star5'].map((geom) => shape(geom)).join('') +
                shape('ellipse', '<a:noFill/>'),
        );
        expect(found.map((element) => [element.type, element.html, element.verticalAlign])).toEqual([
            ...['ellipse', 'rectangle', 'diamond', 'pie', 'path'].map((type) => [type, '<p>Inside</p>', 'center']),
            ['ellipse', '<p>Inside</p>', 'center'],
        ]);
        for (const element of found.slice(0, 5)) expect(element.padding).toBeCloseTo(16, 6);
        // Unpainted, it still holds the text, so it is still drawn, and no border takes from the inset.
        expect(found[5].padding).toBeCloseTo(20, 6);
        expect(found[4].closed).toBe(true);
    });

    test('text stays a box on top of a shape of several paths, an open one and a line', () => {
        const open =
            '<a:path w="2" h="2" fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="2" y="2"/></a:lnTo></a:path>';
        const stroke = `<a:ln w="12700">${solid('00FF00')}</a:ln>`;
        const kinds = (shapes: string) => elementsOf(shapes).map((element) => [element.type, element.html]);
        const can = kinds(sp({ xfrm: box(0, 0, 100, 100), geom: 'can', spPr: FILLED, text: para('Can') }));
        expect(can.length).toBeGreaterThan(2);
        expect(can.slice(0, -1).every(([type, html]) => type === 'path' && html === undefined)).toBe(true);
        expect(can.at(-1)).toEqual(['richtext', '<p>Can</p>']);
        expect(
            kinds(sp({ xfrm: box(0, 0, 100, 100), spPr: `${custGeom(open)}${stroke}`, text: para('Open') })),
        ).toEqual([
            ['path', undefined],
            ['richtext', '<p>Open</p>'],
        ]);
        expect(kinds(sp({ xfrm: box(0, 0, 100, 0), geom: 'line', spPr: stroke, text: para('Line') }))).toEqual([
            ['line', undefined],
            ['richtext', '<p>Line</p>'],
        ]);
    });

    test('vertical text turns its box a further quarter turn, or three, its sides swapped about the center', () => {
        const turned = (vert: string, geom = 'rect', layout = '') => {
            const shape = (bodyPr: string, text?: string) =>
                sp({
                    ph: '<p:ph type="body" idx="1"/>',
                    xfrm: box(100, 100, 400, 100, ' rot="600000"'),
                    geom,
                    spPr: FILLED,
                    text,
                }).replace('<a:bodyPr/>', `<a:bodyPr${bodyPr}/>`);
            return deckOf({
                layouts: [{ shapes: shape(layout, '<a:p/>') }],
                slides: [{ shapes: shape(vert, para('Up')) }],
            });
        };
        const up = turned(' vert="vert270"').slides[0].elements[0];
        expect(up).toMatchObject({ type: 'richtext', html: '<p>Up</p>' });
        expectBox(up, 250, -50, 100, 400);
        expect(up?.angle).toBeCloseTo(280, 6);
        expect(turned(' vert="vert"').slides[0].elements[0]?.angle).toBeCloseTo(100, 6);
        expect(turned('', 'rect', ' vert="vert"').slides[0].elements[0]?.angle).toBeCloseTo(100, 6);
        // A shape keeps its own box, its text box on top turned.
        const [ellipse, text] = turned(' vert="vert"', 'ellipse').slides[0].elements;
        expectBox(ellipse, 100, 100, 400, 100);
        expect(ellipse?.angle).toBeCloseTo(10, 6);
        expectBox(text, 250, -50, 100, 400);
        expect(turned(' vert="horz"').slides[0].elements[0]?.angle).toBeCloseTo(10, 6);
        expect(turned(' vert="vert"').warnings).toEqual([]);
        // East Asian text turns as Latin script does in it; WordArt's stacked letters lie across. Both count.
        const eastAsian = turned(' vert="eaVert"');
        expect(eastAsian.slides[0].elements[0]?.angle).toBeCloseTo(100, 6);
        expect(eastAsian.warnings).toEqual([{ code: 'text-simplified', count: 1 }]);
        const stacked = turned(' vert="wordArtVert"');
        expect(stacked.slides[0].elements[0]?.angle).toBeCloseTo(10, 6);
        expect(stacked.warnings).toEqual([{ code: 'text-simplified', count: 1 }]);
    });

    test('a preset with no kind of its own, or a custGeom, is a path at its box in its paint, holding its text', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        sp({
                            xfrm: box(10, 20, 200, 100),
                            geom: 'rightArrow',
                            spPr: `${FILLED}<a:ln w="12700">${solid('00FF00')}</a:ln>`,
                            text: para('Next'),
                        }) + sp({ xfrm: box(0, 0, 10, 20), spPr: `${custGeom(TRIANGLE)}${FILLED}` }),
                },
            ],
        });
        const [arrow, triangle] = deck.slides[0].elements;
        expect(arrow).toMatchObject({
            type: 'path',
            path: presetGeometry('rightArrow', undefined, 200 * PX, 100 * PX, false)?.[0].path,
            closed: true,
            strokeColor: '#00ff00',
            html: '<p>Next</p>',
        });
        expectBox(arrow, 10, 20, 200, 100);
        expect(JSON.parse(String(arrow.fill))).toMatchObject({ type: 'solid', color: '#ff0000' });
        expect(triangle).toMatchObject({ type: 'path', path: 'M 0.5 0 L 1 1 L 0 1 Z', closed: true });
        expect(deck.slides[0].elements).toHaveLength(2);
        expect(deck.warnings).toEqual([]);
    });

    test('the flowchart presets PowerPoint draws as a rectangle, an ellipse or a diamond are those kinds', () => {
        const [process, connector, decision] = elementsOf(
            sp({ xfrm: box(0, 0, 10, 10), geom: 'flowChartProcess', spPr: FILLED, text: para('Step') }) +
                sp({ xfrm: box(0, 0, 10, 10), geom: 'flowChartConnector', spPr: FILLED }) +
                sp({ xfrm: box(0, 0, 10, 10), geom: 'flowChartDecision', spPr: FILLED }),
        );
        expect(process).toMatchObject({ type: 'rectangle', html: '<p>Step</p>', corners: 'straight' });
        expect(JSON.parse(String(process.fill))).toMatchObject({ color: '#ff0000' });
        expect([connector.type, decision.type, decision.corners]).toEqual(['ellipse', 'diamond', 'straight']);
    });

    test("a shading path fills in the shape's fill blended toward black or white, its alpha kept; a line has no fill", () => {
        const square =
            '<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1" y="0"/></a:lnTo><a:lnTo><a:pt x="1" y="1"/></a:lnTo><a:close/>';
        const paths = ['darken', 'lightenLess', 'none'].map(
            (fill) => `<a:path w="1" h="1" fill="${fill}"${fill === 'none' ? '' : ' stroke="0"'}>${square}</a:path>`,
        );
        const translucent = '<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>';
        const found = elementsOf(
            sp({
                xfrm: box(0, 0, 10, 10),
                spPr: `${custGeom(paths.join(''))}${translucent}<a:ln>${solid('0000FF')}</a:ln>`,
            }),
        );
        expect(found.map((path) => [JSON.parse(String(path.fill)).color, path.strokeColor])).toEqual([
            ['#99000080', 'transparent'],
            ['#ff333380', 'transparent'],
            ['transparent', '#0000ff'],
        ]);
    });

    test('a filled path left open fills closed and strokes open beside; unfilled, it only strokes', () => {
        const open = custGeom(
            '<a:path w="2" h="2"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="2" y="0"/></a:lnTo><a:lnTo><a:pt x="2" y="2"/></a:lnTo></a:path>',
        );
        const line = `<a:ln>${solid('0000FF')}</a:ln>`;
        const [fill, stroke] = elementsOf(sp({ xfrm: box(0, 0, 10, 10), spPr: `${open}${FILLED}${line}` }));
        expect(fill).toMatchObject({ path: 'M 0 0 L 1 0 L 1 1 Z', closed: true, strokeColor: 'transparent' });
        expect(stroke).toMatchObject({ path: 'M 0 0 L 1 0 L 1 1', closed: false, strokeColor: '#0000ff' });
        expect(JSON.parse(String(stroke.fill))).toMatchObject({ color: 'transparent' });
        const unfilled = elementsOf(sp({ xfrm: box(0, 0, 10, 10), spPr: `${open}<a:noFill/>${line}` }));
        expect(unfilled.map((path) => [path.path, path.closed])).toEqual([['M 0 0 L 1 0 L 1 1', false]]);
    });

    test('a flipped path mirrors its points across its box: flipH as it is turned, flipV half a turn more', () => {
        const corner = custGeom(
            '<a:path w="2" h="2"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="2" y="0"/></a:lnTo><a:lnTo><a:pt x="0" y="2"/></a:lnTo><a:close/></a:path>',
        );
        const flipped = (attributes: string) =>
            deckOf({ slides: [{ shapes: sp({ xfrm: box(0, 0, 10, 10, attributes), spPr: `${corner}${FILLED}` }) }] });
        const pathAndAngle = (attributes: string) => {
            const [found] = flipped(attributes).slides[0].elements;
            return [found.path, found.angle];
        };
        // Mirrored, it winds the other way, so it is wound clockwise again as the outermost contour.
        expect(pathAndAngle('')).toEqual(['M 0 0 L 1 0 L 0 1 Z', 0]);
        expect(pathAndAngle(' flipH="1"')).toEqual(['M 1 1 L 0 0 L 1 0 Z', 0]);
        expect(pathAndAngle(' flipV="1"')).toEqual(['M 1 1 L 0 0 L 1 0 Z', 180]);
        expect(pathAndAngle(' flipH="1" flipV="1"')).toEqual(['M 0 0 L 1 0 L 0 1 Z', 180]);
        expect(flipped(' flipH="1"').warnings).toEqual([]);
    });

    test('a flipped path is mirrored before the caps measure it, so the path stored is one the canvas keeps', () => {
        // Its 370 curves fit as drawn; mirrored, each x takes a sign and the path no longer fits unsimplified.
        let commands = '<a:moveTo><a:pt x="0" y="0"/></a:moveTo>';
        const far = '<a:pt x="2999.9" y="123.4"/>';
        for (let i = 0; i < 370; i++) commands += `<a:cubicBezTo>${far}${far}${far}</a:cubicBezTo>`;
        const curves = custGeom(`<a:path w="1000" h="1000" fill="none">${commands}</a:path>`);
        const line = `<a:ln w="12700">${solid('FF0000')}</a:ln>`;
        for (const attributes of ['', ' flipH="1"']) {
            const [found] = elementsOf(sp({ xfrm: box(10, 10, 100, 100, attributes), spPr: `${curves}${line}` }));
            expect(found.type).toBe('path');
            expect(String(found.path).length).toBeLessThanOrEqual(MAX_PATH_BYTES);
        }
    });

    test("a geometry the read's budget can't cover keeps its text and counts as simplified, the deck imported", () => {
        // 250 circles about one center, each 127 full turns: every turn's curves outline it, every circle around another.
        let rings = '';
        for (let ring = 0; ring < 250; ring++) {
            const r = 100 + ring * 3;
            const turn = `<a:arcTo wR="${r}" hR="${r}" stAng="0" swAng="21600000"/>`;
            rings += `<a:moveTo><a:pt x="${1000 + r}" y="1000"/></a:moveTo>${turn.repeat(127)}<a:close/>`;
        }
        const deck = deckOf({
            slides: [
                {
                    shapes: sp({
                        xfrm: box(10, 10, 100, 100),
                        spPr: `${custGeom(`<a:path w="2000" h="2000">${rings}</a:path>`)}${FILLED}`,
                        text: para('keep me'),
                    }),
                },
            ],
        });
        expect(deck.slides[0].elements.map((found) => [found.type, found.html])).toEqual([
            ['richtext', '<p>keep me</p>'],
        ]);
        expect(deck.warnings).toEqual([{ code: 'shapes-simplified', count: 1 }]);
    });

    test('paths painting alike are one path element apart, and one each where they overlap', () => {
        const rect = (x0: number, x1: number) =>
            `<a:path w="4" h="4"><a:moveTo><a:pt x="${x0}" y="0"/></a:moveTo><a:lnTo><a:pt x="${x1}" y="0"/></a:lnTo><a:lnTo><a:pt x="${x1}" y="4"/></a:lnTo><a:lnTo><a:pt x="${x0}" y="4"/></a:lnTo><a:close/></a:path>`;
        const pathsOf = (paths: string) =>
            elementsOf(sp({ xfrm: box(0, 0, 10, 10), spPr: `${custGeom(paths)}${FILLED}` })).map((found) => found.path);
        expect(pathsOf(rect(0, 1) + rect(2, 3))).toEqual([
            'M 0 0 L 0.25 0 L 0.25 1 L 0 1 Z M 0.5 0 L 0.75 0 L 0.75 1 L 0.5 1 Z',
        ]);
        expect(pathsOf(rect(0, 3) + rect(1, 2))).toEqual([
            'M 0 0 L 0.75 0 L 0.75 1 L 0 1 Z',
            'M 0.25 0 L 0.5 0 L 0.5 1 L 0.25 1 Z',
        ]);
    });

    test('a bent connector is an elbow arrow pinned along its bends, its heads and line kept', () => {
        const ln = `<a:ln w="25400">${solid('0000FF')}<a:prstDash val="sysDash"/><a:headEnd type="oval"/><a:tailEnd type="triangle"/></a:ln>`;
        const bent = (geom: string, attributes = '', av = '') =>
            cxn({ xfrm: box(100, 100, 200, 100, attributes), geom, av, ln });
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        bent('bentConnector3') +
                        bent('bentConnector3', ' flipH="1"', '<a:gd name="adj1" fmla="val 25000"/>') +
                        bent('bentConnector4', ' rot="5400000"') +
                        bent('bentConnector5', '', '<a:gd name="adj3" fmla="val 75000"/>') +
                        // Its middle bends coincide by default, and the arrow keeps only the corners it draws.
                        bent('bentConnector5'),
                },
            ],
        });
        const elbows = deck.slides[0].elements;
        for (const found of elbows) {
            expect(found).toMatchObject({
                type: 'arrow',
                elbow: true,
                roundness: 'sharp',
                angle: 0,
                startArrowhead: 'circle',
                endArrowhead: 'triangle',
                strokeColor: '#0000ff',
                strokeStyle: 'dashed',
            });
            expect(found.strokeWidth).toBeCloseTo(4, 6);
        }
        expect(elbows.map(scenePoints)).toEqual([
            [
                [100, 100],
                [200, 100],
                [200, 200],
                [300, 200],
            ],
            [
                [300, 100],
                [250, 100],
                [250, 200],
                [100, 200],
            ],
            [
                [250, 50],
                [250, 150],
                [200, 150],
                [200, 250],
                [150, 250],
            ],
            [
                [100, 100],
                [200, 100],
                [200, 150],
                [250, 150],
                [250, 200],
                [300, 200],
            ],
            [
                [100, 100],
                [200, 100],
                [200, 200],
                [300, 200],
            ],
        ]);
        // Every bend is pinned, so the router never routes it again.
        expect(elbows.map(pinned)).toEqual([[2], [2], [2, 3], [2, 3, 4], [2]]);
        expect(deck.warnings).toEqual([]);
    });

    test('a bent connector no elbow can hold is a sharp arrow through its corners', () => {
        const ln = `<a:ln w="12700">${solid('0000FF')}<a:tailEnd type="arrow"/></a:ln>`;
        const [corner, turned] = elementsOf(
            // An elbow pins only a bend between two others, and a turn off the quarter breaks its right angles.
            cxn({ xfrm: box(100, 100, 200, 100), geom: 'bentConnector2', ln }) +
                cxn({ xfrm: box(100, 100, 200, 100, ' rot="1800000"'), geom: 'bentConnector3', ln }),
        );
        expect(corner).toMatchObject({ type: 'arrow', elbow: false, roundness: 'sharp', endArrowhead: 'arrow' });
        expect(scenePoints(corner)).toEqual([
            [100, 100],
            [300, 100],
            [300, 200],
        ]);
        expect(turned).toMatchObject({ type: 'arrow', elbow: false, roundness: 'sharp', angle: 0 });
        expect(scenePoints(turned)).toHaveLength(4);
    });

    test('a bent or curved connector without a head is its path, nothing lost', () => {
        const ln = `<a:ln w="12700">${solid('0000FF')}<a:tailEnd type="none"/></a:ln>`;
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        cxn({ xfrm: box(0, 0, 100, 50), geom: 'bentConnector3', ln }) +
                        cxn({ xfrm: box(0, 0, 100, 50), geom: 'curvedConnector3', ln }),
                },
            ],
        });
        expect(deck.slides[0].elements.map((found) => [found.type, found.closed, found.strokeColor])).toEqual([
            ['path', false, '#0000ff'],
            ['path', false, '#0000ff'],
        ]);
        expect(deck.warnings).toEqual([]);
    });

    test('a curved connector is a curved arrow through points on its curve, its heads and line kept', () => {
        const ln = `<a:ln w="12700">${solid('0000FF')}<a:headEnd type="arrow"/><a:tailEnd type="stealth"/></a:ln>`;
        const curved = (geom: string) => cxn({ xfrm: box(100, 100, 400, 200), geom, ln });
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        curved('curvedConnector3') +
                        curved('curvedConnector2') +
                        curved('curvedConnector4') +
                        curved('curvedConnector5'),
                },
            ],
        });
        const arrows = deck.slides[0].elements;
        for (const found of arrows) {
            expect(found).toMatchObject({
                type: 'arrow',
                elbow: false,
                roundness: 'round',
                angle: 0,
                startArrowhead: 'arrow',
                endArrowhead: 'triangle',
                strokeColor: '#0000ff',
            });
            const points = scenePoints(found);
            expect(points[0]).toEqual([100, 100]);
            expect(points.at(-1)).toEqual([500, 300]);
        }
        expect(deck.warnings).toEqual([]);
        // curvedConnector3 is two cubics through the box's center. Its points lie on them, and the canvas's curve
        // through those points stays within a few px of them.
        const truth = [
            cubic([100, 100], [200, 100], [300, 150], [300, 200]),
            cubic([300, 200], [300, 250], [400, 300], [500, 300]),
        ].flat();
        const points = scenePoints(arrows[0]).map(([x, y]) => ({ x, y }));
        expect(points.length).toBeGreaterThan(5);
        expect(Math.max(...points.map((point) => nearest(point, truth)))).toBeLessThan(0.5);
        const drawn = arrowCurveBeziers(points).flatMap(([a, b, c, d]) =>
            cubic([a.x, a.y], [b.x, b.y], [c.x, c.y], [d.x, d.y]),
        );
        expect(Math.max(...drawn.map((point) => nearest(point, truth)))).toBeLessThan(1.5);
    });

    test('an open freeform line with a head is an arrow through its points, an elbow where its legs run square', () => {
        const ln = `<a:ln w="12700">${solid('0000FF')}<a:headEnd type="oval"/><a:tailEnd type="triangle"/></a:ln>`;
        const freeform = (points: [number, number][]) => {
            const [first, ...rest] = points.map(([x, y]) => `<a:pt x="${x}" y="${y}"/>`);
            const path = `<a:moveTo>${first}</a:moveTo>${rest.map((pt) => `<a:lnTo>${pt}</a:lnTo>`).join('')}`;
            return sp({
                xfrm: box(100, 100, 200, 100),
                spPr: `${custGeom(`<a:path w="4" h="2" fill="none">${path}</a:path>`)}${ln}`,
            });
        };
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        freeform([
                            [0, 0],
                            [2, 0],
                            [2, 2],
                            [4, 2],
                        ]) +
                        freeform([
                            [0, 0],
                            [4, 1],
                            [0, 2],
                        ]),
                },
            ],
        });
        const [elbow, sharp] = deck.slides[0].elements;
        expect(elbow).toMatchObject({ type: 'arrow', elbow: true, roundness: 'sharp', startArrowhead: 'circle' });
        expect(scenePoints(elbow)).toEqual([
            [100, 100],
            [200, 100],
            [200, 200],
            [300, 200],
        ]);
        expect(pinned(elbow)).toEqual([2]);
        expect(sharp).toMatchObject({ type: 'arrow', elbow: false, roundness: 'sharp', endArrowhead: 'triangle' });
        expect(scenePoints(sharp)).toEqual([
            [100, 100],
            [300, 150],
            [100, 200],
        ]);
        expect(deck.warnings).toEqual([]);
    });

    test('an open freeform curve with a head is a curved arrow through points along it', () => {
        const ln = `<a:ln w="12700">${solid('0000FF')}<a:tailEnd type="triangle"/></a:ln>`;
        const curve =
            '<a:path w="4" h="2" fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:cubicBezTo><a:pt x="2" y="0"/><a:pt x="2" y="2"/><a:pt x="4" y="2"/></a:cubicBezTo></a:path>';
        const deck = deckOf({
            slides: [{ shapes: sp({ xfrm: box(100, 100, 400, 200), spPr: `${custGeom(curve)}${ln}` }) }],
        });
        const [found] = deck.slides[0].elements;
        expect(found).toMatchObject({ type: 'arrow', elbow: false, roundness: 'round', endArrowhead: 'triangle' });
        const truth = cubic([100, 100], [300, 100], [300, 300], [500, 300]);
        const points = scenePoints(found).map(([x, y]) => ({ x, y }));
        expect(points.length).toBeGreaterThan(3);
        expect(Math.max(...points.map((point) => nearest(point, truth)))).toBeLessThan(0.5);
        expect(deck.warnings).toEqual([]);
    });

    test('a closed path loses no arrowheads, as PowerPoint draws a line end only on an open one', () => {
        const ln = `<a:ln w="12700">${solid('0000FF')}<a:tailEnd type="triangle"/></a:ln>`;
        const lines = '<a:lnTo><a:pt x="2" y="0"/></a:lnTo><a:lnTo><a:pt x="2" y="2"/></a:lnTo>';
        const curve = '<a:cubicBezTo><a:pt x="1" y="2"/><a:pt x="0" y="1"/><a:pt x="0" y="2"/></a:cubicBezTo>';
        const read = (path: string) =>
            deckOf({
                slides: [
                    {
                        shapes: sp({
                            xfrm: box(0, 0, 10, 10),
                            spPr: `${custGeom(`<a:path w="2" h="2" fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo>${path}</a:path>`)}${ln}`,
                        }),
                    },
                ],
            });
        const closed = read(`${lines}<a:close/>`);
        expect(closed.slides[0].elements.map((found) => found.type)).toEqual(['path']);
        expect(closed.warnings).toEqual([]);
        // No arrow draws lines and curves at once, nor an arc, so those open paths lose their heads.
        const mixed = read(`${lines}${curve}`);
        expect(mixed.slides[0].elements.map((found) => found.type)).toEqual(['path']);
        expect(mixed.warnings).toEqual([{ code: 'shapes-simplified', count: 1 }]);
        const arc = deckOf({ slides: [{ shapes: sp({ xfrm: box(0, 0, 10, 10), geom: 'arc', spPr: ln }) }] });
        expect(arc.slides[0].elements.map((found) => found.type)).toEqual(['path']);
        expect(arc.warnings).toEqual([{ code: 'shapes-simplified', count: 1 }]);
    });

    test('a custGeom past the caps or empty, or a preset no definition names, keeps its text and says so', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        sp({ xfrm: box(0, 0, 10, 10), geom: 'notAPreset', spPr: FILLED, text: para('Next') }) +
                        sp({ xfrm: box(0, 0, 10, 10), spPr: `<a:custGeom/>${FILLED}` }),
                },
            ],
        });
        expect(deck.slides[0].elements.map((found) => [found.type, found.html])).toEqual([['richtext', '<p>Next</p>']]);
        expect(deck.warnings).toContainEqual({ code: 'shapes-simplified', count: 2 });
    });

    test("a layout placeholder's custGeom converts once for every slide that shows it, each still drawn", () => {
        const convert = spyOn(customGeometryModule, 'customGeometry');
        try {
            const placeholder = (spPr: string) =>
                sp({ ph: '<p:ph type="body" idx="1"/>', xfrm: box(0, 0, 10, 20), spPr, text: para('x') });
            const deck = deckOf({
                layouts: [{ shapes: placeholder(`${custGeom(TRIANGLE)}${FILLED}`) }],
                slides: [{ shapes: placeholder('') }, { shapes: placeholder('') }, { shapes: placeholder('') }],
            });
            expect(deck.slides.map((slide) => slide.elements.map((found) => [found.type, found.html]))).toEqual(
                Array(3).fill([['path', '<p>x</p>']]),
            );
            expect(convert).toHaveBeenCalledTimes(1);
        } finally {
            convert.mockRestore();
        }
    });

    test('a shape with neither fill nor line nor text draws nothing', () => {
        expect(elementsOf(sp({ xfrm: box(0, 0, 10, 10), spPr: '<a:noFill/><a:ln><a:noFill/></a:ln>' }))).toEqual([]);
    });
});

describe('paint', () => {
    test('a scheme color goes through the theme, its transforms applied, and alpha into the hex', () => {
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

    test('a pattern fills in its foreground color, and says so', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes: sp({
                        xfrm: box(0, 0, 10, 10),
                        spPr: '<a:pattFill prst="pct20"><a:fgClr><a:schemeClr val="accent3"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>',
                    }),
                },
            ],
        });
        expect(JSON.parse(String(deck.slides[0].elements[0].fill))).toMatchObject({ color: '#9bbb59' });
        expect(deck.warnings).toContainEqual({ code: 'fills-simplified', count: 1 });
    });

    test('a picture fill on a shape is dropped, and counted', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes: sp({
                        xfrm: box(0, 0, 10, 10),
                        spPr: `<a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:ln>${solid('000000')}</a:ln>`,
                    }),
                    rels: rel('rId2', 'image', '../media/a.png'),
                },
            ],
            files: { 'ppt/media/a.png': PIXEL_PNG },
        });
        const [found] = deck.slides[0].elements;
        expect(JSON.parse(String(found.fill))).toMatchObject({ color: 'transparent' });
        expect(found.strokeColor).toBe('#000000');
        expect(deck.media).toEqual([]);
        expect(deck.warnings).toContainEqual({ code: 'images-dropped', count: 1 });
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

describe('style references', () => {
    const fillOf = (found: NewVectorElement | undefined) => JSON.parse(String(found?.fill)).color;
    const shape = (style: string, spPr = '') => element(sp({ xfrm: box(0, 0, 100, 50), spPr, style }));

    test("a fillRef paints its fillStyleLst entry in the reference's color, the entry's transforms on top", () => {
        expect(fillOf(shape(styleRefs(1, 0)))).toBe('#c0504d');
        expect(fillOf(shape(styleRefs(2, 0)))).toBe('#e2c2c2');
        expect(fillOf(shape(styleRefs(3, 0)))).toBe('#8e3b39');
        const translucent = '<a:schemeClr val="accent1"><a:alpha val="50000"/></a:schemeClr>';
        expect(fillOf(shape(styleRefs(1, 0, translucent)))).toBe('#4f81bd80');
    });

    test('fillRef 0 is no fill, 1001 and up a bgFillStyleLst entry, and past the list nothing', () => {
        expect(elementsOf(sp({ xfrm: box(0, 0, 10, 10), style: styleRefs(0, 0) }))).toEqual([]);
        expect(fillOf(shape(styleRefs(1002, 0)))).toBe('#abcdef');
        expect(elementsOf(sp({ xfrm: box(0, 0, 10, 10), style: styleRefs(9, 0) }))).toEqual([]);
    });

    test("an lnRef strokes with its lnStyleLst entry's width and the reference's color", () => {
        const found = shape(styleRefs(0, 2, '<a:srgbClr val="00FF00"/>'));
        expect(found).toMatchObject({ type: 'rectangle', strokeColor: '#00ff00', strokeStyle: 'solid' });
        expect(found?.strokeWidth).toBeCloseTo(4, 6);
        expect(elementsOf(sp({ xfrm: box(0, 0, 10, 10), style: styleRefs(0, 0) }))).toEqual([]);
    });

    test('an explicit fill and a:ln win, attribute by attribute: what the a:ln leaves out comes from the style', () => {
        const found = shape(styleRefs(1, 3), `${solid('123456')}<a:ln w="12700"><a:prstDash val="dash"/></a:ln>`);
        expect(fillOf(found)).toBe('#123456');
        expect(found).toMatchObject({ strokeColor: '#c0504d', strokeStyle: 'dashed' });
        expect(found?.strokeWidth).toBeCloseTo(2, 6);
        expect(shape(styleRefs(1, 3), '<a:ln><a:noFill/></a:ln>')?.strokeColor).toBe('transparent');
        expect(fillOf(shape(styleRefs(1, 3), '<a:noFill/>'))).toBe('transparent');
    });

    test('a shape with neither a:ln nor p:style has no stroke, nor one whose a:ln states no color', () => {
        expect(element(sp({ xfrm: box(0, 0, 10, 10), spPr: FILLED }))?.strokeColor).toBe('transparent');
        expect(element(sp({ xfrm: box(0, 0, 10, 10), spPr: `${FILLED}<a:ln w="25400"/>` }))?.strokeColor).toBe(
            'transparent',
        );
    });

    test("a connector draws in its lnRef's line, its ends from its own a:ln", () => {
        const found = element(
            cxn({
                xfrm: box(0, 0, 100, 0),
                ln: '<a:ln><a:tailEnd type="triangle"/></a:ln>',
                style: styleRefs(0, 1, '<a:schemeClr val="accent1"/>'),
            }),
        );
        expect(found).toMatchObject({ type: 'arrow', strokeColor: '#4f81bd', endArrowhead: 'triangle' });
        expect(found?.strokeWidth).toBeCloseTo(1.5, 6);
    });

    test("a placeholder with no style of its own takes its layout placeholder's, for its paint and its text", () => {
        const style = `${styleRef('fillRef', 1, '<a:srgbClr val="FF8800"/>')}<a:fontRef idx="major"><a:srgbClr val="00AA00"/></a:fontRef>`;
        const [found] = deckOf({
            layouts: [{ shapes: sp({ ph: '<p:ph type="body" idx="1"/>', xfrm: box(0, 0, 10, 10), style }) }],
            slides: [{ shapes: sp({ ph: '<p:ph type="body" idx="1"/>', text: para('Body') }) }],
        }).slides[0].elements;
        expect(fillOf(found)).toBe('#ff8800');
        expect(found).toMatchObject({ type: 'richtext', color: '#00aa00', fontFamily: 'Source Serif 4' });
    });
});

describe('gradients', () => {
    const stop = (pos: number, color: string) => `<a:gs pos="${pos}">${color}</a:gs>`;
    const RED = '<a:srgbClr val="FF0000"/>';
    const BLUE = '<a:srgbClr val="0000FF"/>';
    const grad = (shade: string, stops = stop(0, RED) + stop(100000, BLUE)) =>
        `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${shade}</a:gradFill>`;
    const fillOf = (spPr: string, width = 200, height = 100) =>
        JSON.parse(String(element(sp({ xfrm: box(0, 0, width, height), spPr }))?.fill));

    test('two stops, the ends of the ramp, through the theme, alpha kept, no color-space correction', () => {
        const found = fillOf(
            grad(
                '<a:lin ang="0" scaled="1"/>',
                stop(0, '<a:schemeClr val="accent1"/>') +
                    stop(40000, '<a:srgbClr val="00FF00"/>') +
                    stop(100000, '<a:srgbClr val="0000FF"><a:alpha val="25000"/></a:srgbClr>'),
            ),
        );
        expect(found).toEqual({ type: 'gradient', from: '#4f81bd', to: '#0000ff40', angle: 90, style: 'solid' });
    });

    test('the stops are taken by position, as PowerPoint sorts them; one stop is a solid fill', () => {
        expect(fillOf(grad('<a:lin ang="0"/>', stop(100000, BLUE) + stop(0, RED)))).toMatchObject({
            from: '#ff0000',
            to: '#0000ff',
        });
        expect(fillOf(grad('', stop(50000, BLUE)))).toEqual({ type: 'solid', color: '#0000ff', style: 'solid' });
    });

    test("a scaled angle is the canvas's box-unit one, a quarter turn on from DrawingML's", () => {
        expect(fillOf(grad('<a:lin ang="0" scaled="1"/>')).angle).toBeCloseTo(90, 6);
        expect(fillOf(grad('<a:lin ang="5400000" scaled="1"/>')).angle).toBeCloseTo(180, 6);
        expect(fillOf(grad('<a:lin ang="2700000" scaled="1"/>')).angle).toBeCloseTo(135, 6);
    });

    test("an unscaled angle is the true one, mapped through the box onto the canvas's box units", () => {
        // 45° true on a 2:1 box: the box-unit line whose isolines the box maps onto the true ones.
        const along = (Math.atan2(2, -1) * 180) / Math.PI;
        expect(fillOf(grad('<a:lin ang="2700000" scaled="0"/>')).angle).toBeCloseTo(along, 2);
        expect(fillOf(grad('<a:lin ang="2700000"/>')).angle).toBeCloseTo(along, 2);
        expect(fillOf(grad('<a:lin ang="2700000"/>'), 100, 100).angle).toBeCloseTo(135, 6);
        expect(fillOf(grad('<a:lin ang="5400000"/>')).angle).toBeCloseTo(180, 6);
    });

    test("a path gradient is the same two stops along DrawingML's default angle, and says so", () => {
        const deck = deckOf({
            slides: [{ shapes: sp({ xfrm: box(0, 0, 10, 10), spPr: grad('<a:path path="circle"/>') }) }],
        });
        expect(JSON.parse(String(deck.slides[0].elements[0].fill))).toMatchObject({
            type: 'gradient',
            from: '#ff0000',
            to: '#0000ff',
            angle: 90,
        });
        expect(deck.warnings).toContainEqual({ code: 'fills-simplified', count: 1 });
    });

    test("a style matrix gradient paints its stops in the reference's color", () => {
        const theme = THEME.replace(
            '<a:fillStyleLst>',
            `<a:fillStyleLst>${grad('<a:lin ang="0" scaled="1"/>', stop(0, '<a:schemeClr val="phClr"><a:tint val="0"/></a:schemeClr>') + stop(100000, '<a:schemeClr val="phClr"/>'))}`,
        );
        const found = element(sp({ xfrm: box(0, 0, 10, 10), style: styleRefs(1, 0, '<a:srgbClr val="FF0000"/>') }), {
            theme,
        });
        expect(JSON.parse(String(found?.fill))).toMatchObject({ from: '#ffffff', to: '#ff0000' });
    });

    test("a gradient line strokes in its first stop's color, and says so", () => {
        const deck = deckOf({
            slides: [{ shapes: sp({ xfrm: box(0, 0, 10, 10), spPr: `<a:ln>${grad('<a:lin ang="0"/>')}</a:ln>` }) }],
        });
        expect(deck.slides[0].elements[0]?.strokeColor).toBe('#ff0000');
        expect(deck.warnings).toContainEqual({ code: 'fills-simplified', count: 1 });
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

    // As the docx reader reads one, the branch the reader understands, here the fallback.
    test('a blipFill in mc:AlternateContent is the branch the reader understands', () => {
        const wrapped = pic({ xfrm: box(10, 20, 30, 40), embed: 'rId2' }).replace(
            /<p:blipFill>.*<\/p:blipFill>/,
            (blipFill) =>
                `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14">${blipFill.replace('rId2', 'rId9')}</mc:Choice><mc:Fallback>${blipFill}</mc:Fallback></mc:AlternateContent>`,
        );
        const deck = deckOf({ slides: [{ shapes: wrapped, rels: rel('rId2', 'image', '../media/a.png') }], files });
        const [image] = deck.slides[0].elements;
        expect(image).toMatchObject({ type: 'image' });
        expectBox(image, 10, 20, 30, 40);
        expect(deck.media).toHaveLength(1);
        expect(deck.warnings).toEqual([]);
    });

    test('a picture cropped to a rounded rectangle has curved corners', () => {
        const deck = deckOf({
            slides: [
                {
                    shapes: pic({ xfrm: box(10, 20, 30, 40), embed: 'rId2', geom: 'roundRect' }),
                    rels: rel('rId2', 'image', '../media/a.png'),
                },
            ],
            files,
        });
        expect(deck.slides[0].elements[0]).toMatchObject({ type: 'image', corners: 'curved' });
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

    test("a picture whose bytes don't read is a placeholder, counted for each shape showing it", () => {
        const shapes = pic({ xfrm: box(0, 0, 10, 10), embed: 'rId2' }).repeat(2);
        const deck = readPptx(
            buildPptxWithBadPictures({ slides: [{ shapes, rels: rel('rId2', 'image', '../media/a.png') }], files }),
            OPTIONS,
        );
        expect(deck.media).toEqual([]);
        expect(deck.slides[0].elements.map((found) => [found.type, found.html, found.mediaName])).toEqual([
            ['richtext', '<p>Picture not imported</p>', undefined],
            ['richtext', '<p>Picture not imported</p>', undefined],
        ]);
        expect(deck.warnings).toEqual([{ code: 'images-dropped', count: 2 }]);
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

describe('losses', () => {
    const PATTERN =
        '<a:pattFill prst="pct20"><a:fgClr><a:srgbClr val="00FF00"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>';

    test("count once for the file's element they are in, however many slides show it", () => {
        const deck = deckOf({
            masters: [
                {
                    shapes:
                        graphicFrame('http://schemas.openxmlformats.org/drawingml/2006/table', 0, 0, 635000, 317500) +
                        sp({ xfrm: box(0, 0, 10, 10), spPr: PATTERN }),
                    bg: '<p:bgPr><a:blipFill><a:blip r:embed="rId7"/><a:tile/></a:blipFill></p:bgPr>',
                    rels: rel('rId7', 'image', '../media/bg.png'),
                },
            ],
            slides: [{}, {}, {}],
            files: { 'ppt/media/bg.png': PIXEL_PNG },
        });
        expect(deck.slides.map((slide) => slide.elements.length)).toEqual([2, 2, 2]);
        expect(deck.warnings).toEqual([
            { code: 'tables-dropped', count: 1 },
            { code: 'fills-simplified', count: 2 },
        ]);
    });

    test('count once for each shape drawn with them: a theme pattern three shapes paint with is three', () => {
        const theme = THEME.replace('<a:fillStyleLst>', `<a:fillStyleLst>${PATTERN}`);
        const patterned = sp({ xfrm: box(0, 0, 10, 10), style: styleRefs(1, 0) });
        const vertical = (ph: string) =>
            `<p:sp><p:nvSpPr><p:cNvPr id="9" name=""/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${box(0, 0, 10, 10)}</p:spPr><p:txBody><a:bodyPr vert="eaVert"/>${para('x')}</p:txBody></p:sp>`;
        const deck = deckOf({
            theme,
            masters: [{ shapes: vertical('<p:ph type="body"/>') }],
            slides: [
                { shapes: patterned + patterned + sp({ ph: '<p:ph type="body"/>', text: para('y') }) },
                { shapes: patterned + sp({ ph: '<p:ph type="body"/>', text: para('y') }) },
            ],
        });
        expect(deck.warnings).toEqual([
            { code: 'fills-simplified', count: 3 },
            { code: 'text-simplified', count: 2 },
        ]);
    });

    test('a path gradient line is one simplified fill', () => {
        const ln = `<a:ln><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:path path="circle"/></a:gradFill></a:ln>`;
        const deck = deckOf({ slides: [{ shapes: sp({ xfrm: box(0, 0, 10, 10), spPr: ln }) }] });
        expect(deck.slides[0].elements[0]?.strokeColor).toBe('#ff0000');
        expect(deck.warnings).toEqual([{ code: 'fills-simplified', count: 1 }]);
    });

    test("a dropped outline's fill is not drawn, so only the outline counts", () => {
        const deck = deckOf({
            slides: [
                {
                    shapes:
                        sp({ xfrm: box(0, 0, 10, 10), spPr: `<a:custGeom/>${PATTERN}` }) +
                        sp({
                            xfrm: box(0, 0, 10, 10),
                            geom: 'line',
                            spPr: `${PATTERN}<a:ln>${solid('000000')}</a:ln>`,
                        }),
                },
            ],
        });
        expect(deck.warnings).toEqual([{ code: 'shapes-simplified', count: 1 }]);
    });

    test("a group's fill counts for each child that shows it", () => {
        const group = (child: string) =>
            grp(`${groupXfrm([0, 0, 100 * PX, 100 * PX], [0, 0, 100 * PX, 100 * PX])}${PATTERN}`, child);
        const unshown = deckOf({ slides: [{ shapes: group(sp({ xfrm: box(0, 0, 10, 10), spPr: FILLED })) }] });
        expect(unshown.warnings).toEqual([]);
        const filled = sp({ xfrm: box(0, 0, 10, 10), spPr: '<a:grpFill/>' });
        const shown = deckOf({ slides: [{ shapes: group(filled + filled) }] });
        expect(JSON.parse(String(shown.slides[0].elements[0].fill))).toMatchObject({ color: '#00ff00' });
        expect(shown.warnings).toEqual([{ code: 'fills-simplified', count: 2 }]);
    });
});

// A SmartArt graphic is drawn from the drawing PowerPoint caches of it: its shapes at the frame's offset, each text in
// the box the drawing gives it.
describe('SmartArt', () => {
    const LINE = `<a:ln w="12700">${scheme('lt1')}</a:ln>`;
    const ORG_CHART = [
        dspSp({
            xfrm: box(20, 10, 200, 100),
            geom: 'roundRect',
            spPr: `${scheme('accent1')}${LINE}`,
            text: para('President', ' sz="3100"'),
            txXfrm: textBox(30, 20, 180, 80),
        }),
        dspSp({
            xfrm: box(300, 10, 200, 100),
            spPr: `${scheme('accent1')}${LINE}`,
            text: para('Vice President'),
            txXfrm: textBox(300, 10, 200, 100),
        }),
    ].join('');
    const deckWith = (diagram: ReturnType<typeof smartArt>) =>
        deckOf({
            slides: [{ shapes: diagram.shapes, rels: diagram.rels }],
            types: diagram.types,
            files: diagram.files,
        });
    const fillOf = (found: NewVectorElement | undefined) => JSON.parse(String(found?.fill));

    test('its shapes come in at the frame offset plus their own, painted, with their text in the txXfrm box', () => {
        const deck = deckWith(smartArt([100, 50, 600, 400], { nodes: ['President'], drawing: ORG_CHART }));
        const [node, text, rectangle, rectangleText] = deck.slides[0].elements;
        expect(deck.slides[0].elements.map((found) => found.type)).toEqual([
            'rectangle',
            'richtext',
            'rectangle',
            'richtext',
        ]);
        expect(node).toMatchObject({ corners: 'curved', strokeColor: '#ffffff' });
        expect(fillOf(node)).toMatchObject({ color: '#4f81bd' });
        expectBox(node, 120, 60, 200, 100);
        expect(text).toMatchObject({ html: '<p>President</p>', color: '#ffffff' });
        expect(fillOf(text).color).toBe(TRANSPARENT_COLOR);
        expectBox(text, 130, 70, 180, 80);
        // A straight rectangle splits too: a painted rectangle, its text on top.
        expect(rectangle).toMatchObject({ corners: 'straight' });
        expect(fillOf(rectangle)).toMatchObject({ color: '#4f81bd' });
        expectBox(rectangle, 400, 60, 200, 100);
        expect(rectangleText?.html).toBe('<p>Vice President</p>');
        expectBox(rectangleText, 400, 60, 200, 100);
    });

    test("a scheme color shows through the slide's color map, and a dsp:style fillRef paints", () => {
        const remapped =
            '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent3" accent2="accent2" accent3="accent3" accent4="accent1" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>';
        const drawing =
            dspSp({ xfrm: box(0, 0, 100, 100), spPr: scheme('accent1') }) +
            dspSp({ xfrm: box(200, 0, 100, 100), style: styleRefs(1, 0) });
        const diagram = smartArt([0, 0, 400, 200], { drawing });
        const deck = deckOf({
            slides: [{ shapes: diagram.shapes, rels: diagram.rels, after: remapped }],
            types: diagram.types,
            files: diagram.files,
        });
        expect(deck.slides[0].elements.map((found) => fillOf(found).color)).toEqual(['#9bbb59', '#c0504d']);
    });

    test("its text turns with its shape, by the txXfrm's own turn: a hexagon turned upright keeps its text level", () => {
        const drawing =
            dspSp({
                xfrm: box(0, 0, 100, 80, ' rot="5400000"'),
                geom: 'hexagon',
                spPr: scheme('accent1'),
                text: para('upright'),
                txXfrm: textBox(20, 10, 60, 60, ' rot="-5400000"'),
            }) +
            dspSp({
                xfrm: box(200, 0, 100, 50, ' rot="1800000"'),
                spPr: scheme('accent1'),
                text: para('turned'),
                txXfrm: textBox(200, 0, 100, 50),
            });
        const elements = deckWith(smartArt([0, 0, 400, 200], { drawing })).slides[0].elements;
        const texts = elements.filter((found) => found.type === 'richtext');
        expect(texts.map((found) => [found.html, Math.round(Number(found.angle))])).toEqual([
            ['<p>upright</p>', 0],
            ['<p>turned</p>', 30],
        ]);
        expectBox(texts[0], 20, 10, 60, 60);
    });

    test("a link in its text resolves through the drawing's own relationships", () => {
        const drawing = dspSp({
            xfrm: box(0, 0, 100, 100),
            text: `<a:p>${run('site', '', '<a:hlinkClick r:id="rId1"/>')}</a:p>`,
            txXfrm: textBox(0, 0, 100, 100),
        });
        const diagram = smartArt([0, 0, 400, 200], {
            drawing,
            drawingRels: rel('rId1', 'hyperlink', 'https://eigen.is/', true),
        });
        const text = deckWith(diagram).slides[0].elements.find((found) => found.type === 'richtext');
        expect(text?.html).toBe('<p><a href="https://eigen.is/">site</a></p>');
    });

    test('a drawn one counts as a graphic that lost its layout, once however many slides show it', () => {
        const diagram = smartArt([0, 0, 400, 200], { drawing: ORG_CHART });
        const deck = deckOf({
            layouts: [{ shapes: diagram.shapes, rels: diagram.rels }],
            slides: [{}, {}],
            types: diagram.types,
            files: diagram.files,
        });
        expect(deck.slides.map((slide) => slide.elements.length)).toEqual([4, 4]);
        expect(deck.warnings).toEqual([{ code: 'diagrams-flattened', count: 1 }]);
    });

    test('without a cached drawing, the dashed box shows its node text and counts as dropped', () => {
        const deck = deckWith(smartArt([100, 50, 400, 200], { nodes: ['Plan', 'Build'] }));
        const [placeholder] = deck.slides[0].elements;
        expect(deck.slides[0].elements).toHaveLength(1);
        expect(placeholder).toMatchObject({
            type: 'richtext',
            strokeStyle: 'dashed',
            html: '<p>SmartArt not imported</p><p>Plan</p><p>Build</p>',
        });
        expectBox(placeholder, 100, 50, 400, 200);
        expect(deck.warnings).toEqual([{ code: 'diagrams-dropped', count: 1 }]);
    });

    // As a govuk deck's alternating hexagons are cached: a spTree with no shape in it.
    test('a cached drawing with no shapes shows the dashed box with the node text too', () => {
        const deck = deckWith(smartArt([100, 50, 400, 200], { nodes: ['Plan'], drawing: '' }));
        expect(deck.slides[0].elements.map((found) => found.html)).toEqual(['<p>SmartArt not imported</p><p>Plan</p>']);
        expect(deck.warnings).toEqual([{ code: 'diagrams-dropped', count: 1 }]);
    });
});
