import type { JSONContent } from '@tiptap/core';
import { MIN_TABLE_COLUMN_PX } from '@workspace/lib/docs/eigendoc';
import { TWIPS_PER_PX, W_NS } from '../../core/ooxml';
import { type XmlElement, xmlElements } from '../../core/xml';
import { HEADER_CELL_LOOK } from '../../export/doc/looks';
import { build, COLUMN_PX, type Item, isWhitespace, type Para, textOf } from './assemble';
import { int, is, isOn, onOff, twips, w, wChild } from './package';
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
        .map((col) => twips(w(col, 'w')) ?? 0)
        .slice(0, MAX_COLUMNS);
    const columns = grid.length || MAX_COLUMNS;
    const columnPx = scaled(grid, scope.room ?? COLUMN_PX);
    const tableStyle = reader.styles.get(w(wChild(tblPr, 'tblStyle'), 'val'));
    const look = wChild(tblPr, 'tblLook');
    const firstRowOn = look
        ? (isOn(w(look, 'firstRow')) ?? (Number.parseInt(w(look, 'val') ?? '0', 16) & 0x20) !== 0)
        : false;
    const tableRun = tableStyle ? reader.styles.run(tableStyle.id) : undefined;
    const tableFill = shadingOf(wChild(tblPr, 'shd')) ?? tableStyle?.fill;
    const cellItems = (cell: XmlElement, rowIndex: number, colwidth: number[] | null): Item[] => {
        const firstRow = rowIndex === 0 && firstRowOn;
        const first = firstRow && tableStyle?.firstRowRun;
        const fill =
            shadingOf(wChild(wChild(cell, 'tcPr'), 'shd')) ??
            (firstRow ? tableStyle?.firstRowFill : undefined) ??
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

    const shadedHeader = isShadedHeader(rows);
    const rowNodes: JSONContent[] = [];
    const open = new Map<number, JSONContent>();
    for (const [rowIndex, row] of rows.entries()) {
        const header = (onOff(wChild(row.trPr, 'tblHeader')) ?? false) || (rowIndex === 0 && shadedHeader);
        const cells: JSONContent[] = [];
        let column = Math.min(Math.max(0, int(w(wChild(row.trPr, 'gridBefore'), 'val')) ?? 0), columns);
        if (column > 0)
            cells.push({
                type: 'tableCell',
                attrs: { colspan: column, colwidth: widths(columnPx, 0, column) },
                content: [{ type: 'paragraph' }],
            });
        for (const cell of row.cells) {
            const tcPr = wChild(cell, 'tcPr');
            // Within the grid's columns left, or Word's limit where the grid names none.
            const colspan = Math.min(
                Math.max(1, int(w(wChild(tcPr, 'gridSpan'), 'val')) ?? 1),
                Math.max(1, columns - column),
            );
            const vMerge = wChild(tcPr, 'vMerge');
            if (vMerge && w(vMerge, 'val') !== 'restart') {
                const above = open.get(column);
                if (above?.attrs) {
                    above.attrs['rowspan'] = Number(above.attrs['rowspan'] ?? 1) + 1;
                    column += colspan;
                    continue;
                }
            }
            const colwidth = widths(columnPx, column, colspan);
            const content = build(cell === onlyCell && onlyItems ? onlyItems : cellItems(cell, rowIndex, colwidth));
            const fill = shadingOf(wChild(tcPr, 'shd'));
            const node: JSONContent = {
                type: header || fill === HEADER_CELL_LOOK.fill ? 'tableHeader' : 'tableCell',
                attrs: { colspan, rowspan: 1, colwidth, ...hoistAlignment(content) },
                content: content.length > 0 ? content : [{ type: 'paragraph' }],
            };
            for (let k = 0; k < colspan; k++) {
                if (vMerge) open.set(column + k, node);
                else open.delete(column + k);
            }
            cells.push(node);
            column += colspan;
        }
        if (cells.length > 0) rowNodes.push({ type: 'tableRow', content: cells });
    }
    if (rowNodes.length === 0) return [];
    const indent = twips(w(wChild(tblPr, 'tblInd'), 'w')) ?? 0;
    return [{ kind: 'table', node: { type: 'table', content: rowNodes }, indent }];
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

// P3: contrast below 1.5 against white, by WCAG's relative luminance. On a fill the schema drops, Word draws such text
// legibly; on Eigen's paper it would vanish, so it takes the body color.
export function isLight(hex: string): boolean {
    const [red = 0, green = 0, blue = 0] = [0, 2, 4].map((at) => {
        const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 1.05 / (0.2126 * red + 0.7152 * green + 0.0722 * blue + 0.05) < 1.5;
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
    const x = twips(w(float, 'tblpX')) ?? 0;
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

function widths(columnPx: number[], column: number, colspan: number): number[] | null {
    const spanned = columnPx.slice(column, column + colspan);
    return spanned.length > 0 && spanned.length === colspan && spanned.every((width) => width > 0) ? spanned : null;
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
