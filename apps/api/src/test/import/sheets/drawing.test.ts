import { describe, expect, test } from 'bun:test';
import { CHART_MAX_SIDE, parseChartSpec } from '@workspace/lib/charts';
import {
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
    type Sheet,
} from '@workspace/lib/sheets';
import { CHART_CONTENT_TYPE } from '../../../lib/core/ooxml-chart';
import type { TransformWarning } from '../../../lib/document/transform/protocol';
import { CHART_SHEET_SIZE } from '../../../lib/import/sheets/drawing';
import { xlsxToSheets } from '../../../lib/import/sheets/from-xlsx';
import { MAX_XLSX_ELEMENTS } from '../../../lib/import/sheets/package';
import { type FixtureSheet, OFFICE_COLORS, xlsxFixture } from '../../fixtures/xlsx';

// A sheet's drawing: each chart anchored on a worksheet a SheetChart over the cells Excel draws it over, its refs by
// sheet id or its caches inline, and a chart sheet a tab of its own holding its chart.

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const PX = 9525;

const rels = (...items: [id: string, type: string, target: string][]) =>
    `<Relationships xmlns="${PACKAGE_RELS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`).join('')}</Relationships>`;

const pts = (values: readonly (string | number)[]) =>
    `<c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join('')}`;

// A series over `sheet`'s A2:A4 and B1:B4, its caches beside them; `values` replaces the values formula.
function ser(sheet: string, values = `${sheet}!$B$2:$B$4`): string {
    return `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${sheet}!$B$1</c:f><c:strCache>${pts(['Sales'])}</c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>${sheet}!$A$2:$A$4</c:f><c:strCache>${pts(['North', 'South', 'East'])}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${values}</c:f><c:numCache><c:formatCode>General</c:formatCode>${pts([1, 2, 3])}</c:numCache></c:numRef></c:val></c:ser>`;
}

const AXES =
    '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:crossAx val="1"/></c:valAx>';

function chartSpace(plot: string): string {
    return `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>${plot}</c:plotArea></c:chart></c:chartSpace>`;
}

const column = (sheet: string, values?: string) =>
    chartSpace(
        `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${ser(sheet, values)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`,
    );
const scatter = (sheet: string) => chartSpace(`<c:scatterChart>${ser(sheet)}</c:scatterChart>${AXES}`);

const graphicFrame = (id: string) =>
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${id}"/></a:graphicData></a:graphic></xdr:graphicFrame>`;

const marker = (name: string, col: number, colOff: number, row: number, rowOff: number) =>
    `<xdr:${name}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${name}>`;

const twoCell = (from: number[], to: number[], body: string) =>
    `<xdr:twoCellAnchor editAs="oneCell">${marker('from', from[0], from[1], from[2], from[3])}${marker('to', to[0], to[1], to[2], to[3])}${body}<xdr:clientData/></xdr:twoCellAnchor>`;
const oneCell = (from: number[], cx: number, cy: number, body: string) =>
    `<xdr:oneCellAnchor>${marker('from', from[0], from[1], from[2], from[3])}<xdr:ext cx="${cx}" cy="${cy}"/>${body}<xdr:clientData/></xdr:oneCellAnchor>`;
const absolute = (x: number, y: number, cx: number, cy: number, body: string) =>
    `<xdr:absoluteAnchor><xdr:pos x="${x}" y="${y}"/><xdr:ext cx="${cx}" cy="${cy}"/>${body}<xdr:clientData/></xdr:absoluteAnchor>`;

const wsDr = (anchors: string) =>
    `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${A}" xmlns:r="${R}" xmlns:mc="${MC}">${anchors}</xdr:wsDr>`;

const DATA =
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Sales</t></is></c></row><row r="2"><c r="B2"><v>1</v></c></row><row r="3"><c r="B3"><v>2</v></c></row><row r="4"><c r="B4"><v>3</v></c></row>';

// Sheet `drawn` (from 0) shows `anchors` naming chart`N`.xml by rIdN, for each part given; `more` are the drawing's
// other relationships.
function workbook({
    sheets,
    drawn = 0,
    anchors,
    charts,
    more = [],
}: {
    sheets: FixtureSheet[];
    drawn?: number;
    anchors: string;
    charts: string[];
    more?: [id: string, type: string, target: string][];
}) {
    const drawing = (sheet: FixtureSheet) => ({ ...sheet, after: `${sheet.after ?? ''}<drawing r:id="rIdD"/>` });
    const folder = sheets[drawn].chartSheet ? 'chartsheets' : 'worksheets';
    return xlsxFixture({
        sheets: sheets.map((sheet, index) => (index === drawn ? drawing(sheet) : sheet)),
        colors: OFFICE_COLORS,
        types: charts
            .map((_, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="${CHART_CONTENT_TYPE}"/>`)
            .join(''),
        parts: [
            {
                name: `xl/${folder}/_rels/sheet${drawn + 1}.xml.rels`,
                data: rels(['rIdD', 'drawing', '../drawings/drawing1.xml']),
            },
            { name: 'xl/drawings/drawing1.xml', data: wsDr(anchors) },
            {
                name: 'xl/drawings/_rels/drawing1.xml.rels',
                data: rels(
                    ...charts.map((_, i): [string, string, string] => [
                        `rId${i + 1}`,
                        'chart',
                        `../charts/chart${i + 1}.xml`,
                    ]),
                    ...more,
                ),
            },
            ...charts.map((data, i) => ({ name: `xl/charts/chart${i + 1}.xml`, data })),
        ],
    });
}

function read(bytes: Uint8Array): { sheets: Sheet[]; warnings: TransformWarning[] } {
    const warnings: TransformWarning[] = [];
    return { sheets: xlsxToSheets(bytes, warnings), warnings };
}

const chartsOf = (sheet: Sheet) => Object.values(sheet.charts ?? {});

describe('a worksheet chart', () => {
    // B is 160 px and C hidden, the rest the sheet's 72 px default; row 2 is 40 px, the rest 20 px.
    test("a two-cell anchor spans the cells Excel draws it over, through the sheet's widths, heights and defaults", () => {
        const { sheets, warnings } = read(
            workbook({
                sheets: [
                    {
                        name: 'Summary',
                        before: '<cols><col min="2" max="2" width="20"/><col min="3" max="3" width="5" hidden="1"/></cols>',
                        data: '<row r="2" ht="30" customHeight="1"><c r="A2"><v>1</v></c></row>',
                    },
                    { name: 'My Data', data: DATA },
                ],
                anchors: twoCell([1, 10 * PX, 1, 0], [4, 20 * PX, 5, 5 * PX], graphicFrame('rId1')),
                charts: [column("'My Data'")],
            }),
        );
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Summary', 'My Data']);
        const [chart] = chartsOf(sheets[0]);
        expect(chart).toMatchObject({ id: 'chart-0', x: 82, y: 20, width: 242, height: 105 });
        expect(typeof chart.index).toBe('string');
        expect(sheets[1].charts).toBeUndefined();
        expect(warnings).toEqual([]);
    });

    test('its refs name sheets by id, a quoted name and any case', () => {
        const { sheets } = read(
            workbook({
                sheets: [{ name: 'Summary' }, { name: 'My Data', data: DATA }],
                anchors: twoCell([0, 0, 0, 0], [2, 0, 10, 0], graphicFrame('rId1')),
                charts: [column("'MY DATA'")],
            }),
        );
        const spec = parseChartSpec(chartsOf(sheets[0])[0].spec);
        const data = { sheetId: 'sheet-1' };
        expect(spec?.type).toBe('column');
        expect(spec?.data).toMatchObject({
            source: 'range',
            categories: { ...data, row: [1, 3], column: [0, 0] },
            series: [
                { name: { ...data, row: [0, 0], column: [1, 1] }, values: { ...data, row: [1, 3], column: [1, 1] } },
            ],
        });
        // Theme colours: the series takes accent1, as the theme states it.
        expect(spec?.data.series[0].color).toBe('#4472c4');
    });

    test('a one-cell anchor takes its size from its ext, an absolute one its place too, each painted in file order', () => {
        const { sheets } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors:
                    oneCell([1, 4 * PX, 2, 0], 300 * PX, 200 * PX, graphicFrame('rId1')) +
                    absolute(50 * PX, 60 * PX, 400 * PX, 250 * PX, graphicFrame('rId1')),
                charts: [column('Data')],
            }),
        );
        const [first, second] = chartsOf(sheets[0]).sort((a, b) => a.id.localeCompare(b.id));
        expect(first).toMatchObject({ id: 'chart-0', x: 76, y: 40, width: 300, height: 200 });
        expect(second).toMatchObject({ id: 'chart-1', x: 50, y: 60, width: 400, height: 250 });
        expect(first.index < second.index).toBe(true);
        expect(first.spec).toBe(second.spec);
    });

    // Excel draws a two-cell anchor between its corners whichever comes first.
    test('a two-cell anchor whose to is before its from spans the same cells', () => {
        const { sheets } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors: twoCell([4, 0, 10, 0], [1, 10 * PX, 2, 0], graphicFrame('rId1')),
                charts: [column('Data')],
            }),
        );
        expect(chartsOf(sheets[0])[0]).toMatchObject({ x: 82, y: 40, width: 206, height: 160 });
    });

    // emu() reads up to 2^53 EMU, about 9.4e11 px, which the painter overflows its stack at.
    test("a side past the max is the max, and a place past Excel's grid its edge", () => {
        const FAR = 9e15;
        const { sheets, warnings } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors:
                    oneCell([0, 0, 0, 0], FAR, 200 * PX, graphicFrame('rId1')) +
                    absolute(FAR, 0, 300 * PX, FAR, graphicFrame('rId1')) +
                    twoCell([0, FAR, 0, 0], [2, 0, 3, FAR], graphicFrame('rId1')),
                charts: [column('Data')],
            }),
        );
        const edge = REFERENCE_COLUMN_COUNT * SHEET_DEFAULT_COL_WIDTH;
        expect(
            chartsOf(sheets[0])
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(({ x, y, width, height }) => [x, y, width, height]),
        ).toEqual([
            [0, 0, CHART_MAX_SIDE, 200],
            [edge, 0, 300, CHART_MAX_SIDE],
            [144, 0, CHART_MAX_SIDE, CHART_MAX_SIDE],
        ]);
        expect(warnings).toEqual([]);
    });

    test('a sheet named twice in different case: its refs mean the first', () => {
        const { sheets } = read(
            workbook({
                sheets: [
                    { name: 'Data', data: DATA },
                    { name: 'DATA', data: DATA },
                ],
                anchors: twoCell([0, 0, 0, 0], [2, 0, 10, 0], graphicFrame('rId1')),
                charts: [column('data')],
            }),
        );
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Data', 'DATA (2)']);
        expect(parseChartSpec(chartsOf(sheets[0])[0].spec)?.data).toMatchObject({
            source: 'range',
            categories: { sheetId: 'sheet-0' },
        });
    });

    test("a ref ranges can't hold, a defined name, comes in with the caches' numbers inline", () => {
        const { sheets, warnings } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors: twoCell([0, 0, 0, 0], [3, 0, 10, 0], graphicFrame('rId1')),
                charts: [column('Data', 'Sales')],
            }),
        );
        expect(parseChartSpec(chartsOf(sheets[0])[0].spec)?.data).toMatchObject({
            source: 'inline',
            categories: ['North', 'South', 'East'],
            series: [{ name: 'Sales', values: [1, 2, 3] }],
        });
        expect(warnings).toEqual([]);
    });

    test("a chart the reader can't draw, a part that isn't there and an Excel 2016 chart are left out and counted", () => {
        const { sheets, warnings } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors:
                    twoCell([0, 0, 0, 0], [3, 0, 10, 0], graphicFrame('rId1')) +
                    twoCell([0, 0, 12, 0], [3, 0, 20, 0], graphicFrame('rId2')) +
                    twoCell([0, 0, 22, 0], [3, 0, 30, 0], graphicFrame('rId9')),
                charts: [scatter('Data'), column('Data')],
                more: [['rIdX', 'chartEx', '../charts/chartEx1.xml']],
            }),
        );
        expect(chartsOf(sheets[0]).map((chart) => [chart.id, chart.y])).toEqual([['chart-0', 240]]);
        expect(warnings).toEqual([{ code: 'charts-dropped', count: 3 }]);
    });

    // A cache declares its points in one tag, and readChart builds them all: each chart placed is charged its part's
    // elements and points, however many anchors name the part.
    test('charts past the element budget are left out, not the workbook', () => {
        const declared = `<c:ser><c:idx val="0"/><c:val><c:numRef><c:f>Data!$B$2:$B$4</c:f><c:numCache><c:ptCount val="2000"/></c:numCache></c:numRef></c:val></c:ser>`;
        const heavy = chartSpace(
            `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${declared.repeat(32)}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`,
        );
        const count = Math.ceil(MAX_XLSX_ELEMENTS / (34 * 2000)) + 10;
        const { sheets, warnings } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors: twoCell([0, 0, 0, 0], [3, 0, 10, 0], graphicFrame('rId1')).repeat(count),
                charts: [heavy],
            }),
        );
        const placed = chartsOf(sheets[0]).length;
        expect(placed).toBeGreaterThan(count - 20);
        expect(warnings).toEqual([{ code: 'charts-dropped', count: count - placed }]);
    });

    // Placing an anchor walks the tracks before its corners, so a far one costs its columns and rows.
    test('anchors far down the grid are charged their tracks, and those past the budget left out', () => {
        const far = (REFERENCE_COLUMN_COUNT - 2 + REFERENCE_ROW_COUNT - 2) * 2;
        const count = Math.floor(MAX_XLSX_ELEMENTS / far) + 3;
        const { sheets, warnings } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors: twoCell(
                    [REFERENCE_COLUMN_COUNT - 2, 0, REFERENCE_ROW_COUNT - 2, 0],
                    [REFERENCE_COLUMN_COUNT - 1, 0, REFERENCE_ROW_COUNT - 1, 0],
                    graphicFrame('rId1'),
                ).repeat(count),
                charts: [column('Data')],
            }),
        );
        const placed = chartsOf(sheets[0]).length;
        expect(placed).toBeLessThan(count - 2);
        expect(warnings).toEqual([{ code: 'charts-dropped', count: count - placed }]);
    });

    test("mc:AlternateContent reads the branch in the drawing's vocabulary; pictures and shapes are not read", () => {
        const picture = `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId7"/></xdr:blipFill><xdr:spPr/></xdr:pic>`;
        const shape =
            '<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="4" name="Box"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>';
        const { sheets, warnings } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors:
                    `<mc:AlternateContent><mc:Choice Requires="a14">${twoCell([0, 0, 0, 0], [2, 0, 5, 0], shape)}</mc:Choice><mc:Fallback>${twoCell([0, 0, 1, 0], [2, 0, 5, 0], graphicFrame('rId1'))}</mc:Fallback></mc:AlternateContent>` +
                    twoCell(
                        [0, 0, 10, 0],
                        [2, 0, 15, 0],
                        `<mc:AlternateContent><mc:Choice Requires="xdr">${graphicFrame('rId1')}</mc:Choice><mc:Fallback>${shape}</mc:Fallback></mc:AlternateContent>`,
                    ) +
                    twoCell([0, 0, 20, 0], [2, 0, 25, 0], picture) +
                    twoCell([0, 0, 30, 0], [2, 0, 35, 0], shape),
                charts: [column('Data')],
            }),
        );
        expect(chartsOf(sheets[0]).map((chart) => chart.y)).toEqual([20, 200]);
        expect(warnings).toEqual([]);
    });
});

