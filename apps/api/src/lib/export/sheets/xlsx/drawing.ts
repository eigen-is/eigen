import { parseChartSpec, readChartLook } from '@workspace/lib/charts';
import { floatingItems, type Sheet, type SheetChart, sheetFloatingBox, sheetTrackAt } from '@workspace/lib/sheets';
import { type CellResolver, createArrayResolver, resolveRangeChartData } from '@workspace/sheet/engine';
import { A_NS, C_NS, EMU_PER_PX, R_NS, XDR_NS } from '../../../core/ooxml';
import { CHART_CONTENT_TYPE } from '../../../core/ooxml-chart';
import { writeChart } from '../../../core/ooxml-chart-writer';
import { type PackagePart, type Relationship, relationshipsXml, relsPathOf } from '../../../core/opc';
import type { ZipWriteEntry } from '../../../core/zip';
import type { CountedWarningCode } from '../../../document/transform/protocol';

// A sheet's floating charts and pictures as its drawing part: the path its <drawing> relationship targets, the parts the
// drawing adds to the package (itself, its relationships and its charts) and its media files.
export type SheetDrawing = { path: string; parts: PackagePart[]; files: ZipWriteEntry[] };

export const DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml';

// The workbook's sheets resolve a chart's ranges, by the names they are written under; `number` names the sheet's
// drawing and chart parts. Each chart is a two-cell anchor over the cells its box covers in paint order, so the import
// (import/sheets/drawing.ts) lands it on the same pixels. A chart whose spec doesn't parse is left out and counted; a
// rotated one is written upright, as Excel turns no chart. Its look goes as far as Excel draws one: background, label
// colour and stroke; hatch, stroke style and sketch don't. Floating images are not written yet. Undefined when the sheet
// floats nothing.
export function drawingOf(
    sheet: Sheet,
    number: number,
    sheets: Sheet[],
    lost: (code: CountedWarningCode) => void,
): SheetDrawing | undefined {
    const names = new Map<string, string>();
    for (const { id, name } of sheets) if (!names.has(id ?? name)) names.set(id ?? name, name);
    const ranges = (sheetId: string) => names.get(sheetId);
    let resolver: CellResolver | undefined;
    const anchors: string[] = [];
    const rels: Relationship[] = [];
    const charts: PackagePart[] = [];
    for (const item of floatingItems(sheet)) {
        if (item.kind !== 'chart') continue;
        const chart = item.object;
        const spec = parseChartSpec(chart.spec);
        if (!spec) {
            lost('charts-dropped');
            continue;
        }
        resolver ??= resolverOf(sheets);
        const data = spec.data.source === 'range' ? resolveRangeChartData(spec.data, resolver) : undefined;
        const name = `chart${number}_${charts.length + 1}.xml`;
        charts.push([
            `xl/charts/${name}`,
            writeChart(spec, {
                ranges,
                cache: typeof data === 'object' ? data : undefined,
                look: readChartLook(chart),
            }),
            CHART_CONTENT_TYPE,
        ]);
        rels.push({ type: `${R_NS}/chart`, target: `../charts/${name}` });
        anchors.push(anchorXml(sheet, chart, rels.length));
    }
    if (anchors.length === 0) return undefined;
    const path = `xl/drawings/drawing${number}.xml`;
    const drawing = `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:c="${C_NS}">${anchors.join('')}</xdr:wsDr>`;
    return {
        path,
        parts: [[path, drawing, DRAWING_CONTENT_TYPE], [relsPathOf(path), relationshipsXml(rels)], ...charts],
        files: [],
    };
}

// A chart's cells as the export's grid reads them: the dense data every sheet carries once materialized.
function resolverOf(sheets: Sheet[]): CellResolver {
    return createArrayResolver(
        sheets.map((sheet) => ({
            id: sheet.id ?? sheet.name,
            name: sheet.name,
            data: sheet.data ?? null,
            calculationChain: [],
            dynamicArrayCompute: [],
        })),
    );
}

// Moves with its cells and keeps its size, as Eigen's chart does. `place` is the anchor's rId and, from 2, its shape id.
function anchorXml(sheet: Sheet, chart: SheetChart, place: number): string {
    const { x, y, width, height } = sheetFloatingBox(chart);
    const corner = (tag: string, left: number, top: number) => {
        const column = sheetTrackAt(sheet, 'column', left);
        const row = sheetTrackAt(sheet, 'row', top);
        const emu = (px: number) => Math.round(px * EMU_PER_PX);
        return `<xdr:${tag}><xdr:col>${column.index}</xdr:col><xdr:colOff>${emu(column.offsetPx)}</xdr:colOff><xdr:row>${row.index}</xdr:row><xdr:rowOff>${emu(row.offsetPx)}</xdr:rowOff></xdr:${tag}>`;
    };
    const frame = [
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${place + 1}" name="Chart ${place}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`,
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>',
        `<a:graphic><a:graphicData uri="${C_NS}"><c:chart r:id="rId${place}"/></a:graphicData></a:graphic></xdr:graphicFrame>`,
    ].join('');
    return `<xdr:twoCellAnchor editAs="oneCell">${corner('from', x, y)}${corner('to', x + width, y + height)}${frame}<xdr:clientData/></xdr:twoCellAnchor>`;
}
