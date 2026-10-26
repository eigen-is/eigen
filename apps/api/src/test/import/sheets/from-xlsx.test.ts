import { describe, expect, test } from 'bun:test';
import type { Cell, Sheet } from '@workspace/lib/sheets';
import { ApiError } from '../../../lib/core/errors';
import { MAX_GRID_SLOTS, MAX_SHARED_FORMULA_TEXT, MAX_TEXT, xlsxToSheets } from '../../../lib/import/sheets/from-xlsx';
import { openZip, writeZip } from '../../../lib/ooxml/zip';
import { OFFICE_COLORS, xlsxFixture } from '../../fixtures/xlsx';
import { buildDeclaredSizeBombZip } from '../../fixtures/zip-bomb';

// The reader end to end, on workbooks that each hold one family of what it reads: values, types, dates, formulas,
// looks, borders, row heights, hidden rows, the sheets, columns, merges, views, the filter, hyperlinks and the rules.

function cellsOf(sheet: Sheet): Record<string, Cell | null | undefined> {
    return Object.fromEntries((sheet.celldata ?? []).map(({ r, c, v }) => [`${r}_${c}`, v]));
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

describe('the reader', () => {
    test('values, types and formulas', () => {
        const data = [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>',
            '<row r="2"><c r="A2"><v>42</v></c><c r="B2"><v>-3.25</v></c><c r="C2"><v>1234567890123</v></c><c r="D2"><v>0.000001</v></c><c r="E2" t="b"><v>1</v></c><c r="F2" t="b"><v>0</v></c><c r="G2" t="e"><v>#DIV/0!</v></c><c r="H2" t="inlineStr"><is><t>inline</t></is></c></row>',
            '<row r="3"><c r="A3"><f>SUM(A2:B2)</f><v>38.75</v></c><c r="B3" t="str"><f>UPPER("ab")</f><v>AB</v></c><c r="C3" t="b"><f>A2&gt;1</f><v>1</v></c><c r="D3" t="e"><f>1/0</f><v>#DIV/0!</v></c><c r="E3"><f>NOW()</f></c></row>',
            '<row r="4"><c r="A4"><f t="shared" ref="A4:C6" si="0">A2*2+$A$2+A$2</f><v>1</v></c><c r="B4"><f t="shared" si="0"/><v>2</v></c><c r="C4"><f t="shared" si="0"/><v>3</v></c><c r="D4"><f t="array" ref="D4:D5">A2:A3*2</f><v>84</v></c></row>',
            '<row r="5"><c r="A5"><f t="shared" si="0"/><v>4</v></c><c r="B5"><f t="shared" si="0"/><v>5</v></c><c r="D5"><v>77.5</v></c><c r="E5"><f t="shared" ref="E5:E6" si="1">SUM($A$2:A2)</f><v>6</v></c></row>',
            '<row r="6"><c r="A6"><f t="shared" si="0"/><v>7</v></c><c r="E6"><f t="shared" si="1"/><v>8</v></c></row>',
        ].join('');
        const [sheet, hidden] = xlsxToSheets(
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
        const text = (value: string) => ({ v: value, m: value, ct: { fa: 'General', t: 's' } });
        const number = (value: number, display: string) => ({ v: value, m: display, ct: { fa: 'General', t: 'n' } });
        const cells = cellsOf(sheet);
        expect(cells).toMatchObject({
            '0_0': text('Name'),
            '0_1': text(' padded '),
            '0_2': {
                ct: {
                    fa: 'General',
                    t: 'inlineStr',
                    s: [
                        { v: 'Rich', bl: 1, fs: 11 },
                        { v: ' text', it: 1, fc: '#FF0000' },
                    ],
                },
            },
            '0_3': text('Line\r\nbreak'),
            '0_4': text('東京'),
            '1_0': number(42, '42'),
            '1_1': number(-3.25, '-3.25'),
            '1_2': number(1234567890123, '1.23457E+12'),
            '1_3': number(0.000001, '0.000001'),
            '1_4': { v: true, m: 'TRUE', ct: { t: 'b' } },
            '1_5': { v: false, m: 'FALSE', ct: { t: 'b' } },
            '1_6': text('#DIV/0!'),
            '1_7': text('inline'),
            '2_0': { ...number(38.75, '38.75'), f: '=SUM(A2:B2)' },
            '2_1': { ...text('AB'), f: '=UPPER("ab")' },
            '2_2': { v: true, f: '=A2>1' },
            '2_3': { v: '#DIV/0!', f: '=1/0' },
            // A shared formula's copies move their relative refs; an array formula sits on its anchor.
            '3_1': { v: 2, f: '=B2*2+$A$2+B$2' },
            '3_3': { v: 84, f: '=A2:A3*2' },
            '4_3': number(77.5, '77.5'),
            '5_0': { v: 7, f: '=A4*2+$A$2+A$2' },
            '5_4': { v: 8, f: '=SUM($A$2:A3)' },
        });
        expect(cells['2_4']).toEqual({ f: '=NOW()' });
        expect(cells['4_3']?.f).toBeUndefined();
        expect(hidden).toMatchObject({
            name: 'Second sheet',
            order: 1,
            hide: 1,
            celldata: [{ r: 1, c: 1, v: { v: 1 } }],
        });
        expect(sheet.hide).toBeUndefined();
    });

    test('number formats and dates', () => {
        const data = [
            '<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="2"><v>45000.5</v></c><c r="C1" s="3"><v>1234.5</v></c><c r="D1" s="4"><v>45000.75</v></c></row>',
            '<row r="2"><c r="A2" s="5"><v>0.125</v></c><c r="B2" s="6"><v>0.75</v></c><c r="C2" s="7"><v>12</v></c><c r="D2" s="10"><v>1</v></c><c r="E2" s="1"><f>A1+1</f><v>45001</v></c></row>',
        ].join('');
        const [sheet] = xlsxToSheets(
            xlsxFixture({ sheets: [{ data }], styles: STYLES, strings: STRINGS, colors: OFFICE_COLORS }),
        );
        expect(cellsOf(sheet)).toMatchObject({
            '0_0': { v: 45000, m: '03-15-23', ct: { fa: 'MM-dd-yy', t: 'd' } },
            '0_1': { v: 45000.5, m: '2023-03-15', ct: { fa: 'yyyy-MM-dd', t: 'd' } },
            '0_2': { v: 1234.5, m: '€1,234.50', ct: { fa: '"€"#,##0.00', t: 'n' } },
            '0_3': { v: 45000.75, m: '15/3/2023 18:00', ct: { fa: 'd/M/yyyy h:mm', t: 'd' } },
            '1_0': { v: 0.125, m: '12.50%', ct: { fa: '0.00%', t: 'n' } },
            '1_1': { v: 0.75, m: '18:00:00', ct: { fa: 'h:mm:ss', t: 'd' } },
            '1_2': { v: 12, m: '12', ct: { fa: '@', t: 'n' } },
            '1_3': { v: 1, m: '01/01/1900', ct: { fa: 'dd/MM/yyyy', t: 'd' } },
            '1_4': { v: 45001, m: '03-16-23', f: '=A1+1', ct: { fa: 'MM-dd-yy', t: 'd' } },
        });
    });

    test("a 1904 workbook's dates", () => {
        const data =
            '<row r="1"><c r="A1" s="1"><v>43538</v></c><c r="B1" s="10"><v>0</v></c><c r="C1"><v>43538</v></c></row>';
        const [sheet] = xlsxToSheets(
            xlsxFixture({
                sheets: [{ data }],
                styles: STYLES,
                colors: OFFICE_COLORS,
                workbookPr: '<workbookPr date1904="1"/>',
            }),
        );
        // A date's serial counts from 1900, as Eigen's do; a number that is no date stays as written.
        expect(cellsOf(sheet)).toMatchObject({
            '0_0': { v: 45000, m: '03-15-23', ct: { t: 'd' } },
            '0_1': { v: 1462, m: '01/01/1904', ct: { t: 'd' } },
            '0_2': { v: 43538, m: '43538', ct: { t: 'n' } },
        });
    });

    test('looks and borders, on cells with values and on styled cells beside them', () => {
        const data = [
            '<row r="1"><c r="A1" s="3" t="s"><v>0</v></c><c r="B1" s="4" t="s"><v>5</v></c><c r="C1" s="5"><v>0.5</v></c><c r="D1" s="8"/><c r="E1" s="9"/><c r="F1" s="11" t="s"><v>5</v></c></row>',
            '<row r="2"><c r="A2" s="0"><v>1</v></c><c r="B2" s="9" t="s"><v>2</v></c><c r="C2" s="7"><v>3</v></c><c r="E2" s="2"/></row>',
        ].join('');
        const [sheet] = xlsxToSheets(
            xlsxFixture({ sheets: [{ data }], styles: STYLES, strings: STRINGS, colors: OFFICE_COLORS }),
        );
        const cells = cellsOf(sheet);
        expect(cells).toMatchObject({
            '0_0': { bl: 1, it: 1, fs: 14, ff: 'Inter', fc: '#1F4E79', bg: '#FFFF00', v: 'Name' },
            // Accent 1, Darker 25% by ECMA-376's luminance shift: Excel's swatch rounds it to #305496.
            '0_1': { un: 1, cl: 1, fs: 20, ff: 'Source Serif 4', fc: '#2F5597', bg: '#DBDBDB', ht: 0, vt: 0, tb: '2' },
            '0_2': { fs: 9, ff: 'JetBrains Mono', fc: '#F4B183', bg: '#00B050', ht: 2, vt: 1, rt: 45, m: '50.00%' },
            '1_1': { bl: 1, it: 1, fs: 14, ct: { t: 'inlineStr' } },
            '1_2': { ht: 1, rt: 'vertical', ct: { fa: '@' } },
        });
        // A styled cell with no value keeps its look.
        expect(cells['0_3']).toEqual({ fs: 11, ff: 'Inter', fc: '#000000', bg: '#FFFF00' });
        expect(cells['1_4']).toEqual({ fs: 11, ff: 'Inter', fc: '#000000', ct: { fa: 'yyyy-MM-dd' } });
        const thinRed = { l: { style: 1, color: '#FF0000' }, r: { style: 8, color: '#4472C4' } };
        expect(sheet.config?.borderInfo).toMatchObject({
            '0_0': { ...thinRed, t: { style: 4, color: '#000000' }, b: { style: 7, color: '#000000' } },
            '0_2': { s: { style: 1, color: '#0000FF' } },
            '0_4': thinRed,
            '1_1': thinRed,
        });
    });

    test('row heights, hidden rows, and the heights of wrapped and large text', () => {
        const data = [
            '<row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row>',
            '<row r="2" ht="15"><c r="A2" s="11" t="s"><v>5</v></c></row>',
            '<row r="3" hidden="1"><c r="A3"><v>3</v></c></row>',
            '<row r="5" spans="1:2" ht="21" customHeight="1" hidden="true"><c r="B5"><v>5</v></c></row>',
            '<row r="7"><c r="A7" s="4" t="s"><v>3</v></c></row>',
        ].join('');
        const [sheet] = xlsxToSheets(
            xlsxFixture({ sheets: [{ data }], styles: STYLES, strings: STRINGS, colors: OFFICE_COLORS }),
        );
        // Custom heights in points to pixels; wrapped and large text grows its row.
        expect(sheet.config?.rowlen).toEqual({ 0: 40, 1: 1590, 4: 28, 6: 78 });
        expect(sheet.config?.rowhidden).toEqual({ 2: 0, 4: 0 });
    });

    test("a row at the sheet's own default height stores none, and the sheet keeps the default", () => {
        const data =
            '<row r="1" ht="12.75"><c r="A1"><v>1</v></c></row><row r="2" ht="15"><c r="A2"><v>2</v></c></row>';
        const [sheet] = xlsxToSheets(
            xlsxFixture({
                sheets: [{ data, before: '<sheetFormatPr defaultColWidth="10" defaultRowHeight="12.75"/>' }],
            }),
        );
        expect(sheet).toMatchObject({ defaultColWidth: 70, defaultRowHeight: 17 });
        expect(sheet.config?.rowlen).toEqual({ 1: 20 });
    });

    test('columns, frozen panes, gridlines and the filter', () => {
        const data =
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1</v></c></row><row r="2"><c r="C2" s="11" t="s"><v>5</v></c></row>';
        const sheets = (before: string, after: string) => ({ data, before, after });
        const [first, second, third] = xlsxToSheets(
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
        expect(first).toMatchObject({
            showGridLines: false,
            frozen: { type: 'rangeBoth', range: { row_focus: 1, column_focus: 0 } },
            filterRange: { row: [0, 8], column: [0, 1] },
        });
        // Calibri 11's 7 px digit: Excel draws these at 215, 28, 87 and 64 px.
        expect(first.config?.columnlen).toMatchObject({ 0: 215, 1: 28, 2: 87, 3: 87, 4: 87, 7: 64, 16383: 64 });
        expect(Object.keys(first.config?.colhidden ?? {})).toHaveLength(1 + 16384 - 7);
        expect(second).toMatchObject({
            frozen: { type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } },
            filterRange: { row: [0, 1], column: [1, 2] },
        });
        expect(second.config?.columnlen).toEqual({ 1: 280, 2: 280 });
        expect(second.config?.colhidden).toEqual({ 3: 0 });
        expect(third.frozen).toBeUndefined();
    });

    test("an Eigen export's widths count Inter's digit", () => {
        const [sheet] = xlsxToSheets(
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

    test('merges, with values, looks and borders on their cells', () => {
        const data = [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="8"/><c r="D1" s="3" t="s"><v>1</v></c><c r="E1"><v>7</v></c></row>',
            '<row r="2"><c r="A2" s="9"/><c r="B2"/><c r="E2" t="s"><v>0</v></c></row>',
            '<row r="5"><c r="F5" s="9"/></row>',
        ].join('');
        const [sheet] = xlsxToSheets(
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
        );
        expect(sheet.config?.merge).toEqual({
            '0_0': { r: 0, c: 0, rs: 2, cs: 2 },
            '0_3': { r: 0, c: 3, rs: 3, cs: 1 },
            '4_5': { r: 4, c: 5, rs: 1, cs: 3 },
            '6_0': { r: 6, c: 0, rs: 2, cs: 3 },
        });
        // Every merged cell points at its anchor, which alone keeps a value; each keeps its own look, and a merge past
        // the cells is placed too.
        const cells = cellsOf(sheet);
        expect(cells).toMatchObject({
            '0_0': { v: 'Name', mc: { r: 0, c: 0, rs: 2, cs: 2 } },
            '0_1': { bg: '#FFFF00', mc: { r: 0, c: 0 } },
            '1_0': { bl: 1, mc: { r: 0, c: 0 } },
            '0_3': { v: ' padded ', mc: { r: 0, c: 3, rs: 3, cs: 1 } },
            '4_5': { bl: 1, mc: { r: 4, c: 5, rs: 1, cs: 3 } },
        });
        expect(cells['1_4']?.v).toBe('Name');
        for (const key of ['1_1', '1_3', '2_3', '4_6', '4_7', '6_1', '7_2'])
            expect(Object.keys(cells[key] ?? {})).toEqual(['mc']);
        expect(cells['6_0']).toEqual({ mc: { r: 6, c: 0, rs: 2, cs: 3 } });
    });

    test('hyperlinks, external and to places in the workbook, on cells with values and on styled cells', () => {
        const data = [
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>0</v></c><c r="D1" s="8"/></row>',
            '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><t>to Data</t></is></c><c r="C2" t="s"><v>4</v></c></row>',
        ].join('');
        const [sheet] = xlsxToSheets(
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
        expect(sheet.hyperlink).toEqual({
            '0_0': { linkType: 'webpage', linkAddress: 'https://example.com/a?b=1&c=2' },
            '0_1': { linkType: 'webpage', linkAddress: 'mailto:someone@example.com' },
            '0_2': { linkType: 'cellrange', linkAddress: "'Second sheet'!B2" },
            '0_3': { linkType: 'cellrange', linkAddress: 'Data!A1' },
            '1_0': { linkType: 'sheet', linkAddress: 'Data' },
            '1_1': { linkType: 'sheet', linkAddress: 'Second sheet' },
        });
    });

    test('hidden sheets import hidden, and tab colours as the editor stores them', () => {
        const tab = (color: string) => `<sheetPr><tabColor ${color}/></sheetPr>`;
        const sheets = xlsxToSheets(
            xlsxFixture({
                sheets: [
                    { name: 'Red', before: tab('rgb="FFFF0000"') },
                    { name: 'Hidden', state: 'hidden', before: tab('theme="4" tint="0.39997558519241921"') },
                    { name: 'Very hidden', state: 'veryHidden', before: tab('indexed="10"') },
                ],
                colors: OFFICE_COLORS,
            }),
        );
        expect(sheets.map(({ name, hide, color }) => ({ name, hide, color }))).toEqual([
            { name: 'Red', hide: undefined, color: '#FF0000' },
            { name: 'Hidden', hide: 1, color: '#8FAADC' },
            // An indexed colour is none.
            { name: 'Very hidden', hide: 1, color: undefined },
        ]);
    });

    // Excel refuses to hide every sheet, and the editor opens on a sheet it shows.
    test('a workbook that hides every sheet shows its first', () => {
        const sheets = xlsxToSheets(
            xlsxFixture({
                sheets: [
                    { name: 'One', state: 'hidden' },
                    { name: 'Two', state: 'veryHidden' },
                ],
            }),
        );
        expect(sheets.map(({ hide }) => hide)).toEqual([undefined, 1]);
    });

    test('a workbook with no styles, theme or shared strings', () => {
        const sheets = xlsxToSheets(
            xlsxFixture({
                sheets: [
                    { data: '<row r="1"><c r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>x</t></is></c></row>' },
                    {},
                ],
            }),
        );
        expect(sheets.map(({ name, celldata }) => ({ name, celldata }))).toEqual([
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 1, m: '1', ct: { fa: 'General', t: 'n' } } },
                    { r: 0, c: 1, v: { v: 'x', m: 'x', ct: { fa: 'General', t: 's' } } },
                ],
            },
            { name: 'Sheet2', celldata: [] },
        ]);
    });
});

describe("the reader's rules", () => {
    // Every row holds A to D, so the span the clamp counts from is the same for both: rows and cells as written.
    const data = Array.from(
        { length: 10 },
        (_, r) =>
            `<row r="${r + 1}">${['A', 'B', 'C', 'D'].map((column, c) => `<c r="${column}${r + 1}"><v>${r * 4 + c}</v></c>`).join('')}</row>`,
    ).join('');
    const DXFS = `<dxfs count="4"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><font><b/><color theme="4" tint="0.4"/></font></dxf><dxf><fill><patternFill patternType="solid"><fgColor rgb="FF00B050"/><bgColor rgb="FF00B050"/></patternFill></fill></dxf><dxf><fill><patternFill patternType="none"><bgColor rgb="FFFF0000"/></patternFill></fill><font><color theme="1"/></font></dxf></dxfs>`;

    test('conditional formats of every family, their dxfs and their order', () => {
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
        const [sheet, plain] = xlsxToSheets(
            xlsxFixture({
                sheets: [{ data, after: formats }, { data }],
                styles: `<fonts><font/></fonts><fills><fill/></fills><borders><border/></borders><cellXfs><xf/></cellXfs>${DXFS}`,
                colors: OFFICE_COLORS,
            }),
        );
        // Excel's priority 1 last, as a later rule wins in the editor; an icon set, which it can't hold, is left out.
        const rules = sheet.conditionalFormatRules ?? [];
        expect(rules.map((rule): string => ('conditionName' in rule ? rule.conditionName : rule.type))).toEqual([
            ...['formula', 'dataBar', 'colorGradation', 'colorGradation', 'duplicateValue', 'duplicateValue'],
            ...['belowAverage', 'aboveAverage', 'last10_percent', 'top10'],
            ...['formula', 'formula', 'formula', 'formula', 'textContains', 'formula'],
            ...['formula', 'formula', 'greaterThan', 'between', 'lessThanOrEqual'],
        ]);
        expect(rules[0]).toEqual({
            type: 'default',
            cellrange: [{ row: [0, 9], column: [2, 2] }],
            format: { textColor: null, cellColor: null },
            conditionName: 'formula',
            conditionRange: [],
            conditionValue: ['=C1>0'],
        });
        expect(rules.slice(1, 4)).toEqual([
            { type: 'dataBar', cellrange: [{ row: [0, 9], column: [2, 2] }], format: ['#638EC6'] },
            {
                type: 'colorGradation',
                cellrange: [{ row: [0, 9], column: [2, 2] }],
                format: ['#63BE7B', '#FFEB84', '#F8696B'],
            },
            // Accent 2, Darker 25%, which Excel's swatch rounds to #C65911.
            { type: 'colorGradation', cellrange: [{ row: [0, 9], column: [2, 2] }], format: ['#C55A11', '#F8696B'] },
        ]);
        expect(rules[10]).toMatchObject({
            cellrange: [
                { row: [1, 3], column: [1, 1] },
                { row: [1, 3], column: [3, 3] },
                { row: [6, 7], column: [0, 0] },
            ],
            format: { textColor: '#000000', cellColor: null },
            conditionValue: ['=LEN(TRIM(B2))=0'],
        });
        expect(rules[8]).toMatchObject({
            format: { textColor: '#9C0006', cellColor: '#FFC7CE' },
            conditionValue: ['20'],
        });
        expect(plain.conditionalFormatRules).toBeUndefined();
    });

    test('validations of every type, their messages, overlaps and the clamp', () => {
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
        const [sheet, plain] = xlsxToSheets(
            xlsxFixture({
                sheets: [
                    { data, after: validations },
                    { name: 'Second sheet', data },
                ],
            }),
        );
        const rules = sheet.dataVerification ?? {};
        const plainRule = { value2: '', prohibitInput: false, hintShow: false, hintValue: '' };
        expect(rules).toMatchObject({
            // The later rule wins a cell two name.
            '0_4': { type: 'dropdown', value1: 'wide' },
            '1_4': { type: 'dropdown', value1: 'Yes,No' },
            '1_1': {
                type: 'dropdown',
                value1: '$D$1:$D$10',
                prohibitInput: true,
                hintShow: true,
                hintValue: 'Pick one',
            },
            '2_0': { type: 'dropdown', value1: "'Second sheet'!$A$1:$A$4" },
            '4_1': { ...plainRule, type: 'number_integer', type2: 'between', value1: '1', value2: '10' },
            '2_2': { ...plainRule, type: 'number', type2: 'moreThanThe', value1: '2.5' },
            '3_2': { ...plainRule, type: 'text_length', type2: 'lessThanOrEqualTo', value1: '5' },
            '4_2': { ...plainRule, type: 'date', type2: 'between', value1: '2024-01-01', value2: '2024-12-31' },
            '5_2': { ...plainRule, type: 'date', type2: 'noEarlierThan', value1: '2024-06-15' },
            '2_7': { type: 'dropdown', value1: 'tall' },
        });
        // A named range and a reference operand have no literal to hold; a custom formula has no editor rule.
        for (const key of ['3_0', '6_2', '7_2']) expect(rules[key]).toBeUndefined();
        // A range is clamped to the cells plus 1,000 rows and 100 columns.
        const perColumn: Record<string, number> = {};
        for (const key of Object.keys(rules)) perColumn[key.split('_')[1]] = (perColumn[key.split('_')[1]] ?? 0) + 1;
        expect(perColumn).toMatchObject({ 4: 1010, 5: 1010, 103: 1 });
        expect(perColumn['104']).toBeUndefined();
        expect(Object.keys(rules)).toHaveLength(2133);
        expect(plain.dataVerification).toBeUndefined();
    });

    test('whole sheets: rules beside merges, links and columns, a merge past the cells widening the span', () => {
        const after = [
            '<mergeCells><mergeCell ref="A1:B1"/><mergeCell ref="E12:F13"/></mergeCells>',
            '<conditionalFormatting sqref="A1:D10"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>20</formula></cfRule></conditionalFormatting>',
            '<conditionalFormatting sqref="C1:C10"><cfRule type="expression" dxfId="1" priority="2"><formula>MOD(C1,2)=0</formula></cfRule></conditionalFormatting>',
            '<dataValidations><dataValidation type="list" allowBlank="1" sqref="D1:D2000"><formula1>"a,b"</formula1></dataValidation><dataValidation type="whole" operator="between" sqref="B2:B4"><formula1>1</formula1><formula2>9</formula2></dataValidation></dataValidations>',
            '<hyperlinks><hyperlink ref="C2" location="\'Second sheet\'!A1"/></hyperlinks>',
        ].join('');
        const [sheet] = xlsxToSheets(
            xlsxFixture({
                sheets: [
                    { data, before: '<cols><col min="1" max="2" width="15" customWidth="1"/></cols>', after },
                    { name: 'Second sheet', data },
                ],
                styles: `<fonts><font/></fonts><fills><fill/></fills><borders><border/></borders><cellXfs><xf/></cellXfs>${DXFS}`,
                colors: OFFICE_COLORS,
            }),
        );
        expect(sheet.conditionalFormatRules).toMatchObject([
            { cellrange: [{ row: [0, 9], column: [2, 2] }], conditionValue: ['=MOD(C1,2)=0'] },
            { cellrange: [{ row: [0, 9], column: [0, 3] }], conditionName: 'greaterThan', conditionValue: ['20'] },
        ]);
        expect(sheet.hyperlink).toEqual({ '1_2': { linkType: 'cellrange', linkAddress: "'Second sheet'!A1" } });
        expect(sheet.config?.merge).toMatchObject({ '0_0': { rs: 1, cs: 2 }, '11_4': { rs: 2, cs: 2 } });
        expect(Object.keys(sheet.dataVerification ?? {})).toHaveLength(1013 + 3);
    });
});

describe("the reader's output budget", () => {
    const refused = (bytes: Uint8Array) => {
        try {
            xlsxToSheets(bytes);
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
            message: 'This spreadsheet is too large to import',
        });
    });

    test('the grids recalc materialises count against the cell cap, every sheet together', () => {
        const corners = (row: number, column: string) =>
            `<row r="1"><c r="A1"><v>1</v></c></row><row r="${row}"><c r="${column}${row}"><v>1</v></c></row>`;
        // 2,000 rows by 1,000 columns (ALL) is 2M cells: one such sheet fits, three don't.
        expect(xlsxToSheets(xlsxFixture({ sheets: [{ data: corners(2000, 'ALL') }] }))).toHaveLength(1);
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
        expect(refused(xlsxFixture({ sheets: [{ data }] }))).toEqual({
            status: 413,
            message: 'This spreadsheet is too large to import',
        });
    }, 30_000);

    test('every sheet counts the grid its cells span, the default grid at the least', () => {
        // A tall, narrow sheet counts its own cells, not a default sheet's width.
        const tall = '<row r="1"><c r="A1"><v>1</v></c></row><row r="160000"><c r="A160000"><v>1</v></c></row>';
        expect(xlsxToSheets(xlsxFixture({ sheets: [{ data: tall }] }))).toHaveLength(1);
        const empty = (count: number) => xlsxFixture({ sheets: Array.from({ length: count }, () => ({})) });
        expect(xlsxToSheets(empty(1_500))).toHaveLength(1_500);
        expect(refused(empty(1_600))).toEqual({ status: 413, message: 'Spreadsheet has too many cells' });
    });

    // Each sheet holding A1 and XFD1 spans 16,384 cells, and recalc builds it 100 rows deep: 1.6M slots.
    test('the grid recalc materialises, every sheet at least a default grid deep and wide, has a budget of its own', () => {
        const wide = (count: number) =>
            xlsxFixture({
                sheets: Array.from({ length: count }, () => ({
                    data: '<row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>1</v></c></row>',
                })),
            });
        const fits = Math.floor(MAX_GRID_SLOTS / (100 * 16_384));
        expect(xlsxToSheets(wide(fits))).toHaveLength(fits);
        expect(refused(wide(fits + 1))).toEqual({ status: 413, message: 'This spreadsheet is too large to import' });
    });

    // Excel refuses two sheets of one name, in any case; a formula naming it means the first.
    test('a sheet named as an earlier one is numbered as Excel numbers a copy', () => {
        const sheets = xlsxToSheets(
            xlsxFixture({
                sheets: [
                    { name: 'S', data: '<row r="1"><c r="A1"><f>s!A1+1</f><v>1</v></c></row>' },
                    { name: 's' },
                    { name: 'S (2)' },
                    { name: 'S' },
                ],
            }),
        );
        expect(sheets.map((sheet) => sheet.name)).toEqual(['S', 's (3)', 'S (2)', 'S (4)']);
        expect(sheets[0].celldata?.[0].v?.f).toBe('=s!A1+1');
    });

    // Imported, a workbook of no sheets would replace a document's with none.
    test('a workbook without a sheet it can read is no xlsx file', () => {
        const fixture = xlsxFixture({ sheets: [{ data: '<row r="1"><c r="A1"><v>1</v></c></row>' }] });
        const zip = openZip(fixture);
        const without = writeZip(
            zip
                .names()
                .filter((name) => name !== 'xl/worksheets/sheet1.xml')
                .flatMap((name) => {
                    const data = zip.read(name);
                    return data ? [{ name, data }] : [];
                }),
        );
        expect(refused(without)).toEqual({ status: 400, message: 'Not a valid xlsx file' });
        expect(refused(xlsxFixture({ sheets: [] }))).toEqual({ status: 400, message: 'Not a valid xlsx file' });
    });

    test("the zip's and the XML's refusals speak of a spreadsheet", () => {
        expect(refused(new Uint8Array(64))).toEqual({ status: 400, message: 'Not a valid xlsx file' });
        expect(refused(buildDeclaredSizeBombZip('xl/worksheets/sheet1.xml', 300 * 1024 * 1024))).toEqual({
            status: 413,
            message: 'This spreadsheet is too large to import',
        });
        expect(refused(xlsxFixture({ sheets: [{ data: '<row r="1"><c r="A1"><v>1</v></row>' }] }))).toEqual({
            status: 400,
            message: 'Not a valid xlsx file',
        });
    });
});
