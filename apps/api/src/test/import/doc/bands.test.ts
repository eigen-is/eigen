import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { ApiError } from '../../../lib/core/errors';
import { MAX_PACKAGE_XML_BYTES } from '../../../lib/core/opc';
import * as xml from '../../../lib/core/xml';
import { docxToPmJson } from '../../../lib/import/doc/from-docx';
import {
    BAND_NAMESPACES,
    buildDocxWithBands,
    buildDocxWithBody,
    type DocxBand,
    GOLDEN_DOCX_IMAGE_RUN,
    nodesOfType,
} from '../../fixtures/golden-docx';

// A docx's headers and footers: the final section's default and first-page parts, read as the body is, through their
// own relationships, into the doc's bands.

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const complexField = (instr: string, cached: string) =>
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instr}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(cached)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function docxWith(bands: DocxBand[], options?: Parameters<typeof buildDocxWithBands>[1]) {
    return docxToPmJson(Buffer.from(await buildDocxWithBands(bands, options)));
}

function texts(json: JSONContent | undefined): string[] {
    return json ? nodesOfType(json, 'text').map((node) => node.text ?? '') : [];
}

describe('docx import — headers and footers', () => {
    test("the final section's default header and footer become the doc's bands, apart from the body", async () => {
        const { json, bands, page } = await docxWith([
            { id: 'h1', kind: 'header', type: 'default', xml: paragraph(run('Acme')) },
            { id: 'f1', kind: 'footer', xml: paragraph(run('Confidential')) },
        ]);
        expect(texts(json)).toEqual(['Body']);
        expect(texts(bands.header)).toEqual(['Acme']);
        expect(texts(bands.footer)).toEqual(['Confidential']);
        expect(Object.keys(bands)).toEqual(['header', 'footer']);
        expect(page.differentFirstPage).toBe(false);
    });

    test('w:titlePg makes page 1 different, with its own bands; a first band without it is never read', async () => {
        const first = [
            { id: 'h1', kind: 'header', xml: paragraph(run('Acme')) },
            { id: 'h2', kind: 'header', type: 'first', xml: paragraph(run('Letterhead')) },
        ] as const;
        const different = await docxWith([...first], { sectPr: '<w:titlePg/>' });
        expect(different.page.differentFirstPage).toBe(true);
        expect(texts(different.bands.headerFirst)).toEqual(['Letterhead']);
        expect(texts(different.bands.header)).toEqual(['Acme']);

        const parses = spyOn(xml, 'parseXml');
        const same = await docxWith([...first]);
        parses.mockRestore();
        expect(same.page.differentFirstPage).toBe(false);
        expect(same.bands.headerFirst).toBeUndefined();
        expect(parses.mock.calls.some(([input]) => Buffer.from(input).includes('Letterhead'))).toBe(false);
    });

    // Word inherits a reference a section leaves out from the section before it.
    test("a final section without references takes an earlier section's", async () => {
        const docx = await buildDocxWithBody(
            `${paragraph(run('One'), '<w:sectPr><w:headerReference w:type="default" r:id="h1"/></w:sectPr>')}${paragraph(run('Two'))}<w:sectPr/>`,
            {
                rels: `<Relationship Id="h1" Type="${REL}/header" Target="h1.xml"/>`,
                media: {
                    'word/media/pixel.png': new Uint8Array(),
                    'word/h1.xml': new TextEncoder().encode(
                        `<w:hdr ${BAND_NAMESPACES}>${paragraph(run('Acme'))}</w:hdr>`,
                    ),
                },
            },
        );
        expect(texts(docxToPmJson(Buffer.from(docx)).bands.header)).toEqual(['Acme']);
    });

    test('a band with nothing to show is no band', async () => {
        const { bands } = await docxWith([
            { id: 'h1', kind: 'header', xml: `${paragraph('')}${paragraph(run('  '))}` },
        ]);
        expect(bands).toEqual({});
    });

    // Word draws even pages' bands only with evenAndOddHeaders; the doc has one header, so the default stands in.
    test('even-page bands are dropped with a warning, only where Word draws them', async () => {
        const even = [
            { id: 'h1', kind: 'header', xml: paragraph(run('Odd')) },
            { id: 'h2', kind: 'header', type: 'even', xml: paragraph(run('Even')) },
        ] as const;
        const drawn = await docxWith([...even], { settings: '<w:evenAndOddHeaders/>' });
        expect(texts(drawn.bands.header)).toEqual(['Odd']);
        expect(drawn.warnings).toContainEqual({ code: 'even-bands-dropped', count: 1 });
        const ignored = await docxWith([...even]);
        expect(ignored.warnings.map(({ code }) => code)).not.toContain('even-bands-dropped');
    });

    test('PAGE and NUMPAGES are page number nodes, whatever their switches, their cached digits gone', async () => {
        const { json, bands } = await docxWith(
            [
                {
                    id: 'f1',
                    kind: 'footer',
                    xml: paragraph(
                        `${run('Page ')}${complexField(' PAGE \\* MERGEFORMAT ', '3')}${run(' of ')}<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple>`,
                    ),
                },
            ],
            { body: paragraph(`${run('Here ')}${complexField(' page ', '1')}`) },
        );
        expect(bands.footer?.content).toEqual([
            {
                type: 'paragraph',
                attrs: expect.anything(),
                content: [
                    { type: 'text', text: 'Page ' },
                    { type: 'pageNumber', attrs: { kind: 'page' } },
                    { type: 'text', text: ' of ' },
                    { type: 'pageNumber', attrs: { kind: 'pages' } },
                ],
            },
        ]);
        expect(nodesOfType(json, 'pageNumber')).toEqual([{ type: 'pageNumber', attrs: { kind: 'page' } }]);
        expect(texts(json)).toEqual(['Here ']);
    });

    // A switch may follow the name with no space; a doc is one section, so its section's page count is the doc's.
    test('NUMPAGES with a switch run on and SECTIONPAGES are page counts, their cached digits gone', async () => {
        const { bands } = await docxWith([
            {
                id: 'f1',
                kind: 'footer',
                xml: paragraph(
                    `${complexField(' NUMPAGES\\*Arabic ', '7')}${run('/')}${complexField(' SECTIONPAGES ', '5')}`,
                ),
            },
        ]);
        expect(nodesOfType(bands.footer ?? {}, 'pageNumber')).toEqual([
            { type: 'pageNumber', attrs: { kind: 'pages' } },
            { type: 'pageNumber', attrs: { kind: 'pages' } },
        ]);
        expect(texts(bands.footer)).toEqual(['/']);
    });

    test("a header's picture resolves through the header's relationships, and an anchored one is a block figure", async () => {
        const anchored = GOLDEN_DOCX_IMAGE_RUN.replace(
            '<wp:inline>',
            '<wp:anchor><wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH><wp:wrapSquare wrapText="bothSides"/>',
        ).replace('</wp:inline>', '</wp:anchor>');
        const { bands, images, warnings } = await docxWith([
            {
                id: 'h1',
                kind: 'header',
                xml: paragraph(`${anchored}${run('Acme')}`),
                rels: `<Relationship Id="rId4" Type="${REL}/image" Target="media/pixel.png"/>`,
            },
        ]);
        const [figure] = nodesOfType(bands.header ?? {}, 'figure');
        expect(figure?.attrs).toMatchObject({ mediaName: 'image-1.png', layout: 'block', alignment: 'right' });
        expect(images.map(({ name }) => name)).toEqual(['image-1.png']);
        expect(warnings).toContainEqual({ code: 'band-images-unanchored', count: 1 });
    });

    // A full-page letterhead or a watermark lies behind the text from the header; as a block it would push the body away.
    test('a band drops a picture behind the text and a VML picture, with a warning', async () => {
        const behind = GOLDEN_DOCX_IMAGE_RUN.replace('<wp:inline>', '<wp:anchor behindDoc="1">').replace(
            '</wp:inline>',
            '</wp:anchor>',
        );
        const inFront = behind.replace('behindDoc="1"', 'behindDoc="0"');
        const watermark = `<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:400pt;height:600pt"><v:imagedata r:id="rId4"/></v:shape></w:pict></w:r>`;
        const { bands, images, warnings } = await docxWith([
            {
                id: 'h1',
                kind: 'header',
                xml: paragraph(`${behind}${watermark}${inFront}${run('Acme')}`),
                rels: `<Relationship Id="rId4" Type="${REL}/image" Target="media/pixel.png"/>`,
            },
        ]);
        expect(nodesOfType(bands.header ?? {}, 'figure')).toHaveLength(1);
        expect(texts(bands.header)).toEqual(['Acme']);
        expect(images).toHaveLength(1);
        expect(warnings).toContainEqual({ code: 'band-content-dropped', count: 2 });
        expect(warnings).toContainEqual({ code: 'band-images-unanchored', count: 1 });
    });

    // A band's schema holds no note: the note belongs to the body's text.
    test('a note reference in a band is dropped, with a warning', async () => {
        const { json, bands, warnings } = await docxWith([
            {
                id: 'f1',
                kind: 'footer',
                xml: paragraph(`${run('Source')}<w:r><w:footnoteReference w:id="1"/></w:r>`),
            },
        ]);
        expect(texts(bands.footer)).toEqual(['Source']);
        expect(texts(json)).toEqual(['Body']);
        expect(warnings).toContainEqual({ code: 'band-content-dropped', count: 1 });
    });

    // In Eigen a band's lists count on their own, so a band's item doesn't continue the body's count.
    test("a band's numbered list starts its own count", async () => {
        const item = (text: string) =>
            paragraph(run(text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>');
        const { json, bands } = await docxWith([{ id: 'h1', kind: 'header', xml: item('Head') }], {
            body: `${item('One')}${item('Two')}`,
        });
        expect(nodesOfType(json, 'orderedList').map((list) => list.attrs?.['start'])).toEqual([1]);
        expect(nodesOfType(bands.header ?? {}, 'orderedList').map((list) => list.attrs?.['start'])).toEqual([1]);
    });

    test("a reference whose relationship isn't a header's or a footer's is no band", async () => {
        const docx = await buildDocxWithBody(
            `${paragraph(run('Body'))}<w:sectPr><w:headerReference w:type="default" r:id="h1"/></w:sectPr>`,
            {
                rels: `<Relationship Id="h1" Type="${REL}/footnotes" Target="h1.xml"/>`,
                media: {
                    'word/media/pixel.png': new Uint8Array(),
                    'word/h1.xml': new TextEncoder().encode(
                        `<w:hdr ${BAND_NAMESPACES}>${paragraph(run('Acme'))}</w:hdr>`,
                    ),
                },
            },
        );
        expect(docxToPmJson(Buffer.from(docx)).bands).toEqual({});
    });

    test('evenAndOddHeaders off is no even-page warning', async () => {
        const { warnings } = await docxWith(
            [
                { id: 'h1', kind: 'header', xml: paragraph(run('Odd')) },
                { id: 'h2', kind: 'header', type: 'even', xml: paragraph(run('Even')) },
            ],
            { settings: '<w:evenAndOddHeaders w:val="0"/>' },
        );
        expect(warnings.map(({ code }) => code)).not.toContain('even-bands-dropped');
    });

    // A field's code shows nothing, a simple field in it included.
    test("a PAGE simple field inside another field's code is no page number", async () => {
        const nested = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> IF </w:instrText></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:instrText xml:space="preserve"> = 1 "x" "y" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('x')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
        const { bands } = await docxWith([{ id: 'f1', kind: 'footer', xml: paragraph(nested) }]);
        expect(nodesOfType(bands.footer ?? {}, 'pageNumber')).toEqual([]);
        expect(texts(bands.footer)).toEqual(['x']);
    });

    // A band's schema holds none of them: a Title-styled header line is a paragraph, a code block its lines.
    test("the nodes a band's schema leaves out are flattened to their text, with a warning", async () => {
        const { bands, warnings } = await docxWith(
            [
                {
                    id: 'h1',
                    kind: 'header',
                    xml: `${paragraph(run('Annual report'), '<w:pStyle w:val="Title"/>')}${paragraph(`${run('a')}<w:r><w:br w:type="page"/></w:r>${run('b')}`)}`,
                },
            ],
            { styles: '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>' },
        );
        expect(nodesOfType(bands.header ?? {}, 'title')).toEqual([]);
        expect(nodesOfType(bands.header ?? {}, 'pageBreak')).toEqual([]);
        // The break goes, as in a note: a band isn't paged.
        expect(texts(bands.header)).toEqual(['Annual report', 'ab']);
        expect(warnings).toContainEqual({ code: 'blocks-flattened', count: 1 });
    });
});

describe('docx import — header budget', () => {
    const spies: { mockRestore(): void }[] = [];
    afterEach(() => {
        for (const spy of spies) spy.mockRestore();
        spies.length = 0;
    });

    test('a header part is charged against the package budget with the body', async () => {
        const padding = `<!--${'x'.repeat(MAX_PACKAGE_XML_BYTES)}-->`;
        const error = await docxWith([{ id: 'h1', kind: 'header', xml: `${paragraph(run('Acme'))}${padding}` }]).then(
            () => undefined,
            (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(ApiError);
        expect(error instanceof ApiError && [error.status, error.message]).toEqual([413, 'Document too large']);
    });
});
