// A worksheet past its grid: the default column width and row height, the tab colour, the column widths and hidden
// columns, the merges, the frozen panes and gridlines, the filter's span and the hyperlinks. A merge's cells and a
// link's cell are placed before the grid is read, so the grid's cell there takes them, and a place the grid holds no
// cell for still gets one. Only what the file holds is walked: a merge's cells after its area is charged, a column
// range's columns after they are, and each column once.

import { ptToPx } from '@workspace/lib/docs/eigendoc';
import type { Sheet, SheetConfig } from '@workspace/lib/sheets';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { parseA1Range, unquoteSheetName } from '@workspace/sheet/engine';
import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlChild, xmlChildren } from '../../core/xml';
import { isOn, R_NS, SML_NS } from '../../ooxml/ooxml';
import type { Relationship } from '../../ooxml/opc';
import { columnWidthToPx, DEFAULT_BASE_COL_WIDTH, DEFAULT_ROW_HEIGHT_PT } from '../../ooxml/spreadsheetml';
import type { PlacedCell } from './cells';
import { cellKey } from './cells';
import type { ThemePalette } from './styles';
import { resolveColor } from './styles';

export type WorksheetContext = {
    // The sheet's id, which a linked cell's backref names.
    id: string;
    // The default font's widest digit, which a column width counts.
    digitWidth: number;
    // The sheet part's own.
    rels: ReadonlyMap<string, Relationship>;
    palette: ThemePalette;
    // Called with the cells and the characters each part emits; throws past the budget.
    charge(cells: number, text: number): void;
};

export type Worksheet = {
    config: Pick<SheetConfig, 'merge' | 'columnlen' | 'colhidden'>;
    sheet: Pick<
        Sheet,
        'defaultColWidth' | 'defaultRowHeight' | 'color' | 'hyperlink' | 'frozen' | 'showGridLines' | 'filterRange'
    >;
    // By cellKey, already charged.
    placed: Map<number, PlacedCell>;
};

export function readWorksheet(rest: XmlElement | undefined, context: WorksheetContext): Worksheet {
    const worksheet: Worksheet = {
        config: {},
        sheet: readDefaults(rest && xmlChild(rest, SML_NS, 'sheetFormatPr'), context.digitWidth),
        placed: new Map(),
    };
    if (!rest) return worksheet;
    const properties = xmlChild(rest, SML_NS, 'sheetPr');
    const color = resolveColor(properties && xmlChild(properties, SML_NS, 'tabColor'), context.palette);
    if (color) worksheet.sheet.color = color;
    readColumns(rest, context, worksheet.config);
    // Before the links, so a merge finds only merges placed.
    readMerges(rest, context, worksheet);
    readHyperlinks(rest, context, worksheet);
    const views = xmlChild(rest, SML_NS, 'sheetViews');
    const view = views && xmlChild(views, SML_NS, 'sheetView');
    if (view && isOn(xmlAttr(view, '', 'showGridLines')) === false) worksheet.sheet.showGridLines = false;
    const pane = view && xmlChild(view, SML_NS, 'pane');
    const state = pane && xmlAttr(pane, '', 'state');
    if (pane && (state === 'frozen' || state === 'frozenSplit')) {
        // ySplit freezes the top rows, xSplit the left columns; the range names the last frozen of each.
        const xSplit = Number.parseInt(xmlAttr(pane, '', 'xSplit') ?? '', 10) || 0;
        const ySplit = Number.parseInt(xmlAttr(pane, '', 'ySplit') ?? '', 10) || 0;
        if (xSplit > 0 || ySplit > 0)
            worksheet.sheet.frozen = {
                type: xSplit > 0 && ySplit > 0 ? 'rangeBoth' : ySplit > 0 ? 'rangeRow' : 'rangeColumn',
                range: {
                    row_focus: Math.min(Math.max(ySplit - 1, 0), REFERENCE_ROW_COUNT - 1),
                    column_focus: Math.min(Math.max(xSplit - 1, 0), REFERENCE_COLUMN_COUNT - 1),
                },
            };
    }
    // Only the span is read. A column's criteria need the editor's condition model, and a filter without them is what
    // the editor's own new filter holds.
    const autoFilter = xmlChild(rest, SML_NS, 'autoFilter');
    const filter = autoFilter && parseA1Range(xmlAttr(autoFilter, '', 'ref') ?? '');
    if (filter)
        worksheet.sheet.filterRange = {
            row: [filter.start.row, filter.end.row],
            column: [filter.start.col, filter.end.col],
        };
    return worksheet;
}

