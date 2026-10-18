import { describe, expect, test } from 'bun:test';
import { parseOoxml } from '../../../lib/core/ooxml';
import { readGrid } from '../../../lib/import/sheets/cells';
import { readBudget, readInBatches } from '../../../lib/import/sheets/package';
import { readSharedStrings } from '../../../lib/import/sheets/strings';
import { readLooks } from '../../../lib/import/sheets/styles';
import { cellKey, type PlacedCell } from '../../../lib/import/sheets/worksheet';
import { SML, sheetXml } from '../../fixtures/xlsx';

// A worksheet's grid: each cell's value, display, type, formula and look, the borders, row heights and hidden rows.

const PALETTE = ['#FFFFFF', '#000000'];
const STYLES = `<numFmts><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts><font/><font><b/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders><border/><border><bottom style="thin"/></border></borders><cellXfs><xf/><xf numFmtId="14"/><xf numFmtId="164"/><xf fontId="1" fillId="2"/><xf><alignment horizontal="left"/></xf><xf borderId="1"/><xf numFmtId="10" fillId="2"/></cellXfs>`;
const [DATE, CUSTOM_DATE, BOLD_FILLED, LEFT, BORDERED, PERCENT_FILLED] = [1, 2, 3, 4, 5, 6];

function read(data: string, options: { strings?: string[]; date1904?: boolean; placed?: PlacedCell[] } = {}) {
    const charged: [number, number][] = [];
    const copied: number[] = [];
    const sst = new TextEncoder().encode(
        `<sst xmlns="${SML}">${(options.strings ?? []).map((si) => `<si>${si}</si>`).join('')}</sst>`,
    );
    const part = new TextEncoder().encode(sheetXml({ data }));
    const budget = readBudget();
    const grid = readGrid(readInBatches(part, 'sheetData', 'row', budget).children, {
        looks: readLooks(parseOoxml(`<styleSheet xmlns="${SML}">${STYLES}</styleSheet>`) ?? undefined, PALETTE),
        strings: readSharedStrings(sst, PALETTE, budget),
        date1904: options.date1904 ?? false,
        palette: PALETTE,
        charge: (cells, text) => charged.push([cells, text]),
        chargeCopy: (chars) => copied.push(chars),
        placed: new Map((options.placed ?? []).map((placed) => [cellKey(placed.r, placed.c), placed])),
    });
    const cell = (ref: string) => {
        const c = ref.charCodeAt(0) - 65;
        const r = Number(ref.slice(1)) - 1;
        return grid.celldata.find((entry) => entry.r === r && entry.c === c)?.v;
    };
    return { grid, cell, charged, copied };
}

function thrown(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected a throw');
}

