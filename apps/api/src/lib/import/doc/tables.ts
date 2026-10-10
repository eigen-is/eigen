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
        const extended = new Set<NonNullable<JSONContent['attrs']>>();
        let column = Math.min(Math.max(0, int(w(wChild(row.trPr, 'gridBefore'), 'val')) ?? 0), columns);
        if (column > 0) cells.push(gridFiller(columnPx, 0, column));
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
                    extended.add(above.attrs);
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
        const after = Math.min(Math.max(0, int(w(wChild(row.trPr, 'gridAfter'), 'val')) ?? 0), columns - column);
        if (after > 0) cells.push(gridFiller(columnPx, column, after));
        // A row of continuations only has no cell to hold: dropped, the cells above don't reach into it.
        if (cells.length === 0) continue;
        for (const attrs of extended) attrs['rowspan'] = Number(attrs['rowspan'] ?? 1) + 1;
        rowNodes.push({ type: 'tableRow', content: cells });
    }
    if (rowNodes.length === 0) return [];
    const indent = twips(w(wChild(tblPr, 'tblInd'), 'w')) ?? 0;
    return [{ kind: 'table', node: { type: 'table', content: rowNodes }, indent }];
}

type CellAttrs = { colspan: number; rowspan: number; colwidth: number[] | null };

type Problem =
    | { type: 'collision'; cell: JSONContent; row: number; n: number }
    | { type: 'missing'; row: number; n: number }
    | { type: 'overlong'; cell: JSONContent; n: number }
    | { type: 'mismatch'; cell: JSONContent; colwidth: number[] };

function cellAttrs(cell: JSONContent): CellAttrs {
    return {
        colspan: Number(cell.attrs?.['colspan'] ?? 1),
        rowspan: Number(cell.attrs?.['rowspan'] ?? 1),
        colwidth: cell.attrs?.['colwidth'] ?? null,
    };
}

// As prosemirror-tables' TableMap reads it: a row's cells and the rowspans reaching into it from above.
function tableWidth(rows: JSONContent[]): number {
    const reaching = new Array<number>(rows.length + 1).fill(0);
    let width = 0;
    let carried = 0;
    for (const [index, row] of rows.entries()) {
        carried += reaching[index] ?? 0;
        let own = 0;
        for (const cell of row.content ?? []) {
            const { colspan, rowspan } = cellAttrs(cell);
            own += colspan;
            reaching[index + 1] = (reaching[index + 1] ?? 0) + colspan;
            const end = Math.min(index + rowspan, rows.length);
            reaching[end] = (reaching[end] ?? 0) - colspan;
        }
        width = Math.max(width, own + carried);
    }
    return width;
}

// The slots of the table's map no cell fills, which the editor fills with a cell each on open.
export function missingCells(table: JSONContent): number {
    const rows = table.content ?? [];
    let filled = 0;
    for (const [index, row] of rows.entries())
        for (const cell of row.content ?? []) {
            const { colspan, rowspan } = cellAttrs(cell);
            filled += colspan * Math.min(rowspan, rows.length - index);
        }
    return tableWidth(rows) * rows.length - filled;
}

// The table as the editor leaves it on open, so the stored doc is the opened one: prosemirror-tables' fixTables, pass
// for pass, repaired in place. Its transaction keeps a copy of the table per repair: 20,000 took 3.4 GB.
export function openTable(table: JSONContent): void {
    while (repairTable(table));
}