// Always set, so an Excel sheet keeps Excel's pitch: a file without sheetFormatPr has Excel's own defaults. defaultColWidth
// counts its padding already; without it Excel pads baseColWidth's digits with 4 px of margin and 1 px of gridline
// (ECMA-376 Part 1 § 18.3.1.81) and rounds up to a multiple of 8 px (support.microsoft.com/kb/214123).
function readDefaults(
    format: XmlElement | undefined,
    digitWidth: number,
): Pick<Sheet, 'defaultColWidth' | 'defaultRowHeight'> {
    const number = (name: string) => Number.parseFloat((format && xmlAttr(format, '', name)) ?? '');
    const width = number('defaultColWidth');
    const base = number('baseColWidth');
    const points = number('defaultRowHeight');
    return {
        defaultColWidth:
            width > 0
                ? columnWidthToPx(width, digitWidth)
                : Math.ceil(((base >= 0 ? base : DEFAULT_BASE_COL_WIDTH) * digitWidth + 5) / 8) * 8,
        defaultRowHeight: Math.round(ptToPx(points > 0 ? points : DEFAULT_ROW_HEIGHT_PT)),
    };
}

// By min, each column takes the first <col> that reaches it. A <col> without a width keeps the sheet's default width.
function readColumns(rest: XmlElement, context: WorksheetContext, config: Worksheet['config']): void {
    const bound = (col: XmlElement, name: string) => Number.parseInt(xmlAttr(col, '', name) ?? '', 10);
    const cols = xmlChildren(rest, SML_NS, 'cols')
        .flatMap((group) => xmlChildren(group, SML_NS, 'col'))
        .filter((col) => Number.isInteger(bound(col, 'min')) && Number.isInteger(bound(col, 'max')))
        .sort((a, b) => bound(a, 'min') - bound(b, 'min'));
    const columnlen: NonNullable<SheetConfig['columnlen']> = {};
    const colhidden: NonNullable<SheetConfig['colhidden']> = {};
    let next = 1;
    for (const col of cols) {
        const from = Math.max(bound(col, 'min'), next);
        const to = Math.min(bound(col, 'max'), REFERENCE_COLUMN_COUNT);
        next = Math.max(next, to + 1);
        const width = Number.parseFloat(xmlAttr(col, '', 'width') ?? '');
        const drawn = width > 0 ? columnWidthToPx(width, context.digitWidth) : 0;
        const pixels = drawn > 0 ? drawn : undefined;
        // A custom width that draws no pixel is a column Excel draws as none, as the editor draws a hidden one.
        const none = drawn === 0 && (width > 0 || isOn(xmlAttr(col, '', 'customWidth')) === true);
        const hidden = isOn(xmlAttr(col, '', 'hidden')) === true || none;
        if (from > to || (pixels === undefined && !hidden)) continue;
        context.charge(to - from + 1, 0);
        for (let column = from - 1; column < to; column++) {
            if (pixels !== undefined) columnlen[column] = pixels;
            if (hidden) colhidden[column] = 0;
        }
    }
    if (Object.keys(columnlen).length > 0) config.columnlen = columnlen;
    if (Object.keys(colhidden).length > 0) config.colhidden = colhidden;
}

