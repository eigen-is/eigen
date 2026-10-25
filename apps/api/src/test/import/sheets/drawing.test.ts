import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHART_MAX_SIDE, FLAT_CHART_LOOK, readChartSpec } from '@workspace/lib/charts';
import type { Sheet } from '@workspace/lib/sheets';
import {
    floatingItems,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_COL_WIDTH,
} from '@workspace/lib/sheets';
import type { TransformWarning } from '../../../lib/document/transform/protocol';
import { IMAGE_EXTENSION_BY_MIME, MAX_MEDIA_PARTS } from '../../../lib/import/image-types';
import { IMPORT_MESSAGES } from '../../../lib/import/messages';
import { CHART_SHEET_SIZE, partsText, placeDrawings, readDrawing } from '../../../lib/import/sheets/drawing';
import { readXlsx } from '../../../lib/import/sheets/from-xlsx';
import { MAX_XLSX_ELEMENTS } from '../../../lib/import/sheets/package';
import { drawingTheme } from '../../../lib/ooxml/drawingml';
import { CHART_CONTENT_TYPE } from '../../../lib/ooxml/ooxml-chart';
import { openPackage, optional } from '../../../lib/ooxml/opc';
import { MAX_DECOMPRESSED_BYTES, openZip, writeZip } from '../../../lib/ooxml/zip';
import { PIXEL_PNG } from '../../fixtures/pptx';
import type { FixtureSheet } from '../../fixtures/xlsx';
import { OFFICE_COLORS, xlsxFixture } from '../../fixtures/xlsx';

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
    return { sheets: readXlsx(bytes, { maxMediaBytes: MAX_DECOMPRESSED_BYTES }, warnings).sheets, warnings };
}

const chartsOf = (sheet: Sheet) => Object.values(sheet.charts ?? {});