// One pass of fixTable over computeMap's problems; false when it found none.
function repairTable(table: JSONContent): boolean {
    const rows = table.content ?? [];
    const height = rows.length;
    const width = tableWidth(rows);
    const map = new Array<number>(width * height).fill(0);
    const cells: JSONContent[] = [];
    // Per column, its width and how many slots agree on it.
    const colWidths: number[] = [];
    const problems: Problem[] = [];
    let mapPos = 0;
    for (const [row, rowNode] of rows.entries()) {
        const own = rowNode.content ?? [];
        for (let index = 0; ; index++) {
            while (mapPos < map.length && map[mapPos] !== 0) mapPos++;
            const cell = own[index];
            if (!cell) break;
            cells.push(cell);
            const { colspan, rowspan, colwidth } = cellAttrs(cell);
            for (let h = 0; h < rowspan; h++) {
                if (h + row >= height) {
                    problems.push({ type: 'overlong', cell, n: rowspan - h });
                    break;
                }
                const start = mapPos + h * width;
                for (let w = 0; w < colspan; w++) {
                    if (map[start + w] === 0) map[start + w] = cells.length;
                    else problems.push({ type: 'collision', cell, row, n: colspan - w });
                    const colW = colwidth?.[w];
                    if (!colW) continue;
                    const at = ((start + w) % width) * 2;
                    const prev = colWidths[at];
                    if (prev === undefined || (prev !== colW && colWidths[at + 1] === 1)) {
                        colWidths[at] = colW;
                        colWidths[at + 1] = 1;
                    } else if (prev === colW) colWidths[at + 1] = (colWidths[at + 1] ?? 0) + 1;
                }
            }
            mapPos += colspan;
        }
        let missing = 0;
        while (mapPos < (row + 1) * width) if (map[mapPos++] === 0) missing++;
        if (missing) problems.push({ type: 'missing', row, n: missing });
    }
    let badWidths = false;
    for (let at = 0; !badWidths && at < colWidths.length; at += 2)
        badWidths = colWidths[at] !== undefined && (colWidths[at + 1] ?? 0) < height;
    if (badWidths) {
        const seen = new Set<number>();
        for (const [slot, id] of map.entries()) {
            const cell = cells[id - 1];
            if (seen.has(id) || !cell) continue;
            seen.add(id);
            const { colspan, colwidth } = cellAttrs(cell);
            let updated: number[] | undefined;
            for (let j = 0; j < colspan; j++) {
                const colWidth = colWidths[((slot + j) % width) * 2];
                if (colWidth !== undefined && colwidth?.[j] !== colWidth)
                    (updated ??= colwidth?.slice() ?? Array<number>(colspan).fill(0))[j] = colWidth;
            }
            if (updated) problems.unshift({ type: 'mismatch', cell, colwidth: updated });
        }
    }
    if (problems.length === 0) return false;

    // Each repair starts from the cell as the pass found it, so a later one on the same cell replaces an earlier.
    const found = new Map(cells.map((cell) => [cell, { ...cell.attrs, ...cellAttrs(cell) }]));
    const mustAdd = new Array<number>(height).fill(0);
    for (const problem of problems) {
        if (problem.type === 'missing') {
            mustAdd[problem.row] = (mustAdd[problem.row] ?? 0) + problem.n;
            continue;
        }
        const attrs = found.get(problem.cell) ?? cellAttrs(problem.cell);
        if (problem.type === 'collision') {
            for (let j = 0; j < attrs.rowspan; j++)
                mustAdd[problem.row + j] = (mustAdd[problem.row + j] ?? 0) + problem.n;
            const colwidth = attrs.colwidth?.toSpliced(attrs.colspan - problem.n, problem.n) ?? null;
            problem.cell.attrs = {
                ...attrs,
                colspan: attrs.colspan - problem.n,
                colwidth: colwidth?.some((px) => px > 0) ? colwidth : null,
            };
        } else if (problem.type === 'overlong') problem.cell.attrs = { ...attrs, rowspan: attrs.rowspan - problem.n };
        else problem.cell.attrs = { ...attrs, colwidth: problem.colwidth };
    }
    const added = [...rows.keys()].filter((row) => (mustAdd[row] ?? 0) > 0);
    const [first] = added;
    const last = added.at(-1);
    for (const [index, row] of rows.entries()) {
        const add = mustAdd[index] ?? 0;
        if (add <= 0) continue;
        const type = row.content?.[0]?.type ?? 'tableCell';
        const fresh = Array.from({ length: add }, () => ({ type, content: [{ type: 'paragraph' }] }));
        // fixTable's own rule for where a row's new cells go.
        const atStart = (index === 0 || first === index - 1) && last === index;
        row.content = atStart ? [...fresh, ...(row.content ?? [])] : [...(row.content ?? []), ...fresh];
    }
    return true;
}

// The columns a row skips before or after its cells: one empty cell, as the editor would pad them on open.
function gridFiller(columnPx: number[], column: number, colspan: number): JSONContent {
    return {
        type: 'tableCell',
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
