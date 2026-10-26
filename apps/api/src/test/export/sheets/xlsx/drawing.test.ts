import { describe, expect, test } from 'bun:test';
import {
    FLAT_CHART_LOOK,
    MAX_CHART_POINTS,
    newSheetChartSpecParts,
    readChartSpec,
    sampleChartSpec,
} from '@workspace/lib/charts';
import type { Cell, Sheet, SheetChart, SheetFloatingObject, SheetImage } from '@workspace/lib/sheets';
import { floatingItems, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { serializeFill, solidFill } from '@workspace/lib/vector';
import type { XmlElement } from '../../../../lib/core/xml';
import { hasXmlName, xmlElements, xmlTrimmedText } from '../../../../lib/core/xml';
import type { CountedWarningCode, TransformWarning } from '../../../../lib/document/transform/protocol';
import { toTransferableBuffer, toTransferableText } from '../../../../lib/document/transform/protocol';
import type { OfficeImages, OfficeMedia } from '../../../../lib/export/office-image';
import { officeImages } from '../../../../lib/export/office-image';
import { drawingOf } from '../../../../lib/export/sheets/xlsx/drawing';
import { readXlsx, xlsxToSheets } from '../../../../lib/import/sheets/from-xlsx';
import { A_NS, EMU_PER_PX, parseOoxml, XDR_NS } from '../../../../lib/ooxml/ooxml';
import { CHART_CONTENT_TYPE } from '../../../../lib/ooxml/ooxml-chart';
import type { PackagePart } from '../../../../lib/ooxml/opc';
import { DRAWING_CONTENT_TYPE, pxToColumnWidth } from '../../../../lib/ooxml/spreadsheetml';
import { MAX_DECOMPRESSED_BYTES, openZip } from '../../../../lib/ooxml/zip';
import { seriesIdsByPlace } from '../../../../scripts/office-audit';
import { PIXEL_PNG } from '../../../fixtures/pptx';
import { exportXlsx, xlsxFixture } from '../../../fixtures/xlsx';

// A sheet's charts as its drawing part, read back by Eigen's own xlsx reader: each chart over the same pixels of the
// same cells, and its spec the same.

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// A fixture without styles reads its column widths in Excel's fallback digit.
const DIGIT = 7;

const range = (row: [number, number], column: [number, number]) => ({ sheetId: 'sheet-1', row, column });

// Sales by region in My Data: names down A2:A4, numbers in B2:B4 under B1.
const RANGE_SPEC = newSheetChartSpecParts({
    ...sampleChartSpec('column'),
    title: { text: 'Sales' },
    data: {
        source: 'range',
        categories: range([1, 3], [0, 0]),
        series: [{ id: 's-1', name: range([0, 0], [1, 1]), values: range([1, 3], [1, 1]) }],
    },
});

const byId = (...charts: SheetChart[]) => Object.fromEntries(charts.map((chart) => [chart.id, chart]));

const RANGED: SheetChart = { id: 'ranged', index: 'a1', x: 50, y: 30, width: 400, height: 300, ...RANGE_SPEC };
const INLINE: SheetChart = {
    id: 'inline',
    index: 'a0',
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    ...newSheetChartSpecParts(sampleChartSpec('line')),
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
    const drawing = drawingOf(sheets[0], 1, sheets, noPictures(), (code) => lost.push(code));
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
    const read = readXlsx(bytes, { maxMediaBytes: MAX_DECOMPRESSED_BYTES });
    return { sheets: read.sheets, warnings: read.warnings, lost };
}

const boxOf = ({ x, y, width, height }: SheetFloatingObject) => ({ x, y, width, height });

function noPictures(): OfficeImages {
    return officeImages([], 'xl/media');
}

const PNG: OfficeMedia = {
    name: 'photo.png',
    contentType: 'image/png',
    data: toTransferableBuffer(PIXEL_PNG),
    width: 1,
    height: 1,
};
const SVG: OfficeMedia = {
    name: 'drawing.svg',
    contentType: 'image/svg+xml',
    data: toTransferableText('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    png: toTransferableBuffer(PIXEL_PNG),
    width: 10,
    height: 10,
};

// Below the line, between the two charts, and above them turned a third of the way to upright.
const BELOW: SheetImage = { id: 'below', index: 'a0V', x: 20, y: 10, width: 60, height: 30, mediaName: 'photo.png' };
const ABOVE: SheetImage = { ...BELOW, id: 'above', index: 'a2', x: 120, angle: 30 };

describe('drawingOf', () => {
    test('each chart reads back over the same pixels with the same spec, in paint order', () => {
        const { sheets, warnings, lost } = roundTrip([SUMMARY, MY_DATA]);
        expect(warnings).toEqual([]);
        expect(lost).toEqual([]);
        expect(sheets[0].defaultColWidth).toBe(100);
        const charts = Object.values(sheets[0].charts ?? {}).sort((a, b) => a.index.localeCompare(b.index));
        const written = [INLINE, RANGED];
        expect(charts.map(boxOf)).toEqual(written.map(boxOf));
        expect(charts.map((chart) => readChartSpec(chart).spec).map((spec) => spec && seriesIdsByPlace(spec))).toEqual(
            written.map((chart) => readChartSpec(chart).spec),
        );
    });

    test("a chart's background, label colour and stroke read back as they were; one without a look reads flat", () => {
        const look = { fill: solidFill('#fafaf0'), color: '#112233', strokeColor: '#44556680', strokeWidth: 3 };
        const styled: Sheet = { ...SUMMARY, charts: byId(INLINE, { ...RANGED, ...look }) };
        const { sheets } = roundTrip([styled, MY_DATA]);
        const [inline, ranged] = Object.values(sheets[0].charts ?? {}).sort((a, b) => a.index.localeCompare(b.index));
        expect(ranged).toMatchObject(look);
        const { fill, color, strokeColor, strokeWidth } = FLAT_CHART_LOOK;
        expect(inline).toMatchObject({ fill, color, strokeColor, strokeWidth });
    });

    test("a line series' own width reads back as it was, the axes keeping theirs", () => {
        const look = { strokeWidth: 1, seriesStrokeWidth: 3 };
        const { sheets } = roundTrip([{ ...SUMMARY, charts: byId({ ...INLINE, ...look }) }, MY_DATA]);
        expect(Object.values(sheets[0].charts ?? {})).toEqual([expect.objectContaining(look)]);
    });

    test('a two-cell anchor names the cells its corners land in, past hidden tracks', () => {
        const drawing = drawingOf(SUMMARY, 1, [SUMMARY, MY_DATA], noPictures(), () => {});
        const root = drawing && parseOoxml(xml(drawing.parts[0]));
        if (!root) throw new Error('no drawing');
        const corners = xmlElements(root).map(cellsOf);
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
        const write = () => drawingOf(SUMMARY, 3, [SUMMARY, MY_DATA], noPictures(), () => {});
        const drawing = write();
        expect(drawing?.path).toBe('xl/drawings/drawing3.xml');
        expect(drawing?.parts.map(([path, , type]) => [path, type])).toEqual([
            ['xl/drawings/drawing3.xml', DRAWING_CONTENT_TYPE],
            ['xl/drawings/_rels/drawing3.xml.rels', undefined],
            ['xl/charts/chart3_1.xml', CHART_CONTENT_TYPE],
            ['xl/charts/chart3_2.xml', CHART_CONTENT_TYPE],
        ]);
        expect(drawing?.parts.map(xml)).toEqual(write()?.parts.map(xml));
        expect(drawing && xml(drawing.parts[1])).toContain('Target="../charts/chart3_1.xml"');
    });

    test("a chart whose spec doesn't parse is left out and counted, and a sheet without charts has no drawing", () => {
        const lost: CountedWarningCode[] = [];
        const broken: Sheet = { ...SUMMARY, charts: byId({ ...INLINE, id: 'bad', specChart: '{' }) };
        expect(drawingOf(broken, 1, [broken], noPictures(), (code) => lost.push(code))).toBeUndefined();
        expect(lost).toEqual(['charts-dropped']);
        expect(drawingOf(MY_DATA, 2, [MY_DATA], noPictures(), () => {})).toBeUndefined();
        const mixed: Sheet = { ...SUMMARY, charts: { ...SUMMARY.charts, ...broken.charts } };
        expect(drawingOf(mixed, 1, [mixed, MY_DATA], noPictures(), (code) => lost.push(code))?.parts).toHaveLength(4);
        expect(lost).toEqual(['charts-dropped', 'charts-dropped']);
    });

    test('a chart whose look no chart part paints, or that Sheets turns, is counted once, a flat one not', () => {
        const hatched = solidFill('#ff0000', 'hachure');
        const lostFor = (look: Partial<SheetChart>) => {
            const lost: CountedWarningCode[] = [];
            const sheet: Sheet = { ...SUMMARY, charts: byId({ ...INLINE, ...look }) };
            drawingOf(sheet, 1, [sheet], noPictures(), (code) => lost.push(code));
            return lost;
        };
        expect(lostFor({})).toEqual([]);
        const gradient = serializeFill({ type: 'gradient', from: '#000000', to: '#ffffff', angle: 0, style: 'solid' });
        for (const look of [
            { roughness: 1 },
            { fill: hatched },
            { fill: gradient },
            { strokeStyle: 'dashed' as const },
            { angle: 30 },
        ]) {
            expect(lostFor(look)).toEqual(['charts-simplified']);
        }
        expect(lostFor({ roughness: 2, strokeStyle: 'dotted', fill: hatched, angle: 90 })).toEqual([
            'charts-simplified',
        ]);
    });

    // B2:B4 resolves to three slices; a whole column, an area and one point too many resolve to none.
    test.each([
        ['B2:B4', range([1, 3], [1, 1]), 3],
        ['a whole column', range([0, REFERENCE_ROW_COUNT - 1], [1, 1]), 0],
        ['an area', range([1, 3], [0, 1]), 0],
        ['one point too many', range([0, MAX_CHART_POINTS], [1, 1]), 0],
    ])('a pie over %s writes a slice per point its cells resolve to', (_, values, slices) => {
        const spec = newSheetChartSpecParts({
            ...sampleChartSpec('pie'),
            data: {
                source: 'range',
                categories: null,
                series: [{ id: 's-1', name: 'Sales', values }],
            },
        });
        const pie: Sheet = { ...SUMMARY, charts: byId({ ...RANGED, ...spec }) };
        const drawing = drawingOf(pie, 1, [pie, MY_DATA], noPictures(), () => {});
        const part = drawing ? xml(drawing.parts[2]) : '';
        expect(part.match(/<c:dPt>/g)?.length ?? 0).toBe(slices);
        expect(part.length).toBeLessThan(10_000);
    });

    test("a chart naming a sheet the workbook doesn't hold keeps its other refs", () => {
        const { sheets } = roundTrip([SUMMARY]);
        const ranged = Object.values(sheets[0].charts ?? {}).find((chart) => chart.y === 30);
        expect((ranged && readChartSpec(ranged).spec)?.data).toMatchObject({ source: 'range', categories: null });
    });
});

describe('a picture', () => {
    test('is an xdr:pic over its cells in paint order among the charts, turned as it turns, related once', () => {
        const lost: CountedWarningCode[] = [];
        const gone: SheetImage = { ...BELOW, id: 'gone', index: 'a3', mediaName: 'gone.png' };
        const sheet: Sheet = { ...SUMMARY, images: { below: BELOW, above: ABOVE, gone } };
        const pictures = officeImages([PNG], 'xl/media');
        const drawing = drawingOf(sheet, 1, [sheet, MY_DATA], pictures, (code) => lost.push(code));
        const root = drawing && parseOoxml(xml(drawing.parts[0]));
        if (!root) throw new Error('no drawing');
        expect(lost).toEqual(['images-dropped']);
        const shapes = xmlElements(root).map((anchor) => xmlElements(anchor)[2]);
        expect(shapes.map((shape) => shape.local)).toEqual(['graphicFrame', 'pic', 'graphicFrame', 'pic']);
        const ids = shapes.map((shape) => descendant(shape, XDR_NS, 'cNvPr')?.attributes['id']);
        expect(ids).toEqual(['2', '3', '4', '5']);
        const xfrms = [shapes[1], shapes[3]].map((shape) => descendant(shape, A_NS, 'xfrm')?.attributes);
        expect(xfrms.map((attributes) => attributes?.['rot'])).toEqual([undefined, String(30 * 60_000)]);
        const embeds = [shapes[1], shapes[3]].map((shape) => descendant(shape, A_NS, 'blip')?.attributes['r:embed']);
        expect(embeds).toEqual(['rId2', 'rId2']);
        // The picture's corners, as a chart's: from 20 px into A and 10 into row 1 to 80 into A and 20 into the 40 px row 2.
        expect(cellsOf(xmlElements(root)[1])).toEqual([
            [0, 20, 0, 10],
            [0, 80, 1, 20],
        ]);
        expect(pictures.files.map(({ name }) => name)).toEqual(['xl/media/image1.png']);
        const rels = xml(drawing.parts[1]);
        expect(rels).toContain(`Id="rId2" Type="${R}/image" Target="../media/image1.png"`);
    });

    test("an SVG goes in beside its PNG as the svgBlip, and a type Excel can't embed is left out and counted", () => {
        const lost: CountedWarningCode[] = [];
        const drawn: SheetImage = { ...BELOW, mediaName: 'drawing.svg' };
        const webp: SheetImage = { ...BELOW, id: 'webp', index: 'a1', mediaName: 'still.webp' };
        const sheet: Sheet = { name: 'Pictures', images: { below: drawn, webp } };
        const pictures = officeImages([SVG, { ...PNG, name: 'still.webp', contentType: 'image/webp' }], 'xl/media');
        const drawing = drawingOf(sheet, 2, [sheet], pictures, (code) => lost.push(code));
        expect(lost).toEqual(['images-dropped']);
        expect(pictures.files.map(({ name }) => name)).toEqual(['xl/media/image1.png', 'xl/media/image1.svg']);
        const part = drawing ? xml(drawing.parts[0]) : '';
        expect(part).toContain('<a:blip r:embed="rId2"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">');
        expect(part).toContain('r:embed="rId1"/>');
    });

    test('turned sideways, is anchored over its box turned a quarter, as Excel and LibreOffice place it', () => {
        const upright: SheetImage = { ...BELOW, x: 100, y: 100, width: 200, height: 50, angle: 0 };
        const placed = (angle: number) => {
            const sheet: Sheet = { name: 'Pictures', images: { below: { ...upright, angle } } };
            const drawing = drawingOf(sheet, 1, [sheet], officeImages([PNG], 'xl/media'), () => {});
            const root = drawing && parseOoxml(xml(drawing.parts[0]));
            if (!root) throw new Error('no drawing');
            const [anchor] = xmlElements(root);
            const xfrm = descendant(anchor, A_NS, 'xfrm');
            const ext = xfrm && descendant(xfrm, A_NS, 'ext');
            return [cellsOf(anchor), [ext?.attributes['cx'], ext?.attributes['cy']].map(Number)];
        };
        // 200 by 50 about (200, 125): upright from B6 to 10 px into D8; a quarter turn 50 by 200, from 75 px into B and 5
        // into row 2 to 25 px into C and 5 into row 12.
        expect(placed(30)).toEqual(placed(0));
        expect(placed(0)).toEqual([
            [
                [1, 0, 5, 0],
                [3, 0, 7, 10],
            ],
            [200 * EMU_PER_PX, 50 * EMU_PER_PX],
        ]);
        expect(placed(90)).toEqual([
            [
                [1, 75, 1, 5],
                [2, 25, 11, 5],
            ],
            [50 * EMU_PER_PX, 200 * EMU_PER_PX],
        ]);
        expect(placed(250)).toEqual(placed(90));
    });

    test('a sheet of pictures only has a drawing, and one whose media is all missing none', () => {
        const sheet: Sheet = { name: 'Pictures', images: { below: BELOW } };
        expect(drawingOf(sheet, 1, [sheet], officeImages([PNG], 'xl/media'), () => {})?.parts).toHaveLength(2);
        expect(drawingOf(sheet, 1, [sheet], noPictures(), () => {})).toBeUndefined();
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
        const bytes = exportXlsx([summary, stored], { warnings });
        expect(warnings).toEqual([{ code: 'charts-simplified', count: 1 }]);
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
        expect(charts.map((chart) => readChartSpec(chart).spec).map((spec) => spec && seriesIdsByPlace(spec))).toEqual(
            [INLINE, turned].map((chart) => readChartSpec(chart).spec),
        );
    });

    test('a chart names its sheet as the workbook writes it, and stacks in paint order among the images', async () => {
        const image = { id: 'picture', index: 'a0V', x: 0, y: 0, width: 10, height: 10, mediaName: 'a.png' };
        const summary: Sheet = { ...SUMMARY, images: { picture: image } };
        const history: Sheet = { ...stored, name: 'History' };
        const [read] = xlsxToSheets(exportXlsx([summary, history]));
        const charts = Object.values(read.charts ?? {}).sort((a, b) => a.index.localeCompare(b.index));
        expect(charts.map(boxOf)).toEqual([INLINE, RANGED].map(boxOf));
        expect(readChartSpec(charts[1]).spec?.data).toMatchObject({
            source: 'range',
            categories: { row: [1, 3], column: [0, 0] },
        });
    });
});

describe('pictures read back by the import', () => {
    test('keep their box, their turn, their bytes and their place among the charts', async () => {
        const sideways: SheetImage = {
            ...BELOW,
            id: 'sideways',
            index: 'a3',
            x: 300,
            y: 200,
            width: 120,
            height: 40,
            angle: 90,
        };
        const drawn: SheetImage = { ...BELOW, id: 'drawn', index: 'a4', mediaName: 'drawing.svg', angle: 200 };
        const summary: Sheet = { ...SUMMARY, images: { below: BELOW, above: ABOVE, sideways, drawn } };
        const warnings: TransformWarning[] = [];
        const bytes = exportXlsx([summary, MY_DATA], { media: [PNG, SVG], warnings });
        expect(warnings).toEqual([]);
        const { sheets, media } = readXlsx(bytes, { maxMediaBytes: 1024 * 1024 });
        const items = floatingItems(sheets[0]);
        expect(items.map(({ kind, object }) => [kind, boxOf(object), object.angle ?? 0])).toEqual([
            ['chart', boxOf(INLINE), 0],
            ['image', boxOf(BELOW), 0],
            ['chart', boxOf(RANGED), 0],
            ['image', boxOf(ABOVE), 30],
            ['image', boxOf(sideways), 90],
            ['image', boxOf(drawn), 200],
        ]);
        const named = new Map(media.map((item) => [item.name, item]));
        const bytesOf = (object: SheetFloatingObject) =>
            'mediaName' in object && typeof object.mediaName === 'string'
                ? [...(named.get(object.mediaName)?.data ?? [])]
                : [];
        expect(items.filter(({ kind }) => kind === 'image').map(({ object }) => bytesOf(object))).toEqual([
            [...PIXEL_PNG],
            [...PIXEL_PNG],
            [...PIXEL_PNG],
            [...new Uint8Array(SVG.data)],
        ]);
        expect(media.map(({ contentType }) => contentType)).toEqual(['image/png', 'image/svg+xml']);
    });
});

// An anchor's corners, each a cellOf.
function cellsOf(anchor: XmlElement): number[][] {
    return xmlElements(anchor)
        .filter((corner) => hasXmlName(corner, XDR_NS, 'from') || hasXmlName(corner, XDR_NS, 'to'))
        .map(cellOf);
}

function descendant(element: XmlElement, ns: string, local: string): XmlElement | undefined {
    for (const child of xmlElements(element)) {
        if (hasXmlName(child, ns, local)) return child;
        const found = descendant(child, ns, local);
        if (found) return found;
    }
    return undefined;
}

// A corner's column, its offset in px, its row and its offset.
function cellOf(corner: XmlElement): number[] {
    const value = (local: string) => {
        const found = xmlElements(corner).find((element) => hasXmlName(element, XDR_NS, local));
        return Number(found && xmlTrimmedText(found));
    };
    return [value('col'), value('colOff') / EMU_PER_PX, value('row'), value('rowOff') / EMU_PER_PX];
}
