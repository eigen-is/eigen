import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import { ApiError } from '../../../lib/core/errors';
import { MAX_SHARED_FORMULA_TEXT, MAX_TEXT, xlsxToSheets, xlsxToSheetsOwn } from '../../../lib/import/sheets/from-xlsx';
import { OFFICE_COLORS, xlsxFixture } from '../../fixtures/xlsx';
import { buildDeclaredSizeBombZip } from '../../fixtures/zip-bomb';

// The own reader against ExcelJS's, on workbooks that hold only what it reads so far: values, types, dates, formulas,
// looks, borders, row heights, hidden rows, the sheets, columns, merges, views, the filter and hyperlinks. Each workbook steers clear of the differences the reader
// makes on purpose (docs: the xlsx plan's difference classes), so any difference here is a regression.

// The cell order is the file's for the own reader and the row order for ExcelJS's.
function normalized(sheets: Sheet[]): Sheet[] {
    return sheets.map((sheet) => ({
        ...sheet,
        celldata: [...(sheet.celldata ?? [])].sort((a, b) => a.r - b.r || a.c - b.c),
    }));
}

async function expectSameSheets(bytes: Uint8Array, as = normalized): Promise<Sheet[]> {
    const own = as(xlsxToSheetsOwn(bytes));
    expect(own).toEqual(as(await xlsxToSheets(Buffer.from(bytes))));
    return own;
}

// ExcelJS gave a merged cell its anchor's value, which the own reader leaves to the anchor.
function withoutCopiedValues(sheets: Sheet[]): Sheet[] {
    return normalized(sheets).map((sheet) => ({
        ...sheet,
        celldata: sheet.celldata?.map(({ r, c, v }) => {
            if (!v?.mc || 'rs' in v.mc) return { r, c, v };
            const { v: _value, m: _display, ct: _type, ...rest } = v;
            return { r, c, v: rest };
        }),
    }));
}

