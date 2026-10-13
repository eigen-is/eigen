import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import { ApiError } from '../../../lib/core/errors';
import { readGrid } from '../../../lib/import/sheets/cells';
import { MAX_TEXT, xlsxToSheets, xlsxToSheetsOwn } from '../../../lib/import/sheets/from-xlsx';
import { readPackage } from '../../../lib/import/sheets/package';
import { readRules } from '../../../lib/import/sheets/rules';
import { readSharedStrings } from '../../../lib/import/sheets/strings';
import { readDxfs, readLooks, themePalette } from '../../../lib/import/sheets/styles';
import { OFFICE_COLORS, xlsxFixture } from '../../fixtures/xlsx';
import { buildDeclaredSizeBombZip } from '../../fixtures/zip-bomb';

// The own reader against ExcelJS's, on workbooks that hold only what it reads so far: values, types, dates, formulas,
// looks, borders, row heights, hidden rows and the sheets. Each workbook steers clear of the differences the reader
// makes on purpose (docs: the xlsx plan's difference classes), so any difference here is a regression.

// The cell order is the file's for the own reader and the row order for ExcelJS's.
function normalized(sheets: Sheet[]): Sheet[] {
    return sheets.map((sheet) => ({
        ...sheet,
        celldata: [...(sheet.celldata ?? [])].sort((a, b) => a.r - b.r || a.c - b.c),
    }));
}

async function expectSameSheets(bytes: Uint8Array): Promise<Sheet[]> {
    const own = normalized(xlsxToSheetsOwn(bytes));
    expect(own).toEqual(normalized(await xlsxToSheets(Buffer.from(bytes))));
    return own;
}

const STYLES = `<numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="&quot;€&quot;#,##0.00"/><numFmt numFmtId="166" formatCode="d/m/yyyy h:mm"/><numFmt numFmtId="167" formatCode="dd/mm/yyyy"/></numFmts>
<fonts><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><i/><sz val="14"/><color rgb="FF1F4E79"/><name val="Arial"/></font><font><u/><strike/><sz val="20"/><color theme="4" tint="-0.249977111117893"/><name val="Times New Roman"/></font><font><sz val="9"/><color theme="5" tint="0.39997558519241921"/><name val="Courier New"/></font></fonts>
<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor theme="6" tint="0.59999389629810485"/></patternFill></fill><fill><patternFill patternType="darkGrid"><fgColor rgb="FF00B050"/></patternFill></fill></fills>
<borders><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFFF0000"/></left><right style="medium"><color theme="4"/></right><top style="dashed"/><bottom style="double"><color auto="1"/></bottom><diagonal/></border><border diagonalDown="1"><diagonal style="thin"><color rgb="FF0000FF"/></diagonal></border></borders>
<cellXfs>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="165" fontId="1" fillId="2" borderId="1"/>
<xf numFmtId="166" fontId="2" fillId="3" borderId="0"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="10" fontId="3" fillId="4" borderId="2"><alignment horizontal="right" vertical="top" textRotation="45"/></xf>
<xf numFmtId="21" fontId="0" fillId="0" borderId="0"><alignment horizontal="general" textRotation="135"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0"><alignment horizontal="left" textRotation="255"/></xf>
<xf numFmtId="0" fontId="0" fillId="2" borderId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0"><alignment wrapText="1"/></xf>
</cellXfs>`;

const STRINGS = [
    '<t>Name</t>',
    '<t xml:space="preserve"> padded </t>',
    '<r><rPr><b/><sz val="11"/></rPr><t>Rich</t></r><r><rPr><i/><color rgb="FFFF0000"/></rPr><t xml:space="preserve"> text</t></r>',
    '<t>Line_x000D_\nbreak</t>',
    '<t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh>',
    `<t>${'A long wrapped sentence that needs several lines at the default column width. '.repeat(3)}</t>`,
];