describe('a value', () => {
    test('a number displays through its format and aligns right', () => {
        const { cell } = read('<row r="1"><c r="A1"><v>1.5</v></c><c r="B1" s="6"><v>0.25</v></c></row>');
        expect(cell('A1')).toEqual({ v: 1.5, m: '1.5', ht: 2, ct: { fa: 'General', t: 'n' } });
        expect(cell('B1')).toEqual({ v: 0.25, m: '25.00%', ht: 2, bg: '#FFFF00', ct: { fa: '0.00%', t: 'n' } });
    });

    test('strings shared, inline and formula-made, a rich one in its runs alone', () => {
        const { cell } = read(
            '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="B1" t="inlineStr"><is><r><rPr><b/></rPr><t>in</t></r><r><t>line</t></r></is></c><c r="C1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c><c r="D1" t="s"><v>9</v></c><c r="E1" t="s"><v>0</v></c></row>',
            { strings: ['<t>zero</t>', '<r><rPr><i/></rPr><t>ri</t></r><r><t>ch</t></r>'] },
        );
        // A rich cell keeps its text in its runs alone, as the editor writes one.
        expect(cell('A1')).toEqual({ ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'ri', it: 1 }, { v: 'ch' }] } });
        expect(cell('B1')).toEqual({ ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'in', bl: 1 }, { v: 'line' }] } });
        expect(cell('E1')).toEqual({ v: 'zero', m: 'zero', ct: { fa: 'General', t: 's' } });
        expect(cell('C1')).toEqual({ v: 'ab', m: 'ab', f: '="a"&"b"', ct: { fa: 'General', t: 's' } });
        // An index past the shared strings is no value.
        expect(cell('D1')).toBeUndefined();
    });

    test("a run without properties is in its cell's font, one with them in its own; an empty run is none", () => {
        const { cell } = read(
            `<row r="1"><c r="A1" s="${BOLD_FILLED}" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`,
            {
                strings: [
                    '<r><t>plain</t></r><r><rPr><i/></rPr><t>it</t></r><r><rPr><b/></rPr><t/></r>',
                    '<r><t/></r>',
                ],
            },
        );
        expect(cell('A1')).toEqual({
            bl: 1,
            bg: '#FFFF00',
            ct: {
                fa: 'General',
                t: 'inlineStr',
                s: [
                    { v: 'plain', bl: 1 },
                    { v: 'it', it: 1 },
                ],
            },
        });
        // Runs with no text are a string with none.
        expect(cell('B1')).toEqual({ v: '', m: '', ct: { fa: 'General', t: 's' } });
    });

    test('booleans and errors', () => {
        const { cell } = read(
            '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="e"><v>#N/A</v></c></row>',
        );
        expect(cell('A1')).toEqual({ v: true, m: 'TRUE', ct: { fa: 'General', t: 'b' } });
        expect(cell('B1')).toEqual({ v: false, m: 'FALSE', ct: { fa: 'General', t: 'b' } });
        expect(cell('C1')).toEqual({ v: '#N/A', m: '#N/A', ct: { fa: 'General', t: 's' } });
    });

    test('a number in a date format is a date serial; an ISO date cell too', () => {
        const { cell } = read(
            `<row r="1"><c r="A1" s="${DATE}"><v>45000</v></c><c r="B1" s="${CUSTOM_DATE}"><v>45000.5</v></c><c r="C1" t="d"><v>2023-03-15T12:00:00</v></c><c r="D1" t="d"><v>not a date</v></c></row>`,
        );
        expect(cell('A1')).toEqual({ v: 45000, m: '03-15-23', ht: 2, ct: { fa: 'MM-dd-yy', t: 'd' } });
        expect(cell('B1')).toEqual({ v: 45000.5, m: '2023-03-15', ht: 2, ct: { fa: 'yyyy\\-MM\\-dd', t: 'd' } });
        expect(cell('C1')).toEqual({ v: 45000.5, m: '3/15/2023', ht: 2, ct: { fa: 'General', t: 'd' } });
        expect(cell('D1')).toBeUndefined();
    });

    test("a 1904 workbook's dates move to the 1900 system; its other numbers stay", () => {
        const { cell } = read(`<row r="1"><c r="A1" s="${DATE}"><v>43538</v></c><c r="B1"><v>43538</v></c></row>`, {
            date1904: true,
        });
        expect(cell('A1')?.v).toBe(45000);
        expect(cell('A1')?.m).toBe('03-15-23');
        expect(cell('B1')?.v).toBe(43538);
    });

    test('an empty cell with no look is none; a look with a format but no value has the format alone', () => {
        const { cell, grid } = read(
            `<row r="1"><c r="A1"/><c r="B1"><v></v></c><c r="C1" s="${PERCENT_FILLED}"/></row>`,
        );
        expect(grid.celldata).toHaveLength(1);
        expect(cell('C1')).toEqual({ bg: '#FFFF00', ct: { fa: '0.00%' } });
    });
});