describe('a chart sheet', () => {
    const chartSheet = (name: string, after = ''): FixtureSheet => ({ name, chartSheet: true, after });

    test('is a tab of its own in workbook order, holding its chart at the top left at its size', () => {
        const { sheets } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }, chartSheet('Chart1'), { name: 'Notes' }],
                drawn: 1,
                anchors: absolute(10 * PX, 10 * PX, 977 * PX, 638 * PX, graphicFrame('rId1')),
                charts: [column('Data')],
            }),
        );
        expect(sheets.map((sheet) => [sheet.name, sheet.id, sheet.celldata])).toEqual([
            ['Data', 'sheet-0', expect.any(Array)],
            ['Chart1', 'sheet-1', []],
            ['Notes', 'sheet-2', []],
        ]);
        expect(chartsOf(sheets[1])).toEqual([
            { id: 'chart-0', index: expect.any(String), x: 0, y: 0, width: 977, height: 638, spec: expect.any(String) },
        ]);
        expect(parseChartSpec(chartsOf(sheets[1])[0].spec)?.data).toMatchObject({
            source: 'range',
            categories: { sheetId: 'sheet-0' },
        });
    });

    test("one whose anchor names no size takes Excel's page; one the reader can't draw is an empty tab", () => {
        const sized = read(
            workbook({
                sheets: [chartSheet('Chart1')],
                anchors: twoCell([0, 0, 0, 0], [3, 0, 3, 0], graphicFrame('rId1')),
                charts: [column('Data')],
            }),
        );
        expect(chartsOf(sized.sheets[0])[0]).toMatchObject({ x: 0, y: 0, ...CHART_SHEET_SIZE });
        const unsupported = read(
            workbook({
                sheets: [chartSheet('Chart1'), { name: 'Data', data: DATA }],
                anchors: absolute(0, 0, 600 * PX, 400 * PX, graphicFrame('rId1')),
                charts: [scatter('Data')],
            }),
        );
        expect(unsupported.sheets.map((sheet) => [sheet.name, sheet.charts])).toEqual([
            ['Chart1', undefined],
            ['Data', undefined],
        ]);
        expect(unsupported.warnings).toEqual([{ code: 'charts-dropped', count: 1 }]);
    });

    // LibreOffice's tdf107586 was refused as "only chart sheets".
    test('a workbook of chart sheets only imports, a chart of cached numbers on each', () => {
        const { sheets } = read(
            workbook({
                sheets: [chartSheet('Chart1', '<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>')],
                anchors: absolute(0, 0, 600 * PX, 400 * PX, graphicFrame('rId1')),
                charts: [column('Gone')],
            }),
        );
        expect(sheets).toHaveLength(1);
        expect(sheets[0]).toMatchObject({ name: 'Chart1', color: '#FF0000' });
        // The sheet its refs name is none of the workbook's, as an external ref's isn't: its caches come in inline.
        expect(parseChartSpec(chartsOf(sheets[0])[0].spec)?.data).toMatchObject({
            source: 'inline',
            series: [{ values: [1, 2, 3] }],
        });
    });
});