// A merge's cells are charged from its area before any is visited. One over a cell an earlier merge holds is dropped,
// as Excel repairs it; the cells already placed tell, never a merge against another.
function readMerges(rest: XmlElement, context: WorksheetContext, worksheet: Worksheet): void {
    const mergeCells = xmlChild(rest, SML_NS, 'mergeCells');
    const merge: NonNullable<SheetConfig['merge']> = {};
    for (const mergeCell of mergeCells ? xmlChildren(mergeCells, SML_NS, 'mergeCell') : []) {
        const range = parseA1Range(xmlAttr(mergeCell, '', 'ref') ?? '');
        if (!range || range.sheet !== undefined) continue;
        const r = Math.min(range.start.row, range.end.row);
        const c = Math.min(range.start.col, range.end.col);
        const bottom = Math.max(range.start.row, range.end.row);
        const right = Math.max(range.start.col, range.end.col);
        if (bottom >= REFERENCE_ROW_COUNT || right >= REFERENCE_COLUMN_COUNT) continue;
        const rs = bottom - r + 1;
        const cs = right - c + 1;
        context.charge(rs * cs, 0);
        const covered = () => {
            for (let row = r; row <= bottom; row++)
                for (let column = c; column <= right; column++)
                    if (worksheet.placed.has(cellKey(row, column))) return true;
            return false;
        };
        if (covered()) continue;
        merge[`${r}_${c}`] = { r, c, rs, cs };
        // The anchor's mc carries the span; fortune-sheet tells it by `rs`.
        for (let row = r; row <= bottom; row++)
            for (let column = c; column <= right; column++)
                worksheet.placed.set(cellKey(row, column), {
                    r: row,
                    c: column,
                    v: { mc: row === r && column === c ? { r, c, rs, cs } : { r, c } },
                });
    }
    if (Object.keys(merge).length > 0) worksheet.config.merge = merge;
}

// A link lands on its ref's first cell, whether the grid holds a cell there or not, and of two on one cell the later
// wins: Excel writes a range's new link after the stale one for its first cell alone. A location is a place in the
// workbook; with an external relationship it is the target's fragment.
function readHyperlinks(rest: XmlElement, context: WorksheetContext, worksheet: Worksheet): void {
    const hyperlinks = xmlChild(rest, SML_NS, 'hyperlinks');
    const hyperlink: NonNullable<Sheet['hyperlink']> = {};
    for (const element of hyperlinks ? xmlChildren(hyperlinks, SML_NS, 'hyperlink') : []) {
        const range = parseA1Range(xmlAttr(element, '', 'ref') ?? '');
        const location = xmlAttr(element, '', 'location');
        const rel = context.rels.get(xmlAttr(element, R_NS, 'id') ?? '');
        const target = rel?.external ? rel.target : undefined;
        // A relationship to `#` beside the location, as ExcelJS writes an internal link, is the location.
        const link = hyperlinkOf(
            target !== undefined && !target.startsWith('#')
                ? `${target}${location ? `#${location}` : ''}`
                : location !== undefined
                  ? `#${location.replace(/^#/, '')}`
                  : target,
        );
        if (!range || range.sheet !== undefined || !link) continue;
        const { row: r, col: c } = range.start;
        if (r >= REFERENCE_ROW_COUNT || c >= REFERENCE_COLUMN_COUNT) continue;
        const key = cellKey(r, c);
        const placed = worksheet.placed.get(key);
        context.charge(placed ? 0 : 1, link.linkAddress.length);
        hyperlink[`${r}_${c}`] = link;
        // The linked cell carries a backref to its link, which the editor's cell edits look up.
        const hl = { r, c, id: context.id };
        if (placed) placed.v.hl = hl;
        else worksheet.placed.set(key, { r, c, v: { hl } });
    }
    if (Object.keys(hyperlink).length > 0) worksheet.sheet.hyperlink = hyperlink;
}

// A target is a web or mail address as written, or `#` and a place in the workbook. A web address's scheme is checked
// where it is followed or exported, by resolveWebLink.
function hyperlinkOf(target: string | undefined): { linkType: string; linkAddress: string } | undefined {
    if (target === undefined || target.trim().length === 0) return undefined;
    if (!target.startsWith('#')) return { linkType: 'webpage', linkAddress: target };
    const location = target.slice(1);
    if (location.length === 0) return undefined;
    // Quoted sheet name ('My Sheet', 'It''s') with an optional !ref tail. Sheet names may legally contain '!', so
    // don't split the quoted form on it.
    const quoted = location.match(/^('(?:[^']|'')*')(!.+)?$/);
    if (quoted) {
        // The editor finds a sheet link's sheet by its exact name, so the quotes go. A cell range keeps them, as the
        // editor's range parser reads the quoted form.
        return quoted[2]
            ? { linkType: 'cellrange', linkAddress: location }
            : { linkType: 'sheet', linkAddress: unquoteSheetName(quoted[1]) };
    }
    return location.includes('!')
        ? { linkType: 'cellrange', linkAddress: location }
        : { linkType: 'sheet', linkAddress: location };
}
