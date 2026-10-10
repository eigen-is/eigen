import type { JSONContent } from '@tiptap/core';
import { MIN_TABLE_COLUMN_PX } from '@workspace/lib/docs/eigendoc';
import { isOn, TWIPS_PER_PX, W_NS } from '../../core/ooxml';
import { type XmlElement, xmlElements } from '../../core/xml';
import { HEADER_CELL_LOOK } from '../../document/looks';
import { build, COLUMN_PX, type Item, isWhitespace, type Para, textOf } from './assemble';
import { int, is, onOff, twipsOf, w, wChild } from './package';
import { type Reader, readBlocks, type Scope, WRAPPERS } from './paragraphs';
import { isFill, mergeRun, shadingOf } from './styles';

type Row = { trPr?: XmlElement; cells: XmlElement[] };

// Word's column limit: a span is walked column by column, so a gridSpan of 2e9 would hold the Worker to its deadline.
const MAX_COLUMNS = 63;

// Each table nests three nodes deep; 1,000 nested tables overflowed the Worker's stack.
export const MAX_TABLE_DEPTH = 8;

export function readTable(reader: Reader, table: XmlElement, scope: Scope): Item[] {
    const rows = tableRows(table);
    if (scope.tables >= MAX_TABLE_DEPTH)
        return rows.flatMap((row) => row.cells.flatMap((cell) => readBlocks(reader, cellContent(cell), scope)));
    const tblPr = wChild(table, 'tblPr');
    const grid = xmlElements(wChild(table, 'tblGrid') ?? table)
        .filter((col) => is(col, W_NS, 'gridCol'))
        .map((col) => twipsOf(w(col, 'w')) ?? 0)
        .slice(0, MAX_COLUMNS);
    const columns = grid.length || MAX_COLUMNS;
    const columnPx = scaled(grid, scope.room ?? COLUMN_PX);
    const tableStyle = reader.styles.get(w(wChild(tblPr, 'tblStyle'), 'val'));
    const look = wChild(tblPr, 'tblLook');
    const firstRowOn = look
        ? (isOn(w(look, 'firstRow')) ?? (Number.parseInt(w(look, 'val') ?? '0', 16) & 0x20) !== 0)
        : false;
    const tableRun = tableStyle ? reader.styles.run(tableStyle.id) : undefined;
    const tableLook = tableStyle ? reader.styles.table(tableStyle.id) : undefined;
    const tableFill = shadingOf(wChild(tblPr, 'shd')) ?? tableLook?.fill;
    const cellItems = (cell: XmlElement, rowIndex: number, colwidth: number[] | null): Item[] => {
        const firstRow = rowIndex === 0 && firstRowOn;
        const first = firstRow && tableLook?.firstRowRun;
        const fill =
            shadingOf(wChild(wChild(cell, 'tcPr'), 'shd')) ??
            (firstRow ? tableLook?.firstRowFill : undefined) ??
            tableFill;
        const cellScope: Scope = {
            ...scope,
            tables: scope.tables + 1,
            tableRun: first ? mergeRun(tableRun ?? {}, first) : tableRun,
            room: colwidth ? colwidth.reduce((sum, width) => sum + width, 0) : scope.room,
            onFill: scope.onFill || isFill(fill),
        };
        return readBlocks(reader, cellContent(cell), cellScope);
    };

    // Read once: the walk counts list numbers and notes as it goes.
    const float = wChild(tblPr, 'tblpPr');
    const [onlyRow] = rows;
    const onlyCell = rows.length === 1 && onlyRow?.cells.length === 1 ? onlyRow.cells[0] : undefined;
    const onlyItems = float && onlyCell ? cellItems(onlyCell, 0, widths(columnPx, 0, columnPx.length)) : undefined;
    if (float && onlyItems) {
        const figure = floatingFigure(reader, onlyItems, float, grid);
        if (figure) return [{ kind: 'float', figure }];
    }

    // A first row the table style fills is a header row, as one the cells fill is.
    const shadedHeader = isShadedHeader(rows) || (firstRowOn && isFill(tableLook?.firstRowFill));
    const rowNodes: { cells: JSONContent[]; end: number }[] = [];
    // The merged cells a continuation in the next row extends, by the column each starts at.
    let open = new Map<number, CellAttrs>();
    for (const [rowIndex, row] of rows.entries()) {
        const header = (onOff(wChild(row.trPr, 'tblHeader')) ?? false) || (rowIndex === 0 && shadedHeader);
        const cells: JSONContent[] = [];
        const next = new Map<number, CellAttrs>();
        const extended: CellAttrs[] = [];
        let column = Math.min(Math.max(0, int(w(wChild(row.trPr, 'gridBefore'), 'val')) ?? 0), columns);
        if (column > 0) cells.push(gridFiller(columnPx, 0, column));
        for (const cell of row.cells) {
            const tcPr = wChild(cell, 'tcPr');
            const vMerge = wChild(tcPr, 'vMerge');
            // Only where the cell above starts, and over its columns: anywhere else the two would overlap.
            const above = vMerge && w(vMerge, 'val') !== 'restart' ? open.get(column) : undefined;
            if (above) {
                extended.push(above);
                next.set(column, above);
                column += above.colspan;
                continue;
            }
            // Within the grid's columns left, or Word's limit where the grid names none.
            const colspan = Math.min(
                Math.max(1, int(w(wChild(tcPr, 'gridSpan'), 'val')) ?? 1),
                Math.max(1, columns - column),
            );
            const colwidth = widths(columnPx, column, colspan);
            const content = build(cell === onlyCell && onlyItems ? onlyItems : cellItems(cell, rowIndex, colwidth));
            const fill = shadingOf(wChild(tcPr, 'shd'));
            const attrs: CellAttrs = { colspan, rowspan: 1, colwidth, ...hoistAlignment(content) };
            cells.push({
                type: header || fill === HEADER_CELL_LOOK.fill ? 'tableHeader' : 'tableCell',
                attrs,
                content: content.length > 0 ? content : [{ type: 'paragraph' }],
            });
            if (vMerge) next.set(column, attrs);
            column += colspan;
        }
        const after = Math.min(Math.max(0, int(w(wChild(row.trPr, 'gridAfter'), 'val')) ?? 0), columns - column);
        if (after > 0) {
            cells.push(gridFiller(columnPx, column, after));
            column += after;
        }
        // A row of continuations only has no cell to hold: dropped, the cells above don't reach into it.
        if (cells.length === 0) continue;
        for (const attrs of extended) attrs.rowspan++;
        open = next;
        rowNodes.push({ cells, end: column });
    }
    if (rowNodes.length === 0) return [];
    // A row short of the widest ends in a cell of its first cell's type, as the editor pads it on open, but one over
    // the columns missing, so padding costs a cell per row; past the grid's widths a second, or its widths would run on.
    const width = rowNodes.reduce((widest, { end }) => Math.max(widest, end), 0);
    const content = rowNodes.map(({ cells, end }) => {
        const type = cells[0]?.type ?? 'tableCell';
        const gridEnd = Math.min(width, Math.max(end, columnPx.length));
        if (end < gridEnd) cells.push(gridFiller(columnPx, end, gridEnd - end, type));
        if (gridEnd < width) cells.push(gridFiller(columnPx, gridEnd, width - gridEnd, type));
        return { type: 'tableRow', content: cells };
    });
    const indent = twipsOf(w(wChild(tblPr, 'tblInd'), 'w')) ?? 0;
    return [{ kind: 'table', node: { type: 'table', content }, indent }];
}