describe('a formula', () => {
    test('keeps its cached value, zero too, behind the =', () => {
        const { cell } = read('<row r="1"><c r="A1"><f>SUM(B1:B2)</f><v>0</v></c><c r="B1"><f>NOW()</f></c></row>');
        expect(cell('A1')).toEqual({ v: 0, m: '0', ht: 2, f: '=SUM(B1:B2)', ct: { fa: 'General', t: 'n' } });
        expect(cell('B1')).toEqual({ f: '=NOW()' });
    });

    test('on a rich string keeps the formula and its cached text, plain', () => {
        const { cell } = read(
            '<row r="1"><c r="A1" t="s"><f>B1</f><v>0</v></c><c r="B1" t="inlineStr"><f>C1</f><is><r><rPr><b/></rPr><t>in</t></r><r><t>line</t></r></is></c></row>',
            { strings: ['<r><rPr><i/></rPr><t>ri</t></r><r><t>ch</t></r>'] },
        );
        expect(cell('A1')).toEqual({ v: 'rich', m: 'rich', f: '=B1', ct: { fa: 'General', t: 's' } });
        expect(cell('B1')).toEqual({ v: 'inline', m: 'inline', f: '=C1', ct: { fa: 'General', t: 's' } });
    });

    test("a shared formula's copies shift its relative references by their offset", () => {
        const { cell } = read(
            '<row r="1"><c r="C1"><f t="shared" ref="C1:D3" si="0">A1*$B$1+B$1</f><v>1</v></c><c r="D1"><f t="shared" si="0"/><v>2</v></c></row><row r="3"><c r="C3"><f t="shared" si="0"/><v>3</v></c><c r="D3"><f t="shared" si="7"/><v>4</v></c></row>',
        );
        expect(cell('C1')?.f).toBe('=A1*$B$1+B$1');
        expect(cell('D1')?.f).toBe('=B1*$B$1+C$1');
        expect(cell('C3')?.f).toBe('=A3*$B$1+B$1');
        // A copy of a formula nothing defined keeps its value alone.
        expect(cell('D3')).toEqual({ v: 4, m: '4', ht: 2, ct: { fa: 'General', t: 'n' } });
    });

    test("an array formula sits on its anchor; a data table's cells keep their values", () => {
        const { cell } = read(
            '<row r="1"><c r="A1"><f t="array" ref="A1:A2">B1:B2*2</f><v>2</v></c><c r="B1"><f t="dataTable" ref="B1:B2" dt2D="0" dtr="0" r1="C1"/><v>5</v></c></row><row r="2"><c r="A2"><v>4</v></c></row>',
        );
        expect(cell('A1')?.f).toBe('=B1:B2*2');
        expect(cell('A2')).toEqual({ v: 4, m: '4', ht: 2, ct: { fa: 'General', t: 'n' } });
        expect(cell('B1')?.f).toBeUndefined();
        expect(cell('B1')?.v).toBe(5);
    });
});

describe('a look', () => {
    test("a cell carries its format's keys; an aligned number keeps its alignment; format 0 is none", () => {
        const { cell } = read(
            `<row r="1"><c r="A1" s="${BOLD_FILLED}" t="s"><v>0</v></c><c r="B1" s="${LEFT}"><v>3</v></c><c r="C1" s="0"><v>4</v></c></row>`,
            { strings: ['<t>x</t>'] },
        );
        expect(cell('A1')).toEqual({ v: 'x', m: 'x', bl: 1, bg: '#FFFF00', ct: { fa: 'General', t: 's' } });
        expect(cell('B1')).toEqual({ v: 3, m: '3', ht: 1, ct: { fa: 'General', t: 'n' } });
        expect(cell('C1')).toEqual({ v: 4, m: '4', ht: 2, ct: { fa: 'General', t: 'n' } });
    });

    test("a border is the sheet's, on an empty cell too", () => {
        const { grid } = read(`<row r="2"><c r="B2" s="${BORDERED}"/><c r="C2" s="${BORDERED}"><v>1</v></c></row>`);
        expect(grid.borderInfo).toEqual({
            '1_1': { b: { style: 1, color: '#000000' } },
            '1_2': { b: { style: 1, color: '#000000' } },
        });
        expect(grid.celldata.map(({ r, c }) => [r, c])).toEqual([[1, 2]]);
    });
});

