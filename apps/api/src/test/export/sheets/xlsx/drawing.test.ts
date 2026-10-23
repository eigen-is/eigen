import { describe, expect, test } from 'bun:test';
import { parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { Cell, Sheet, SheetChart } from '@workspace/lib/sheets';
import { EMU_PER_PX, parseOoxml, XDR_NS } from '../../../../lib/core/ooxml';
import { CHART_CONTENT_TYPE } from '../../../../lib/core/ooxml-chart';
import type { PackagePart } from '../../../../lib/core/opc';
import { hasXmlName, type XmlElement, xmlElements, xmlTrimmedText } from '../../../../lib/core/xml';
import { openZip } from '../../../../lib/core/zip';
import { pxToColumnWidth } from '../../../../lib/document/spreadsheetml';
import type { CountedWarningCode, TransformWarning } from '../../../../lib/document/transform/protocol';
import { sheetsToXlsx } from '../../../../lib/export/sheets/to-xlsx';
import { DRAWING_CONTENT_TYPE, drawingOf } from '../../../../lib/export/sheets/xlsx/drawing';
import { xlsxToSheets } from '../../../../lib/import/sheets/from-xlsx';
import { xlsxFixture } from '../../../fixtures/xlsx';

// A sheet's charts as its drawing part, read back by Eigen's own xlsx reader: each chart over the same pixels of the
// same cells, and its spec the same.

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// A fixture without styles reads its column widths in Excel's fallback digit.
const DIGIT = 7;

const range = (row: [number, number], column: [number, number]) => ({ sheetId: 'sheet-1', row, column });

// Sales by region in My Data: names down A2:A4, numbers in B2:B4 under B1.
const RANGE_SPEC = JSON.stringify({
    ...sampleChartSpec('column'),
    title: 'Sales',
    data: {
        source: 'range',
        categories: range([1, 3], [0, 0]),
        series: [
            { name: range([0, 0], [1, 1]), values: range([1, 3], [1, 1]), color: null, markers: false, smooth: false },
        ],
    },
});

const byId = (...charts: SheetChart[]) => Object.fromEntries(charts.map((chart) => [chart.id, chart]));

const RANGED: SheetChart = { id: 'ranged', index: 'a1', x: 50, y: 30, width: 400, height: 300, spec: RANGE_SPEC };
const INLINE: SheetChart = {
    id: 'inline',
    index: 'a0',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    spec: JSON.stringify(sampleChartSpec('line')),
};

const text = (value: string): Cell => ({ v: value, m: value });
const DATA: (Cell | null)[][] = [
    [text('Region'), text('Sales')],
    [text('North'), { v: 1, m: '1' }],
    [text('South'), { v: 2, m: '2' }],
    [text('East'), { v: 3, m: '3' }],
];
const DATA_XML =
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Sales</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>South</t></is></c><c r="B3"><v>2</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>East</t></is></c><c r="B4"><v>3</v></c></row>';

// B is 140 px and C hidden; row 2 is 40 px and row 4 hidden; the rest 100 by 20.
const SUMMARY: Sheet = {
    id: 'sheet-0',
    name: 'Summary',
    defaultColWidth: 100,
    defaultRowHeight: 20,
    config: { columnlen: { 1: 140 }, colhidden: { 2: 0 }, rowlen: { 1: 40 }, rowhidden: { 3: 0 } },
    charts: byId(RANGED, INLINE),
};
const MY_DATA: Sheet = { id: 'sheet-1', name: 'My Data', data: DATA };

// The geometry above as SpreadsheetML, which X1's worksheet writes.
const GEOMETRY = `<sheetFormatPr defaultColWidth="${pxToColumnWidth(100, DIGIT)}" defaultRowHeight="15"/><cols><col min="2" max="2" width="${pxToColumnWidth(140, DIGIT)}" customWidth="1"/><col min="3" max="3" width="${pxToColumnWidth(100, DIGIT)}" hidden="1"/></cols>`;
const ROWS = '<row r="2" ht="30" customHeight="1"/><row r="4" hidden="1"/>';

function xml([, body]: PackagePart): string {
    return typeof body === 'string' ? body : [...body()].join('');
}

// The workbook with Summary's drawing, read back.
function roundTrip(sheets: Sheet[]): { sheets: Sheet[]; warnings: TransformWarning[]; lost: CountedWarningCode[] } {
    const lost: CountedWarningCode[] = [];
    const drawing = drawingOf(sheets[0], 1, sheets, (code) => lost.push(code));
    if (!drawing) throw new Error('no drawing');
    const bytes = xlsxFixture({
        sheets: [
            { name: 'Summary', before: GEOMETRY, data: ROWS, after: '<drawing r:id="rIdD"/>' },
            { name: 'My Data', data: DATA_XML },
        ],
        types: drawing.parts
            .map(([path, , type]) => (type ? `<Override PartName="/${path}" ContentType="${type}"/>` : ''))
            .join(''),
        parts: [
            {
                name: 'xl/worksheets/_rels/sheet1.xml.rels',
                data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdD" Type="${R}/drawing" Target="/${drawing.path}"/></Relationships>`,
            },
            ...drawing.parts.map((part) => ({ name: part[0], data: xml(part) })),
        ],
    });
    const warnings: TransformWarning[] = [];
    return { sheets: xlsxToSheets(bytes, warnings), warnings, lost };
}

const boxOf = ({ x, y, width, height }: SheetChart) => ({ x, y, width, height });

describe('drawingOf', () => {
    test('each chart reads back over the same pixels with the same spec, in paint order', () => {
        const { sheets, warnings, lost } = roundTrip([SUMMARY, MY_DATA]);
        expect(warnings).toEqual([]);
        expect(lost).toEqual([]);
        expect(sheets[0].defaultColWidth).toBe(100);
        const charts = Object.values(sheets[0].charts ?? {}).sort((a, b) => a.index.localeCompare(b.index));
        const written = [INLINE, RANGED];
        expect(charts.map(boxOf)).toEqual(written.map(boxOf));
        expect(charts.map((chart) => parseChartSpec(chart.spec))).toEqual(
            written.map((chart) => parseChartSpec(chart.spec)),
        );
    });

    test('a two-cell anchor names the cells its corners land in, past hidden tracks', () => {
        const drawing = drawingOf(SUMMARY, 1, [SUMMARY, MY_DATA], () => {});
        const root = drawing && parseOoxml(xml(drawing.parts[0]));
        if (!root) throw new Error('no drawing');
        const corners = xmlElements(root).map((anchor) =>
            xmlElements(anchor)
                .filter((corner) => hasXmlName(corner, XDR_NS, 'from') || hasXmlName(corner, XDR_NS, 'to'))
                .map(cellOf),
        );
        // A1 to D11 for the line; x 450 is past A, B and the hidden C, 10 px into F, and y 330 past the hidden row 4.
        expect(corners).toEqual([
            [
                [0, 0, 0, 0],
                [3, 60, 10, 0],
            ],
            [
                [0, 50, 1, 10],
                [5, 10, 16, 10],
            ],
        ]);
    });

    test('names its parts after the sheet, with their content types, the same bytes every time', () => {
        const write = () => drawingOf(SUMMARY, 3, [SUMMARY, MY_DATA], () => {});
        const drawing = write();
        expect(drawing?.path).toBe('xl/drawings/drawing3.xml');
        expect(drawing?.parts.map(([path, , type]) => [path, type])).toEqual([
            ['xl/drawings/drawing3.xml', DRAWING_CONTENT_TYPE],
            ['xl/drawings/_rels/drawing3.xml.rels', undefined],
            ['xl/charts/chart3_1.xml', CHART_CONTENT_TYPE],
            ['xl/charts/chart3_2.xml', CHART_CONTENT_TYPE],
        ]);
        expect(drawing?.files).toEqual([]);
        expect(drawing?.parts.map(xml)).toEqual(write()?.parts.map(xml));
        expect(drawing && xml(drawing.parts[1])).toContain('Target="../charts/chart3_1.xml"');
    });

    test("a chart whose spec doesn't parse is left out and counted, and a sheet without charts has no drawing", () => {
        const lost: CountedWarningCode[] = [];
        const broken: Sheet = { ...SUMMARY, charts: byId({ ...INLINE, id: 'bad', spec: '{' }) };
        expect(drawingOf(broken, 1, [broken], (code) => lost.push(code))).toBeUndefined();
        expect(lost).toEqual(['charts-dropped']);
        expect(drawingOf(MY_DATA, 2, [MY_DATA], () => {})).toBeUndefined();
        const mixed: Sheet = { ...SUMMARY, charts: { ...SUMMARY.charts, ...broken.charts } };
        expect(drawingOf(mixed, 1, [mixed, MY_DATA], (code) => lost.push(code))?.parts).toHaveLength(4);
        expect(lost).toEqual(['charts-dropped', 'charts-dropped']);
    });

    test("a chart naming a sheet the workbook doesn't hold keeps its other refs", () => {
        const { sheets } = roundTrip([SUMMARY]);
        const ranged = Object.values(sheets[0].charts ?? {}).find((chart) => chart.y === 30);
        expect(parseChartSpec(ranged?.spec ?? '')?.data).toMatchObject({ source: 'range', categories: null });
    });
});

describe('the workbook', () => {
    // My Data's cells as a stored sheet holds them, beside its dense data.
    const stored: Sheet = {
        ...MY_DATA,
        celldata: DATA.flatMap((row, r) => row.map((v, c) => ({ r, c, v }))),
    };

    test("writes each sheet's drawing beside it, and the import lands each chart where it was, a turned one upright", async () => {
        const turned: SheetChart = { ...RANGED, angle: 30, color: '#AA0000', strokeColor: '#00AA00' };
        const summary: Sheet = { ...SUMMARY, charts: byId(INLINE, turned) };
        const warnings: TransformWarning[] = [];
        const bytes = await sheetsToXlsx([summary, stored], { warnings });
        expect(warnings).toEqual([]);
        const zip = openZip(bytes);
        const part = (path: string) => new TextDecoder().decode(zip.read(path) ?? new Uint8Array());
        expect(part('xl/worksheets/sheet1.xml')).toContain('<drawing r:id="rId1"/></worksheet>');
        expect(part('xl/worksheets/_rels/sheet1.xml.rels')).toContain('Target="../drawings/drawing1.xml"');
        expect(part('[Content_Types].xml')).toContain(
            `<Override PartName="/xl/drawings/drawing1.xml" ContentType="${DRAWING_CONTENT_TYPE}"/>`,
        );
        expect(zip.names().filter((name) => name.startsWith('xl/drawings/drawing'))).toEqual([
            'xl/drawings/drawing1.xml',
        ]);
        // Its labels and axes in the stored look's colours.
        expect(part('xl/charts/chart1_2.xml')).toContain('<a:srgbClr val="AA0000">');
        expect(part('xl/charts/chart1_2.xml')).toContain('<a:srgbClr val="00AA00">');
        const [read] = xlsxToSheets(bytes);
        const charts = Object.values(read.charts ?? {}).sort((a, b) => a.index.localeCompare(b.index));
        expect(charts.map(boxOf)).toEqual([INLINE, turned].map(boxOf));
        expect(charts.map((chart) => chart.angle ?? 0)).toEqual([0, 0]);
        expect(charts.map((chart) => parseChartSpec(chart.spec))).toEqual(
            [INLINE, turned].map((chart) => parseChartSpec(chart.spec)),
        );
    });

    test('a chart names its sheet as the workbook writes it, and stacks in paint order among the images', async () => {
        const image = { id: 'picture', index: 'a0V', x: 0, y: 0, width: 10, height: 10, mediaName: 'a.png' };
        const summary: Sheet = { ...SUMMARY, images: { picture: image } };
        const history: Sheet = { ...stored, name: 'History' };
        const [read] = xlsxToSheets(await sheetsToXlsx([summary, history]));
        const charts = Object.values(read.charts ?? {}).sort((a, b) => a.index.localeCompare(b.index));
        expect(charts.map(boxOf)).toEqual([INLINE, RANGED].map(boxOf));
        expect(parseChartSpec(charts[1].spec)?.data).toMatchObject({
            source: 'range',
            categories: { row: [1, 3], column: [0, 0] },
        });
    });
});

// A corner's column, its offset in px, its row and its offset.
function cellOf(corner: XmlElement): number[] {
    const value = (local: string) => {
        const found = xmlElements(corner).find((element) => hasXmlName(element, XDR_NS, local));
        return Number(found && xmlTrimmedText(found));
    };
    return [value('col'), value('colOff') / EMU_PER_PX, value('row'), value('rowOff') / EMU_PER_PX];
}