type CellAttrs = { colspan: number; rowspan: number; colwidth: number[] | null; align?: string };

// The columns a row skips before or after its cells: one empty cell, as the editor would pad them on open.
function gridFiller(columnPx: number[], column: number, colspan: number, type = 'tableCell'): JSONContent {
    return {
        type,
        attrs: { colspan, colwidth: widths(columnPx, column, colspan) },
        content: [{ type: 'paragraph' }],
    };
}

function cellContent(cell: XmlElement): XmlElement[] {
    return xmlElements(cell).filter((child) => !is(child, W_NS, 'tcPr'));
}

function cellFill(cell: XmlElement): boolean {
    return isFill(shadingOf(wChild(wChild(cell, 'tcPr'), 'shd')));
}

// A shaded first row over unshaded rows is a header row, as Google Docs and many templates draw one.
function isShadedHeader(rows: Row[]): boolean {
    const [first, ...rest] = rows;
    return (
        !!first &&
        rest.length > 0 &&
        first.cells.length > 0 &&
        first.cells.every(cellFill) &&
        rest.every((row) => !row.cells.some(cellFill))
    );
}

// The writer's wrapped figure: a floating one-cell table holding the image and its caption.
function floatingFigure(reader: Reader, items: Item[], float: XmlElement, grid: number[]): JSONContent | undefined {
    const paras = items.filter((item): item is Para => item.kind === 'para' && !item.empty);
    if (paras.length !== items.filter((item) => item.kind !== 'para' || !item.empty).length) return undefined;
    const [image, caption, ...rest] = paras;
    const figures = image?.inlines.filter((node) => node.type === 'figure') ?? [];
    const [figure] = figures;
    if (!figure || figures.length !== 1 || rest.length > 0) return undefined;
    if (image?.inlines.some((node) => node.type !== 'figure' && !isWhitespace(node))) return undefined;
    const spec = w(float, 'tblpXSpec');
    const x = twipsOf(w(float, 'tblpX')) ?? 0;
    const width = grid.reduce((sum, col) => sum + col, 0);
    const right =
        spec === 'right' || spec === 'outside' || (spec === undefined && x + width / 2 > reader.columnTwips / 2);
    return {
        ...figure,
        attrs: {
            ...figure.attrs,
            layout: right ? 'wrap-right' : 'wrap-left',
            caption: caption ? textOf(caption.inlines) || null : null,
        },
    };
}

