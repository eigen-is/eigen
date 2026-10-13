import { describe, expect, test } from 'bun:test';
import type { NewVectorElement } from '@workspace/lib/vector';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { box, buildPptx, PIXEL_PNG, type PptxFixture, para, rel, scheme, solid, sp, THEME } from '../../fixtures/pptx';

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

    const gradient = (lin: string, stops = '<a:srgbClr val="010203"/>') =>
        `<p:bgPr><a:gradFill><a:gsLst><a:gs pos="0">${stops}</a:gs><a:gs pos="100000"><a:srgbClr val="FFFFFF"><a:alpha val="50000"/></a:srgbClr></a:gs></a:gsLst>${lin}</a:gradFill></p:bgPr>`;

    test("a gradient background is its two end stops at the CSS angle of DrawingML's true one", () => {
        expect(background({ slides: [{ bg: gradient('<a:lin ang="5400000" scaled="0"/>') }] })).toEqual({
            type: 'gradient',
            from: '#010203',
            to: '#ffffff80',
            angle: 180,
        });
        const angle = (lin: string) => {
            const found = background({ slides: [{ bg: gradient(lin) }] });
            return found?.type === 'gradient' ? found.angle : Number.NaN;
        };
        expect(angle('<a:lin ang="0"/>')).toBeCloseTo(90, 6);
        expect(angle('<a:lin ang="2700000" scaled="0"/>')).toBeCloseTo(135, 6);
        // Scaled, 45° runs corner to corner of the 16:9 slide.
        expect(angle('<a:lin ang="2700000" scaled="1"/>')).toBeCloseTo((Math.atan2(16, 9) * 180) / Math.PI + 90, 2);
        expect(angle('<a:path path="rect"/>')).toBeCloseTo(90, 6);
    });

    test("a bgRef's gradient paints the reference's colour into phClr", () => {
        const theme = THEME.replace(
            '<a:bgFillStyleLst>',
            `<a:bgFillStyleLst><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="50000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0" scaled="1"/></a:gradFill>`,
        );
        expect(
            background({ theme, masters: [{ bg: '<p:bgRef idx="1001"><a:srgbClr val="808080"/></p:bgRef>' }] }),
        ).toEqual({ type: 'gradient', from: '#404040', to: '#808080', angle: 90 });
    });

    test('a picture background covers the frame, its picture read as a slide picture is', () => {
        const picture = (fill: string) =>
            `<p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="rId7"/>${fill}</a:blipFill><a:effectLst/></p:bgPr>`;
        const deck = deckOf({
            masters: [
                { bg: picture('<a:stretch><a:fillRect/></a:stretch>'), rels: rel('rId7', 'image', '../media/bg.png') },
            ],
            slides: [{}, {}],
            files: { 'ppt/media/bg.png': PIXEL_PNG },
        });
        expect(deck.media).toHaveLength(1);
        expect(deck.media[0].name).toMatch(/^pptx-[0-9a-f]{8}-image-1\.png$/);
        for (const slide of deck.slides)
            expect(slide.background).toEqual({ type: 'image', mediaName: deck.media[0].name, fit: 'cover' });
        expect(deck.warnings).toEqual([]);

        const tiled = deckOf({
            slides: [
                {
                    bg: picture('<a:tile tx="0" ty="0" sx="100000" sy="100000"/>'),
                    rels: rel('rId7', 'image', '../media/bg.png'),
                },
            ],
            files: { 'ppt/media/bg.png': PIXEL_PNG },
        });
        expect(tiled.slides[0].background).toMatchObject({ type: 'image', fit: 'cover' });
        expect(tiled.warnings).toEqual([{ code: 'fills-simplified', count: 1 }]);
    });

    test("a background picture the deck can't show is none, and counted; a bgRef's picture is named by the theme", () => {
        const emf = deckOf({
            slides: [
                {
                    bg: '<p:bgPr><a:blipFill><a:blip r:embed="rId7"/><a:stretch/></a:blipFill></p:bgPr>',
                    rels: rel('rId7', 'image', '../media/bg.emf'),
                },
            ],
            files: { 'ppt/media/bg.emf': new Uint8Array(4) },
        });
        expect(emf.slides[0].background).toBeNull();
        expect(emf.media).toEqual([]);
        expect(emf.warnings).toEqual([{ code: 'images-unshown', count: 1 }]);

        const theme = THEME.replace(
            '<a:bgFillStyleLst>',
            '<a:bgFillStyleLst><a:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
        );
        const themed = deckOf({
            theme,
            themeRels: rel('rId9', 'image', '../media/theme.png'),
            masters: [{ bg: '<p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef>' }],
            slides: [{}],
            files: { 'ppt/media/theme.png': PIXEL_PNG },
        });
        expect(themed.slides[0].background).toEqual({ type: 'image', mediaName: themed.media[0].name, fit: 'cover' });
    });
});