describe("the own reader against ExcelJS's", () => {
    test('values, types and formulas', async () => {
        const data = [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>',
            '<row r="2"><c r="A2"><v>42</v></c><c r="B2"><v>-3.25</v></c><c r="C2"><v>1234567890123</v></c><c r="D2"><v>0.000001</v></c><c r="E2" t="b"><v>1</v></c><c r="F2" t="b"><v>0</v></c><c r="G2" t="e"><v>#DIV/0!</v></c><c r="H2" t="inlineStr"><is><t>inline</t></is></c></row>',
            '<row r="3"><c r="A3"><f>SUM(A2:B2)</f><v>38.75</v></c><c r="B3" t="str"><f>UPPER("ab")</f><v>AB</v></c><c r="C3" t="b"><f>A2&gt;1</f><v>1</v></c><c r="D3" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="E3"><f>NOW()</f></c></row>',
            '<row r="4"><c r="A4"><f t="shared" ref="A4:C6" si="0">A2*2+$A$2+A$2</f><v>1</v></c><c r="B4"><f t="shared" si="0"/><v>2</v></c><c r="C4"><f t="shared" si="0"/><v>3</v></c><c r="D4"><f t="array" ref="D4:D5">A2:A3*2</f><v>84</v></c></row>',
            '<row r="5"><c r="A5"><f t="shared" si="0"/><v>4</v></c><c r="B5"><f t="shared" si="0"/><v>5</v></c><c r="D5"><v>77.5</v></c><c r="E5"><f t="shared" ref="E5:E6" si="1">SUM($A$2:A2)</f><v>6</v></c></row>',
            '<row r="6"><c r="A6"><f t="shared" si="0"/><v>7</v></c><c r="E6"><f t="shared" si="1"/><v>8</v></c></row>',
        ].join('');
        await expectSameSheets(
            xlsxFixture({
                sheets: [
                    { name: 'Data', data },
                    { name: 'Second sheet', state: 'hidden', data: '<row r="2"><c r="B2"><v>1</v></c></row>' },
                ],
                styles: STYLES,
                strings: STRINGS,
                colors: OFFICE_COLORS,
            }),
        );
    });

    test('number formats and dates', async () => {
        const data = [
            '<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45000.5</v></c><c r="C1" s="3"><v>1234.5</v></c><c r="D1" s="4"><v>45000.75</v></c></row>',
            '<row r="2"><c r="A2" s="5"><v>0.125</v></c><c r="B2" s="6"><v>0.75</v></c><c r="C2" s="7"><v>12</v></c><c r="D2" s="10"><v>1</v></c><c r="E2" s="1"><f>A1+1</f><v>45001</v></c></row>',
        ].join('');
        const own = await expectSameSheets(
            xlsxFixture({ sheets: [{ data }], styles: STYLES, strings: STRINGS, colors: OFFICE_COLORS }),
        );
        expect(own[0].celldata?.[0]?.v).toMatchObject({ v: 45000, m: '03-15-23', ct: { fa: 'MM-dd-yy', t: 'd' } });
    });

    test("a 1904 workbook's dates", async () => {
        const data =
            '<row r="1"><c r="A1" s="1"><v>43538</v></c><c r="B1" s="10"><v>0</v></c><c r="C1"><v>43538</v></c></row>';
        await expectSameSheets(
            xlsxFixture({
                sheets: [{ data }],
                styles: STYLES,
                colors: OFFICE_COLORS,
                workbookPr: '<workbookPr date1904="1"/>',
            }),
        );
    });

    test('looks and borders, on cells with values and on styled cells beside them', async () => {
        const data = [
            '<row r="1"><c r="A1" s="3" t="s"><v>0</v></c><c r="B1" s="4" t="s"><v>5</v></c><c r="C1" s="5"><v>0.5</v></c><c r="D1" s="8"/><c r="E1" s="9"/><c r="F1" s="11" t="s"><v>5</v></c></row>',
            '<row r="2"><c r="A2" s="0"><v>1</v></c><c r="B2" s="9" t="s"><v>2</v></c><c r="C2" s="7"><v>3</v></c><c r="E2" s="2"/></row>',
        ].join('');
        await expectSameSheets(
            xlsxFixture({ sheets: [{ data }], styles: STYLES, strings: STRINGS, colors: OFFICE_COLORS }),
        );
    });

    test('row heights, hidden rows, and the heights of wrapped and large text', async () => {
        const data = [
            '<row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row>',
            '<row r="2" ht="15.75"><c r="A2" s="11" t="s"><v>5</v></c></row>',
            '<row r="3" hidden="1"><c r="A3"><v>3</v></c></row>',
            '<row r="5" spans="1:2" ht="21" customHeight="1" hidden="true"><c r="B5"><v>5</v></c></row>',
            '<row r="7"><c r="A7" s="4" t="s"><v>3</v></c></row>',
        ].join('');
        const own = await expectSameSheets(
            xlsxFixture({ sheets: [{ data }], styles: STYLES, strings: STRINGS, colors: OFFICE_COLORS }),
        );
        expect(own[0].config?.rowlen?.['0']).toBe(40);
        expect(own[0].config?.rowhidden).toEqual({ 2: 0, 4: 0 });
    });

    test('a workbook with no styles, theme or shared strings', async () => {
        await expectSameSheets(
            xlsxFixture({
                sheets: [
                    { data: '<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c></row>' },
                    {},
                ],
            }),
        );
    });
});