// Rows and cells as Word lays them out: content controls, custom XML and insertions unwrapped, deleted rows gone.
function tableRows(table: XmlElement): Row[] {
    const rows: Row[] = [];
    const visitCells = (children: XmlElement[], cells: XmlElement[]) => {
        for (const child of children) {
            if (child.ns !== W_NS) continue;
            if (child.local === 'tc') cells.push(child);
            else if (child.local === 'sdt') visitCells(xmlElements(wChild(child, 'sdtContent') ?? child), cells);
            else if (WRAPPERS.has(child.local)) visitCells(xmlElements(child), cells);
        }
    };
    const visitRows = (elements: XmlElement[]) => {
        for (const element of elements) {
            if (element.ns !== W_NS) continue;
            if (element.local === 'tr') {
                const trPr = wChild(element, 'trPr');
                if (wChild(trPr, 'del')) continue;
                const cells: XmlElement[] = [];
                visitCells(xmlElements(element), cells);
                rows.push({ trPr, cells });
            } else if (element.local === 'sdt') visitRows(xmlElements(wChild(element, 'sdtContent') ?? element));
            else if (WRAPPERS.has(element.local)) visitRows(xmlElements(element));
        }
    };
    visitRows(xmlElements(table));
    return rows;
}

// Twips to px, within the room: a column too thin to draw takes the floor and the others scale into what is left,
// rounded at the running sum so they fill it exactly. At most one pass per column, of at most 63.
function scaled(grid: number[], room: number): number[] {
    const px = grid.map((width) => (width > 0 ? width / TWIPS_PER_PX : 0));
    const total = px.reduce((sum, width) => sum + width, 0);
    const target = Math.min(room, total);
    const thin = new Set<number>();
    let scale = 1;
    for (let grew = true; grew; ) {
        const free = px.reduce((sum, width, index) => (thin.has(index) ? sum : sum + width), 0);
        scale = free > 0 ? Math.max(0, target - thin.size * MIN_TABLE_COLUMN_PX) / free : 0;
        grew = false;
        for (const [index, width] of px.entries()) {
            if (width > 0 && !thin.has(index) && width * scale < MIN_TABLE_COLUMN_PX) {
                thin.add(index);
                grew = true;
            }
        }
    }
    let before = 0;
    return px.map((width, index) => {
        if (!(width > 0)) return 0;
        if (thin.has(index)) return MIN_TABLE_COLUMN_PX;
        const start = Math.round(before * scale);
        before += width;
        return Math.max(MIN_TABLE_COLUMN_PX, Math.round(before * scale) - start);
    });
}

// A column the grid gives no width is 0 in a cell over others, as the editor gives it on open; over none, null.
function widths(columnPx: number[], column: number, colspan: number): number[] | null {
    const spanned = columnPx.slice(column, column + colspan);
    return spanned.some((width) => width > 0) ? spanned : null;
}

// A cell whose paragraphs share one alignment is an aligned cell.
function hoistAlignment(content: JSONContent[]): { align?: string } {
    const aligns = content.map((node) =>
        node.type === 'paragraph' || node.type === 'heading' ? node.attrs?.['textAlign'] : 'mixed',
    );
    const [first] = aligns;
    if (typeof first !== 'string' || first === 'mixed' || !aligns.every((align) => align === first)) return {};
    for (const node of content) if (node.attrs) node.attrs['textAlign'] = null;
    return { align: first };
}
