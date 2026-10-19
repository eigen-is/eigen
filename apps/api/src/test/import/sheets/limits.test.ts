import { describe, expect, test } from 'bun:test';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { MAX_CELLS, MAX_TEXT } from '../../../lib/import/sheets/from-xlsx';
import { build, deflated } from '../../fixtures/raw-zip';

// The bounds an untrusted xlsx meets. The zip refuses an archive past its caps before anything inflates; past that the
// reader parses only what it charges against the read budget (package.ts), and emits only what it charges against one
// output budget (from-xlsx.ts), so a range a file declares costs what it emits, never what it spans. Each probe is a
// hostile file, read in a process of its own so its peak and its time are the import's alone.

const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

type Part = { name: string; xml: string; version?: string };

// One sheet holding A1; `after` follows the sheet data, `before` precedes it, `names` sits in the workbook, and
// `version` is the sheet's XML version. `sheets` are the bodies of more sheets, `sheetId` the first sheet's id and
// `entries` more <sheet> entries.
function xlsx(
    sheet: {
        before?: string;
        data?: string;
        after?: string;
        names?: string;
        workbookPart?: string;
        version?: string;
        sheets?: string[];
        sheetId?: number;
        entries?: string;
    },
    extra: Part[] = [],
): Buffer {
    const {
        before = '',
        data = '<row r="1"><c r="A1"><v>1</v></c></row>',
        after = '',
        names = '',
        workbookPart = 'xl/workbook.xml',
        version = '1.0',
        sheets = [],
        sheetId = 1,
        entries = '',
    } = sheet;
    const more = sheets.map((_, i) => i + 2);
    const parts: Part[] = [
        {
            name: '[Content_Types].xml',
            xml: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        },
        {
            name: '_rels/.rels',
            xml: `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        },
        {
            name: workbookPart,
            xml: `<workbook xmlns="${SML}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="${sheetId}" r:id="rId1"/>${more.map((n) => `<sheet name="S${n}" sheetId="${n + sheetId}" r:id="rId${n}"/>`).join('')}${entries}</sheets>${names}</workbook>`,
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            xml: `<Relationships xmlns="${PACKAGE_REL}">${[1, ...more].map((n) => `<Relationship Id="rId${n}" Type="${REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('')}</Relationships>`,
        },
        {
            name: 'xl/worksheets/sheet1.xml',
            xml: `<worksheet xmlns="${SML}">${before}<sheetData>${data}</sheetData>${after}</worksheet>`,
            version,
        },
        ...sheets.map((body, i) => ({
            name: `xl/worksheets/sheet${i + 2}.xml`,
            xml: `<worksheet xmlns="${SML}">${body}</worksheet>`,
        })),
        ...extra,
    ];
    return build(
        parts.map(({ name, xml, version = '1.0' }) =>
            deflated(name, `<?xml version="${version}" encoding="UTF-8"?>${xml}`),
        ),
    );
}

const merges = (...refs: string[]) =>
    `<mergeCells count="${refs.length}">${refs.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`;
const validation = (sqref: string) =>
    `<dataValidations count="1"><dataValidation type="whole" operator="between" sqref="${sqref}"><formula1>1</formula1><formula2>10</formula2></dataValidation></dataValidations>`;
const definedName = (text: string, name = 'big') => `<definedName name="${name}">${text}</definedName>`;
const columns = (min: number | string, max: number | string) =>
    `<cols><col min="${min}" max="${max}" width="20" customWidth="1"/></cols>`;
const sst = (body: string) => ({ name: 'xl/sharedStrings.xml', xml: `<sst xmlns="${SML}">${body}</sst>` });
const rowsOf = (count: number, cell: (r: number) => string) =>
    Array.from({ length: count }, (_, i) => `<row r="${i + 1}">${cell(i + 1)}</row>`).join('');

const MB = 1024 * 1024;

type Measured = { cells?: number[]; status?: number; message?: string; rssGrowth: number; cpuMs: number };