describe("the own reader's rules against ExcelJS's", () => {
    // Until the assembly reads them: each sheet's conditional formats and validations, from its grid's rest and span.
    function ownRules(bytes: Uint8Array): Pick<Sheet, 'conditionalFormatRules' | 'dataVerification'>[] {
        const book = readPackage(bytes);
        const palette = themePalette(book.theme);
        const looks = readLooks(book.styles, palette);
        const dxfs = readDxfs(book.styles, palette);
        const strings = readSharedStrings(book.sharedStrings, palette);
        return book.sheets.map(({ path }) => {
            const part = book.pkg.zip.read(path);
            if (!part) throw new Error(`no part ${path}`);
            const grid = readGrid(part, { looks, strings, date1904: book.date1904, palette, charge: () => {} });
            const { rows, columns } = grid;
            return readRules(grid.rest, { dxfs, palette, date1904: book.date1904, rows, columns, charge: () => {} });
        });
    }

    async function expectSameRules(bytes: Uint8Array): Promise<void> {
        const theirs = (await xlsxToSheets(Buffer.from(bytes))).map(({ conditionalFormatRules, dataVerification }) => ({
            conditionalFormatRules,
            dataVerification,
        }));
        expect(ownRules(bytes)).toEqual(theirs);
    }

    // Every row holds A to D, so the span the clamp counts from is the same for both: rows and cells as written.
    const data = Array.from(
        { length: 10 },
        (_, r) =>
            `<row r="${r + 1}">${['A', 'B', 'C', 'D'].map((column, c) => `<c r="${column}${r + 1}"><v>${r * 4 + c}</v></c>`).join('')}</row>`,
    ).join('');
    const DXFS = `<dxfs count="4"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><font><b/><color theme="4" tint="0.4"/></font></dxf><dxf><fill><patternFill patternType="solid"><fgColor rgb="FF00B050"/><bgColor rgb="FF00B050"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="none"><bgColor rgb="FFFF0000"/></patternFill></fill><font><color theme="1"/></font></dxf></dxfs>`;

    test('conditional formats of every family, their dxfs and their order', async () => {
        const rule = (attributes: string, inner = '') => `<cfRule ${attributes}>${inner}</cfRule>`;
        const formula = (...texts: string[]) => texts.map((text) => `<formula>${text}</formula>`).join('');
        const formats = [
            `<conditionalFormatting sqref="A1:A10">${[
                rule('type="cellIs" dxfId="0" priority="3" operator="greaterThan"', formula('10')),
                rule('type="cellIs" dxfId="1" priority="1" operator="lessThanOrEqual"', formula('"5%"')),
                rule('type="cellIs" dxfId="2" priority="2" operator="between"', formula('2', '"x"')),
                rule('type="cellIs" dxfId="3" priority="4" operator="notEqual"', formula('$B$1')),
                rule('type="cellIs" dxfId="0" priority="5" operator="notBetween"', formula('$B$1', 'C2*2')),
            ].join('')}</conditionalFormatting>`,
            `<conditionalFormatting sqref="B2:B4 D2:D4 A7:A8">${[
                rule('type="expression" dxfId="1" priority="6"', formula('SUM(B2:$C$3)&gt;2')),
                rule(
                    'type="containsText" dxfId="0" priority="7" operator="containsText" text="ab"',
                    formula('NOT(ISERROR(SEARCH("ab",B2)))'),
                ),
                rule(
                    'type="notContainsText" dxfId="2" priority="8" operator="notContains" text="z"',
                    formula('ISERROR(SEARCH("z",B2))'),
                ),
                rule(
                    'type="beginsWith" dxfId="2" priority="9" operator="beginsWith" text="a"',
                    formula('LEFT(B2,LEN("a"))="a"'),
                ),
                rule('type="timePeriod" dxfId="3" priority="10" timePeriod="today"', formula('FLOOR(B2,1)=TODAY()')),
                rule('type="containsBlanks" dxfId="3" priority="11"', formula('LEN(TRIM(B2))=0')),
            ].join('')}</conditionalFormatting>`,
            `<conditionalFormatting sqref="C1:C10">${[
                rule('type="top10" dxfId="0" priority="12" rank="3"'),
                rule('type="top10" dxfId="0" priority="13" percent="1" bottom="1" rank="20"'),
                rule('type="aboveAverage" dxfId="1" priority="14"'),
                rule('type="aboveAverage" dxfId="1" priority="15" aboveAverage="0"'),
                rule('type="duplicateValues" dxfId="2" priority="16"'),
                rule('type="uniqueValues" dxfId="2" priority="17"'),
                rule(
                    'type="colorScale" priority="18"',
                    '<colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFF8696B"/><color theme="5" tint="-0.25"/></colorScale>',
                ),
                rule(
                    'type="colorScale" priority="19"',
                    '<colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale>',
                ),
                rule(
                    'type="dataBar" priority="20"',
                    '<dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar>',
                ),
                rule(
                    'type="iconSet" priority="21"',
                    '<iconSet iconSet="3Arrows"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet>',
                ),
                rule('type="expression" dxfId="9" priority="22"', formula('C1&gt;0')),
            ].join('')}</conditionalFormatting>`,
        ].join('');
        await expectSameRules(
            xlsxFixture({
                sheets: [{ data, after: formats }, { data }],
                styles: `<fonts><font/></fonts><fills><fill/></fills><borders><border/></borders><cellXfs><xf/></cellXfs>${DXFS}`,
                colors: OFFICE_COLORS,
            }),
        );
    });

    test('validations of every type, their messages, overlaps and the clamp', async () => {
        const validation = (attributes: string, ...formulas: string[]) =>
            `<dataValidation ${attributes}>${formulas.map((text, index) => `<formula${index + 1}>${text}</formula${index + 1}>`).join('')}</dataValidation>`;
        const validations = `<dataValidations>${[
            validation('type="list" allowBlank="1" sqref="E1:E2000"', '"Yes,No"'),
            validation(
                'type="list" allowBlank="1" showInputMessage="1" prompt="Pick one" showErrorMessage="1" sqref="A1:B2"',
                '$D$1:$D$10',
            ),
            validation('type="list" sqref="A3"', "'Second sheet'!$A$1:$A$4"),
            validation('type="list" sqref="A4"', 'NamedRange'),
            validation('type="whole" sqref="B3:B5" showErrorMessage="1" errorStyle="warning"', '1', '10'),
            validation('type="decimal" operator="greaterThan" sqref="C3"', '2.5'),
            validation('type="textLength" operator="lessThanOrEqual" sqref="C4"', '5'),
            validation('type="date" sqref="C5"', '45292', '45657'),
            validation('type="date" operator="greaterThanOrEqual" sqref="C6"', '45458'),
            validation('type="whole" operator="greaterThan" sqref="C7"', '$B$1'),
            validation('type="custom" sqref="C8"', 'C8&gt;0'),
            validation('type="list" sqref="A1:XFD1"', '"wide"'),
            validation('type="list" sqref="F1:F1048576 H3"', '"tall"'),
        ].join('')}</dataValidations>`;
        await expectSameRules(
            xlsxFixture({
                sheets: [
                    { data, after: validations },
                    { name: 'Second sheet', data },
                ],
            }),
        );
    });
});

