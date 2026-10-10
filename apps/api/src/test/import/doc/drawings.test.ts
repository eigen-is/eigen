import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { CAPTION_LOOK } from '../../../lib/document/looks';
import { GOLDEN_DOCX_IMAGE_RUN, importDocxBody, marksOfType, nodesOfType } from '../../fixtures/golden-docx';

// Pictures: one media file per image part, named from its content type, placed as Word places it.

const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const paragraph = (inner: string) => `<w:p>${inner}</w:p>`;
const picture = (rid: string) => GOLDEN_DOCX_IMAGE_RUN.replace('r:embed="rId4"', `r:embed="${rid}"`);
const BYTES = new Uint8Array([1, 2, 3]);

describe('media', () => {
    // Decision 1: kept under its real name, though no browser draws it; the import logs it.
    test('a WMF part is image-N.wmf, image/x-wmf, and counts as unshown', async () => {
        const { json, images, warnings } = await importDocxBody(paragraph(picture('rId9')), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/image1.wmf"/>`,
            contentTypes: '<Default Extension="wmf" ContentType="image/x-wmf"/>',
            media: { 'word/media/image1.wmf': BYTES },
        });
        expect(images.map(({ name, contentType }) => [name, contentType])).toEqual([['image-1.wmf', 'image/x-wmf']]);
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['mediaName'])).toEqual(['image-1.wmf']);
        expect(warnings).toEqual([{ code: 'images-unshown', count: 1 }]);
    });

    test('an undeclared part takes its extension, and image/jpg reads as image/jpeg', async () => {
        const { images } = await importDocxBody(paragraph(`${picture('rId9')}${picture('rId10')}`), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/a.gif"/><Relationship Id="rId10" Type="${IMAGE_REL}" Target="media/b.jpg"/>`,
            contentTypes: '<Override PartName="/word/media/b.jpg" ContentType="image/jpg"/>',
            media: { 'word/media/a.gif': BYTES, 'word/media/b.jpg': BYTES },
        });
        expect(images.map(({ name, contentType }) => [name, contentType])).toEqual([
            ['image-1.gif', 'image/gif'],
            ['image-2.jpeg', 'image/jpeg'],
        ]);
    });

    test('a part shown twice is stored once', async () => {
        const { json, images } = await importDocxBody(paragraph(`${picture('rId4')}${picture('rId4')}`));
        expect(images).toHaveLength(1);
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['mediaName'])).toEqual([
            'image-1.png',
            'image-1.png',
        ]);
    });

    test('an SVG wins over its PNG fallback', async () => {
        const svg = GOLDEN_DOCX_IMAGE_RUN.replace(
            '<a:blip r:embed="rId4"/>',
            '<a:blip r:embed="rId4"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></a:ext></a:extLst></a:blip>',
        );
        const { images } = await importDocxBody(paragraph(svg), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/image1.svg"/>`,
            contentTypes: '<Default Extension="svg" ContentType="image/svg+xml"/>',
            media: { 'word/media/pixel.png': BYTES, 'word/media/image1.svg': new TextEncoder().encode('<svg/>') },
        });
        expect(images.map(({ name, contentType }) => [name, contentType])).toEqual([['image-1.svg', 'image/svg+xml']]);
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

    // The writer's convention for code and quotes: a text box's blocks sit at its anchor's text.
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

        test('its text stays in the item, and in the quote', async () => {
            const quoted = `<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>${text('Said')}${vml(box('Inside', '000000'))}</w:p>`;
            expect(
                await read(`${item(`${text('One')}${shape(box('Boxed', '000000'))}`)}${item(text('Two'))}${quoted}`),
            ).toEqual(['bulletList[listItem[One | Boxed] | listItem[Two]]', 'blockquote[Said | Inside]']);
        });

        test('a table and a list in it stay in the item', async () => {
            const table = `<w:tbl><w:tr><w:tc><w:p>${text('Cell')}</w:p></w:tc></w:tr></w:tbl>`;
            const inner = `<w:txbxContent>${table}${item(text('Boxed'), 6)}</w:txbxContent>`;
            expect(await read(`${item(`${text('One')}${shape(inner)}`)}${item(text('Two'))}`)).toEqual([
                'bulletList[listItem[One | table[tableRow[tableCell[Cell]]] | bulletList[listItem[Boxed]]] | listItem[Two]]',
            ]);
        });
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
            marksOfType(json, 'small').map((mark) => mark.text),
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

    test('a small line after a block figure, not in the caption look, is a paragraph in small', async () => {
        expect(await captionOf(GOLDEN_DOCX_IMAGE_RUN, line('Note', '<w:sz w:val="16"/>'))).toEqual([null, ['Note']]);
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
                ['Table 1', ['textStyle', 'bold', 'italic', 'small']],
            ]);
            expect(marksOfType(json, 'textStyle')[0]?.attrs?.['color']).toBe('#44546a');
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

// SmartArt's text is the document's, read in place; a chart keeps its title. Each counts as a graphic dropped.
describe('SmartArt and charts', () => {
    const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
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
    const lines = (json: Parameters<typeof nodesOfType>[0]) =>
        nodesOfType(json, 'paragraph')
            .map((node) => (node.content ?? []).map((child) => child.text ?? '\n').join(''))
            .filter(Boolean);

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
        expect(warnings).toEqual([{ code: 'graphics-dropped', count: 1 }]);
    });

    test('without a drawing part its data model gives the text of its points', async () => {
        const { json } = await importDocxBody(paragraph(frame(diagram)), {
            rels: diagramRels,
            media: { 'word/diagrams/data1.xml': encode(data('')) },
        });
        expect(lines(json)).toEqual(['from', 'model']);
    });

    test("a chart keeps its title's text or its cell's, a chart with none leaves nothing", async () => {
        const chart = (id: string) => `<c:chart xmlns:c="${C}" r:id="${id}"/>`;
        const part = (title: string) =>
            `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart>${title}<c:plotArea><c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>Axis</a:t></a:r></a:p></c:rich></c:tx></c:title></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
        const { json, warnings } = await importDocxBody(
            paragraph(`${frame(chart('rId20'))}${frame(chart('rId21'))}${frame(chart('rId22'))}`),
            {
                rels: `<Relationship Id="rId20" Type="${RELS}/chart" Target="charts/chart1.xml"/><Relationship Id="rId21" Type="${RELS}/chart" Target="charts/chart2.xml"/><Relationship Id="rId22" Type="${RELS}/chart" Target="charts/chart3.xml"/>`,
                media: {
                    'word/charts/chart1.xml': encode(
                        part(
                            '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales </a:t></a:r><a:r><a:t>2024</a:t></a:r></a:p></c:rich></c:tx></c:title>',
                        ),
                    ),
                    'word/charts/chart2.xml': encode(part('<c:title><c:overlay val="0"/></c:title>')),
                    'word/charts/chart3.xml': encode(
                        part(
                            '<c:title><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx></c:title>',
                        ),
                    ),
                },
            },
        );
        expect(lines(json)).toEqual(['Sales 2024', 'Revenue']);
        expect(warnings).toEqual([{ code: 'graphics-dropped', count: 3 }]);
    });
});