// A process of its own with a deadline, so its peak RSS is the import's alone and a file the reader expands can't hold
// the suite; a refusal reports itself.
function measuredImport(file: Buffer): Measured {
    const script = `
        const { xlsxToSheets } = await import(process.env.READER);
        const { peakRss } = await import(process.env.PEAK_RSS);
        const data = new Uint8Array(await Bun.stdin.arrayBuffer());
        const peak = peakRss();
        const cpu = process.cpuUsage();
        let result = {};
        try {
            const sheets = xlsxToSheets(data);
            result = { cells: sheets.map((sheet) => sheet.celldata.length) };
        } catch (error) {
            result = { status: error.status, message: error.message };
        }
        const used = process.cpuUsage(cpu);
        console.log(JSON.stringify({
            ...result,
            rssGrowth: peakRss() - peak,
            cpuMs: (used.user + used.system) / 1000,
        }));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', script], {
        env: {
            ...process.env,
            READER: Bun.resolveSync('../../../lib/import/sheets/from-xlsx', import.meta.dir),
            PEAK_RSS: Bun.resolveSync('../../../lib/core/peak-rss', import.meta.dir),
        },
        stdin: new Uint8Array(file),
        timeout: 20_000,
    });
    expect(child.exitedDueToTimeout).toBe(false);
    expect(child.stderr.toString()).toBe('');
    return JSON.parse(child.stdout.toString());
}

const TOO_LARGE = { status: 413, message: 'This spreadsheet is too large to import' };
const TOO_MANY_CELLS = { status: 413, message: 'Spreadsheet has too many cells' };
const INVALID = { status: 400, message: 'Not a valid xlsx file' };

// Each was a 1.5 KB file the ExcelJS import expanded per cell, past its deadline at 2.3 to 9 GB, until a scan refused
// it before the load.
describe('a range a file declares costs what it emits', () => {
    test.each<[string, Parameters<typeof xlsx>[0], Partial<Measured>]>([
        // A validation stops a margin past the cells.
        ['a validation over the whole grid', { after: validation('A1:XFD1048576') }, { cells: [1] }],
        [
            'a validation of 1,000 whole rows',
            { after: validation(Array(1000).fill('1:1048576').join(' ')) },
            { cells: [1] },
        ],
        // A merge is charged its area before any of its cells is visited.
        ['a merge of 26 whole columns', { after: merges('A1:Z1048576') }, TOO_MANY_CELLS],
        ['whole rows and four whole columns merged', { after: merges('1:1048576', 'A1:D1048576') }, TOO_MANY_CELLS],
        ['a merge a raw tab names past the grid', { after: merges('A1\tx:XFD1048576!A1:A1') }, { cells: [1] }],
        // Merges are never checked against each other: the ExcelJS import refused more than 10,000.
        [
            '10,001 merges',
            { after: merges(...Array.from({ length: 10_001 }, (_, i) => `A${i + 1}:B${i + 1}`)) },
            { cells: [20_002] },
        ],
        // A column range stops at the grid.
        ['a column range past the grid', { before: columns(1, 100_000_000) }, { cells: [1] }],
        ['a column range starting past the grid', { before: columns(100_000_000, 1) }, { cells: [1] }],
        ['a column range past the grid behind whitespace', { before: columns(1, ' \t20000000') }, { cells: [1] }],
        // XML 1.1 reads a NEL as a space too, which ended a range for the ExcelJS import's scan; Bun reads 1.1 as 1.0.
        ['an XML 1.1 part', { version: '1.1', after: validation('B1:B1\u0085A1:XFD1048576') }, { cells: [1] }],
        ['a row past the grid', { data: '<row r="1000000000" hidden="1"/>' }, TOO_MANY_CELLS],
        ['a sheet id far past any real one', { sheetId: 4_294_967_294 }, { cells: [1] }],
        // Defined names are never read: the ExcelJS import walked every cell of a name's range.
        [
            'names over external workbooks covering 614 million cells, as a GOV.UK workbook has',
            {
                names: `<definedNames>${['Derived', 'External', 'Gross', 'Net']
                    .map((name, i) =>
                        definedName(`[1]${name}!$B$9:$ES$1048576`, name).replace('>', ` localSheetId="${i}">`),
                    )
                    .join('')}</definedNames>`,
            },
            { cells: [1] },
        ],
        [
            'a name over the whole grid',
            { names: `<definedNames>${definedName('S!$A$1:$XFD$1048576')}</definedNames>` },
            { cells: [1] },
        ],
        ['a names block that never closes', { names: `<definedNames>${definedName('S!$A$1:$XFD$1048576')}` }, INVALID],
    ])(
        '%s',
        (_name, sheet, expected) => {
            const result = measuredImport(xlsx(sheet));
            expect(result).toMatchObject(expected);
            expect(result.rssGrowth).toBeLessThan(64 * MB);
            expect(result.cpuMs).toBeLessThan(2_000);
        },
        30_000,
    );
});

describe('each cap', () => {
    test('a merge past the cell cap is too many cells before any of its cells is placed', () => {
        const result = measuredImport(xlsx({ after: merges(`A1:D${MAX_CELLS / 4 + 1}`) }));
        expect(result).toMatchObject(TOO_MANY_CELLS);
        expect(result.rssGrowth).toBeLessThan(64 * MB);
    }, 30_000);

    test('a column range may reach the last column of the grid', () => {
        expect(measuredImport(xlsx({ before: columns(1, REFERENCE_COLUMN_COUNT) }))).toMatchObject({ cells: [1] });
    }, 30_000);

    test('a row may be the last row of the grid, and one past it is too many cells', () => {
        expect(measuredImport(xlsx({ data: `<row r="${REFERENCE_ROW_COUNT}" hidden="1"/>` }))).toMatchObject({
            cells: [0],
        });
        expect(measuredImport(xlsx({ data: `<row r="${REFERENCE_ROW_COUNT + 1}" hidden="1"/>` }))).toMatchObject(
            TOO_MANY_CELLS,
        );
    }, 30_000);

    // A row without its number is the one after the last: a run of empty rows reaches past the grid.
    test('a run of empty rows past the grid is too many cells', () => {
        const result = measuredImport(xlsx({ data: '<row/>'.repeat(REFERENCE_ROW_COUNT + 1) }));
        expect(result).toMatchObject(TOO_MANY_CELLS);
        expect(result.rssGrowth).toBeLessThan(512 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // Only what a row emits is read, never the row numbers before it: the ExcelJS import walked 103 s through 500
    // sheets that each hid their last row.
    test('sheets that each hide their last row cost what they emit', () => {
        const last = '<row r="1048576" hidden="1"/>';
        const result = measuredImport(xlsx({ data: last, sheets: Array(499).fill(`<sheetData>${last}</sheetData>`) }));
        expect(result.cells).toHaveLength(500);
        expect(result.rssGrowth).toBeLessThan(64 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // Counting a row's last column walked every slot before it: 50,000 rows ending at XFD took 14.5 s.
    test('rows reaching far columns are too many cells at no cost', () => {
        const rows = (column: string) => xlsx({ data: rowsOf(50_000, (r) => `<c r="${column}${r}"><v>1</v></c>`) });
        const result = measuredImport(rows('XFD'));
        expect(result).toMatchObject(TOO_MANY_CELLS);
        // Against the same rows at A, so a machine's speed cancels out.
        expect(result.cpuMs / measuredImport(rows('A')).cpuMs).toBeLessThan(3);
    }, 30_000);

    // One shared string is copied into every cell that names it: 2,000 cells of a 1 MB rich string reached 9.7 GB.
    test('text past its cap is too large at no cost', () => {
        const text = 'a'.repeat(1_000_000);
        // A rich cell holds its text once, in its runs.
        const cells = Math.ceil(MAX_TEXT / text.length) + 1;
        const result = measuredImport(
            xlsx({ data: rowsOf(cells, (r) => `<c r="A${r}" t="s"><v>0</v></c>`) }, [
                sst(`<si><r><t>${text}</t></r><r><t>b</t></r></si>`),
            ]),
        );
        expect(result).toMatchObject(TOO_LARGE);
        expect(result.rssGrowth).toBeLessThan(256 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // A rich string's runs are a copy per cell: 300,000 runs in 20 cells would be 6 million objects.
    test("a rich string's runs count as cells", () => {
        const result = measuredImport(
            xlsx({ data: rowsOf(20, (r) => `<c r="A${r}" t="s"><v>0</v></c>`) }, [
                sst(`<si>${'<r><t>a</t></r>'.repeat(300_000)}</si>`),
            ]),
        );
        expect(result).toMatchObject(TOO_MANY_CELLS);
        expect(result.rssGrowth).toBeLessThan(1024 * MB);
        expect(result.cpuMs).toBeLessThan(5_000);
    }, 30_000);

    test('emitted text may reach its cap across the workbook', () => {
        // A plain shared string reaches every cell as one string, its value and its display, beside its format.
        const cells = 128;
        const text = 'a'.repeat((MAX_TEXT / cells - 'General'.length) / 2);
        const half = Math.floor(cells / 2);
        const shared = (count: number) => rowsOf(count, (r) => `<c r="A${r}" t="s"><v>0</v></c>`);
        const file = (more: string) =>
            xlsx({ data: shared(half), sheets: [`<sheetData>${shared(cells - half)}${more}</sheetData>`] }, [
                sst(`<si><t>${text}</t></si><si><t>b</t></si>`),
            ]);
        expect(measuredImport(file(''))).toMatchObject({ cells: [half, cells - half] });
        expect(
            measuredImport(file(`<row r="${cells + 1}"><c r="A${cells + 1}" t="s"><v>1</v></c></row>`)),
        ).toMatchObject(TOO_LARGE);
    }, 30_000);

    // A validation's prompt reaches every cell it keys: a 1 MB prompt over the clamp's 100,000 cells.
    test("a validation's prompt counts once per cell it keys", () => {
        const prompt = `<dataValidations count="1"><dataValidation type="whole" operator="greaterThan" showInputMessage="1" prompt="${'a'.repeat(1_000_000)}" sqref="A1:CV1001"><formula1>1</formula1></dataValidation></dataValidations>`;
        const result = measuredImport(xlsx({ after: prompt }));
        expect(result).toMatchObject(TOO_LARGE);
        expect(result.rssGrowth).toBeLessThan(64 * MB);
    }, 30_000);
});

// A scan that backtracks per start position is quadratic in a run of one character: a million of them in a 1 KB file.
describe('text the import reads', () => {
    test('a merge reads a million spaces before its end in linear time', () => {
        const merge = `<mergeCells count="1"><mergeCell ref="A1:B1"${' '.repeat(1_000_000)}/></mergeCells>`;
        const result = measuredImport(xlsx({ after: merge }));
        // The merge's second cell is one too.
        expect(result).toMatchObject({ cells: [2] });
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    test('a conditional format reads a million digits before no number in linear time', () => {
        const rule = `<conditionalFormatting sqref="A1"><cfRule type="cellIs" priority="1" operator="equal"><formula>${'1'.repeat(1_000_000)}x</formula></cfRule></conditionalFormatting>`;
        const result = measuredImport(xlsx({ after: rule }));
        expect(result).toMatchObject({ cells: [1] });
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // Each sheet entry read its part's hyperlinks again: 1,000 entries naming one 190 MB part took 140 s.
    test('sheets naming one part read it once', () => {
        const entries = Array.from({ length: 200 }, (_, i) => `<sheet name="T${i}" sheetId="${i + 2}" r:id="rId1"/>`);
        const result = measuredImport(xlsx({ entries: entries.join(''), after: `<!--${'x'.repeat(30_000_000)}-->` }));
        expect(result.cells).toEqual([1]);
        expect(result.cpuMs).toBeLessThan(5_000);
    }, 30_000);
});

// Each a file of about 1 MB that the reader parsed for 10 to 120 s, or into gigabytes, emitting little or nothing: what
// it parses is charged before it is parsed.
describe('what a file holds costs its parse', () => {
    test('a grid of more empty cells and rows than the element budget is too large before any is parsed', () => {
        const result = measuredImport(xlsx({ data: rowsOf(1_601, () => '<c/>'.repeat(10_000)) }));
        expect(result).toMatchObject(TOO_LARGE);
        expect(result.rssGrowth).toBeLessThan(512 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    test('a row or a shared string longer than a batch may be is too large', () => {
        const runs = '<r><t>a</t></r>'.repeat(1_000_000);
        for (const file of [
            xlsx({ data: `<row r="1"><c r="A1" t="inlineStr"><is>${runs}</is></c></row>` }),
            xlsx({}, [sst(`<si>${runs}</si>`)]),
        ]) {
            const result = measuredImport(file);
            expect(result).toMatchObject(TOO_LARGE);
            expect(result.rssGrowth).toBeLessThan(512 * MB);
        }
    }, 30_000);

    test('a part past its grid of more bytes or tags than a whole parse may hold is too large before it is parsed', () => {
        for (const after of [
            validation(Array(3_300_000).fill('XFD1048576').join(' ')),
            `<rowBreaks>${'<brk/>'.repeat(1_600_000)}</rowBreaks>`,
        ]) {
            const result = measuredImport(xlsx({ after }));
            expect(result).toMatchObject(TOO_LARGE);
            expect(result.rssGrowth).toBeLessThan(256 * MB);
            expect(result.cpuMs).toBeLessThan(2_000);
        }
    }, 30_000);

    test('a 1 MB number format on 1,000 cells shows them as General', () => {
        const styles = {
            name: 'xl/styles.xml',
            xml: `<styleSheet xmlns="${SML}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0;m${'0'.repeat(1_000_000)}"/></numFmts><cellXfs count="2"><xf/><xf numFmtId="164"/></cellXfs></styleSheet>`,
        };
        const result = measuredImport(
            xlsx({ data: rowsOf(1_000, (r) => `<c r="A${r}" s="1"><v>1</v></c>`) }, [styles]),
        );
        expect(result).toMatchObject({ cells: [1_000] });
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);
});