describe('the grid', () => {
    test('a cell or row without its reference is the one after the previous', () => {
        const { grid } = read(
            '<row><c><v>1</v></c><c><v>2</v></c><c r="E1"><v>3</v></c><c><v>4</v></c></row><row r="4"><c><v>5</v></c></row><row><c r="B5"><v>6</v></c></row>',
        );
        expect(grid.celldata.map(({ r, c, v }) => [r, c, v?.v])).toEqual([
            [0, 0, 1],
            [0, 1, 2],
            [0, 4, 3],
            [0, 5, 4],
            [3, 0, 5],
            [4, 1, 6],
        ]);
        expect([grid.rows, grid.columns]).toEqual([5, 6]);
    });

    test('row heights as written, and hidden rows, with cells or without', () => {
        const { grid } = read(
            '<row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row><row r="3" hidden="1" ht="0"/><row r="4" hidden="true" ht="abc"><c r="A4"><v>1</v></c></row>',
        );
        expect([...grid.heights]).toEqual([[0, 30]]);
        expect(grid.rowhidden).toEqual({ 2: 0, 3: 0 });
    });

    test('a row or column past the grid has too many cells; a reference that is none is no valid file', () => {
        expect(thrown(() => read('<row r="1048577"/>'))).toMatchObject({
            status: 413,
            message: 'Spreadsheet has too many cells',
        });
        expect(thrown(() => read('<row r="1"><c r="XFE1"><v>1</v></c></row>'))).toMatchObject({ status: 413 });
        expect(thrown(() => read('<row r="1"><c r="AAAAAAAAAAAAAAAAAAAA1"><v>1</v></c></row>'))).toMatchObject({
            status: 413,
        });
        expect(read('<row r="1"><c r="XFD1"><v>1</v></c></row>').grid.columns).toBe(16_384);
        expect(thrown(() => read('<row r="0"/>'))).toMatchObject({ status: 400, message: 'Not a valid xlsx file' });
        expect(thrown(() => read('<row r="1"><c r="11"><v>1</v></c></row>'))).toMatchObject({ status: 400 });
    });

    // Its format too: the snapshot spells it per cell.
    test('charges each cell it emits with the characters it writes, a border alone too', () => {
        const { charged } = read(
            `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f>A1</f><v>12</v></c><c r="C1" s="${BORDERED}"/><c r="D1"/></row>`,
            { strings: ['<t>abc</t>'] },
        );
        expect(charged).toEqual([
            [1, 6 + 'General'.length],
            [1, 5 + 'General'.length],
            [1, 0],
        ]);
    });

    // The runs are a copy per cell: a shared string of a million runs in a few cells is millions of objects.
    test("charges a rich string's runs, each as a cell, and their text before it builds them", () => {
        const { charged } = read('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', {
            strings: ['<r><rPr><b/></rPr><t>ab</t></r><r><t>c</t></r><r><t/></r>'],
        });
        expect(charged).toEqual([
            [2, 3],
            [1, 'General'.length],
        ]);
    });

    test("charges each row's height and hidden flag it keeps, once per row", () => {
        const { charged } = read('<row r="1" hidden="1" ht="30"/><row r="1" hidden="1" ht="20"/><row r="2" ht="15"/>');
        expect(charged).toEqual([
            [1, 0],
            [1, 0],
            [1, 0],
        ]);
    });

    test('charges every copy of a shared formula with its own text', () => {
        const { charged, copied, cell } = read(
            '<row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">B1+1</f></c></row><row r="2"><c r="A2"><f t="shared" si="0"/></c></row><row r="3"><c r="A3"><f t="shared" si="0"/></c></row>',
        );
        expect(cell('A3')?.f).toBe('=B3+1');
        expect(charged).toEqual([
            [1, 5],
            [1, 5],
            [1, 5],
        ]);
        // The translation is weighed before it runs.
        expect(copied).toEqual([4, 4]);
    });

    test("Excel's future functions lose their prefixes, in a shared formula's copies too", () => {
        const { cell } = read(
            '<row r="1"><c r="A1"><f>_xlfn.IFNA(B1,0)</f><v>0</v></c><c r="B1"><f t="shared" ref="B1:B2" si="0">_xlfn._xlws.SORT(C1:C2)</f></c></row><row r="2"><c r="B2"><f t="shared" si="0"/></c></row>',
        );
        expect(cell('A1')?.f).toBe('=IFNA(B1,0)');
        expect(cell('B2')?.f).toBe('=SORT(C2:C3)');
    });

    // Excel writes neither; read as written, a value that is no finite number is text.
    test('a number that is no number is its text', () => {
        const { cell } = read(
            '<row r="1"><c r="A1"><v>abc</v></c><c r="B1"><v>INF</v></c><c r="C1"><v>1e999</v></c><c r="D1"><v>0x10</v></c><c r="E1"><v> -1.5E+3 </v></c></row>',
        );
        expect(['A1', 'B1', 'C1', 'D1'].map((ref) => cell(ref)?.v)).toEqual(['abc', 'INF', '1e999', '0x10']);
        expect(cell('A1')?.ct).toEqual({ fa: 'General', t: 's' });
        expect(cell('E1')?.v).toBe(-1500);
    });

    test("a cell naming another row than its row's is dropped, and a cell met again keeps the first", () => {
        const { grid, cell } = read(
            '<row r="1"><c r="A2"><v>1</v></c><c r="B1"><v>2</v></c><c r="B1"><v>3</v></c></row><row r="1"><c r="B1"><v>4</v></c><c r="C1"><v>5</v></c></row>',
            {
                placed: [
                    { r: 0, c: 1, v: { mc: { r: 0, c: 1, rs: 1, cs: 2 } } },
                    { r: 0, c: 2, v: { mc: { r: 0, c: 1 } } },
                ],
            },
        );
        expect(cell('A2')).toBeUndefined();
        expect(cell('B1')).toMatchObject({ v: 2, mc: { r: 0, c: 1, rs: 1, cs: 2 } });
        expect(cell('C1')).toMatchObject({ v: 5, mc: { r: 0, c: 1 } });
        expect(grid.celldata).toHaveLength(2);
    });

    // A 1 MB formula's 20 copies were a 1 MB file that translated into 2.9 GB.
    test("a shared formula past Excel's 8,192 characters is not translated: its copies keep their values", () => {
        const shared = (text: string) =>
            read(
                `<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">${text}</f><v>2</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>2</v></c></row>`,
            );
        const longest = `${'B1+'.repeat(2730)}B1`;
        expect(longest).toHaveLength(8192);
        expect(shared(longest).cell('A2')?.f).toBe(`=${'B2+'.repeat(2730)}B2`);
        const longer = shared(`${longest}0`);
        expect(longer.cell('A2')).toMatchObject({ v: 2 });
        expect(longer.cell('A2')?.f).toBeUndefined();
        expect(longer.copied).toEqual([]);
    });

    test("a placed cell takes the grid's cell there, charged for its text alone, and one the grid lacks is emitted", () => {
        const { grid, cell, charged } = read('<row r="1"><c r="A1"><v>1</v></c><c r="B1"/></row>', {
            placed: [
                { r: 0, c: 0, v: { mc: { r: 0, c: 0, rs: 1, cs: 2 } } },
                { r: 0, c: 1, v: { mc: { r: 0, c: 0 } } },
                { r: 4, c: 2, v: { hl: { r: 4, c: 2, id: 'sheet-0' } } },
            ],
        });
        expect(cell('A1')).toEqual({
            v: 1,
            m: '1',
            ht: 2,
            ct: { fa: 'General', t: 'n' },
            mc: { r: 0, c: 0, rs: 1, cs: 2 },
        });
        expect(cell('B1')).toEqual({ mc: { r: 0, c: 0 } });
        expect(cell('C5')).toEqual({ hl: { r: 4, c: 2, id: 'sheet-0' } });
        expect(grid.celldata).toHaveLength(3);
        expect([grid.rows, grid.columns]).toEqual([5, 3]);
        expect(charged).toEqual([
            [0, 1 + 'General'.length],
            [0, 0],
        ]);
    });
});