describe("the own reader's output budget", () => {
    const refused = (bytes: Uint8Array) => {
        try {
            xlsxToSheetsOwn(bytes);
        } catch (error) {
            if (error instanceof ApiError) return { status: error.status, message: error.message };
            throw error;
        }
        throw new Error('expected a refusal');
    };

    test('a shared string counts once per cell that shows it', () => {
        const length = 1_000_000;
        const cells = Math.ceil(MAX_TEXT / (2 * length)) + 1;
        const data = Array.from(
            { length: cells },
            (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="s"><v>0</v></c></row>`,
        ).join('');
        expect(refused(xlsxFixture({ sheets: [{ data }], strings: [`<t>${'x'.repeat(length)}</t>`] }))).toEqual({
            status: 413,
            message: 'Spreadsheet too large',
        });
    });

    test('the grids recalc materialises count against the cell cap, every sheet together', () => {
        const corners = (row: number, column: string) =>
            `<row r="1"><c r="A1"><v>1</v></c></row><row r="${row}"><c r="${column}${row}"><v>1</v></c></row>`;
        // 2,000 rows by 1,000 columns (ALL) is 2M cells: one such sheet fits, three don't.
        expect(xlsxToSheetsOwn(xlsxFixture({ sheets: [{ data: corners(2000, 'ALL') }] }))).toHaveLength(1);
        expect(refused(xlsxFixture({ sheets: [1, 2, 3].map(() => ({ data: corners(2000, 'ALL') })) }))).toEqual({
            status: 413,
            message: 'Spreadsheet has too many cells',
        });
    });

    test("the zip's and the XML's refusals speak of a spreadsheet", () => {
        expect(refused(new Uint8Array(64))).toEqual({ status: 400, message: 'Not a valid xlsx file' });
        expect(refused(buildDeclaredSizeBombZip('xl/worksheets/sheet1.xml', 300 * 1024 * 1024))).toEqual({
            status: 413,
            message: 'Spreadsheet too large',
        });
        expect(refused(xlsxFixture({ sheets: [{ data: '<row r="1"><c r="A1"><v>1</v></row>' }] }))).toEqual({
            status: 400,
            message: 'Not a valid xlsx file',
        });
    });
});
