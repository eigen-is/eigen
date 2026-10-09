import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { COLUMN_PX } from '../../../lib/import/doc/assemble';
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

    // ST_OnOff allows whitespace around the value.
    test.each(['1', 'true', 'on', ' true '])(
        'w:firstRow="%s" in tblLook applies the style\'s first row look',
        async (value) => {
            const { json } = await importDocxBody(styled(`<w:tblLook w:firstRow="${value}"/>`), { styles });
            expect(marksOfType(json, 'bold').map((mark) => mark.text)).toEqual(['Head', 'H2']);
        },
    );

    test('w:firstRow="false" in tblLook does not', async () => {
        const { json } = await importDocxBody(styled('<w:tblLook w:firstRow="false"/>'), { styles });
        expect(marksOfType(json, 'bold')).toEqual([]);
    });

    test("w:val's first row bit applies it without w:firstRow", async () => {
        const { json } = await importDocxBody(styled('<w:tblLook w:val="0420"/>'), { styles });
        expect(marksOfType(json, 'bold').map((mark) => mark.text)).toEqual(['Head', 'H2']);
    });

    test('w:firstRow="0" wins over the first row bit of w:val\'s mask', async () => {
        const { json } = await importDocxBody(styled('<w:tblLook w:val="0420" w:firstRow="0"/>'), { styles });
        expect(marksOfType(json, 'bold')).toEqual([]);
    });
});

describe('column widths', () => {
    const gridded = (grid: (number | string)[], cells: string[]) =>
        `<w:tbl><w:tblGrid>${grid.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${row(cells)}</w:tbl>`;
    const colwidths = (json: JSONContent) => nodesOfType(json, 'tableCell').map((node) => node.attrs?.['colwidth']);

    // 200, 400 and 449 px: 1,049 px, which the editor would clip.
    test('a grid wider than the text column scales down to it, column by column', async () => {
        const { json } = await importDocxBody(gridded([3000, 6000, 6735], [cell('a'), cell('b'), cell('c')]));
        const widths = colwidths(json);
        expect(widths).toEqual([[122], [245], [275]]);
        expect(widths.flat().reduce((sum, width) => sum + width, 0)).toBe(COLUMN_PX);
    });

    test('a grid that fits keeps its widths', async () => {
        const { json } = await importDocxBody(gridded([3000, 4500], [cell('a'), cell('b')]));
        expect(colwidths(json)).toEqual([[200], [300]]);
    });

    test('a grid in universal measures, as Strict OOXML writes it, is read in points', async () => {
        const { json } = await importDocxBody(gridded(['150pt', '2in'], [cell('a'), cell('b')]));
        expect(colwidths(json)).toEqual([[200], [192]]);
    });

    test("a nested table scales down to its cell's width", async () => {
        const nested = gridded([4500, 4500], [cell('x'), cell('y')]);
        const { json } = await importDocxBody(
            gridded([3000, 3000], [`<w:tc>${nested}${paragraph('')}</w:tc>`, cell('b')]),
        );
        expect(colwidths(json)).toEqual([[200], [100], [100], [200]]);
    });
});

// P3: Word draws light text on a fill the schema drops; on Eigen's paper it would vanish.
describe('light text on a fill', () => {
    const colored = (text: string, color: string, pPr = '', rPr = '') =>
        paragraph(`<w:r><w:rPr><w:color w:val="${color}"/>${rPr}</w:rPr><w:t>${text}</w:t></w:r>`, pPr);
    const colorsOf = async (body: string, styles = '') =>
        marksOfType((await importDocxBody(body, { styles })).json, 'textStyle').map((mark) => [
            mark.text,
            mark.attrs['color'],
        ]);
    const filledCell = (inner: string, fill: string) =>
        `<w:tc><w:tcPr><w:shd w:val="clear" w:fill="${fill}"/></w:tcPr>${inner}</w:tc>`;

    test('white and light grey text in a teal cell lose their color; grey, dark blue and highlighted keep it', async () => {
        const inner = [
            colored('white', 'FFFFFF'),
            colored('light', 'D9D9D9'),
            colored('grey', '808080'),
            colored('blue', '1F4E79'),
            colored('marked', 'FFFFFF', '', '<w:highlight w:val="darkBlue"/>'),
        ].join('');
        expect(await colorsOf(table([row([filledCell(inner, '008080'), cell('b')])]))).toEqual([
            ['grey', '#808080'],
            ['blue', '#1f4e79'],
            ['marked', '#ffffff'],
        ]);
    });

    test("white text in a nested table's plain cell or a plain paragraph lets the teal cell around it show", async () => {
        const nested = table([row([`<w:tc>${colored('nested', 'FFFFFF')}</w:tc>`, cell('b')])]);
        const plain = colored('plain', 'FFFFFF', '<w:shd w:val="clear" w:fill="auto"/>');
        expect(await colorsOf(table([row([filledCell(`${nested}${plain}`, '008080'), cell('b')])]))).toEqual([]);
    });

    test('white text on no fill keeps its color', async () => {
        expect(await colorsOf(colored('white', 'FFFFFF'))).toEqual([['white', '#ffffff']]);
    });

    test('white text in a shaded paragraph loses its color', async () => {
        expect(await colorsOf(colored('white', 'FFFFFF', '<w:shd w:val="clear" w:fill="1F4E79"/>'))).toEqual([]);
    });

    test("white text on a table style's first row fill loses its color, in the body rows it keeps it", async () => {
        const styles =
            '<w:style w:type="table" w:styleId="Dark"><w:name w:val="Dark"/><w:tblStylePr w:type="firstRow"><w:tcPr><w:shd w:val="clear" w:fill="4472C4"/></w:tcPr></w:tblStylePr></w:style>';
        const body = table(
            [
                row([`<w:tc>${colored('head', 'FFFFFF')}</w:tc>`, cell('b')]),
                row([`<w:tc>${colored('body', 'FFFFFF')}</w:tc>`, cell('d')]),
            ],
            '<w:tblStyle w:val="Dark"/><w:tblLook w:firstRow="1"/>',
        );
        expect(await colorsOf(body, styles)).toEqual([['body', '#ffffff']]);
    });

    test("a cell without a fill of its own in a table filled whole loses it; a cell's explicit none keeps it", async () => {
        const body = table(
            [row([`<w:tc>${colored('filled', 'FFFFFF')}</w:tc>`, filledCell(colored('clear', 'FFFFFF'), 'auto')])],
            '<w:shd w:val="clear" w:fill="000000"/>',
        );
        expect(await colorsOf(body)).toEqual([['clear', '#ffffff']]);
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
