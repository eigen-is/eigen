import { describe, expect, test } from 'bun:test';
import type { NewVectorElement } from '@workspace/lib/vector';
import { A_NS, parseOoxml } from '../../../lib/core/ooxml';
import { xmlChild, xmlElements } from '../../../lib/core/xml';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { paintOf, type SlideTheme } from '../../../lib/import/slides/inherit';
import { withWorkBudget } from '../../../lib/import/slides/lookup';
import {
    box,
    buildPptx,
    buildPptxWithBadPictures,
    countVisits,
    NS,
    PIXEL_PNG,
    type PptxFixture,
    para,
    pptxParts,
    rel,
    scheme,
    solid,
    sp,
    styleRefs,
    THEME,
    zipParts,
} from '../../fixtures/pptx';

// What a slide takes from its layout, master and theme: placeholder geometry, the shapes drawn beneath, the colour
// map and the background.

const OPTIONS = { maxMediaBytes: 35 * 1024 * 1024 };
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

    test("what slide shapes inherit is read once: a master placeholder's, its text styles, the presentation's default and the theme's style lists", () => {
        // 100,000 empty elements where a lookup scans: once a slide shape, they took seconds.
        const junk = (prefix: string) => `<${prefix}:x/>`.repeat(100_000);
        const placeholder = (inner: string) =>
            `<p:sp><p:nvSpPr><p:cNvPr id="2" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>${inner}</p:sp>`;
        const at = `<p:spPr>${box(0, 0, 100, 100)}</p:spPr>`;
        const text = '<p:txBody><a:bodyPr/><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody>';
        const own = placeholder(`<p:spPr/>${text}`).repeat(2000);
        const cases: PptxFixture[] = [
            { masters: [{ shapes: placeholder(`${at}<p:txBody>${'<a:p/>'.repeat(100_000)}</p:txBody>`) }] },
            { masters: [{ shapes: placeholder(`<p:spPr>${box(0, 0, 100, 100)}${junk('a')}</p:spPr>`) }] },
            { masters: [{ shapes: placeholder(`${at}${junk('p')}`) }] },
            {
                masters: [{ shapes: placeholder(at), txStyles: `<p:txStyles>${junk('p')}<p:bodyStyle/></p:txStyles>` }],
            },
        ].map((fixture) => ({ ...fixture, slides: [{ shapes: own }] }));
        const shape = sp({ xfrm: box(0, 0, 1, 1), text: para('x'), style: styleRefs(1, 1) }).repeat(2000);
        const presentation = pptxParts({ slides: [{ shapes: shape }] });
        presentation['ppt/presentation.xml'] = String(presentation['ppt/presentation.xml']).replace(
            '</p:presentation>',
            `${junk('p')}<p:defaultTextStyle/></p:presentation>`,
        );
        const theme = THEME.replace('<a:fillStyleLst>', `<a:fillStyleLst>${junk('a')}`.replace(/a:x/g, 'a:noFill'));
        for (const pptx of [
            ...cases.map(buildPptx),
            zipParts(presentation),
            buildPptx({ theme, slides: [{ shapes: shape }] }),
        ]) {
            const started = performance.now();
            readPptx(pptx, OPTIONS);
            expect(performance.now() - started).toBeLessThan(1000);
        }
    });

    test("what a shared part's elements hold is looked into once: text style levels, run defaults, theme styles, fills, backgrounds and attributes", () => {
        // Junk where a lookup scans, under 2,000 paragraphs, runs or shapes, or 500 slides: scanned again by each, they
        // took seconds to minutes.
        const junk = (count: number, tag = 'a:x') => `<${tag}/>`.repeat(count);
        const body = (inner: string) =>
            `<p:sp><p:nvSpPr><p:cNvPr id="3" name=""/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${inner}</p:txBody></p:sp>`;
        const styled = (bodyStyle: string, inner: string): PptxFixture => ({
            masters: [
                {
                    shapes: placeholder('<p:ph type="body"/>', box(0, 0, 100, 100)),
                    txStyles: `<p:txStyles><p:bodyStyle>${bodyStyle}</p:bodyStyle></p:txStyles>`,
                },
            ],
            slides: [{ shapes: body(inner) }],
        });
        const paragraphs = para('x').repeat(2000);
        const runs = `<a:p>${'<a:r><a:t>x</a:t></a:r>'.repeat(2000)}</a:p>`;
        const shapes = (spPr: string, style?: string) => sp({ xfrm: box(0, 0, 1, 1), spPr, style }).repeat(2000);
        const slides = (count: number, after = (_: number) => '') =>
            Array.from({ length: count }, (_, i) => ({ after: after(i) }));
        const slots = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
        const override = (i: number) =>
            `<p:clrMapOvr><a:overrideClrMapping bg1="${slots[i % 10]}" tx1="${slots[Math.floor(i / 10) % 10]}" bg2="lt2" tx2="dk2"/></p:clrMapOvr>`;
        const master = pptxParts({ slides: slides(500) });
        master['ppt/slideMasters/slideMaster1.xml'] = String(master['ppt/slideMasters/slideMaster1.xml']).replace(
            '<p:cSld>',
            `${junk(300_000, 'p:x')}<p:cSld><p:bg><p:bgPr>${solid('FF0000')}<a:effectLst/></p:bgPr></p:bg>`,
        );
        const blip = `<a:blip xmlns:q="urn:q" ${Array.from({ length: 300_000 }, (_, i) => `q:a${i}=""`).join(' ')} r:embed="rId9"/>`;
        for (const pptx of [
            buildPptx(styled(`${junk(100_000)}<a:lvl1pPr/>`, paragraphs)),
            buildPptx(styled(`<a:lvl1pPr>${junk(100_000)}<a:defRPr/></a:lvl1pPr>`, paragraphs)),
            buildPptx(styled(`<a:lvl1pPr><a:defRPr>${junk(100_000)}</a:defRPr></a:lvl1pPr>`, `<a:p>${runs}</a:p>`)),
            buildPptx(
                styled(
                    `<a:lvl1pPr><a:defRPr><a:solidFill>${junk(100_000)}<a:srgbClr val="FF0000"/></a:solidFill></a:defRPr></a:lvl1pPr>`,
                    runs,
                ),
            ),
            buildPptx({
                theme: THEME.replace('<a:fillStyleLst><a:solidFill>', `<a:fillStyleLst><a:solidFill>${junk(100_000)}`),
                slides: [{ shapes: shapes('', styleRefs(1, 0)) }],
            }),
            buildPptx({
                theme: THEME.replace('<a:ln w="9525">', `<a:ln w="9525">${junk(100_000)}`),
                slides: [{ shapes: shapes('', styleRefs(0, 1)) }],
            }),
            buildPptx({
                masters: [
                    {
                        shapes: placeholder(
                            '<p:ph type="body"/>',
                            `${box(0, 0, 100, 100)}<a:ln>${junk(100_000)}${solid('FF0000')}</a:ln>`,
                        ),
                    },
                ],
                slides: [{ shapes: body('').repeat(2000) }],
            }),
            buildPptx({
                slides: [
                    {
                        shapes: `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${box(0, 0, 10, 10)}<a:solidFill>${junk(100_000)}<a:srgbClr val="FF0000"/></a:solidFill></p:grpSpPr>${shapes('<a:grpFill/>')}</p:grpSp>`,
                    },
                ],
            }),
            buildPptx({
                theme: THEME.replace(
                    '<a:bgFillStyleLst><a:solidFill>',
                    `<a:bgFillStyleLst><a:solidFill>${junk(300_000)}`,
                ),
                masters: [{ bg: '<p:bgRef idx="1001"><a:srgbClr val="FF0000"/></p:bgRef>' }],
                slides: slides(500),
            }),
            zipParts(master),
            // Every slide maps its colours anew, the same way: its own placeholder's master fill resolves once.
            buildPptx({
                masters: [
                    {
                        shapes: placeholder(
                            '<p:ph type="body"/>',
                            `${box(0, 0, 100, 100)}<a:solidFill>${junk(300_000)}<a:schemeClr val="tx1"/></a:solidFill>`,
                        ),
                    },
                ],
                slides: slides(500, () => override(0)).map((slide) => ({ ...slide, shapes: body('') })),
            }),
            buildPptx({
                masters: [{ shapes: sp({ xfrm: box(0, 0, 1, 1), spPr: `${junk(300_000)}${solid('FF0000')}` }) }],
                slides: slides(500, override),
            }),
            buildPptx({
                masters: [
                    {
                        bg: `<p:bgPr><a:blipFill>${blip}<a:stretch/></a:blipFill><a:effectLst/></p:bgPr>`,
                        rels: rel('rId9', 'image', '../media/image1.png'),
                    },
                ],
                slides: slides(500),
                files: { 'ppt/media/image1.png': PIXEL_PNG },
            }),
        ]) {
            const started = performance.now();
            readPptx(pptx, OPTIONS);
            expect(performance.now() - started).toBeLessThan(1000);
        }
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

    test("a master's shape is painted with each slide's colour map", () => {
        const override = '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="dk2" bg2="lt2" tx2="lt2"/></p:clrMapOvr>';
        const deck = deckOf({
            masters: [{ shapes: sp({ xfrm: box(0, 0, 1, 1), spPr: scheme('tx1') }) }],
            slides: [{}, { after: override }, {}, { after: override }],
        });
        const fills = deck.slides.map((slide) => JSON.parse(String(slide.elements[0].fill)).color);
        expect(fills).toEqual(['#000000', '#1f497d', '#000000', '#1f497d']);
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

describe('a shared fill', () => {
    const parse = (xml: string) => {
        const element = parseOoxml(xml);
        if (!element) throw new Error(`not XML: ${xml}`);
        return element;
    };
    const themeOf = (accent1: string): SlideTheme => ({
        colors: {
            scheme: new Map([
                ['accent1', '#4f81bd'],
                ['accent2', '#c0504d'],
            ]),
            map: new Map([['accent1', accent1]]),
        },
        fonts: { major: '', minor: '' },
        formats: { fills: [], backgrounds: [], lines: [] },
    });
    const lost = () => {};
    const junk = '<a:x/>'.repeat(100);

    test('is scanned once and resolved once for each colour map, however many shapes it paints', () => {
        const fill = parse(`<a:solidFill ${NS}>${junk}<a:schemeClr val="accent1"/></a:solidFill>`);
        const count = countVisits(fill);
        const [mapped, remapped] = [themeOf('accent1'), themeOf('accent2')];
        for (let i = 0; i < 1000; i++) {
            expect(paintOf(fill, mapped, { lost })).toEqual({ type: 'solid', color: '#4f81bd' });
            expect(paintOf(fill, remapped, { lost })).toEqual({ type: 'solid', color: '#c0504d' });
        }
        expect(count.visits).toBe(101);
    });

    test("a style matrix entry's colour and its gradient's stops are found once, however many phClr paint them", () => {
        const solidEntry = parse(
            `<a:solidFill ${NS}>${junk}<a:schemeClr val="phClr">${junk}<a:shade val="50000"/></a:schemeClr></a:solidFill>`,
        );
        const entry = parse(
            `<a:gradFill ${NS}><a:gsLst>${junk}<a:gs pos="100000"><a:srgbClr val="00FF00"/></a:gs><a:gs pos="0">${junk}<a:schemeClr val="phClr"/></a:gs><a:gs pos="50000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>`,
        );
        const stops = xmlChild(entry, A_NS, 'gsLst');
        const stop = stops && xmlElements(stops)[101];
        const color = xmlChild(solidEntry, A_NS, 'schemeClr');
        if (!stop || !stops || !color) throw new Error('no stops');
        const counts = [solidEntry, color, stops, stop].map(countVisits);
        const theme = themeOf('accent1');
        for (let i = 0; i < 1000; i++) {
            const hex = (0x100000 + i).toString(16);
            const reference = parse(`<a:fillRef ${NS} idx="1"><a:srgbClr val="${hex}"/></a:fillRef>`);
            expect(paintOf(entry, theme, { lost, reference })).toEqual({
                type: 'gradient',
                from: `#${hex}`,
                to: '#00ff00',
                angle: 90,
            });
            expect(paintOf(solidEntry, theme, { lost, reference })?.type).toBe('solid');
        }
        // Each scanned once: a phClr reapplies the colour's few transforms, and the ramp's ends are picked anew.
        expect(counts.map((count) => count.visits)).toEqual([101, 101, 103, 101]);
    });

    test("a gradient's ends alone are resolved for each phClr, and a colour that isn't phClr once for all", () => {
        const stops = Array.from(
            { length: 1000 },
            (_, i) => `<a:gs pos="${i * 100}"><a:schemeClr val="phClr"/></a:gs>`,
        );
        const entry = parse(`<a:gradFill ${NS}><a:gsLst>${stops.join('')}</a:gsLst></a:gradFill>`);
        const fixed = parse(
            `<a:solidFill ${NS}><a:srgbClr val="123456">${'<a:lumMod val="99000"/>'.repeat(20)}</a:srgbClr></a:solidFill>`,
        );
        const theme = themeOf('accent1');
        // Every stop resolved for every phClr would be a million units, the fixed colour's 20 transforms 21,000.
        withWorkBudget(20_000, () => {
            for (let i = 0; i < 1000; i++) {
                const reference = parse(
                    `<a:fillRef ${NS} idx="1"><a:srgbClr val="${(0x100000 + i).toString(16)}"/></a:fillRef>`,
                );
                expect(paintOf(entry, theme, { lost, reference })?.type).toBe('gradient');
                expect(paintOf(fixed, theme, { lost, reference })?.type).toBe('solid');
            }
        });
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
        expect(deck.media[0].name).toMatch(/^pptx-[0-9a-f-]{36}-image-1\.png$/);
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

        const recoloured = deckOf({
            slides: [
                {
                    bg: '<p:bgPr><a:blipFill><a:blip r:embed="rId7"><a:duotone><a:srgbClr val="000000"/><a:srgbClr val="FFFFFF"/></a:duotone></a:blip><a:stretch/></a:blipFill></p:bgPr>',
                    rels: rel('rId7', 'image', '../media/bg.png'),
                },
            ],
            files: { 'ppt/media/bg.png': PIXEL_PNG },
        });
        expect(recoloured.slides[0].background).toMatchObject({ type: 'image', fit: 'cover' });
        expect(recoloured.warnings).toEqual([{ code: 'fills-simplified', count: 1 }]);
    });

    test("a background picture whose bytes don't read is none, and counted", () => {
        const deck = readPptx(
            buildPptxWithBadPictures({
                masters: [
                    {
                        bg: '<p:bgPr><a:blipFill><a:blip r:embed="rId7"/></a:blipFill></p:bgPr>',
                        rels: rel('rId7', 'image', '../media/bg.png'),
                    },
                ],
                slides: [{}, {}],
                files: { 'ppt/media/bg.png': PIXEL_PNG },
            }),
            OPTIONS,
        );
        expect(deck.slides.map((slide) => slide.background)).toEqual([null, null]);
        expect(deck.media).toEqual([]);
        expect(deck.warnings).toEqual([{ code: 'images-unshown', count: 1 }]);
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

    test("a bgRef's picture the theme names outside the package's ppt/ folder, or a part not a picture, is not read", () => {
        const theme = THEME.replace(
            '<a:bgFillStyleLst>',
            '<a:bgFillStyleLst><a:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>',
        );
        const themed = (target: string) =>
            deckOf({
                theme,
                themeRels: rel('rId9', 'image', target),
                masters: [{ bg: '<p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef>' }],
                slides: [{}],
                files: { 'escaped.png': PIXEL_PNG, 'ppt/media/fake.xml': '<x/>' },
            });
        for (const target of ['../../escaped.png', '/escaped.png', '../slides/slide1.xml', '../media/fake.xml']) {
            const deck = themed(target);
            expect(deck.slides[0].background).toBeNull();
            expect(deck.media).toEqual([]);
            expect(deck.warnings).toEqual([{ code: 'images-unshown', count: 1 }]);
        }
    });
});
