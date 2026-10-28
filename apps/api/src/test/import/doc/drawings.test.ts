import { describe, expect, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { CHART_MAX_SIDE, DEFAULT_CHART_SERIES_STYLE, readChartSpec } from '@workspace/lib/charts';
import { CAPTION_LOOK, LIST_LEVEL } from '../../../lib/document/looks';
import { docxToPmJson, readDocx } from '../../../lib/import/doc/from-docx';
import { MAX_MEDIA_PARTS, PICTURE_NOT_IMPORTED } from '../../../lib/import/image-types';
import { C_NS } from '../../../lib/ooxml/ooxml';
import * as ooxmlChart from '../../../lib/ooxml/ooxml-chart';
import { CHART_CONTENT_TYPE, CHART_NOT_IMPORTED } from '../../../lib/ooxml/ooxml-chart';
import {
    buildDocxWithBands,
    buildDocxWithBody,
    chartParts,
    chartRun,
    GOLDEN_DOCX_IMAGE_RUN,
    importDocxBody,
    marksOfType,
    nodesOfType,
    unprefixed,
} from '../../fixtures/golden-docx';

// Pictures: one media file per image part, named from its content type, placed as Word places it.

const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const paragraph = (inner: string) => `<w:p>${inner}</w:p>`;
const picture = (rid: string) => GOLDEN_DOCX_IMAGE_RUN.replace('r:embed="rId4"', `r:embed="${rid}"`);
const BYTES = new Uint8Array([1, 2, 3]);
// Each paragraph's text, a break as a newline; empty ones left out.
const lines = (json: JSONContent) =>
    nodesOfType(json, 'paragraph')
        .map((node) =>
            (node.content ?? []).map((child) => child.text ?? (child.type === 'hardBreak' ? '\n' : '')).join(''),
        )
        .filter(Boolean);

describe('media', () => {
    // Decision 1: kept under its real name, though no browser draws it; the import logs it.
    test('a WMF part is image-N.wmf, image/x-wmf, and counts as unshown once for every figure that shows it', async () => {
        const { json, media, warnings } = await importDocxBody(paragraph(`${picture('rId9')}${picture('rId9')}`), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/image1.wmf"/>`,
            contentTypes: '<Default Extension="wmf" ContentType="image/x-wmf"/>',
            media: { 'word/media/image1.wmf': BYTES },
        });
        expect(media.map(({ name, contentType }) => [unprefixed(name), contentType])).toEqual([
            ['image-1.wmf', 'image/x-wmf'],
        ]);
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['mediaName'])).toEqual(
            media.flatMap(({ name }) => [name, name]),
        );
        expect(warnings).toEqual([{ code: 'images-unshown', count: 2 }]);
    });

    test('an undeclared part takes its extension, and image/jpg reads as image/jpeg', async () => {
        const { media } = await importDocxBody(paragraph(`${picture('rId9')}${picture('rId10')}`), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/a.gif"/><Relationship Id="rId10" Type="${IMAGE_REL}" Target="media/b.jpg"/>`,
            contentTypes: '<Override PartName="/word/media/b.jpg" ContentType="image/jpg"/>',
            media: { 'word/media/a.gif': BYTES, 'word/media/b.jpg': BYTES },
        });
        expect(media.map(({ name, contentType }) => [unprefixed(name), contentType])).toEqual([
            ['image-1.gif', 'image/gif'],
            ['image-2.jpeg', 'image/jpeg'],
        ]);
    });

    test('a part shown twice is stored once', async () => {
        const { json, media } = await importDocxBody(paragraph(`${picture('rId4')}${picture('rId4')}`));
        expect(media).toHaveLength(1);
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['mediaName'])).toEqual([
            media[0]?.name,
            media[0]?.name,
        ]);
    });

    test(`past ${MAX_MEDIA_PARTS} parts a picture is left out and counted`, async () => {
        const count = MAX_MEDIA_PARTS + 2;
        const ids = Array.from({ length: count }, (_, i) => i + 1);
        const { json, media, warnings } = await importDocxBody(
            ids.map((i) => paragraph(picture(`rIdP${i}`))).join(''),
            {
                rels: ids
                    .map((i) => `<Relationship Id="rIdP${i}" Type="${IMAGE_REL}" Target="media/p${i}.png"/>`)
                    .join(''),
                media: Object.fromEntries(ids.map((i) => [`word/media/p${i}.png`, BYTES])),
            },
        );
        expect([media.length, nodesOfType(json, 'figure').length]).toEqual([MAX_MEDIA_PARTS, MAX_MEDIA_PARTS]);
        expect(warnings).toEqual([{ code: 'images-dropped', count: 2 }]);
    });

    test('past the upload cap in bytes a picture is left out and counted, the ones before it kept', async () => {
        const { doc, media, warnings } = readDocx(
            Buffer.from(
                await buildDocxWithBody(paragraph(`${picture('rId9')}${picture('rId10')}`), {
                    rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/a.png"/><Relationship Id="rId10" Type="${IMAGE_REL}" Target="media/b.png"/>`,
                    media: { 'word/media/a.png': BYTES, 'word/media/b.png': BYTES },
                }),
            ),
            { publicOrigin: undefined, maxMediaBytes: BYTES.length + 1 },
        );
        expect(media.map(({ name }) => unprefixed(name))).toEqual(['image-1.png']);
        expect(nodesOfType(doc.toJSON(), 'figure')).toHaveLength(1);
        expect(lines(doc.toJSON())).toEqual([PICTURE_NOT_IMPORTED]);
        expect(warnings).toEqual([{ code: 'images-dropped', count: 1 }]);
    });

    test('a picture whose part is missing, or not of an image type, is left out and counted', async () => {
        const { json, media, warnings } = await importDocxBody(paragraph(`${picture('rId9')}${picture('rId10')}`), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/gone.png"/><Relationship Id="rId10" Type="${IMAGE_REL}" Target="media/a.bin"/>`,
            contentTypes: '<Override PartName="/word/media/a.bin" ContentType="application/octet-stream"/>',
            media: { 'word/media/a.bin': BYTES },
        });
        expect([media.length, nodesOfType(json, 'figure').length]).toEqual([0, 0]);
        expect(lines(json)).toEqual([PICTURE_NOT_IMPORTED, PICTURE_NOT_IMPORTED]);
        expect(warnings).toEqual([{ code: 'images-dropped', count: 2 }]);
    });

    test("the line a picture left out leaves keeps its paragraph's alignment, a grouped text box's paragraph its own", async () => {
        const box = `<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="2" name="Box"/><a:graphic><a:graphicData><wpg:wgp xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx><w:txbxContent><w:p><w:r><w:t>Boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
        const { json } = await importDocxBody(
            `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${picture('rId9')}${box}</w:p>`,
            { rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/gone.png"/>` },
        );
        expect(
            nodesOfType(json, 'paragraph').map((node) => [
                lines({ type: 'doc', content: [node] }),
                node.attrs?.['textAlign'],
            ]),
        ).toEqual([
            [[], 'center'],
            [[PICTURE_NOT_IMPORTED], 'center'],
            [['Boxed'], null],
        ]);
    });

    test('an SVG wins over its PNG fallback', async () => {
        const svg = GOLDEN_DOCX_IMAGE_RUN.replace(
            '<a:blip r:embed="rId4"/>',
            '<a:blip r:embed="rId4"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></a:ext></a:extLst></a:blip>',
        );
        const { media } = await importDocxBody(paragraph(svg), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/image1.svg"/>`,
            contentTypes: '<Default Extension="svg" ContentType="image/svg+xml"/>',
            media: { 'word/media/pixel.png': BYTES, 'word/media/image1.svg': new TextEncoder().encode('<svg/>') },
        });
        expect(media.map(({ name, contentType }) => [unprefixed(name), contentType])).toEqual([
            ['image-1.svg', 'image/svg+xml'],
        ]);
    });

    test('a PNG stands in for an SVG whose part is missing', async () => {
        const svg = GOLDEN_DOCX_IMAGE_RUN.replace(
            '<a:blip r:embed="rId4"/>',
            '<a:blip r:embed="rId4"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></a:ext></a:extLst></a:blip>',
        );
        const { media, warnings } = await importDocxBody(paragraph(svg), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/gone.svg"/>`,
            contentTypes: '<Default Extension="svg" ContentType="image/svg+xml"/>',
            media: { 'word/media/pixel.png': BYTES },
        });
        expect(media.map(({ name, contentType }) => [unprefixed(name), contentType])).toEqual([
            ['image-1.png', 'image/png'],
        ]);
        expect(warnings).toEqual([]);
    });

    // Word for Mac's logo: a PDF for Mac Office (ma) first, the PNG every other Word draws as the fallback.
    test("a picture's blip is the branch Word reads, a choice for a namespace the reader doesn't know left for its fallback", async () => {
        const blipFill = (rid: string) =>
            `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`;
        const logo = GOLDEN_DOCX_IMAGE_RUN.replace(
            /<pic:blipFill>.*<\/pic:blipFill>/,
            `<ve:AlternateContent xmlns:ve="http://schemas.openxmlformats.org/markup-compatibility/2006"><ve:Choice xmlns:ma="http://schemas.microsoft.com/office/mac/drawingml/2008/main" Requires="ma">${blipFill('rId1')}</ve:Choice><ve:Fallback>${blipFill('rId2')}</ve:Fallback></ve:AlternateContent>`,
        );
        const { bands, media, warnings } = docxToPmJson(
            Buffer.from(
                await buildDocxWithBands(
                    [
                        {
                            id: 'h1',
                            kind: 'header',
                            xml: paragraph(logo),
                            rels: `<Relationship Id="rId1" Type="${IMAGE_REL}" Target="media/image1.pdf"/><Relationship Id="rId2" Type="${IMAGE_REL}" Target="media/image2.png"/>`,
                        },
                    ],
                    {
                        contentTypes: '<Default Extension="pdf" ContentType="application/pdf"/>',
                        media: { 'word/media/image1.pdf': BYTES, 'word/media/image2.png': BYTES },
                    },
                ),
            ),
        );
        expect(media.map(({ name, contentType }) => [unprefixed(name), contentType])).toEqual([
            ['image-1.png', 'image/png'],
        ]);
        expect(nodesOfType(bands.header ?? {}, 'figure').map((node) => node.attrs?.['mediaName'])).toEqual(
            media.map(({ name }) => name),
        );
        expect([bands.header && lines(bands.header), warnings]).toEqual([[], []]);
    });
});

