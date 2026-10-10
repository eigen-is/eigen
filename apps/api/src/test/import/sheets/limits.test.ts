import { describe, expect, test } from 'bun:test';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT, toA1 } from '@workspace/sheet/engine';
import { ApiError } from '../../../lib/core/errors';
import {
    MAX_CELLS,
    MAX_MERGES,
    MAX_ROWS,
    MAX_TEXT,
    MAX_VALIDATION_KEYS,
    xlsxToSheets,
} from '../../../lib/import/sheets/from-xlsx';
import { build, deflated } from '../../fixtures/raw-zip';

// The bounds an untrusted xlsx meets before exceljs loads it: exceljs expands a range per cell while it loads, before
// the cell cap can count anything.

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
const definedNames = (text: string) => `<definedNames>${definedName(text)}</definedNames>`;
// exceljs walks every cell of a name's range: this one has 17 billion.
const WHOLE_GRID = 'S!$A$1:$XFD$1048576';
const columns = (min: number | string, max: number | string) =>
    `<cols><col min="${min}" max="${max}" width="20" customWidth="1"/></cols>`;
// exceljs reads sheets by part name alone, so it never sees this part: the scan counts it without exceljs paying for it.
const unread = (xml: string, name = 'unread') => ({
    name: `xl/worksheets/${name}.xml`,
    xml: `<worksheet xmlns="${SML}">${xml}</worksheet>`,
});

const MB = 1024 * 1024;

