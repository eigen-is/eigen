import { describe, expect, test } from 'bun:test';
import { CAPTION_LOOK } from '../../../lib/export/doc/looks';
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

    test('a picture keeps its alt text, its width in pixels and its click link', async () => {
        const linked = GOLDEN_DOCX_IMAGE_RUN.replace(
            'descr="A pixel"/>',
            'descr="A pixel"><a:hlinkClick xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:id="rId9"/></wp:docPr>',
        );
        const { json } = await importDocxBody(paragraph(linked), {
            rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="https://example.com/" TargetMode="External"/>`,
        });
        const [figure] = nodesOfType(json, 'figure');
        expect([figure?.attrs?.['alt'], figure?.attrs?.['width']]).toEqual(['A pixel', 40]);
        expect(figure?.marks?.map((mark) => mark.attrs?.['href'])).toEqual(['https://example.com/']);
        expect(marksOfType(json, 'link')).toEqual([]);
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
});
