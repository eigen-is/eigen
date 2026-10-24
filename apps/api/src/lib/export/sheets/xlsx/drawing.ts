import { parseChartSpec, readChartLook } from '@workspace/lib/charts';
import type { Sheet, SheetFloatingObject } from '@workspace/lib/sheets';
import { floatingItems, sheetFloatingBox, sheetTrackAt } from '@workspace/lib/sheets';
import { normalizeAngle } from '@workspace/lib/vector';
import type { CellResolver } from '@workspace/sheet/engine';
import { resolveRangeChartData } from '@workspace/sheet/engine';
import type { CountedWarningCode } from '../../../document/transform/protocol';
import { anchoredBox, blipXml, DEGREE } from '../../../ooxml/drawingml';
import { A_NS, C_NS, EMU_PER_PX, R_NS, XDR_NS } from '../../../ooxml/ooxml';
import { CHART_CONTENT_TYPE } from '../../../ooxml/ooxml-chart';
import { writeChart } from '../../../ooxml/ooxml-chart-writer';
import type { PackagePart } from '../../../ooxml/opc';
import { partRelationships, relationshipsXml, relsPathOf } from '../../../ooxml/opc';
import { DRAWING_CONTENT_TYPE } from '../../../ooxml/spreadsheetml';
import type { OfficeImages } from '../../office-image';
import { sheetsResolver } from '../cell-style';

// A sheet's floating charts and pictures as its drawing part: the path its <drawing> relationship targets, and the parts
// the drawing adds to the package (itself, its relationships and its charts).
export type SheetDrawing = { path: string; parts: PackagePart[] };

// The workbook's sheets resolve a chart's ranges, by the names they are written under; `number` names the sheet's
// drawing and chart parts. Each chart and picture is a two-cell anchor over the cells its box covers, in paint order, so
// the import (import/sheets/drawing.ts) lands it on the same pixels. A chart whose spec doesn't parse is left out and
// counted; a rotated one is written upright, as Excel turns no chart. Its look goes as far as Excel draws one:
// background, label colour and stroke; hatch, stroke style and sketch don't. A picture keeps its turn; one whose media
// the transform has no raster for, missing or unreadable, is left out and counted. Undefined when the sheet floats
// nothing.
export function drawingOf(
    sheet: Sheet,
    number: number,
    sheets: Sheet[],
    pictures: OfficeImages,
    lost: (code: CountedWarningCode) => void,
): SheetDrawing | undefined {
    const names = new Map<string, string>();
    for (const { id, name } of sheets) if (!names.has(id ?? name)) names.set(id ?? name, name);
    const ranges = (sheetId: string) => names.get(sheetId);
    let resolver: CellResolver | undefined;
    const anchors: string[] = [];
    const { relationships, relate } = partRelationships();
    const charts: PackagePart[] = [];
    for (const item of floatingItems(sheet)) {
        // Excel numbers a drawing's shapes from 2.
        const id = anchors.length + 2;
        if (item.kind === 'image') {
            const { mediaName } = item.object;
            const image = pictures.image(mediaName);
            if (!image) {
                lost('images-dropped');
                continue;
            }
            const svg = image.svgPart && relate('image', `../media/${image.svgPart}`);
            const blip = blipXml(relate('image', `../media/${image.part}`), svg);
            const placed = placedBox(item.object);
            anchors.push(anchorXml(sheet, placed, pictureXml(placed, id, blip)));
            continue;
        }
        const chart = item.object;
        const spec = parseChartSpec(chart.spec);
        if (!spec) {
            lost('charts-dropped');
            continue;
        }
        resolver ??= sheetsResolver(sheets);
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
        const frame = chartFrameXml(id, relate('chart', `../charts/${name}`));
        anchors.push(anchorXml(sheet, placedBox({ ...chart, angle: 0 }), frame));
    }
    if (anchors.length === 0) return undefined;
    const path = `xl/drawings/drawing${number}.xml`;
    const drawing = `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:c="${C_NS}">${anchors.join('')}</xdr:wsDr>`;
    return {
        path,
        parts: [[path, drawing, DRAWING_CONTENT_TYPE], [relsPathOf(path), relationshipsXml(relationships)], ...charts],
    };
}

type Placed = { x: number; y: number; width: number; height: number; angle: number };

// Where Excel places a floating object: its box, and for a picture turned sideways the box turned a quarter, as Excel
// and LibreOffice read it (anchoredBox), held to the grid.
function placedBox(object: SheetFloatingObject): Placed {
    const box = sheetFloatingBox(object);
    const { x, y, width, height } = anchoredBox(box, box.angle);
    return { x: Math.max(0, x), y: Math.max(0, y), width, height, angle: box.angle };
}

// Moves with its cells and keeps its size, as Eigen's floating objects do.
function anchorXml(sheet: Sheet, { x, y, width, height }: Placed, content: string): string {
    const corner = (tag: string, left: number, top: number) => {
        const column = sheetTrackAt(sheet, 'column', left);
        const row = sheetTrackAt(sheet, 'row', top);
        return `<xdr:${tag}><xdr:col>${column.index}</xdr:col><xdr:colOff>${toEmu(column.offsetPx)}</xdr:colOff><xdr:row>${row.index}</xdr:row><xdr:rowOff>${toEmu(row.offsetPx)}</xdr:rowOff></xdr:${tag}>`;
    };
    return `<xdr:twoCellAnchor editAs="oneCell">${corner('from', x, y)}${corner('to', x + width, y + height)}${content}<xdr:clientData/></xdr:twoCellAnchor>`;
}

function toEmu(px: number): number {
    return Math.round(px * EMU_PER_PX);
}

function chartFrameXml(id: number, rId: string): string {
    return [
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Chart ${id - 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`,
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>',
        `<a:graphic><a:graphicData uri="${C_NS}"><c:chart r:id="${rId}"/></a:graphicData></a:graphic></xdr:graphicFrame>`,
    ].join('');
}

// Stretched over its box, as the editor draws it, and turned clockwise as Eigen turns it, in 60,000ths of a degree. The
// transform states the anchor's box, which LibreOffice sizes the picture by.
function pictureXml({ x, y, width, height, angle }: Placed, id: number, blip: string): string {
    const rot = Math.round(normalizeAngle(angle) * DEGREE);
    return [
        `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${id - 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`,
        `<xdr:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`,
        `<xdr:spPr><a:xfrm${rot ? ` rot="${rot}"` : ''}><a:off x="${toEmu(x)}" y="${toEmu(y)}"/><a:ext cx="${toEmu(width)}" cy="${toEmu(height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`,
    ].join('');
}