describe('a worksheet chart', () => {
    // B is 140 px and C hidden, the rest Excel's 64 px default; row 2 is 40 px, the rest 20 px.
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
        expect(chart).toMatchObject({ id: 'chart-0', x: 74, y: 20, width: 214, height: 105 });
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
        const { spec } = readChartSpec(chartsOf(sheets[0])[0]);
        const data = { sheetId: 'sheet-1' };
        expect(spec?.chart.type).toBe('column');
        expect(spec?.data).toMatchObject({
            source: 'range',
            categories: { ...data, row: [1, 3], column: [0, 0] },
            series: [
                { name: { ...data, row: [0, 0], column: [1, 1] }, values: { ...data, row: [1, 3], column: [1, 1] } },
            ],
        });
        // Theme colours: the series takes accent1, as the theme states it.
        expect(spec?.series['x-0']?.color).toBe('#4472c4');
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
        expect(first).toMatchObject({ id: 'chart-0', x: 68, y: 40, width: 300, height: 200 });
        expect(second).toMatchObject({ id: 'chart-1', x: 50, y: 60, width: 400, height: 250 });
        expect(first.index < second.index).toBe(true);
        expect(readChartSpec(first).stored).toEqual(readChartSpec(second).stored);
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
        expect(chartsOf(sheets[0])[0]).toMatchObject({ x: 74, y: 40, width: 182, height: 160 });
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
            [128, 0, CHART_MAX_SIDE, CHART_MAX_SIDE],
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
        expect(readChartSpec(chartsOf(sheets[0])[0]).spec?.data).toMatchObject({
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
        expect(readChartSpec(chartsOf(sheets[0])[0]).spec?.data).toMatchObject({
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

    test('a pie over more cells than a pie holds slices for reads its caches, and is left out and counted only when they hold too many too', () => {
        const pie = (cache: string) =>
            chartSpace(
                `<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>p</c:v></c:tx><c:val><c:numRef><c:f>Data!$B$1:$B$1048576</c:f>${cache}</c:numRef></c:val></c:ser></c:pieChart>`,
            );
        const { sheets, warnings } = read(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors:
                    twoCell([0, 0, 0, 0], [3, 0, 10, 0], graphicFrame('rId1')) +
                    twoCell([0, 0, 12, 0], [3, 0, 20, 0], graphicFrame('rId2')),
                charts: [
                    pie(
                        `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2001"/>${pts([1])}</c:numCache>`,
                    ),
                    pie(`<c:numCache><c:formatCode>General</c:formatCode>${pts([1, 2, 3])}</c:numCache>`),
                ],
            }),
        );
        const specs = chartsOf(sheets[0]).map((chart) => readChartSpec(chart).stored);
        expect(specs).toMatchObject([
            { chart: { type: 'pie' }, data: { source: 'inline', series: [{ values: [1, 2, 3] }] } },
        ]);
        expect(warnings).toEqual([{ code: 'charts-dropped', count: 1 }]);
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

    // A chart's parts are what the snapshot holds of it, so the output budget counts their text, keys and all.
    test("each chart placed is charged its parts' text", () => {
        const pkg = openPackage(
            workbook({
                sheets: [{ name: 'Data', data: DATA }],
                anchors:
                    twoCell([0, 0, 0, 0], [3, 0, 10, 0], graphicFrame('rId1')) +
                    twoCell([0, 0, 12, 0], [3, 0, 20, 0], graphicFrame('rId1')),
                charts: [column('Data')],
            }),
            IMPORT_MESSAGES.xlsx,
        );
        const drawing = readDrawing(
            pkg,
            pkg.part('xl/worksheets/sheet1.xml'),
            pkg.relationships('xl/worksheets/sheet1.xml'),
        );
        if (!drawing) throw new Error('no drawing');
        const sheet: Sheet = { name: 'Data', id: 'sheet-0' };
        const charged: number[] = [];
        placeDrawings([{ sheet, chartSheet: false, ...drawing }], {
            pkg,
            theme: drawingTheme(optional(() => pkg.part('xl/theme/theme1.xml'))),
            sheetIds: new Map([['data', 'sheet-0']]),
            spend: () => true,
            charge: (_, text) => charged.push(text),
            mediaName: () => undefined,
            lost: () => {},
        });
        const charts = chartsOf(sheet);
        expect(charts).toHaveLength(2);
        expect(Object.keys(charts[0].specSeries)).not.toEqual([]);
        expect(charged).toEqual(charts.map(partsText));
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

    test("mc:AlternateContent reads the branch in the drawing's vocabulary; shapes are not read", () => {
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
        // The picture names no part.
        expect(warnings).toEqual([{ code: 'images-dropped', count: 1 }]);
    });
});

// A drawing of pictures, each `[id, target]` relationship an image part with these bytes, beside a column chart as rId1.
function pictures(anchors: string, images: [id: string, target: string, data: Uint8Array][]): Uint8Array {
    const base = workbook({
        sheets: [{ name: 'Data', data: DATA }],
        anchors,
        charts: [column('Data')],
        more: images.map(([id, target]): [string, string, string] => [id, 'image', target]),
    });
    const zip = openZip(base);
    const entries = zip.names().map((name) => ({ name, data: zip.read(name) ?? new Uint8Array() }));
    const types = entries.find((entry) => entry.name === '[Content_Types].xml');
    if (types)
        types.data = new TextEncoder().encode(
            new TextDecoder()
                .decode(types.data)
                .replace(
                    '<Default Extension="xml"',
                    `${[...IMAGE_EXTENSION_BY_MIME, ['image/jpeg', 'jpg']]
                        .map(([mime, extension]) => `<Default Extension="${extension}" ContentType="${mime}"/>`)
                        .join('')}<Default Extension="xml"`,
                ),
        );
    const media = images.map(([, target, data]) => ({ name: `xl/${target.replace('../', '')}`, data }));
    return writeZip([...entries, ...media]);
}

const pic = (id: string, xfrm = '') =>
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
const turned = (degrees: number) =>
    `<a:xfrm rot="${degrees * 60_000}"><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm>`;

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

function readPictures(bytes: Uint8Array, maxMediaBytes = 1024 * 1024) {
    const warnings: TransformWarning[] = [];
    const { sheets, media } = readXlsx(bytes, { maxMediaBytes }, warnings);
    const images = Object.values(sheets[0].images ?? {});
    return { sheet: sheets[0], images, media, warnings };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('a worksheet picture', () => {
    test('a two-cell, a one-cell and an absolute anchor each place it, painted in file order among the charts', () => {
        const { sheet, images, media, warnings } = readPictures(
            pictures(
                twoCell([0, 10 * PX, 1, 0], [2, 0, 5, 0], pic('rIdP')) +
                    twoCell([0, 0, 10, 0], [3, 0, 20, 0], graphicFrame('rId1')) +
                    oneCell([1, 4 * PX, 2, 0], 30 * PX, 20 * PX, pic('rIdP')) +
                    absolute(50 * PX, 60 * PX, 40 * PX, 25 * PX, pic('rIdJ')),
                [
                    ['rIdP', '../media/image1.png', PIXEL_PNG],
                    ['rIdJ', '../media/image2.jpg', JPEG],
                ],
            ),
        );
        expect(warnings).toEqual([]);
        // Excel's default column is 64 px.
        expect(images.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
            [10, 20, 118, 80],
            [68, 40, 30, 20],
            [50, 60, 40, 25],
        ]);
        expect(images.every((image) => UUID.test(image.id) && image.angle === undefined)).toBe(true);
        const [chart] = chartsOf(sheet);
        expect([
            images[0].index < chart.index,
            chart.index < images[1].index,
            images[1].index < images[2].index,
        ]).toEqual([true, true, true]);
        // One media file a part, however many pictures show it, named by the import's prefix.
        const [png, jpeg] = media;
        expect(png.name).toMatch(/^xlsx-[0-9a-f-]{36}-image-1\.png$/);
        expect(jpeg.name).toBe(png.name.replace('image-1.png', 'image-2.jpeg'));
        expect(images.map((image) => image.mediaName)).toEqual([png.name, png.name, jpeg.name]);
        expect(media.map(({ contentType, data }) => [contentType, [...data]])).toEqual([
            ['image/png', [...PIXEL_PNG]],
            ['image/jpeg', [...JPEG]],
        ]);
        expect(
            readPictures(
                pictures(twoCell([0, 0, 0, 0], [1, 0, 1, 0], pic('rIdP')), [['rIdP', '../media/a.png', PIXEL_PNG]]),
            ).media[0].name,
        ).not.toBe(png.name);
    });

    test('its turn is its a:xfrm rot, and sideways its anchor is its box turned a quarter', () => {
        const { images } = readPictures(
            pictures(
                // 50 by 200 about (200, 125) in px, B2 and on at Excel's 64 px columns.
                twoCell([2, 47 * PX, 1, 5 * PX], [3, 33 * PX, 11, 5 * PX], pic('rIdP', turned(90))) +
                    twoCell([1, 0, 5, 0], [3, 0, 7, 10 * PX], pic('rIdP', turned(30))) +
                    twoCell([1, 0, 5, 0], [3, 0, 7, 10 * PX], pic('rIdP', turned(-90))),
                [['rIdP', '../media/image1.png', PIXEL_PNG]],
            ),
        );
        expect(images.map(({ x, y, width, height, angle }) => [x, y, width, height, angle])).toEqual([
            [100, 100, 200, 50, 90],
            [64, 100, 128, 50, 30],
            [103, 61, 50, 128, 270],
        ]);
    });

    test("an SVG comes in as its svgBlip; EMF, WMF and TIFF, and a part that isn't there, are left out and counted", () => {
        const svgBlip = `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdP"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rIdS"/></a:ext></a:extLst></a:blip></xdr:blipFill><xdr:spPr/></xdr:pic>`;
        const { images, media, warnings } = readPictures(
            pictures(
                twoCell([0, 0, 0, 0], [1, 0, 1, 0], svgBlip) +
                    twoCell([0, 0, 2, 0], [1, 0, 3, 0], pic('rIdE')) +
                    twoCell([0, 0, 4, 0], [1, 0, 5, 0], pic('rIdW')) +
                    twoCell([0, 0, 6, 0], [1, 0, 7, 0], pic('rIdT')) +
                    twoCell([0, 0, 8, 0], [1, 0, 9, 0], pic('rIdGone')),
                [
                    ['rIdP', '../media/image1.png', PIXEL_PNG],
                    ['rIdS', '../media/image2.svg', SVG_BYTES],
                    ['rIdE', '../media/image3.emf', JPEG],
                    ['rIdW', '../media/image4.wmf', JPEG],
                    ['rIdT', '../media/image5.tiff', JPEG],
                ],
            ),
        );
        expect(media.map(({ name, contentType }) => [name.slice(-11), contentType])).toEqual([
            ['image-1.svg', 'image/svg+xml'],
        ]);
        expect(images.map((image) => image.mediaName)).toEqual([media[0].name]);
        expect(warnings).toEqual([{ code: 'images-dropped', count: 4 }]);
    });

    // markitdown's sample, written by openpyxl: four PNGs over three sheets, each a one-cell anchor at 300 by 80 px.
    test("a real workbook's pictures come in, each sheet's in file order", () => {
        const bytes = readFileSync(
            join(import.meta.dir, '../../fixtures/workbooks/markitdown-xlsx_multiple_images.xlsx'),
        );
        const warnings: TransformWarning[] = [];
        const { sheets, media } = readXlsx(bytes, { maxMediaBytes: 1024 * 1024 }, warnings);
        expect(warnings).toEqual([]);
        const placed = sheets.map((sheet) =>
            floatingItems(sheet).map(({ object }) => [object.x, object.y, object.width, object.height]),
        );
        expect(placed).toEqual([
            [
                [0, 60, 300, 80],
                [0, 160, 300, 80],
            ],
            [[0, 60, 300, 80]],
            [[0, 60, 300, 80]],
        ]);
        const names = sheets.flatMap((sheet) => Object.values(sheet.images ?? {}).map((image) => image.mediaName));
        expect(media.map((item) => item.name)).toEqual(names);
        expect(media.map((item) => item.data.subarray(1, 4).toString())).toEqual(['PNG', 'PNG', 'PNG', 'PNG']);
    });

    test('pictures past the media budget are left out and counted, not the workbook', () => {
        const anchors = (count: number) =>
            Array.from({ length: count }, (_, i) => twoCell([0, 0, i, 0], [1, 0, i + 1, 0], pic(`rIdP${i}`))).join('');
        const parts = (count: number) =>
            Array.from({ length: count }, (_, i): [string, string, Uint8Array] => [
                `rIdP${i}`,
                `../media/image${i + 1}.png`,
                PIXEL_PNG,
            ]);
        const bytes = readPictures(pictures(anchors(3), parts(3)), PIXEL_PNG.length * 2);
        expect([bytes.images.length, bytes.media.length]).toEqual([2, 2]);
        expect(bytes.warnings).toEqual([{ code: 'images-dropped', count: 1 }]);
        const count = MAX_MEDIA_PARTS + 2;
        const many = readPictures(pictures(anchors(count), parts(count)));
        expect([many.images.length, many.media.length]).toEqual([MAX_MEDIA_PARTS, MAX_MEDIA_PARTS]);
        expect(many.warnings).toEqual([{ code: 'images-dropped', count: 2 }]);
    });

    test("mc:AlternateContent around a picture reads the branch in the drawing's vocabulary", () => {
        const { images } = readPictures(
            pictures(
                twoCell(
                    [0, 0, 1, 0],
                    [1, 0, 2, 0],
                    `<mc:AlternateContent><mc:Choice Requires="a14">${pic('rIdX')}</mc:Choice><mc:Fallback>${pic('rIdP')}</mc:Fallback></mc:AlternateContent>`,
                ),
                [['rIdP', '../media/image1.png', PIXEL_PNG]],
            ),
        );
        expect(images.map(({ y, height }) => [y, height])).toEqual([[20, 20]]);
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
            {
                id: 'chart-0',
                index: expect.any(String),
                x: 0,
                y: 0,
                width: 977,
                height: 638,
                angle: 0,
                // The theme's tx1, as Excel draws a label without a colour of its own; the rest flat.
                fill: FLAT_CHART_LOOK.fill,
                color: '#000000',
                strokeColor: FLAT_CHART_LOOK.strokeColor,
                strokeWidth: FLAT_CHART_LOOK.strokeWidth,
                specChart: expect.any(String),
                specTitle: expect.any(String),
                specLegend: expect.any(String),
                specAxes: expect.any(Object),
                specPlots: expect.any(Object),
                specSeries: expect.any(Object),
                specPoints: expect.any(Object),
                specData: expect.any(String),
            },
        ]);
        expect(readChartSpec(chartsOf(sheets[1])[0]).spec?.data).toMatchObject({
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
        expect(readChartSpec(chartsOf(sheets[0])[0]).spec?.data).toMatchObject({
            source: 'inline',
            series: [{ values: [1, 2, 3] }],
        });
    });
});
