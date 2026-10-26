// A sheet part around its grid: the tab color, the view with its frozen pane and gridlines, the default sizes, the
// columns, the filter's span, the merges, the rules, the links and the drawing, in the order CT_Worksheet sets, since
// Excel repairs a file that breaks it.

import { pxToPt } from '@workspace/lib/docs/eigendoc';
import type { Sheet } from '@workspace/lib/sheets';
import {
    parseCellKey,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    SHEET_DEFAULT_DIGIT_WIDTH,
    sheetDefaultColWidth,
    sheetDefaultRowHeight,
} from '@workspace/lib/sheets';
import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import { escapeXml } from '@workspace/lib/xml';
import { parseA1Range, quoteSheetName, rangeToA1, toA1, unquoteSheetName } from '@workspace/sheet/engine';
import { R_NS, SML_NS } from '../../../ooxml/ooxml';
import type { Relationship } from '../../../ooxml/opc';
import { uriReference } from '../../../ooxml/opc';
import { MAX_SHEET_LINKS, pxToColumnWidth } from '../../../ooxml/spreadsheetml';
import type { GridContext } from './cells';
import { inGrid, keyOf, sheetGrid } from './cells';
import { rulesXml } from './rules';
import { argbOf } from './styles';

export type WorksheetContext = GridContext & {
    // As the workbook names it.
    name: string;
    // The name the workbook gives each sheet, by the name it has here.
    names: ReadonlyMap<string, string>;
    selected: boolean;
    // The drawing relationship's target, when the sheet floats anything.
    drawing?: string;
};

// The area a sheet's filter spans, within Excel's grid.
export function filterArea(sheet: Sheet): { row: [number, number]; column: [number, number] } | undefined {
    const { row, column } = sheet.filterRange ?? {};
    const bound = (values: number[] | undefined, count: number) =>
        values?.length === 2 && values.every((value) => Number.isInteger(value) && value >= 0)
            ? ([Math.min(...values), Math.min(Math.max(...values), count - 1)] satisfies [number, number])
            : undefined;
    const rows = bound(row, REFERENCE_ROW_COUNT);
    const columns = bound(column, REFERENCE_COLUMN_COUNT);
    return rows && columns ? { row: rows, column: columns } : undefined;
}

const PAGE_MARGINS = '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';

// The links are read up front, as their relationships are part of the package before the sheet is written.
export function worksheetPart(
    sheet: Sheet,
    context: WorksheetContext,
): { xml: () => Generator<string>; relationships: Relationship[] } {
    // The drawing is the first relationship, and each link takes the next id.
    const drawingId = 'rId1';
    const relationships: Relationship[] = context.drawing ? [{ type: `${R_NS}/drawing`, target: context.drawing }] : [];
    const links = linksXml(sheet, context, relationships);
    function* xml(): Generator<string> {
        const grid = sheetGrid(sheet, context);
        const tabColor = sheet.color ? argbOf(sheet.color) : undefined;
        yield [
            `<worksheet xmlns="${SML_NS}" xmlns:r="${R_NS}">`,
            tabColor ? `<sheetPr><tabColor rgb="${tabColor}"/></sheetPr>` : '',
            `<dimension ref="${grid.dimension}"/>`,
            viewsXml(sheet, context.selected),
            `<sheetFormatPr defaultColWidth="${pxToColumnWidth(sheetDefaultColWidth(sheet), SHEET_DEFAULT_DIGIT_WIDTH)}" defaultRowHeight="${pxToPt(sheetDefaultRowHeight(sheet))}" customHeight="1"/>`,
            colsXml(sheet),
            '<sheetData>',
        ].join('');
        yield* grid.rows();
        const filter = filterArea(sheet);
        yield [
            '</sheetData>',
            filter ? `<autoFilter ref="${rangeToA1(filter)}"/>` : '',
            mergesXml(sheet),
            rulesXml(sheet, context.styles, context.lost),
            links,
            PAGE_MARGINS,
            context.drawing ? `<drawing r:id="${drawingId}"/>` : '',
            '</worksheet>',
        ].join('');
    }
    return { xml, relationships };
}

// One view: Excel honors only the first. A frozen pane splits after the last frozen row and column.
function viewsXml(sheet: Sheet, selected: boolean): string {
    const attributes = `${sheet.showGridLines === false || sheet.showGridLines === 0 ? ' showGridLines="0"' : ''}${selected ? ' tabSelected="1"' : ''} workbookViewId="0"`;
    const { type, range } = sheet.frozen ?? {};
    const rows =
        type === 'row' || type === 'both' || type === 'rangeRow' || type === 'rangeBoth'
            ? Math.min((range?.row_focus ?? 0) + 1, REFERENCE_ROW_COUNT - 1)
            : 0;
    const columns =
        type === 'column' || type === 'both' || type === 'rangeColumn' || type === 'rangeBoth'
            ? Math.min((range?.column_focus ?? 0) + 1, REFERENCE_COLUMN_COUNT - 1)
            : 0;
    if (!(rows > 0) && !(columns > 0)) return `<sheetViews><sheetView${attributes}/></sheetViews>`;
    const pane = rows > 0 && columns > 0 ? 'bottomRight' : rows > 0 ? 'bottomLeft' : 'topRight';
    const splits = `${columns > 0 ? ` xSplit="${columns}"` : ''}${rows > 0 ? ` ySplit="${rows}"` : ''}`;
    return `<sheetViews><sheetView${attributes}><pane${splits} topLeftCell="${toA1(rows, columns)}" activePane="${pane}" state="frozen"/><selection pane="${pane}"/></sheetView></sheetViews>`;
}