describe('relationship targets', () => {
    const imageAt = async (target: string, path: string, mode = '') =>
        (
            await importDocxBody(paragraph(picture('rId9')), {
                rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="${target}"${mode}/>`,
                media: { [path]: BYTES },
            })
        ).media.map(({ name, contentType }) => [unprefixed(name), contentType]);

    test("a target with '..' resolves against the part's folder", async () => {
        expect(await imageAt('../media/x.png', 'media/x.png')).toEqual([['image-1.png', 'image/png']]);
    });

    test('an absolute target is a part name from the package root', async () => {
        expect(await imageAt('/word/media/x.png', 'word/media/x.png')).toEqual([['image-1.png', 'image/png']]);
    });

    test('an External target is no image, though a part of its name is in the package', async () => {
        expect(await imageAt('media/x.png', 'word/media/x.png', ' TargetMode="External"')).toEqual([]);
    });
});

describe('placement', () => {
    const anchored = (inner: string) =>
        GOLDEN_DOCX_IMAGE_RUN.replace('<wp:inline>', `<wp:anchor>${inner}`).replace('</wp:inline>', '</wp:anchor>');

    test('an anchor wrapped square on the right is a figure wrapped right', async () => {
        const { json } = await importDocxBody(
            paragraph(
                anchored(
                    '<wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH><wp:wrapSquare wrapText="bothSides"/>',
                ),
            ),
        );
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['layout'])).toEqual(['wrap-right']);
    });

    // Word's offset is from the area relativeFrom names. A4 with a 4000 twip left margin and a 720 right one: the column
    // starts 2,540,000 EMU in and is 4,563,110 wide, so the 381,000 EMU picture at 3,000,000 sits in its left half from
    // the paper's edge and in its right half from the column's.
    test.each([
        ['page', 3_000_000, 'wrap-left'],
        ['leftMargin', 3_000_000, 'wrap-left'],
        ['insideMargin', 3_000_000, 'wrap-left'],
        ['margin', 3_000_000, 'wrap-right'],
        ['column', 3_000_000, 'wrap-right'],
        ['character', 3_000_000, 'wrap-right'],
        ['rightMargin', 0, 'wrap-right'],
        ['outsideMargin', 0, 'wrap-right'],
        ['margin', 100_000, 'wrap-left'],
        ['page', -1e12, 'wrap-left'],
        ['page', 1e12, 'wrap-right'],
        ['rightMargin', -1e12, 'wrap-left'],
    ])('an anchor %s-relative at %d EMU is a figure %s', async (relativeFrom, offset, layout) => {
        const { json } = await importDocxBody(
            paragraph(
                anchored(
                    `<wp:positionH relativeFrom="${relativeFrom}"><wp:posOffset>${offset}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:wrapSquare wrapText="bothSides"/>`,
                ),
            ) +
                '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="720" w:bottom="1440" w:left="4000"/></w:sectPr>',
        );
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['layout'])).toEqual([layout]);
    });

    // In front of or behind the text: the offsets from the anchor paragraph's box, which Word gives from the text column
    // and the paragraph. The golden package's page is Word's default, A4 with 1 in margins: the column starts 96 px in
    // and is 9026 twips wide.
    describe('in front of and behind the text', () => {
        const EMU = 9525;
        const placed = (inner: string, attrs = '') =>
            GOLDEN_DOCX_IMAGE_RUN.replace('<wp:inline>', `<wp:anchor${attrs}>${inner}`).replace(
                '</wp:inline>',
                '</wp:anchor>',
            );
        const at = (x: number, y: number, h = 'column', v = 'paragraph') =>
            `<wp:positionH relativeFrom="${h}"><wp:posOffset>${x * EMU}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="${v}"><wp:posOffset>${y * EMU}</wp:posOffset></wp:positionV>`;
        const front = (x = 100, y = 20, attrs = '') => placed(`${at(x, y)}<wp:wrapNone/>`, attrs);
        const placesOf = (json: JSONContent) =>
            [...nodesOfType(json, 'figure'), ...nodesOfType(json, 'chart')].map((node) => [
                node.attrs?.['layout'],
                node.attrs?.['offsetX'],
                node.attrs?.['offsetY'],
            ]);
        const text = (value: string) => `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;

        test('wrapNone is in front of the text, behindDoc behind it, each at its offsets in px', async () => {
            const { json } = await importDocxBody(
                paragraph(`${front()}${text('Over it')}`) +
                    paragraph(`${front(-30, -5, ' behindDoc="1"')}${text('x')}`),
            );
            expect(placesOf(json)).toEqual([
                ['front', 100, 20],
                ['behind', -30, -5],
            ]);
        });

        // A page-relative offset counts from the paper's edge, 96 px left of the column; an aligned one sits where the
        // alignment puts it in its area, the 40 px picture centred in the 601.7 px column.
        test('a horizontal offset from another area or an alignment is an offset from the text column', async () => {
            const centred =
                '<wp:positionH relativeFrom="column"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:wrapNone/>';
            const right =
                '<wp:positionH relativeFrom="page"><wp:align>right</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:wrapNone/>';
            const { json } = await importDocxBody(
                paragraph(placed(`${at(0, 0, 'page')}<wp:wrapNone/>`)) +
                    paragraph(placed(centred)) +
                    paragraph(placed(right)),
            );
            expect(placesOf(json)).toEqual([
                ['front', -96, 0],
                ['front', 281, 0],
                ['front', 658, 0],
            ]);
        });

        test('a vertical offset from the page or the margin, an aligned one or a simple position is 0', async () => {
            const aligned =
                '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:align>top</wp:align></wp:positionV><wp:wrapNone/>';
            const { json } = await importDocxBody(
                [
                    placed(`${at(0, 300, 'column', 'page')}<wp:wrapNone/>`),
                    placed(`${at(0, 300, 'column', 'margin')}<wp:wrapNone/>`),
                    placed(aligned),
                    placed(`<wp:simplePos x="0" y="0"/>${at(0, 300)}<wp:wrapNone/>`, ' simplePos="1"'),
                ]
                    .map((run) => paragraph(`${run}${text('x')}`))
                    .join(''),
            );
            expect(placesOf(json).map(([, , y]) => y)).toEqual([0, 0, 0, 0]);
        });

        test('its width caps at the paper, a block one at the column', async () => {
            const wide = (run: string) => run.replaceAll('cx="381000"', `cx="${1000 * EMU}"`);
            const { json } = await importDocxBody(paragraph(wide(front())) + paragraph(wide(GOLDEN_DOCX_IMAGE_RUN)));
            expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['width'])).toEqual([793, 601]);
        });

        test('in a table cell or a note it is a block, where a wrapped one stays wrapped', async () => {
            const square = placed(`${at(400, 0)}<wp:wrapSquare wrapText="bothSides"/>`);
            const cell = (run: string) =>
                `<w:tbl><w:tr><w:tc><w:p>${run}${text('In a cell')}</w:p></w:tc></w:tr></w:tbl>`;
            const namespaced = front().replace(
                '<w:drawing>',
                '<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
            );
            const { json } = await importDocxBody(
                `${cell(front())}${cell(square)}${paragraph(`${text('Noted')}<w:r><w:footnoteReference w:id="1"/></w:r>`)}`,
                {
                    footnotes: `<w:footnote w:id="1"><w:p>${namespaced}${text('In a note')}</w:p></w:footnote>`,
                    media: {
                        'word/media/pixel.png': new Uint8Array(),
                        'word/_rels/footnotes.xml.rels': new TextEncoder().encode(
                            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="${IMAGE_REL}" Target="media/pixel.png"/></Relationships>`,
                        ),
                    },
                },
            );
            expect(placesOf(json)).toEqual([
                ['block', null, null],
                ['wrap-right', null, null],
                ['block', null, null],
            ]);
        });

        test('a group of two pictures is a block, as one anchor has one place', async () => {
            const WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
            const pic = (id: number) =>
                `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId4"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="381000" cy="381000"/></a:xfrm></pic:spPr></pic:pic>`;
            const group = `<w:r><w:drawing><wp:anchor>${at(10, 10)}<wp:extent cx="762000" cy="381000"/><wp:wrapNone/><wp:docPr id="9" name="Group"/><a:graphic><a:graphicData uri="${WPG}"><wpg:wgp xmlns:wpg="${WPG}">${pic(1)}${pic(2)}</wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
            const { json } = await importDocxBody(paragraph(group));
            expect(placesOf(json)).toEqual([
                ['block', null, null],
                ['block', null, null],
            ]);
        });

        // GOV.UK's Shigellosis form: its one picture would take the group's extent, the text box beside it included.
        test('a group of one picture and a text box is a block too', async () => {
            const WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
            const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
            const pic = `<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId4"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="381000" cy="381000"/></a:xfrm></pic:spPr></pic:pic>`;
            const box =
                '<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Beside it</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>';
            const group = `<w:r><w:drawing><wp:anchor>${at(10, 10)}<wp:extent cx="6000000" cy="381000"/><wp:wrapNone/><wp:docPr id="9" name="Group"/><a:graphic><a:graphicData uri="${WPG}"><wpg:wgp xmlns:wpg="${WPG}" xmlns:wps="${WPS}">${pic}${box}</wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
            const { json } = await importDocxBody(paragraph(group));
            expect(placesOf(json)).toEqual([['block', null, null]]);
        });

        // Eigen's box holds the list's indent, which is its own, not Word's: Word's 720 twips go, Eigen's level counts.
        test("X in a list item counts from the item's box, past Eigen's own list indent", async () => {
            const { json } = await importDocxBody(
                `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${front()}${text('Item')}</w:p>`,
            );
            expect(nodesOfType(json, 'listItem')).toHaveLength(1);
            expect(placesOf(json)).toEqual([['front', Math.round(100 - LIST_LEVEL / 15), 20]]);
        });

        // Word counts a paragraph-relative offset from the top of the space before and a line-relative one from the
        // text; Eigen from the box, whose padding holds a paragraph's own space before and none of a heading's style.
        test('Y counts from the box, past the space before Word draws and the padding Eigen draws', async () => {
            const h2 =
                '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="480"/></w:pPr></w:style>';
            const heading = (run: string, before = '') =>
                `<w:p><w:pPr><w:pStyle w:val="Heading2"/>${before}</w:pPr>${run}${text('Heading')}</w:p>`;
            const { json } = await importDocxBody(
                [
                    heading(front(100, 40)),
                    heading(front(100, 40), '<w:spacing w:before="240"/>'),
                    heading(placed(`${at(100, 40, 'column', 'line')}<wp:wrapNone/>`)),
                    `<w:p><w:pPr><w:spacing w:before="240"/></w:pPr>${placed(`${at(100, 4, 'column', 'line')}<wp:wrapNone/>`)}${text('Spaced')}</w:p>`,
                ].join(''),
                { styles: h2 },
            );
            expect(nodesOfType(json, 'heading').map((node) => node.attrs?.['spaceBefore'] ?? null)).toEqual([
                null,
                12,
                null,
            ]);
            expect(placesOf(json).map(([, , y]) => y)).toEqual([8, 40, 40, 20]);
        });

        test('one anchored mid-paragraph leads it, and a heading that anchors only one stays a heading, no caption taken', async () => {
            const { json } = await importDocxBody(
                paragraph(`${text('Before ')}${front()}${text('after')}`) +
                    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${front()}</w:p>` +
                    '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Not a caption</w:t></w:r></w:p>',
                { styles: '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>' },
            );
            const [first, second, third] = json.content ?? [];
            expect(first?.content?.map((node) => node.type)).toEqual(['figure', 'text']);
            expect(first?.content?.[1]?.text).toBe('Before after');
            expect([second?.type, second?.content?.map((node) => node.type)]).toEqual(['heading', ['figure']]);
            expect([third?.type, third?.content?.[0]?.text]).toEqual(['paragraph', 'Not a caption']);
            expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['caption'])).toEqual([null, null]);
        });

        // The figure in front is out of the flow, so the block figure is its line's only figure and takes the caption.
        test('a block figure beside one in front of the text takes the Caption line after them', async () => {
            const { json } = await importDocxBody(
                paragraph(`${GOLDEN_DOCX_IMAGE_RUN}${front()}`) +
                    '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 1</w:t></w:r></w:p>',
                { styles: '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>' },
            );
            expect(
                nodesOfType(json, 'figure').map((node) => [node.attrs?.['layout'], node.attrs?.['caption']]),
            ).toEqual([
                ['front', null],
                ['block', 'Figure 1'],
            ]);
            expect(nodesOfType(json, 'text')).toEqual([]);
        });
    });

    // The store keeps marks on text only, so a figure's link would not survive saving.
    test('a picture keeps its alt text and its width in pixels, not its click link or the link around it', async () => {
        const linked = GOLDEN_DOCX_IMAGE_RUN.replace(
            'descr="A pixel"/>',
            'descr="A pixel"><a:hlinkClick xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:id="rId9"/></wp:docPr>',
        );
        const { json } = await importDocxBody(
            `${paragraph(linked)}${paragraph(`<w:hyperlink r:id="rId9">${GOLDEN_DOCX_IMAGE_RUN}</w:hyperlink>`)}`,
            {
                rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`,
            },
        );
        const figures = nodesOfType(json, 'figure');
        expect(figures.map((figure) => [figure.attrs?.['alt'], figure.attrs?.['width'], figure.marks])).toEqual([
            ['A pixel', 40, undefined],
            ['A pixel', 40, undefined],
        ]);
        expect(marksOfType(json, 'link')).toEqual([]);
    });
});

// Word's extent is what Word drew, stretched or not, so a picture keeps both sides, the height capped with the width.
describe('size', () => {
    const EMU = 9525;
    const sized = (cx: number, cy: number) =>
        GOLDEN_DOCX_IMAGE_RUN.replaceAll('cx="381000" cy="381000"', `cx="${cx * EMU}" cy="${cy * EMU}"`);

    test('a picture keeps the height its extent gives, scaled with a width capped at the column', async () => {
        const { json } = await importDocxBody(paragraph(sized(40, 20)) + paragraph(sized(1202, 300)));
        expect(nodesOfType(json, 'figure').map((node) => [node.attrs?.['width'], node.attrs?.['height']])).toEqual([
            [40, 20],
            [601, 150],
        ]);
    });
});

// VML's office attributes are read by their namespace, whatever prefix binds it.
describe('VML', () => {
    const OFFICE = 'urn:schemas-microsoft-com:office:office';
    const vml = (attributes: string, inner = '') =>
        `<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" ${attributes}>${inner}</v:shape></w:pict></w:r>`;

    test("a rule is the office namespace's hr, not a prefix's", async () => {
        const { json } = await importDocxBody(
            `${paragraph(vml(`xmlns:office="${OFFICE}" office:hr="t"`))}${paragraph(vml('xmlns:o="urn:other" o:hr="t"'))}`,
        );
        expect(nodesOfType(json, 'horizontalRule')).toHaveLength(1);
    });

    test("a picture's size is its style's width and height", async () => {
        const { json } = await importDocxBody(
            paragraph(vml('style="width:100pt;height:50pt"', '<v:imagedata r:id="rId4"/>')),
        );
        expect(nodesOfType(json, 'figure').map((node) => [node.attrs?.['width'], node.attrs?.['height']])).toEqual([
            [133, 67],
        ]);
    });

    test("a picture's alt text is the office namespace's title, not a prefix's", async () => {
        const image = (title: string) => `<v:imagedata r:id="rId4" ${title}/>`;
        const { json } = await importDocxBody(
            paragraph(
                `${vml('', image(`xmlns:office="${OFFICE}" office:title="Office"`))}${vml('', image('xmlns:o="urn:other" o:title="Other"'))}`,
            ),
        );
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['alt'])).toEqual(['Office', null]);
    });

    test('a linked picture is left out and counted, its alt text after the line, as a DrawingML one is', async () => {
        const { json, warnings } = await importDocxBody(paragraph(vml('alt="Logo"', '<v:imagedata r:id="rId9"/>')), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="https://example.com/logo.png" TargetMode="External"/>`,
        });
        expect(lines(json)).toEqual([`${PICTURE_NOT_IMPORTED}\nLogo`]);
        expect(warnings).toEqual([{ code: 'images-dropped', count: 1 }]);
    });
});

// A shape's text sits on its fill, which the schema drops, so light text there takes the body color.
describe('text boxes', () => {
    const box = (text: string, color: string) =>
        `<w:txbxContent><w:p><w:r><w:rPr><w:color w:val="${color}"/></w:rPr><w:t>${text}</w:t></w:r></w:p></w:txbxContent>`;
    const shape = (inner: string) =>
        `<w:r><w:drawing><wp:anchor><wp:extent cx="1905000" cy="571500"/><wp:docPr id="2" name="Shape 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx>${inner}</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
    const vml = (inner: string) =>
        `<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox>${inner}</v:textbox></v:shape></w:pict></w:r>`;

    test('white text in a DrawingML or a VML shape has no color, a dark one keeps its', async () => {
        const { json } = await importDocxBody(
            paragraph(`${shape(`${box('Drawn', 'FFFFFF')}${box('Red', 'C00000')}`)}${vml(box('Legacy', 'FFFFFF'))}`),
        );
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Drawn', 'Red', 'Legacy']);
        expect(marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['color']])).toEqual([
            ['Red', '#c00000'],
        ]);
    });

    // A box in a list item or a quote is a box of the item's or the quote's paragraph, its blocks its paragraphs.
    describe('anchored in a list item or a quote', () => {
        const NUMBERING =
            '<w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="5"/></w:num><w:num w:numId="6"><w:abstractNumId w:val="5"/></w:num>';
        const STYLES = '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>';
        const item = (inner: string, numId = 5) =>
            `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${inner}</w:p>`;
        const text = (value: string) => `<w:r><w:t>${value}</w:t></w:r>`;
        const outline = (node: JSONContent): string => {
            if (node.type === 'text') return node.text ?? '';
            const children = (node.content ?? []).map(outline);
            return node.type === 'paragraph' ? children.join('') : `${node.type}[${children.join(' | ')}]`;
        };
        const read = async (body: string) =>
            ((await importDocxBody(body, { numbering: NUMBERING, styles: STYLES })).json.content ?? []).map(outline);

        test('it stays in the item, and in the quote', async () => {
            const quoted = `<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>${text('Said')}${vml(box('Inside', '000000'))}</w:p>`;
            expect(
                await read(`${item(`${text('One')}${shape(box('Boxed', '000000'))}`)}${item(text('Two'))}${quoted}`),
            ).toEqual(['bulletList[listItem[OnetextBox[Boxed]] | listItem[Two]]', 'blockquote[SaidtextBox[Inside]]']);
        });

        test('a table and a list in it are its paragraphs', async () => {
            const table = `<w:tbl><w:tr><w:tc><w:p>${text('Cell')}</w:p></w:tc></w:tr></w:tbl>`;
            const inner = `<w:txbxContent>${table}${item(text('Boxed'), 6)}</w:txbxContent>`;
            expect(await read(`${item(`${text('One')}${shape(inner)}`)}${item(text('Two'))}`)).toEqual([
                'bulletList[listItem[OnetextBox[Cell | Boxed]] | listItem[Two]]',
            ]);
        });
    });
});

// A Word text box alone in its drawing is a text box, at Word's place, size and look; its paragraphs read as a note's.
describe('text boxes as boxes', () => {
    const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
    const text = (value: string) => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`;
    type Box = {
        frame?: 'anchor' | 'inline';
        wrap?: string;
        behind?: boolean;
        x?: number;
        y?: number;
        cx?: number;
        cy?: number;
        spPr?: string;
        style?: string;
        bodyPr?: string;
        fit?: string;
        content?: string;
        txbx?: string;
        position?: string;
    };
    const boxRun = ({
        frame = 'anchor',
        wrap = '<wp:wrapNone/>',
        behind = false,
        x = 952500,
        y = 95250,
        cx = 1905000,
        cy = 952500,
        spPr = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
        style = '',
        bodyPr = 'lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t"',
        fit = '<a:noAutofit/>',
        content = text('Boxed'),
        txbx,
        position,
    }: Box = {}) => {
        const head =
            frame === 'anchor'
                ? `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>${position ?? `<wp:positionH relativeFrom="column"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="line"><wp:posOffset>${y}</wp:posOffset></wp:positionV>`}<wp:extent cx="${cx}" cy="${cy}"/>${wrap}`
                : `<wp:inline><wp:extent cx="${cx}" cy="${cy}"/>`;
        const body = txbx ?? `<wps:txbx><w:txbxContent>${content}</w:txbxContent></wps:txbx>`;
        return `<w:r><w:drawing>${head}<wp:docPr id="7" name="Text Box 7"/><a:graphic><a:graphicData uri="${WPS}"><wps:wsp xmlns:wps="${WPS}"><wps:cNvSpPr txBox="1"/><wps:spPr>${spPr}</wps:spPr>${style}${body}<wps:bodyPr ${bodyPr}>${fit}</wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:${frame}></w:drawing></w:r>`;
    };
    const boxesOf = async (body: string, parts = {}) => {
        const result = await importDocxBody(body, parts);
        return { ...result, boxes: nodesOfType(result.json, 'textBox') };
    };
    const anchored = (box: Box, after = 'Anchor') => paragraph(`${boxRun(box)}<w:r><w:t>${after}</w:t></w:r>`);

    test('wrapNone in the body is in front of or behind the text, at its offsets from the paragraph’s box', async () => {
        const { boxes } = await boxesOf(`${anchored({})}${anchored({ behind: true })}`);
        expect(boxes.map((box) => [box.attrs?.['layout'], box.attrs?.['offsetX'], box.attrs?.['offsetY']])).toEqual([
            ['front', 100, 10],
            ['behind', 100, 10],
        ]);
        expect(boxes.map((box) => box.attrs?.['width'])).toEqual([200, 200]);
    });

    test('a square, tight or through wrap is wrapped on its side; top and bottom, or in line, is in the flow', async () => {
        const right =
            '<wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>';
        const { boxes } = await boxesOf(
            [
                anchored({ wrap: '<wp:wrapSquare wrapText="bothSides"/>', position: right }),
                anchored({ wrap: '<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon/></wp:wrapTight>' }),
                anchored({ wrap: '<wp:wrapTopAndBottom/>' }),
                paragraph(boxRun({ frame: 'inline' })),
            ].join(''),
        );
        expect(boxes.map((box) => box.attrs?.['layout'] ?? 'block')).toEqual([
            'wrap-right',
            'wrap-left',
            'block',
            'block',
        ]);
    });

    test('wrapNone in a table cell is in the flow', async () => {
        const { boxes } = await boxesOf(`<w:tbl><w:tr><w:tc>${anchored({})}</w:tc></w:tr></w:tbl>`);
        expect(boxes.map((box) => box.attrs?.['layout'] ?? 'block')).toEqual(['block']);
    });

    test('its size is its extent, and a box Word grows with its text has no height', async () => {
        const { boxes } = await boxesOf(
            `${anchored({ cx: 2857500, cy: 1428750 })}${anchored({ fit: '<a:spAutoFit/>' })}`,
        );
        expect(boxes.map((box) => [box.attrs?.['width'], box.attrs?.['height']])).toEqual([
            [300, 150],
            [200, null],
        ]);
    });

    test('its fill, outline, insets, vertical alignment and rounded corners are its look', async () => {
        const spPr =
            '<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:prstDash val="dash"/></a:ln>';
        const { boxes } = await boxesOf(
            anchored({ spPr, bodyPr: 'lIns="114300" tIns="57150" rIns="114300" bIns="57150" anchor="ctr"' }),
        );
        expect(boxes[0]?.attrs).toMatchObject({
            fill: '#fff2cc',
            outline: '2px dashed #c00000',
            paddingX: 12,
            paddingY: 6,
            verticalAlign: 'middle',
            rounded: true,
        });
    });

    test('a double line, a dotted one, no line and no fill read as the cell border forms', async () => {
        const ln = (inner: string, attrs = '') => `<a:noFill/><a:ln w="9525"${attrs}>${inner}</a:ln>`;
        const solid = '<a:solidFill><a:srgbClr val="000000"/></a:solidFill>';
        const { boxes } = await boxesOf(
            [
                anchored({ spPr: ln(solid, ' cmpd="dbl"') }),
                anchored({ spPr: ln(`${solid}<a:prstDash val="sysDot"/>`) }),
                anchored({ spPr: ln('<a:noFill/>') }),
            ].join(''),
        );
        expect(boxes.map((box) => [box.attrs?.['fill'], box.attrs?.['outline']])).toEqual([
            [null, '1px double #000000'],
            [null, '1px dotted #000000'],
            [null, null],
        ]);
    });

    test('its paragraphs keep their own alignment and store no spacing; a list and a table flatten, counted', async () => {
        const centred =
            '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr><w:r><w:t>Middle</w:t></w:r></w:p>';
        const table = `<w:tbl><w:tr><w:tc>${text('Cell')}</w:tc></w:tr></w:tbl>`;
        const { boxes, warnings } = await boxesOf(
            `<w:p><w:pPr><w:jc w:val="right"/></w:pPr>${boxRun({ content: `${centred}${table}` })}<w:r><w:t>A</w:t></w:r></w:p>`,
        );
        const paragraphs = boxes[0]?.content ?? [];
        expect(paragraphs.map((p) => [p.content?.[0]?.text, p.attrs?.['textAlign'], p.attrs?.['spaceAfter']])).toEqual([
            ['Middle', 'center', null],
            ['Cell', null, null],
        ]);
        expect(warnings).toContainEqual({ code: 'text-simplified', count: 1 });
    });

    test('every box gets an id of its own, and a box in a box is its text', async () => {
        const inner = boxRun({ content: text('Inner') });
        const { boxes } = await boxesOf(
            `${anchored({})}${anchored({ content: `<w:p><w:r><w:t>Outer</w:t></w:r>${inner}</w:p>` })}`,
        );
        expect(boxes).toHaveLength(2);
        const [first, second] = boxes.map((box) => box.attrs?.['id']);
        expect(typeof first).toBe('string');
        expect(first).not.toBe(second);
        expect(nodesOfType({ type: 'doc', content: boxes.slice(1) }, 'text').map((t) => t.text)).toEqual([
            'Outer',
            'Inner',
        ]);
    });

    test('an empty box with no fill or line is dropped uncounted; a painted one stays', async () => {
        const empty = { content: '<w:p/>', spPr: '<a:noFill/><a:ln><a:noFill/></a:ln>' };
        const painted = { content: '<w:p/>', spPr: '<a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill>' };
        const { boxes, warnings } = await boxesOf(`${anchored(empty)}${anchored(painted)}`);
        expect(boxes.map((box) => box.attrs?.['fill'])).toEqual(['#ddeeff']);
        expect(warnings).toEqual([]);
    });

    test('a linked box is an empty box of its look, counted; a rotated or odd-shaped one is counted', async () => {
        const linked = '<wps:linkedTxbx id="1" seq="1"/>';
        const { boxes, warnings } = await boxesOf(
            `${anchored({ txbx: linked, spPr: '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>' })}${anchored({ spPr: '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' })}`,
        );
        expect(boxes).toHaveLength(2);
        expect(warnings).toEqual([{ code: 'text-simplified', count: 2 }]);
    });

    test('a box in mc:AlternateContent is read once, from its Choice', async () => {
        const choice = `<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps">${boxRun({}).slice('<w:r>'.length, -'</w:r>'.length)}</mc:Choice><mc:Fallback><w:pict><v:rect xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${text('Boxed')}</w:txbxContent></v:textbox></v:rect></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
        const { json, boxes } = await boxesOf(paragraph(`${choice}<w:r><w:t>Anchor</w:t></w:r>`));
        expect(boxes).toHaveLength(1);
        expect(nodesOfType(json, 'text').map((t) => t.text)).toEqual(['Boxed', 'Anchor']);
    });

    // Word's VML places from the column and the paragraph as `text`, both ways.
    const vmlBox = (style: string, inner = '', textbox = '') =>
        `<w:r><w:pict><v:rect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w10="urn:schemas-microsoft-com:office:word" style="${style}" fillcolor="#ffeeaa" strokecolor="#0000ff" strokeweight="1.5pt"><v:textbox inset="7.2pt,3.6pt,7.2pt,3.6pt"${textbox}><w:txbxContent>${text('Legacy')}</w:txbxContent></v:textbox>${inner}</v:rect></w:pict></w:r>`;
    const PLACED =
        'position:absolute;margin-left:30pt;margin-top:15pt;width:150pt;height:60pt;mso-position-horizontal-relative:text;mso-position-vertical-relative:text';
    const vmlBoxesOf = async (...runs: string[]) =>
        (await boxesOf(runs.map((run) => paragraph(`${run}<w:r><w:t>Anchor</w:t></w:r>`)).join(''))).boxes;

    test('a VML box outside a Fallback reads its place, size, fill, stroke and insets', async () => {
        const boxes = await vmlBoxesOf(vmlBox(`${PLACED};z-index:-1`));
        expect(boxes[0]?.attrs).toMatchObject({
            layout: 'behind',
            offsetX: 40,
            offsetY: 20,
            width: 200,
            height: 80,
            fill: '#ffeeaa',
            outline: '2px solid #0000ff',
        });
        // Word's own insets, which a box draws when it stores none.
        expect(boxes[0]?.attrs).toMatchObject({ paddingX: null, paddingY: null });
    });

    // mso-wrap-style is how the text wraps inside the shape; w10:wrap is how the body's text wraps around it.
    test('a VML box wraps by its w10:wrap, never by the wrap of its own text', async () => {
        const boxes = await vmlBoxesOf(
            vmlBox(`${PLACED};mso-wrap-style:square`),
            vmlBox(`${PLACED};mso-wrap-style:none`, '<w10:wrap type="square"/>'),
            vmlBox(`${PLACED};mso-position-horizontal:right`, '<w10:wrap type="tight"/>'),
            vmlBox(`${PLACED}`, '<w10:wrap type="topAndBottom"/>'),
            vmlBox('width:150pt;height:60pt;mso-wrap-style:square'),
        );
        expect(boxes.map((box) => box.attrs?.['layout'])).toEqual([
            'front',
            'wrap-left',
            'wrap-right',
            'block',
            'block',
        ]);
    });

    test("a VML box grows by its textbox's mso-fit-shape-to-text and aligns its text by v-text-anchor", async () => {
        const boxes = await vmlBoxesOf(
            vmlBox(`${PLACED};v-text-anchor:middle`, '', ' style="mso-fit-shape-to-text:t"'),
            vmlBox(`${PLACED};v-text-anchor:bottom-center`),
            vmlBox(`${PLACED};v-text-anchor:top`),
        );
        expect(boxes.map((box) => [box.attrs?.['height'], box.attrs?.['verticalAlign']])).toEqual([
            [null, 'middle'],
            [80, 'bottom'],
            [80, null],
        ]);
    });

    // A box holds no note and no box: each is its text, and the import says it drew the text simpler.
    test('a note or a box inside a box is its text, counted', async () => {
        const noted = paragraph('<w:r><w:t>Boxed</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r>');
        const footnotes = `<w:footnote w:id="1">${text('Noted')}</w:footnote>`;
        const note = await boxesOf(anchored({ content: noted }), { footnotes });
        expect(note.boxes.map(lines)).toEqual([['Boxed Noted']]);
        expect(note.warnings).toEqual([{ code: 'text-simplified', count: 1 }]);

        const nested = await boxesOf(anchored({ content: paragraph(boxRun({ frame: 'inline' })) }));
        expect(nested.boxes.map(lines)).toEqual([['Boxed']]);
        expect(nested.warnings).toEqual([{ code: 'text-simplified', count: 1 }]);

        const vml = `<w:r><w:pict><v:rect xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${text('Legacy')}</w:txbxContent></v:textbox></v:rect></w:pict></w:r>`;
        const legacy = await boxesOf(anchored({ content: paragraph(vml) }));
        expect(legacy.boxes.map(lines)).toEqual([['Legacy']]);
        expect(legacy.warnings).toEqual([{ code: 'text-simplified', count: 1 }]);
    });

    // A box Word draws, by its fill or its line, stays a box around its picture; an unpainted one is the picture.
    test('a box holding only a picture is a box when it is painted, else the picture, counted', async () => {
        const parts = {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/image1.png"/>`,
            media: { 'word/media/image1.png': BYTES },
        };
        const content = paragraph(picture('rId9'));
        const painted = await boxesOf(
            anchored({ content, spPr: '<a:solidFill><a:srgbClr val="FFEEAA"/></a:solidFill>' }),
            parts,
        );
        expect(painted.boxes.map((box) => nodesOfType(box, 'figure').length)).toEqual([1]);
        expect(painted.warnings).toEqual([]);
        const bare = await boxesOf(anchored({ content, spPr: '<a:noFill/><a:ln><a:noFill/></a:ln>' }), parts);
        expect([bare.boxes, nodesOfType(bare.json, 'figure').length]).toEqual([[], 1]);
        expect(bare.warnings).toEqual([{ code: 'text-simplified', count: 1 }]);
    });

    test('in a header a box keeps its paragraphs after the anchor’s', async () => {
        const { json, bands } = docxToPmJson(
            Buffer.from(
                await buildDocxWithBands([{ id: 'h1', kind: 'header', xml: anchored({}, 'Head') }], {
                    body: paragraph('<w:r><w:t>Body</w:t></w:r>'),
                }),
            ),
        );
        expect(nodesOfType(json, 'textBox')).toEqual([]);
        expect(bands.header && nodesOfType(bands.header, 'textBox')).toEqual([]);
        expect(bands.header && lines(bands.header)).toEqual(['Head', 'Boxed']);
    });

    // A block box is no figure: the Caption line after it stays a paragraph.
    test('a box in the flow takes no caption, and its paragraph keeps its heading', async () => {
        const STYLES =
            '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>';
        const { json, boxes } = await boxesOf(
            `${paragraph(boxRun({ frame: 'inline' }))}<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 1</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${boxRun({})}<w:r><w:t>Title</w:t></w:r></w:p>`,
            { styles: STYLES },
        );
        expect(boxes).toHaveLength(2);
        expect(lines(json)).toContain('Figure 1');
        expect(nodesOfType(json, 'heading')).toHaveLength(1);
    });
});

// G9: a figure keeps its place; a block figure takes the next line as its caption only in the Caption style or the
// writer's caption look, a wrapped one only what its own drawing holds.
describe('captions', () => {
    const STYLES = '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>';
    const BODY = '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>';
    const wrapped = GOLDEN_DOCX_IMAGE_RUN.replace(
        '<wp:inline>',
        '<wp:anchor><wp:wrapSquare wrapText="bothSides"/>',
    ).replace('</wp:inline>', '</wp:anchor>');
    const line = (text: string, rPr: string, pPr = '') =>
        `<w:p>${pPr}<w:r><w:rPr>${rPr}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
    const captionOf = async (figure: string, next: string) => {
        const { json } = await importDocxBody(`${paragraph(figure)}${next}`, { styles: `${BODY}${STYLES}` });
        return [
            nodesOfType(json, 'figure')[0]?.attrs?.['caption'],
            marksOfType(json, 'textStyle').map((mark) => [mark.text, mark.attrs['fontSize']]),
        ];
    };

    test('a Caption paragraph after an anchored, wrapped figure stays a paragraph', async () => {
        expect(await captionOf(wrapped, line('Figure 1', '', '<w:pPr><w:pStyle w:val="Caption"/></w:pPr>'))).toEqual([
            null,
            [],
        ]);
    });

    // Word for the web turns the writer's floating figure into a frame around the image and its caption.
    test('a Caption paragraph in the frame of a framed figure is its caption, one outside it is not', async () => {
        const frame = (side: string) => `<w:framePr w:wrap="around" w:xAlign="${side}"/>`;
        const framed = (inner: string, side: string, style = '') =>
            `<w:p><w:pPr>${style}${frame(side)}</w:pPr>${inner}</w:p>`;
        const caption = '<w:pStyle w:val="Caption"/>';
        const body = `${framed(GOLDEN_DOCX_IMAGE_RUN, 'left')}${framed('<w:r><w:t>Left</w:t></w:r>', 'left', caption)}${framed(GOLDEN_DOCX_IMAGE_RUN, 'right')}${framed('<w:r><w:t>Other</w:t></w:r>', 'left', caption)}`;
        const { json } = await importDocxBody(body, { styles: STYLES });
        expect(nodesOfType(json, 'figure').map((node) => [node.attrs?.['layout'], node.attrs?.['caption']])).toEqual([
            ['wrap-left', 'Left'],
            ['wrap-right', null],
        ]);
    });

    test("the caption look Google Docs flattens the writer's caption to is a block figure's caption", async () => {
        const look = `<w:color w:val="${CAPTION_LOOK.color}"/><w:sz w:val="${CAPTION_LOOK.sizePt * 2}"/>`;
        expect(await captionOf(GOLDEN_DOCX_IMAGE_RUN, line('Figure 1', look))).toEqual(['Figure 1', []]);
    });

    test('a small line after a block figure, not in the caption look, is a paragraph in its size', async () => {
        expect(await captionOf(GOLDEN_DOCX_IMAGE_RUN, line('Note', '<w:sz w:val="16"/>'))).toEqual([
            null,
            [['Note', 8]],
        ]);
    });

    // A figure's caption is plain text; a Caption line no figure takes is a paragraph like any other.
    describe("in Word's caption look", () => {
        const WORD_CAPTION =
            '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:rPr><w:i/><w:color w:val="44546A"/><w:sz w:val="18"/></w:rPr></w:style>';
        const CAPTION = '<w:pPr><w:pStyle w:val="Caption"/></w:pPr>';

        test('a Caption paragraph no figure takes keeps the look and its own marks', async () => {
            const { json } = await importDocxBody(line('Table 1', '<w:b/>', CAPTION), {
                styles: `${BODY}${WORD_CAPTION}`,
            });
            expect(nodesOfType(json, 'text').map((node) => [node.text, node.marks?.map((mark) => mark.type)])).toEqual([
                ['Table 1', ['textStyle', 'bold', 'italic']],
            ]);
            expect(marksOfType(json, 'textStyle')[0]?.attrs).toMatchObject({ color: '#44546a', fontSize: 9 });
        });

        test('a Caption paragraph after a block figure is its caption, nothing left behind', async () => {
            const { json } = await importDocxBody(
                `${paragraph(GOLDEN_DOCX_IMAGE_RUN)}${line('Figure 1', '<w:b/>', CAPTION)}`,
                { styles: `${BODY}${WORD_CAPTION}` },
            );
            expect([nodesOfType(json, 'figure')[0]?.attrs?.['caption'], nodesOfType(json, 'text')]).toEqual([
                'Figure 1',
                [],
            ]);
        });
    });
});

// SmartArt's text is the document's, read in place, and counts as a graphic dropped.
describe('SmartArt', () => {
    const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const encode = (text: string) => new TextEncoder().encode(text);
    const frame = (graphic: string) =>
        `<w:r><w:drawing><wp:inline><wp:extent cx="2575560" cy="964504"/><wp:docPr id="3" name="Graphic 3"/><a:graphic><a:graphicData>${graphic}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const diagram = `<dgm:relIds xmlns:dgm="${DGM}" r:dm="rId20" r:lo="rId21" r:qs="rId22" r:cs="rId23"/>`;
    const point = (id: number, text: string, type = '') =>
        `<dgm:pt modelId="${id}"${type && ` type="${type}"`}><dgm:t><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></dgm:t></dgm:pt>`;
    const data = (ext: string) =>
        `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst><dgm:pt modelId="0" type="doc"/>${point(1, 'from')}${point(2, 'link', 'sibTrans')}${point(3, 'model')}</dgm:ptLst>${ext}</dgm:dataModel>`;
    const DRAWING_EXT = `<dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="rId24"/></a:ext></dgm:extLst>`;
    const shape = (paragraphs: string) => `<dsp:sp><dsp:txBody><a:bodyPr/>${paragraphs}</dsp:txBody></dsp:sp>`;
    const drawing = `<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="${A}"><dsp:spTree>${shape('<a:p><a:r><a:t>foo</a:t></a:r></a:p>')}${shape('<a:p><a:endParaRPr/></a:p>')}${shape('<a:p><a:r><a:t>bar</a:t></a:r><a:br/><a:fld type="slidenum"><a:t>baz</a:t></a:fld></a:p><a:p><a:r><a:t>qux</a:t></a:r></a:p>')}</dsp:spTree></dsp:drawing>`;
    const diagramRels = `<Relationship Id="rId20" Type="${RELS}/diagramData" Target="diagrams/data1.xml"/><Relationship Id="rId24" Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing" Target="diagrams/drawing1.xml"/>`;

    test("a SmartArt's shapes read as paragraphs in place, from its drawing part", async () => {
        const { json, warnings } = await importDocxBody(
            `${paragraph('<w:r><w:t>Before</w:t></w:r>')}${paragraph(frame(diagram))}${paragraph('<w:r><w:t>After</w:t></w:r>')}`,
            {
                rels: diagramRels,
                media: {
                    'word/diagrams/data1.xml': encode(data(DRAWING_EXT)),
                    'word/diagrams/drawing1.xml': encode(drawing),
                },
            },
        );
        expect(lines(json)).toEqual(['Before', 'foo', 'bar\nbaz', 'qux', 'After']);
        expect(warnings).toEqual([{ code: 'diagrams-dropped', count: 1 }]);
    });

    test('without a drawing part its data model gives the text of its points', async () => {
        const { json } = await importDocxBody(paragraph(frame(diagram)), {
            rels: diagramRels,
            media: { 'word/diagrams/data1.xml': encode(data('')) },
        });
        expect(lines(json)).toEqual(['from', 'model']);
    });
});

// A chart the reader draws is a chart node where the chart was, placed as a picture is; one it can't is a paragraph
// saying which kind it was, counted as a chart dropped.
describe('charts', () => {
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const cached = (values: (string | number)[]) =>
        `<c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join('')}`;
    const series = (idx: number, name: string, values: number[]) =>
        `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache>${cached([name])}</c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:schemeClr val="accent${idx + 1}"/></a:solidFill></c:spPr><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache>${cached(['North', 'South'])}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode>${cached(values)}</c:numCache></c:numRef></c:val></c:ser>`;
    const SERIES = `${series(0, 'Plan', [1, 2])}${series(1, 'Actual', [3, 4])}`;
    const COLUMNS = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${SERIES}<c:axId val="1"/><c:axId val="2"/></c:barChart>`;
    const LINES = `<c:lineChart><c:grouping val="standard"/>${series(2, 'Trend', [5, 6])}<c:axId val="1"/><c:axId val="2"/></c:lineChart>`;
    const AXES =
        '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>';
    const chartSpace = (plot: string, title = 'Sales') =>
        `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A}"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}${AXES}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;
    const THEME = `<a:theme xmlns:a="${A}" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="C00000"/></a:accent1><a:accent2><a:srgbClr val="00B050"/></a:accent2></a:clrScheme></a:themeElements></a:theme>`;
    const imported = (body: string, parts: string[]) => importDocxBody(body, { ...chartParts(parts), theme: THEME });
    const charts = (json: Parameters<typeof nodesOfType>[0]) => nodesOfType(json, 'chart');

    test("a column chart is a chart node at its extent in px, its series in the theme's colours, aligned as its paragraph", async () => {
        const centered = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${chartRun('rId20')}</w:p>`;
        const { json, warnings } = await imported(centered, [chartSpace(COLUMNS)]);
        const [chart] = charts(json);
        const { spec } = readChartSpec(chart?.attrs ?? {});
        expect([spec?.chart.type, spec?.title.text, spec?.legend.position, spec?.data]).toEqual([
            'column',
            'Sales',
            'bottom',
            {
                source: 'inline',
                categories: ['North', 'South'],
                series: [
                    { id: 'x-0', name: 'Plan', values: [1, 2] },
                    { id: 'x-1', name: 'Actual', values: [3, 4] },
                ],
            },
        ]);
        expect(spec?.series).toEqual({
            'x-0': { ...DEFAULT_CHART_SERIES_STYLE, color: '#c00000' },
            'x-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#00b050' },
        });
        expect([chart?.attrs?.['width'], chart?.attrs?.['height'], chart?.attrs?.['alignment']]).toEqual([
            480,
            288,
            'center',
        ]);
        expect(warnings).toEqual([]);
    });

    test('a part two drawings name is read once, and each is a chart', async () => {
        const reads = spyOn(ooxmlChart, 'readChart');
        const { json } = await imported(paragraph(`${chartRun('rId20')}${chartRun('rId20')}`), [chartSpace(COLUMNS)]);
        const calls = reads.mock.calls.length;
        reads.mockRestore();
        expect([charts(json).length, calls]).toEqual([2, 1]);
    });

    test('an anchor wrapped square on the right is a chart wrapped right, one wrapped top and bottom aligned', async () => {
        const right = chartRun('rId20', {
            anchor: '<wp:positionH relativeFrom="column"><wp:align>right</wp:align></wp:positionH><wp:wrapSquare wrapText="bothSides"/>',
        });
        const centered = chartRun('rId20', {
            anchor: '<wp:positionH relativeFrom="column"><wp:align>center</wp:align></wp:positionH><wp:wrapTopAndBottom/>',
        });
        const { json } = await imported(`${paragraph(right)}${paragraph(centered)}`, [chartSpace(COLUMNS)]);
        expect(charts(json).map((chart) => [chart.attrs?.['layout'], chart.attrs?.['alignment']])).toEqual([
            ['wrap-right', 'center'],
            ['block', 'center'],
        ]);
    });

    test('a chart wider than the column fits it and one taller than the largest page fits that, each keeping its shape', async () => {
        const wide = chartRun('rId20', { extent: 'cx="9525000" cy="4762500"' });
        const tall = chartRun('rId20', { extent: 'cx="952500" cy="28575000"' });
        const { json } = await imported(paragraph(`${wide}${tall}`), [chartSpace(COLUMNS)]);
        expect(charts(json).map((chart) => [chart.attrs?.['width'], chart.attrs?.['height']])).toEqual([
            [601, 301],
            [70, CHART_MAX_SIDE],
        ]);
    });

    // tdf124398: Word groups a chart with its caption's text box; the chart's own frame sizes it.
    test("a chart grouped with a caption's text box takes it as its caption, at its own frame's size", async () => {
        const WPG = 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup';
        const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
        const group = `<w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="column"><wp:align>center</wp:align></wp:positionH><wp:extent cx="5467350" cy="3620770"/><wp:wrapTopAndBottom/><wp:docPr id="11" name="Group 11"/><a:graphic><a:graphicData uri="${WPG}"><wpg:wgp xmlns:wpg="${WPG}" xmlns:wps="${WPS}"><wpg:graphicFrame><wpg:xfrm><a:off x="0" y="0"/><a:ext cx="4572000" cy="2743200"/></wpg:xfrm><a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" r:id="rId20"/></a:graphicData></a:graphic></wpg:graphicFrame><wps:wsp><wps:txbx><w:txbxContent><w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr><w:r><w:t>Figure 1 Sales</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></wpg:wgp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
        const { json } = await importDocxBody(paragraph(group), {
            ...chartParts([chartSpace(COLUMNS)]),
            styles: '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>',
        });
        expect(
            charts(json).map((chart) => [chart.attrs?.['width'], chart.attrs?.['height'], chart.attrs?.['caption']]),
        ).toEqual([[480, 288, 'Figure 1 Sales']]);
        expect(lines(json)).toEqual([]);
    });

    test("a chart the reader can't draw is a paragraph naming its kind with its title, a missing part one saying a chart", async () => {
        const { json, warnings } = await imported(
            `${paragraph('<w:r><w:t>Before</w:t></w:r>')}${paragraph(chartRun('rId20'))}${paragraph(chartRun('rId9'))}${paragraph('<w:r><w:t>After</w:t></w:r>')}`,
            [chartSpace(`${COLUMNS}${LINES}`, 'Mixed')],
        );
        expect([charts(json), lines(json)]).toEqual([
            [],
            ['Before', 'Combo chart not imported\nMixed', CHART_NOT_IMPORTED, 'After'],
        ]);
        expect(warnings).toEqual([{ code: 'charts-dropped', count: 2 }]);
    });

    // A header's schema holds no chart, and the Chart panel follows the body only.
    test("a header's chart keeps its title as the chart reads it, a chart with none leaves nothing", async () => {
        const part = (title: string) =>
            `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A}"><c:chart>${title}<c:plotArea><c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>Axis</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
        const {
            rels = '',
            media,
            contentTypes,
        } = chartParts([
            part(
                '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales </a:t></a:r><a:r><a:t>2024</a:t></a:r></a:p></c:rich></c:tx></c:title>',
            ),
            part('<c:title><c:overlay val="0"/></c:title>'),
            part(
                '<c:title><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx></c:title>',
            ),
            part('<c:autoTitleDeleted val="1"/>'),
            chartSpace(COLUMNS, 'Drawn'),
        ]);
        const header = paragraph(['rId20', 'rId21', 'rId22', 'rId23', 'rId24'].map((id) => chartRun(id)).join(''));
        const { json, bands, warnings } = docxToPmJson(
            Buffer.from(
                await buildDocxWithBands([{ id: 'h1', kind: 'header', xml: header, rels }], { media, contentTypes }),
            ),
        );
        expect([lines(json), bands.header && lines(bands.header), charts(bands.header ?? {})]).toEqual([
            ['Body'],
            ['Sales 2024', 'Chart Title', 'Revenue', 'Drawn'],
            [],
        ]);
        expect(warnings).toEqual([{ code: 'charts-dropped', count: 5 }]);
    });

    // A band's chart is found as the body's is: by a chart relationship, under word/charts/, of the chart content type.
    test("a header's reference to anything but a chart part keeps no title", async () => {
        const titled = new TextEncoder().encode(chartSpace(COLUMNS, 'Hidden'));
        const rel = (id: string, type: string, target: string) =>
            `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
        const header = paragraph(['rId30', 'rId31', 'rId32'].map((id) => chartRun(id)).join(''));
        const { bands, warnings } = docxToPmJson(
            Buffer.from(
                await buildDocxWithBands(
                    [
                        {
                            id: 'h1',
                            kind: 'header',
                            xml: header,
                            rels:
                                rel('rId30', 'chart', 'media/chart.xml') +
                                rel('rId31', 'chart', 'charts/untyped.xml') +
                                rel('rId32', 'image', 'charts/chart1.xml'),
                        },
                    ],
                    {
                        media: {
                            'word/media/chart.xml': titled,
                            'word/charts/untyped.xml': titled,
                            'word/charts/chart1.xml': titled,
                        },
                        contentTypes: `<Override PartName="/word/media/chart.xml" ContentType="${CHART_CONTENT_TYPE}"/><Override PartName="/word/charts/chart1.xml" ContentType="${CHART_CONTENT_TYPE}"/>`,
                    },
                ),
            ),
        );
        // A header of nothing but these is no header.
        expect(bands.header).toBeUndefined();
        expect(warnings).toEqual([{ code: 'charts-dropped', count: 3 }]);
    });
});
