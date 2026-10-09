import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { GOLDEN_DOCX_IMAGE_RUN, importDocxBody, marksOfType, nodesOfType } from '../../fixtures/golden-docx';

// Rows and cells, merges, header rows and the writer's floating figure.

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const cell = (text: string, tcPr = '') => `<w:tc>${tcPr && `<w:tcPr>${tcPr}</w:tcPr>`}${paragraph(run(text))}</w:tc>`;
const row = (cells: string[], trPr = '') => `<w:tr>${trPr && `<w:trPr>${trPr}</w:trPr>`}${cells.join('')}</w:tr>`;
const table = (rows: string[], tblPr = '') =>
    `<w:tbl>${tblPr && `<w:tblPr>${tblPr}</w:tblPr>`}<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows.join('')}</w:tbl>`;
const FILL = '<w:shd w:val="clear" w:fill="1F4E79"/>';

// Each row as its cells' types.
async function rowTypes(body: string): Promise<string[][]> {
    const { json } = await importDocxBody(body);
    return nodesOfType(json, 'tableRow').map((tableRow: JSONContent) =>
        (tableRow.content ?? []).map((node) => node.type ?? ''),
    );
}

describe('header rows', () => {
    // P12: Google Docs and many templates draw a header as a filled first row.
    test('a first row filled in every cell over rows without a fill is a header row', async () => {
        const body = table([
            row([cell('Region', FILL), cell('Q1', FILL)]),
            row([cell('North'), cell('4')]),
            row([cell('South'), cell('5')]),
        ]);
        expect(await rowTypes(body)).toEqual([
            ['tableHeader', 'tableHeader'],
            ['tableCell', 'tableCell'],
            ['tableCell', 'tableCell'],
        ]);
    });

    test('a filled first row over a filled row is no header row', async () => {
        const body = table([row([cell('A', FILL), cell('B', FILL)]), row([cell('C', FILL), cell('D')])]);
        expect((await rowTypes(body))[0]).toEqual(['tableCell', 'tableCell']);
    });

    test('a first row filled in one cell only is no header row', async () => {
        const body = table([row([cell('A', FILL), cell('B')]), row([cell('C'), cell('D')])]);
        expect((await rowTypes(body))[0]).toEqual(['tableCell', 'tableCell']);
    });

    test('a w:tblHeader row is a header row, and w:tblHeader off is not', async () => {
        const body = table([
            row([cell('A'), cell('B')], '<w:tblHeader/>'),
            row([cell('C'), cell('D')], '<w:tblHeader w:val="0"/>'),
        ]);
        expect(await rowTypes(body)).toEqual([
            ['tableHeader', 'tableHeader'],
            ['tableCell', 'tableCell'],
        ]);
    });
});

describe('table style first row', () => {
    const styles =
        '<w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr></w:tblStylePr></w:style>';
    const styled = (look: string) =>
        table([row([cell('Head'), cell('H2')]), row([cell('Body'), cell('B2')])], `<w:tblStyle w:val="Grid"/>${look}`);

    test.each(['1', 'true', 'on'])('w:firstRow="%s" in tblLook applies the style\'s first row look', async (value) => {
        const { json } = await importDocxBody(styled(`<w:tblLook w:firstRow="${value}"/>`), { styles });
        expect(marksOfType(json, 'bold').map((mark) => mark.text)).toEqual(['Head', 'H2']);
    });

    test('w:firstRow="false" in tblLook does not', async () => {
        const { json } = await importDocxBody(styled('<w:tblLook w:firstRow="false"/>'), { styles });
        expect(marksOfType(json, 'bold')).toEqual([]);
    });
});

describe('merges', () => {
    test('gridSpan and vMerge are colspan and rowspan', async () => {
        const body = table([
            row([cell('Both', '<w:gridSpan w:val="2"/>')]),
            row([cell('Down', '<w:vMerge w:val="restart"/>'), cell('x')]),
            row([cell('', '<w:vMerge/>'), cell('y')]),
        ]);
        const { json } = await importDocxBody(body);
        expect(
            nodesOfType(json, 'tableCell').map((node) => [node.attrs?.['colspan'], node.attrs?.['rowspan']]),
        ).toEqual([
            [2, 1],
            [1, 2],
            [1, 1],
            [1, 1],
        ]);
    });

    test('a cell whose paragraphs share one alignment is an aligned cell', async () => {
        const centered = `<w:tc>${paragraph(run('a'), '<w:jc w:val="center"/>')}${paragraph(run('b'), '<w:jc w:val="center"/>')}</w:tc>`;
        const { json } = await importDocxBody(table([row([centered, cell('c')])]));
        expect(nodesOfType(json, 'tableCell').map((node) => node.attrs?.['align'] ?? null)).toEqual(['center', null]);
    });
});

describe('wrappers', () => {
    // The block walk's wrappers hold rows and cells too.
    test('rows and cells inside wrappers are read', async () => {
        const wrap = (local: string, inner: string) => `<w:${local}>${inner}</w:${local}>`;
        const body = table([
            row([cell('A'), wrap('smartTag', cell('B'))]),
            wrap('smartTag', row([cell('C'), wrap('customXml', cell('D'))])),
            wrap('ins', row([cell('E'), cell('F')])),
        ]);
        expect(await rowTypes(body)).toEqual([
            ['tableCell', 'tableCell'],
            ['tableCell', 'tableCell'],
            ['tableCell', 'tableCell'],
        ]);
    });
});

describe("the writer's wrapped figure", () => {
    test('a floating one-cell table holding a picture and its caption is a wrapped figure', async () => {
        const float = `<w:tbl><w:tblPr><w:tblpPr w:tblpXSpec="right"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>${paragraph(GOLDEN_DOCX_IMAGE_RUN)}${paragraph(run('A caption'))}</w:tc></w:tr></w:tbl>`;
        const { json } = await importDocxBody(`${float}${paragraph(run('Text beside it.'))}`);
        expect(nodesOfType(json, 'table')).toEqual([]);
        expect(nodesOfType(json, 'figure').map((node) => [node.attrs?.['layout'], node.attrs?.['caption']])).toEqual([
            ['wrap-right', 'A caption'],
        ]);
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Text beside it.']);
    });
});