// Columns of one width and one hidden flag are one <col>. A hidden column without a width of its own has none.
function colsXml(sheet: Sheet): string {
    const { columnlen = {}, colhidden = {} } = sheet.config ?? {};
    const columns = [...new Set([...Object.keys(columnlen), ...Object.keys(colhidden)].map(Number))]
        .filter((column) => Number.isInteger(column) && column >= 0 && column < REFERENCE_COLUMN_COUNT)
        .sort((a, b) => a - b);
    const attributesOf = (column: number) => {
        const px = Number(columnlen[column]);
        const width =
            px > 0 && Number.isFinite(px)
                ? ` width="${pxToColumnWidth(px, SHEET_DEFAULT_DIGIT_WIDTH)}" customWidth="1"`
                : '';
        return `${width}${colhidden[column] != null ? ' hidden="1"' : ''}`;
    };
    const runs: string[] = [];
    for (let index = 0; index < columns.length; ) {
        const min = columns[index];
        const attributes = attributesOf(min);
        let max = min;
        while (columns[index + 1] === max + 1 && attributesOf(max + 1) === attributes) max = columns[++index];
        index++;
        if (attributes) runs.push(`<col min="${min + 1}" max="${max + 1}"${attributes}/>`);
    }
    return runs.length > 0 ? `<cols>${runs.join('')}</cols>` : '';
}

function mergesXml(sheet: Sheet): string {
    const refs = Object.values(sheet.config?.merge ?? {}).flatMap(({ r, c, rs = 1, cs = 1 }) => {
        const valid = [r, c, rs, cs].every(Number.isInteger) && r >= 0 && c >= 0 && rs >= 1 && cs >= 1;
        if (!valid || (rs === 1 && cs === 1) || r >= REFERENCE_ROW_COUNT || c >= REFERENCE_COLUMN_COUNT) return [];
        const bottom = Math.min(r + rs, REFERENCE_ROW_COUNT) - 1;
        const right = Math.min(c + cs, REFERENCE_COLUMN_COUNT) - 1;
        return [`<mergeCell ref="${rangeToA1({ row: [r, bottom], column: [c, right] })}"/>`];
    });
    return refs.length > 0 ? `<mergeCells count="${refs.length}">${refs.join('')}</mergeCells>` : '';
}

// A link is independent of its cell's value: a web address is an external relationship, a place in the workbook a
// location, labelled by the cell's text as Excel and Google label one. A sheet the workbook renamed is named as written;
// a `sheet` link to a name no sheet holds is a defined name's, as the import reads a location without a cell.
function linksXml(sheet: Sheet, context: WorksheetContext, relationships: Relationship[]): string {
    const entries = Object.entries(sheet.hyperlink ?? {});
    if (entries.length === 0) return '';
    const linked = new Set(
        entries.map(([key]) => {
            const [r, c] = parseCellKey(key);
            return keyOf(r, c);
        }),
    );
    const shown = new Map<number, string>();
    for (const { r, c, v } of sheet.celldata ?? []) {
        const key = keyOf(r, c);
        if (!v || !linked.has(key)) continue;
        const text = v.ct?.s ? v.ct.s.map((run) => run.v ?? '').join('') : String(v.m ?? v.v ?? '');
        shown.set(key, text);
    }
    const renamed = (name: string) => quoteSheetName(context.names.get(name) ?? name);
    const items: string[] = [];
    for (const [key, { linkType, linkAddress }] of entries) {
        const [r, c] = parseCellKey(key);
        if (!inGrid(r, c)) continue;
        const ref = toA1(r, c);
        const location =
            linkType === 'sheet'
                ? context.names.has(linkAddress)
                    ? `${renamed(linkAddress)}!A1`
                    : linkAddress
                : linkType === 'cellrange'
                  ? cellrangeLocation(linkAddress, context)
                  : undefined;
        const target = linkType === 'webpage' ? resolveWebLink(linkAddress) : null;
        // An address no editor opens, a script's among them, or a range that is none.
        if ((location === undefined && target === null) || items.length >= MAX_SHEET_LINKS) {
            context.lost('links-dropped');
            continue;
        }
        if (target !== null) {
            relationships.push({ type: `${R_NS}/hyperlink`, target: uriReference(target), external: true });
            items.push(`<hyperlink ref="${ref}" r:id="rId${relationships.length}"/>`);
        } else {
            const display = shown.get(keyOf(r, c)) || linkAddress;
            items.push(
                `<hyperlink ref="${ref}" location="${escapeXml(location ?? '')}" display="${escapeXml(display)}"/>`,
            );
        }
    }
    return items.length > 0 ? `<hyperlinks>${items.join('')}</hyperlinks>` : '';
}

// Stored as written in the editor or the file: a sheet's prefix, quoted or bare, and a cell or a range; a bare ref is the
// sheet's own.
function cellrangeLocation(address: string, { name: own, names }: WorksheetContext): string | undefined {
    const quoted = address.match(/^('(?:[^']|'')*')!(.+)$/);
    const bang = address.lastIndexOf('!');
    const [prefix, ref] = quoted
        ? [quoted[1], quoted[2]]
        : bang >= 0
          ? [address.slice(0, bang), address.slice(bang + 1)]
          : [undefined, address];
    const range = parseA1Range(ref);
    if (!range || range.sheet !== undefined) return undefined;
    if (prefix === undefined) return `${quoteSheetName(own)}!${ref}`;
    const name = unquoteSheetName(prefix);
    const written = names.get(name);
    return `${written !== undefined && written !== name ? quoteSheetName(written) : prefix}!${ref}`;
}