const SHEET_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:someone@example.com" TargetMode="External"/></Relationships>`;

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

    test('columns, frozen panes, gridlines and the filter', async () => {
        const data =
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1</v></c></row><row r="2"><c r="C2" s="11" t="s"><v>5</v></c></row>';
        const sheets = (before: string, after: string) => ({ data, before, after });
        const [first, second, third] = await expectSameSheets(
            xlsxFixture({
                sheets: [
                    sheets(
                        '<sheetViews><sheetView showGridLines="0" tabSelected="1" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="C4" sqref="C4"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="30.7109375" customWidth="1"/><col min="2" max="2" width="4" hidden="1" customWidth="1"/><col min="3" max="5" width="12.5" customWidth="1"/><col min="8" max="16384" width="9.140625" hidden="1"/></cols>',
                        '<autoFilter ref="A1:B9"/>',
                    ),
                    sheets(
                        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozenSplit"/></sheetView></sheetViews><cols><col min="4" max="4" width="0" hidden="1"/><col min="2" max="3" width="40"/></cols>',
                        '<autoFilter ref="$B$1:$C$2"><filterColumn colId="0"><filters><filter val="1"/></filters></filterColumn></autoFilter>',
                    ),
                    sheets(
                        '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2400" ySplit="1200" topLeftCell="C5"/></sheetView></sheetViews>',
                        '',
                    ),
                ],
                styles: STYLES,
                strings: STRINGS,
                colors: OFFICE_COLORS,
            }),
        );
        expect(first).toMatchObject({ showGridLines: false, frozen: { type: 'rangeBoth' }, filterRange: {} });
        expect(Object.keys(first.config?.colhidden ?? {})).toHaveLength(1 + 16384 - 7);
        expect(second.config?.columnlen).toEqual({ 1: 320, 2: 320 });
        expect(third.frozen).toBeUndefined();
    });

    test("an Eigen export's widths count Inter's digit", async () => {
        const [sheet] = await expectSameSheets(
            xlsxFixture({
                sheets: [
                    {
                        data: '<row r="1"><c r="A1"><v>1</v></c></row>',
                        before: '<cols><col min="1" max="2" width="11.11"/></cols>',
                    },
                ],
                styles: '<fonts><font><sz val="10"/><name val="Inter"/></font></fonts><cellXfs><xf/></cellXfs>',
            }),
        );
        expect(sheet.config?.columnlen).toEqual({ 0: 100, 1: 100 });
    });

    test('merges, with values, looks and borders on their cells', async () => {
        const data = [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="8"/><c r="D1" s="3" t="s"><v>1</v></c><c r="E1"><v>7</v></c></row>',
            '<row r="2"><c r="A2" s="9"/><c r="B2"/><c r="E2" t="s"><v>0</v></c></row>',
            '<row r="5"><c r="F5" s="9"/></row>',
        ].join('');
        const [sheet] = await expectSameSheets(
            xlsxFixture({
                sheets: [
                    {
                        data,
                        after: '<mergeCells count="4"><mergeCell ref="A1:B2"/><mergeCell ref="D1:D3"/><mergeCell ref="F5:H5"/><mergeCell ref="A7:C8"/></mergeCells>',
                    },
                ],
                styles: STYLES,
                strings: STRINGS,
                colors: OFFICE_COLORS,
            }),
            withoutCopiedValues,
        );
        expect(Object.keys(sheet.config?.merge ?? {})).toEqual(['0_0', '0_3', '4_5', '6_0']);
    });

    test('hyperlinks, external and to places in the workbook, on cells with values and on styled cells', async () => {
        const data = [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>0</v></c><c r="D1" s="8"/></row>',
            '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><t>to Data</t></is></c><c r="C2" t="s"><v>4</v></c></row>',
        ].join('');
        const [sheet] = await expectSameSheets(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Data',
                        data,
                        after: `<hyperlinks><hyperlink ref="A1" r:id="rId1" tooltip="tip"/><hyperlink ref="B1" r:id="rId2"/><hyperlink ref="C1" location="'Second sheet'!B2" display="go"/><hyperlink ref="D1" location="Data!A1"/><hyperlink ref="A2" location="Data"/><hyperlink ref="B2:C2" location="'Second sheet'"/></hyperlinks>`,
                    },
                    { name: 'Second sheet', data: '<row r="2"><c r="B2"><v>1</v></c></row>' },
                ],
                styles: STYLES,
                strings: STRINGS,
                colors: OFFICE_COLORS,
                parts: [{ name: 'xl/worksheets/_rels/sheet1.xml.rels', data: SHEET_RELS }],
            }),
        );
        expect(Object.keys(sheet.hyperlink ?? {})).toEqual(['0_0', '0_1', '0_2', '0_3', '1_0', '1_1']);
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

    // Each copy is translated before it is weighed, at about 3M characters a second: under MAX_TEXT alone a 0.14 MB
    // zip translated for 100 s.
    test("a shared formula's copies are translated within a budget of their own", () => {
        const anchor = Array.from({ length: 1_000 }, (_, index) => `A${index + 1}`).join('+');
        const copies = Math.ceil(MAX_SHARED_FORMULA_TEXT / anchor.length) + 1;
        let data = `<row r="1"><c r="B1"><f t="shared" ref="B1:B${copies + 1}" si="0">${anchor}</f></c></row>`;
        for (let r = 2; r <= copies + 1; r++) data += `<row r="${r}"><c r="B${r}"><f t="shared" si="0"/></c></row>`;
        expect(refused(xlsxFixture({ sheets: [{ data }] }))).toEqual({ status: 413, message: 'Spreadsheet too large' });
    }, 30_000);

    test('every sheet counts the default grid recalc gives it, an empty one too', () => {
        const empty = (count: number) => xlsxFixture({ sheets: Array.from({ length: count }, () => ({})) });
        expect(xlsxToSheetsOwn(empty(1_500))).toHaveLength(1_500);
        expect(refused(empty(1_600))).toEqual({ status: 413, message: 'Spreadsheet has too many cells' });
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
