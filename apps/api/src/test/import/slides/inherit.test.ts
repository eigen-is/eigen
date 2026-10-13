import { describe, expect, test } from 'bun:test';
import type { NewVectorElement } from '@workspace/lib/vector';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { box, buildPptx, type PptxFixture, para, scheme, solid, sp } from '../../fixtures/pptx';

// What a slide takes from its layout, master and theme: placeholder geometry, the shapes drawn beneath, the colour
// map and the background.

const OPTIONS = { width: 1920, height: 1080, maxMediaBytes: 35 * 1024 * 1024 };
const deckOf = (fixture: PptxFixture) => readPptx(buildPptx(fixture), OPTIONS);
const first = (fixture: PptxFixture): NewVectorElement[] => deckOf(fixture).slides[0].elements;
const placed = (found: NewVectorElement | undefined) =>
    [found?.x, found?.y, found?.width, found?.height].map((value) => Math.round(value ?? Number.NaN));

const placeholder = (ph: string, at?: string, text?: string) =>
    sp({ ph, xfrm: at, text: text === undefined ? undefined : para(text) });

describe('placeholders', () => {
    test("a placeholder with no xfrm takes its layout's, else its master's", () => {
        const [title, body] = first({
            masters: [{ shapes: placeholder('<p:ph type="body" idx="1"/>', box(10, 300, 900, 600)) }],
            layouts: [
                { shapes: placeholder('<p:ph type="title"/>', box(10, 20, 900, 100)) + placeholder('<p:ph idx="1"/>') },
            ],
            slides: [
                {
                    shapes:
                        placeholder('<p:ph type="ctrTitle"/>', undefined, 'Title') +
                        placeholder('<p:ph idx="1"/>', undefined, 'Body'),
                },
            ],
        });
        expect(placed(title)).toEqual([10, 20, 900, 100]);
        expect(placed(body)).toEqual([10, 300, 900, 600]);
    });

    test('a layout placeholder matches by idx before type; a master one by kind, never by an idx a date reuses', () => {
        const [found] = first({
            masters: [
                {
                    shapes:
                        placeholder('<p:ph type="dt" idx="2"/>', box(0, 1000, 100, 50)) +
                        placeholder('<p:ph type="body" idx="1"/>', box(50, 50, 500, 500)),
                },
            ],
            layouts: [
                {
                    shapes:
                        placeholder('<p:ph type="body" idx="1"/>', box(1, 1, 1, 1)) +
                        placeholder('<p:ph type="body" sz="half" idx="2"/>'),
                },
            ],
            slides: [{ shapes: placeholder('<p:ph type="body" sz="half" idx="2"/>', undefined, 'Half') }],
        });
        expect(placed(found)).toEqual([50, 50, 500, 500]);
    });

    test('a picture, table, chart, clip art, diagram or media placeholder takes the master body placeholder', () => {
        const kinds = ['pic', 'tbl', 'chart', 'clipArt', 'dgm', 'media'];
        const elements = first({
            masters: [{ shapes: placeholder('<p:ph type="body" idx="1"/>', box(50, 50, 500, 500)) }],
            slides: [
                {
                    shapes: kinds
                        .map((type, i) => placeholder(`<p:ph type="${type}" idx="${i + 20}"/>`, undefined, type))
                        .join(''),
                },
            ],
        });
        expect(elements.map(placed)).toEqual(kinds.map(() => [50, 50, 500, 500]));
    });

    test('a slide of many placeholders over a layout of many matches each in one lookup', () => {
        const ph = (attributes: string) => `<p:sp><p:nvSpPr><p:nvPr><p:ph ${attributes}/></p:nvPr></p:nvSpPr></p:sp>`;
        const layout = Array.from({ length: 40_000 }, (_, i) => ph(`type="dt" idx="${i + 100_000}"`)).join('');
        const slide = Array.from({ length: 5000 }, (_, i) => ph(`type="chart" idx="${i}"`)).join('');
        const pptx = buildPptx({
            layouts: [{ shapes: layout }],
            slides: [{ shapes: slide, attributes: ' showMasterSp="0"' }],
        });
        const started = performance.now();
        readPptx(pptx, OPTIONS);
        // Quadratic matching took seconds here; one lookup each takes milliseconds.
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test("a slide's empty placeholder is not drawn, and the title's text names the frame", () => {
        const deck = deckOf({
            layouts: [{ shapes: placeholder('<p:ph type="title"/>', box(0, 0, 100, 100)) }],
            slides: [
                {
                    shapes:
                        placeholder('<p:ph type="title"/>', undefined, ' A   long\ttitle ') +
                        placeholder('<p:ph idx="5"/>', box(0, 0, 9, 9), ''),
                },
                { shapes: placeholder('<p:ph type="title"/>', undefined, 'x'.repeat(300)) },
            ],
        });
        expect(deck.slides[0].elements).toHaveLength(1);
        expect(deck.slides[0].name).toBe('A long title');
        expect(deck.slides[1].name).toHaveLength(100);
    });
});

describe('layout and master shapes', () => {
    const logo = (color: string) => sp({ xfrm: box(0, 0, 10, 10), spPr: solid(color) });
    const fixture = (slide: string, layout = ''): PptxFixture => ({
        masters: [
            {
                shapes:
                    logo('AA0000') +
                    placeholder('<p:ph type="dt" idx="2"/>', box(0, 0, 10, 10), 'today') +
                    placeholder('<p:ph type="sldNum" idx="4"/>', box(0, 0, 10, 10), '1'),
            },
        ],
        layouts: [
            {
                shapes: logo('00AA00') + placeholder('<p:ph type="title"/>', box(0, 0, 10, 10), 'Click to edit'),
                attributes: layout,
            },
        ],
        slides: [{ shapes: logo('0000AA'), attributes: slide }],
    });
    const colors = (fixture: PptxFixture) => first(fixture).map((found) => JSON.parse(String(found.fill)).color);

    test("the master's and the layout's non-placeholder shapes are drawn beneath the slide's, none of their placeholders", () => {
        expect(colors(fixture(''))).toEqual(['#aa0000', '#00aa00', '#0000aa']);
    });

    test("showMasterSp on the slide hides both, on the layout the master's", () => {
        expect(colors(fixture(' showMasterSp="0"'))).toEqual(['#0000aa']);
        expect(colors(fixture('', ' showMasterSp="0"'))).toEqual(['#00aa00', '#0000aa']);
    });
});

describe('colour', () => {
    const tx1 = (after = '', clrMap?: string) =>
        JSON.parse(
            String(
                first({
                    masters: [{ clrMap }],
                    slides: [{ shapes: sp({ xfrm: box(0, 0, 1, 1), spPr: scheme('tx1') }), after }],
                })[0].fill,
            ),
        ).color;

    test("a scheme colour is mapped through the master's clrMap, and the slide's override", () => {
        expect(tx1()).toBe('#000000');
        expect(tx1('', 'bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2"')).toBe('#ffffff');
        expect(tx1('<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="dk2" bg2="lt2" tx2="lt2"/></p:clrMapOvr>')).toBe(
            '#1f497d',
        );
        expect(tx1('<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>')).toBe('#000000');
    });
});

describe('backgrounds', () => {
    const background = (fixture: Partial<PptxFixture>) => deckOf({ slides: [{}], ...fixture }).slides[0].background;

    test("the slide's own, else its layout's, else its master's; none is null", () => {
        expect(background({})).toBeNull();
        expect(background({ masters: [{ bg: `<p:bgPr>${solid('112233')}</p:bgPr>` }] })).toEqual({
            type: 'solid',
            color: '#112233',
        });
        expect(
            background({
                masters: [{ bg: `<p:bgPr>${solid('112233')}</p:bgPr>` }],
                layouts: [{ bg: `<p:bgPr>${solid('445566')}</p:bgPr>` }],
            }),
        ).toEqual({ type: 'solid', color: '#445566' });
        expect(
            background({
                layouts: [{ bg: `<p:bgPr>${solid('445566')}</p:bgPr>` }],
                slides: [{ bg: `<p:bgPr>${scheme('accent2')}</p:bgPr>` }],
            }),
        ).toEqual({ type: 'solid', color: '#c0504d' });
    });

    test("a bgRef of 1001 and up picks from the theme's bgFillStyleLst, its own colour the placeholder colour", () => {
        const ref = (idx: number) =>
            background({ masters: [{ bg: `<p:bgRef idx="${idx}"><a:srgbClr val="FF8800"/></p:bgRef>` }] });
        expect(ref(1001)).toEqual({ type: 'solid', color: '#ff8800' });
        expect(ref(1002)).toEqual({ type: 'solid', color: '#abcdef' });
        expect(ref(1003)).toBeNull();
        expect(ref(0)).toBeNull();
        expect(ref(1999)).toBeNull();
    });

    test('a gradient background is its first stop for now', () => {
        const gradient = `<p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="010203"/></a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst></a:gradFill></p:bgPr>`;
        expect(background({ slides: [{ bg: gradient }] })).toEqual({ type: 'solid', color: '#010203' });
    });
});
