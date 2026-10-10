import { describe, expect, test } from 'bun:test';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/sheet/engine';
import { ApiError } from '../../../lib/core/errors';
import { MAX_CELLS, MAX_MERGES, MAX_RANGE_KEYS, xlsxToSheets } from '../../../lib/import/sheets/from-xlsx';
import { build, deflated } from '../../fixtures/raw-zip';

// The bounds an untrusted xlsx meets before exceljs loads it: exceljs expands a range per cell while it loads, before
// the cell cap can count anything.

const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// One sheet holding A1; `after` follows the sheet data, `before` precedes it, `names` sits in the workbook.
function xlsx(
    sheet: { before?: string; data?: string; after?: string; names?: string },
    extra: { name: string; xml: string }[] = [],
): Buffer {
    const { before = '', data = '<row r="1"><c r="A1"><v>1</v></c></row>', after = '', names = '' } = sheet;
    return build(
        [
            {
                name: '[Content_Types].xml',
                xml: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
            },
            {
                name: '_rels/.rels',
                xml: `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
            },
            {
                name: 'xl/workbook.xml',
                xml: `<workbook xmlns="${SML}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>${names}</workbook>`,
            },
            {
                name: 'xl/_rels/workbook.xml.rels',
                xml: `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
            },
            {
                name: 'xl/worksheets/sheet1.xml',
                xml: `<worksheet xmlns="${SML}">${before}<sheetData>${data}</sheetData>${after}</worksheet>`,
            },
            ...extra,
        ].map(({ name, xml }) => deflated(name, `<?xml version="1.0" encoding="UTF-8"?>${xml}`)),
    );
}

const merges = (...refs: string[]) =>
    `<mergeCells count="${refs.length}">${refs.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`;
const validation = (sqref: string) =>
    `<dataValidations count="1"><dataValidation type="whole" operator="between" sqref="${sqref}"><formula1>1</formula1><formula2>10</formula2></dataValidation></dataValidations>`;
const definedName = (text: string) => `<definedNames><definedName name="big">${text}</definedName></definedNames>`;
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
function measuredImport(file: Buffer): { status?: number; message?: string; rssGrowth: number; cpuMs: number } {
    const script = `
        const { xlsxToSheets } = await import(process.env.READER);
        const data = Buffer.from(await Bun.stdin.arrayBuffer());
        const peak = process.resourceUsage().maxRSS * 1024;
        const cpu = process.cpuUsage();
        let result = {};
        try {
            await xlsxToSheets(data);
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
        ['a defined name over the whole grid', { names: definedName('S!$A$1:$XFD$1048576') }],
        ['a column range past the grid', { before: columns(1, 100_000_000) }],
        ['a column range starting past the grid', { before: columns(100_000_000, 1) }],
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

    test('merges are counted across the workbook', async () => {
        const refs = (count: number) => Array.from({ length: count }, (_, i) => `A${i + 1}`);
        const half = MAX_MERGES / 2;
        expect(await outcome(xlsx({ after: merges(...refs(half)) }, [unread(merges(...refs(half)))]))).toBe('imported');
        expect(await outcome(xlsx({ after: merges(...refs(half)) }, [unread(merges(...refs(half + 1)))]))).toEqual(
            TOO_LARGE,
        );
    });

    test('validated cells and named cells share one cap, every range of a sqref counted', async () => {
        const names = MAX_RANGE_KEYS / 2;
        const sqref = (extra: number) => `${row(names / 2)} B1:B${names / 2 + extra}`;
        const file = (extra: number) =>
            xlsx({}, [unread(`${validation(sqref(extra))}${definedName(`S!$A$1:$A$${names}`)}`)]);
        expect(await outcome(file(0))).toBe('imported');
        expect(await outcome(file(1))).toEqual(TOO_LARGE);
    });

    test('validated cells alone may reach the cap', async () => {
        const half = MAX_RANGE_KEYS / 2;
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
    ])('a merge spelled with %s counts', async (_name, xml) => {
        expect(await outcome(xlsx({}, [unread(xml)]))).toEqual(TOO_LARGE);
    });

    // exceljs reads a part as UTF-8 and splits a sqref on any space JavaScript knows.
    test('a validation whose ranges an em space separates counts each', async () => {
        const sqref = `A1:A2 A1:A${MAX_RANGE_KEYS + 1}`;
        expect(await outcome(xlsx({}, [unread(validation(sqref))]))).toEqual(TOO_LARGE);
    });

    // exceljs's decoder takes the capitals before the first digit as the column, past a sheet name it couldn't strip.
    test('a defined name counts with the column exceljs reads past an unquoted sheet name with a space', async () => {
        const name = definedName(`M Z!$A$1:$B$${Math.ceil(MAX_RANGE_KEYS / 9000)}`);
        expect(await outcome(xlsx({ names: name }))).toEqual(TOO_LARGE);
    });

    test.each([
        ['a quoted sheet name holding a comma', `'XYZ,XYZ'!$A$1:$A$${MAX_RANGE_KEYS + 1}`],
        ['entities', `&apos;P&amp;L&apos;!$A$1&#58;$A$${MAX_RANGE_KEYS + 1}`],
        ['a second range', `S!$A$1,S!$A$1:$A$${MAX_RANGE_KEYS + 1}`],
    ])('a defined name with %s counts', async (_name, text) => {
        expect(await outcome(xlsx({ names: definedName(text) }))).toEqual(TOO_LARGE);
    });

    // exceljs joins text around a comment; a name whose text holds markup is not counted, so it is refused.
    test('a defined name with markup in its text is 413', async () => {
        const name = definedName('S!$A$1:<!-- -->$A$2');
        expect(await outcome(xlsx({ names: name }))).toEqual(TOO_LARGE);
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
                names: definedName('S!$A$1:$L$1000').replace(
                    'name="big"',
                    'name="_xlnm._FilterDatabase" localSheetId="0" hidden="1"',
                ),
            }),
        );
        expect(sheets[0].config?.merge).toEqual({
            '0_0': { r: 0, c: 0, rs: 1, cs: 3 },
            '1_0': { r: 1, c: 0, rs: 2, cs: 1 },
        });
        expect(Object.keys(sheets[0].dataVerification ?? {}).length).toBeGreaterThan(0);
    }, 30_000);
});