// A process of its own with a deadline, so its peak RSS is the import's alone and a file exceljs expands can't hold
// the suite; a refusal reports itself.
function measuredImport(file: Buffer): {
    cells?: number[];
    status?: number;
    message?: string;
    rssGrowth: number;
    cpuMs: number;
} {
    const script = `
        const { xlsxToSheets } = await import(process.env.READER);
        const data = Buffer.from(await Bun.stdin.arrayBuffer());
        const peak = process.resourceUsage().maxRSS * 1024;
        const cpu = process.cpuUsage();
        let result = {};
        try {
            const sheets = await xlsxToSheets(data);
            result = { cells: sheets.map((sheet) => sheet.celldata.length) };
        } catch (error) {
            result = { status: error.status, message: error.message };
        }
        const used = process.cpuUsage(cpu);
        console.log(JSON.stringify({
            ...result,
            rssGrowth: process.resourceUsage().maxRSS * 1024 - peak,
            cpuMs: (used.user + used.system) / 1000,
        }));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, READER: Bun.resolveSync('../../../lib/import/sheets/from-xlsx', import.meta.dir) },
        stdin: new Uint8Array(file),
        timeout: 20_000,
    });
    expect(child.exitedDueToTimeout).toBe(false);
    expect(child.stderr.toString()).toBe('');
    return JSON.parse(child.stdout.toString());
}

async function outcome(file: Buffer): Promise<{ status: number; message: string } | 'imported'> {
    return xlsxToSheets(file).then(
        () => 'imported' as const,
        (error: unknown) => {
            if (!(error instanceof ApiError)) throw error;
            return { status: error.status, message: error.message };
        },
    );
}

const TOO_LARGE = { status: 413, message: 'Spreadsheet too large' };
const TOO_MANY_CELLS = { status: 413, message: 'Spreadsheet has too many cells' };

describe('what exceljs expands per cell is refused before it loads', () => {
    // Each is a 1.5 KB file: exceljs ran each past the Worker's 120 s deadline, at 2.3 to 9 GB and still growing.
    test.each([
        ['a validation over the whole grid', { after: validation('A1:XFD1048576') }],
        ['a merge of 26 whole columns', { after: merges('A1:Z1048576') }],
        ['a column range past the grid', { before: columns(1, 100_000_000) }],
        ['a column range starting past the grid', { before: columns(100_000_000, 1) }],
        ['a column range past the grid behind whitespace', { before: columns(1, ' \t20000000') }],
        // A missing row or column reads as 1: 1,000 whole-row pieces in 1.65 KB ran past 60 s.
        [
            'a validation of 1,000 whole rows with no column',
            { after: validation(Array(1000).fill('1:1048576').join(' ')) },
        ],
        [
            'a merge of whole rows with no column beside one of three columns',
            { after: merges('1:1048576', 'B1:D1048576') },
        ],
        // A raw tab is a space to exceljs's parser, so the sheet name it seems to end hides the whole grid.
        ['a merge whose raw tab hides the grid', { after: merges('A1\tx:XFD1048576!A1:A1') }],
    ])(
        '%s is 413 at no cost',
        (_name, sheet) => {
            const result = measuredImport(xlsx(sheet));
            expect(result).toMatchObject(TOO_LARGE);
            expect(result.rssGrowth).toBeLessThan(64 * MB);
            expect(result.cpuMs).toBeLessThan(2_000);
        },
        30_000,
    );

    // exceljs checks each merge against every earlier one: 30,000 one-row merges took 27 s.
    test('more merges than the cap are 413 at no cost', () => {
        const refs = Array.from({ length: MAX_MERGES + 1 }, (_, i) => `A${i + 1}:B${i + 1}`);
        const result = measuredImport(xlsx({ after: merges(...refs) }));
        expect(result).toMatchObject(TOO_LARGE);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // XML 1.1 reads a NEL in a value as a space too, and Excel writes 1.0 only.
    test.each([
        [
            'a validation whose ranges a NEL separates',
            { version: '1.1', after: validation('B1:B1\u0085A1:XFD1048576') },
        ],
        ['a column range whose bound a NEL starts', { version: '1.1', before: columns(1, '\u008520000000') }],
    ])(
        '%s in an XML 1.1 part is 400 at no cost',
        (_name, sheet) => {
            const result = measuredImport(xlsx(sheet));
            expect(result).toMatchObject({ status: 400, message: 'Not a valid xlsx file' });
            expect(result.rssGrowth).toBeLessThan(64 * MB);
            expect(result.cpuMs).toBeLessThan(2_000);
        },
        30_000,
    );

    // exceljs builds a model per cell before the grid they span is counted: 12M empty cells imported at 3.7 GB.
    test('more cells than the cap are 413 at no cost', () => {
        const result = measuredImport(xlsx({ data: `<row r="1">${'<c/>'.repeat(MAX_CELLS + 1)}</row>` }));
        expect(result).toMatchObject(TOO_MANY_CELLS);
        expect(result.rssGrowth).toBeLessThan(64 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // exceljs builds a model per row too: 30M empty rows in 787 KB peaked at 17.4 GB.
    test('more rows than the cap are 413 at no cost', () => {
        const result = measuredImport(xlsx({ data: '<row/>'.repeat(MAX_ROWS + 1) }));
        expect(result).toMatchObject(TOO_LARGE);
        expect(result.rssGrowth).toBeLessThan(64 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // An empty row far down passes the cell cap, and every walk to the last row took 84 s at row 1,000,000,000.
    test('a row past the grid is 413 at no cost', () => {
        const result = measuredImport(xlsx({ data: '<row r="1000000000" hidden="1"/>' }));
        expect(result).toMatchObject(TOO_MANY_CELLS);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);
});

describe('each cap', () => {
    const row = (count: number) => `A1:A${count}`;

    test('merged cells are counted against the cell cap across the workbook', async () => {
        const half = MAX_CELLS / 2;
        expect(await outcome(xlsx({}, [unread(merges(row(half))), unread(merges(`B1:B${half}`), 'other')]))).toBe(
            'imported',
        );
        expect(
            await outcome(xlsx({}, [unread(merges(row(half))), unread(merges(`B1:B${half + 1}`), 'other')])),
        ).toEqual(TOO_LARGE);
    });

    // exceljs skips what an extension holds, so these cells cost it nothing; a calculation chain's entries are no cells.
    test('cells in the sheets are counted against the cell cap before the load', async () => {
        const chain = {
            name: 'xl/calcChain.xml',
            xml: `<calcChain xmlns="${SML}">${'<c r="A1" i="1"/>'.repeat(10)}</calcChain>`,
        };
        const file = (count: number) =>
            xlsx(
                {
                    before: '<cols><col min="1" max="1"/></cols>',
                    after: `<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>A1</formula></cfRule></conditionalFormatting><extLst><ext uri="x">${'<c/>'.repeat(count)}</ext></extLst>`,
                },
                [chain],
            );
        // The sheet holds A1 too.
        expect(await outcome(file(MAX_CELLS - 1))).toBe('imported');
        expect(await outcome(file(MAX_CELLS))).toEqual(TOO_MANY_CELLS);
    }, 30_000);

    // exceljs skips what an extension holds, so these rows cost it nothing; a row break is no row.
    test('rows in the sheets are counted against their cap across the workbook before the load', async () => {
        const rows = (count: number) =>
            `<rowBreaks count="0"/><extLst><ext uri="x">${'<row/>'.repeat(count)}</ext></extLst>`;
        const half = MAX_ROWS / 2;
        // Sheet 1 holds row 1 too; exceljs reads sheet2.xml as a sheet part though no sheet names it.
        const file = (count: number) =>
            xlsx({ after: rows(half) }, [
                { name: 'xl/worksheets/sheet2.xml', xml: `<worksheet xmlns="${SML}">${rows(count)}</worksheet>` },
            ]);
        expect(await outcome(file(half - 1))).toBe('imported');
        expect(await outcome(file(half))).toEqual(TOO_LARGE);
    }, 30_000);

    test('a range missing its column counts as column A, as exceljs walks it', async () => {
        const rest = (MAX_CELLS - REFERENCE_ROW_COUNT) / 3;
        const file = (extra: number) => xlsx({}, [unread(merges(`1:${REFERENCE_ROW_COUNT}`, `B1:D${rest + extra}`))]);
        expect(await outcome(file(0))).toBe('imported');
        expect(await outcome(file(1))).toEqual(TOO_LARGE);
    });

    test('an XML 1.1 part is 400 whatever it holds', async () => {
        expect(await outcome(xlsx({ version: '1.1' }))).toEqual({ status: 400, message: 'Not a valid xlsx file' });
        expect(await outcome(xlsx({ version: '1.0' }))).toBe('imported');
    });

    test('merges are counted across the workbook', async () => {
        const refs = (count: number) => Array.from({ length: count }, (_, i) => `A${i + 1}`);
        const half = MAX_MERGES / 2;
        expect(await outcome(xlsx({ after: merges(...refs(half)) }, [unread(merges(...refs(half)))]))).toBe('imported');
        expect(await outcome(xlsx({ after: merges(...refs(half)) }, [unread(merges(...refs(half + 1)))]))).toEqual(
            TOO_LARGE,
        );
    });

    test('validated cells alone may reach the cap', async () => {
        const half = MAX_VALIDATION_KEYS / 2;
        const file = (extra: number) => xlsx({}, [unread(validation(`${row(half)} B1:B${half + extra}`))]);
        expect(await outcome(file(0))).toBe('imported');
        expect(await outcome(file(1))).toEqual(TOO_LARGE);
    });

    test('a column range may reach the last column of the grid, from either end', async () => {
        expect(await outcome(xlsx({ before: columns(1, REFERENCE_COLUMN_COUNT) }))).toBe('imported');
        expect(await outcome(xlsx({ before: columns(1, REFERENCE_COLUMN_COUNT + 1) }))).toEqual(TOO_LARGE);
        expect(await outcome(xlsx({ before: columns(REFERENCE_COLUMN_COUNT + 1, 1) }))).toEqual(TOO_LARGE);
    });

    test('a row may be the last row of the grid', async () => {
        expect(await outcome(xlsx({ data: `<row r="${REFERENCE_ROW_COUNT}" hidden="1"/>` }))).toBe('imported');
        expect(await outcome(xlsx({ data: `<row r="${REFERENCE_ROW_COUNT + 1}" hidden="1"/>` }))).toEqual(
            TOO_MANY_CELLS,
        );
    });
});

// The scan reads the markup as exceljs's parser does, so no spelling of a range hides it.
describe('what the scan reads', () => {
    const over = `A1:A${MAX_CELLS + 1}`;

    test.each([
        ['an entity in the value', '<mergeCell ref="A1&#58;A4000001"/>'],
        ['a hex entity in the value', '<mergeCell ref="A1&#x3a;A4000001"/>'],
        ['single quotes and spaces around the equals sign', `<mergeCell ref = '${over}'/>`],
        ['a line break before the attribute', `<mergeCell\nref="${over}"/>`],
        ['an attribute before it', `<mergeCell xref="A1" ref="${over}"/>`],
        ['an attribute value that looks like it', `<mergeCell x=" ref='A1'" ref="${over}"/>`],
        ['a sheet name before the range', `<mergeCell ref="S!${over}"/>`],
        ['dollar anchors', `<mergeCell ref="$A$1:$A$4000001"/>`],
        ['the ends swapped', `<mergeCell ref="A4000001:A1"/>`],
        ['a raw tab before a seeming sheet name', '<mergeCell ref="A1\tx:A4000001!A1:A1"/>'],
        ['a raw line feed before a seeming sheet name', '<mergeCell ref="A1\nx:A4000001!A1:A1"/>'],
        ['a raw carriage return before a seeming sheet name', '<mergeCell ref="A1\rx:A4000001!A1:A1"/>'],
        ['a raw tab after a `>` in another value', '<mergeCell x="a>b" ref="A1\tx:A4000001!A1:A1"/>'],
        // exceljs's decoder takes every capital before the first digit as the column: M, Z and A make column 9,465.
        ['an unquoted sheet name with a space', '<mergeCell ref="M Z!A1:B500"/>'],
    ])('a merge spelled with %s counts', async (_name, xml) => {
        expect(await outcome(xlsx({}, [unread(xml)]))).toEqual(TOO_LARGE);
    });

    // exceljs reads a part as UTF-8 and splits a sqref on any space JavaScript knows.
    test('a validation whose ranges an em space separates counts each', async () => {
        const sqref = `A1:A2 A1:A${MAX_VALIDATION_KEYS + 1}`;
        expect(await outcome(xlsx({}, [unread(validation(sqref))]))).toEqual(TOO_LARGE);
    });

    // exceljs reads only unprefixed names, and no column has such a name.
    test.each([
        ['a prefixed merge', `<x:mergeCell xmlns:x="${SML}" ref="${over}"/>`],
        ['a longer name', `<mergeCellX ref="${over}"/>`],
        ['an escaped merge', `&lt;mergeCell ref="${over}"/&gt;`],
    ])('%s is not counted', async (_name, xml) => {
        expect(await outcome(xlsx({}, [unread(`<x>${xml}</x>`)]))).toBe('imported');
    });

    test('a real workbook shape imports: column-wide validations, a filter name, whole-row columns, merges', async () => {
        const sheets = await xlsxToSheets(
            xlsx({
                before: columns(1, REFERENCE_COLUMN_COUNT),
                after: `${merges('A1:C1', 'A2:A3')}${validation('D2:D1048576')}`,
                names: `<definedNames>${definedName('S!$A$1:$L$1000', '_xlnm._FilterDatabase')}</definedNames>`,
            }),
        );
        expect(sheets[0].config?.merge).toEqual({
            '0_0': { r: 0, c: 0, rs: 1, cs: 3 },
            '1_0': { r: 1, c: 0, rs: 2, cs: 1 },
        });
        expect(Object.keys(sheets[0].dataVerification ?? {}).length).toBeGreaterThan(0);
    }, 30_000);
});

// Eigen drops defined names, so the import hides them from exceljs instead of counting what it would expand.
describe('defined names never reach exceljs', () => {
    const expand = definedName(WHOLE_GRID);
    test.each([
        [
            'names over external workbooks covering 614 million cells, as a GOV.UK workbook has',
            `<definedNames>${['Derived', 'External', 'Gross', 'Net']
                .map(
                    (name, i) =>
                        `<definedName name="${name}" localSheetId="${i}">[1]${name}!$B$9:$ES$1048576</definedName>`,
                )
                .join('')}</definedNames>`,
        ],
        ['a name over the whole grid', definedNames(WHOLE_GRID)],
        ['attributes and whitespace in both tags', `<definedNames a="1"\n>${expand}</definedNames\t>`],
        ['a default namespace declared on it', `<definedNames xmlns="${SML}">${expand}</definedNames>`],
        [
            'a prefix, which exceljs reads as another element',
            `<x:definedNames xmlns:x="${SML}">${expand}</x:definedNames>`,
        ],
        ['an end tag in a comment inside it', `<definedNames><!-- </definedNames> -->${expand}</definedNames>`],
        [
            'an end tag in CDATA inside it',
            `<definedNames>${definedName('<![CDATA[</definedNames>]]>', 'a')}${expand}</definedNames>`,
        ],
        ['an empty one before another', `<definedNames/><definedNames>${expand}</definedNames>`],
        ['one inside an element exceljs ignores', `<extLst><ext><definedNames>${expand}</definedNames></ext></extLst>`],
        ['a nested one', `<definedNames><definedNames>${expand}</definedNames>${expand}</definedNames>`],
    ])(
        '%s imports at no cost',
        (_name, names) => {
            const result = measuredImport(xlsx({ names }));
            expect(result.cells).toEqual([1]);
            expect(result.rssGrowth).toBeLessThan(64 * MB);
            expect(result.cpuMs).toBeLessThan(2_000);
        },
        30_000,
    );

    // exceljs reads a part named with a leading slash as the one without.
    test('a workbook part named with a leading slash imports at no cost', () => {
        const result = measuredImport(xlsx({ names: definedNames(WHOLE_GRID), workbookPart: '/xl/workbook.xml' }));
        expect(result.cells).toEqual([1]);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    test('a block that never closes costs nothing', () => {
        const result = measuredImport(xlsx({ names: `<definedNames>${expand}` }));
        expect(result.cells).toBeUndefined();
        expect(result.rssGrowth).toBeLessThan(64 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);
});

// What exceljs or the conversion builds per element, per sheet or per character, past what the cell grid counts.
describe('what else the import builds is refused before it costs', () => {
    const sst = (body: string) => ({ name: 'xl/sharedStrings.xml', xml: `<sst xmlns="${SML}">${body}</sst>` });
    const sharedCells = (count: number) =>
        Array.from({ length: count }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>0</v></c></row>`).join('');

    // One shared string is copied into every cell that names it: 2,000 cells of a 1 MB rich string reached 9.7 GB.
    test('text past its cap is 413 at no cost', () => {
        const text = 'a'.repeat(1_000_000);
        const cells = Math.ceil(MAX_TEXT / (2 * text.length)) + 1;
        const result = measuredImport(
            xlsx({ data: sharedCells(cells) }, [sst(`<si><r><t>${text}</t></r><r><t>b</t></r></si>`)]),
        );
        expect(result).toMatchObject(TOO_LARGE);
        expect(result.rssGrowth).toBeLessThan(256 * MB);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // Counting a row's last column walks every slot before it: 50,000 rows ending at XFD took 14.5 s.
    test('rows reaching far columns are 413 at no cost', () => {
        const rows = Array.from(
            { length: 50_000 },
            (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`,
        );
        const result = measuredImport(xlsx({ data: rows.join('') }));
        expect(result).toMatchObject(TOO_MANY_CELLS);
        expect(result.cpuMs).toBeLessThan(2_000);
    }, 30_000);

    // Each sheet entry read its part's hyperlinks again: 1,000 entries naming one 190 MB part took 140 s.
    test('sheets naming one part read it once', () => {
        const entries = Array.from({ length: 200 }, (_, i) => `<sheet name="T${i}" sheetId="${i + 2}" r:id="rId1"/>`);
        const result = measuredImport(xlsx({ entries: entries.join(''), after: `<!--${'x'.repeat(50_000_000)}-->` }));
        expect(result.cells).toEqual([1]);
        expect(result.cpuMs).toBeLessThan(5_000);
    }, 30_000);

    test('emitted text may reach its cap across the workbook', async () => {
        // A plain shared string reaches every cell as one string, its value and its display.
        const text = 'a'.repeat(1_000_000);
        const cells = MAX_TEXT / (2 * text.length);
        const half = Math.floor(cells / 2);
        const file = (more: string) =>
            xlsx({ data: sharedCells(half), sheets: [`<sheetData>${sharedCells(cells - half)}${more}</sheetData>`] }, [
                sst(`<si><t>${text}</t></si><si><t>b</t></si>`),
            ]);
        expect(await outcome(file(''))).toBe('imported');
        expect(await outcome(file(`<row r="${cells + 1}"><c r="A${cells + 1}" t="s"><v>1</v></c></row>`))).toEqual(
            TOO_LARGE,
        );
    }, 30_000);

    // A row walks every column up to its last cell, styled or not; rows without a value cost exceljs no cell.
    test('the columns rows reach may add up to the cell cap', async () => {
        const styled = (row: number, column: number) =>
            `<row r="${row}"><c r="${toA1(row - 1, column - 1)}" s="1"/></row>`;
        const file = (last: number) =>
            xlsx({
                data: `<row r="1"><c r="A1"><v>1</v></c></row>${Array.from({ length: 249 }, (_, i) => styled(i + 2, 16_000)).join('')}${styled(251, last)}`,
            });
        expect(1 + 249 * 16_000 + 15_999).toBe(MAX_CELLS);
        expect(await outcome(file(15_999))).toBe('imported');
        expect(await outcome(file(16_000))).toEqual(TOO_MANY_CELLS);
    }, 30_000);

    test('a part named by two sheets takes the name exceljs gives it, the last', async () => {
        const sheets = await xlsxToSheets(
            xlsx({
                entries: '<sheet name="B" sheetId="2" r:id="rId1"/>',
                after: '<hyperlinks><hyperlink ref="A1" location="B!A1"/></hyperlinks>',
            }),
        );
        expect(sheets.map((sheet) => sheet.name)).toEqual(['B']);
        expect(sheets[0].hyperlink).toEqual({ '0_0': { linkType: 'cellrange', linkAddress: 'B!A1' } });
    });
});
