import type { JSONContent } from '@tiptap/core';
import { type XmlElement, xmlElements } from '../../core/xml';
import { HEADER_CELL_LOOK, TWIPS_PER_PX, W_NS } from '../../export/doc/ooxml';
import { build, type Item, isWhitespace, type Para, textOf } from './assemble';
import { int, is, onOff, w, wChild } from './package';
import { type Reader, readBlocks, type Scope } from './paragraphs';
import { mergeRun, shadingOf } from './styles';

type Row = { trPr?: XmlElement; cells: XmlElement[] };

export function readTable(reader: Reader, table: XmlElement, scope: Scope): Item[] {
    const tblPr = wChild(table, 'tblPr');
    const grid = xmlElements(wChild(table, 'tblGrid') ?? table)
        .filter((col) => is(col, W_NS, 'gridCol'))
        .map((col) => int(w(col, 'w')) ?? 0);
    const tableStyle = reader.styles.get(w(wChild(tblPr, 'tblStyle'), 'val'));
    const look = wChild(tblPr, 'tblLook');
    const firstRowOn = look
        ? w(look, 'firstRow') === '1' || (Number.parseInt(w(look, 'val') ?? '0', 16) & 0x20) !== 0
        : false;
    const tableRun = tableStyle ? reader.styles.run(tableStyle.id) : undefined;

    const rows = tableRows(table);
    const float = wChild(tblPr, 'tblpPr');
    const [onlyRow] = rows;
    if (float && rows.length === 1 && onlyRow?.cells.length === 1) {
        const figure = floatingFigure(reader, onlyRow.cells[0], float, grid, scope);
        if (figure) return [{ kind: 'float', figure }];
    }

    const shadedHeader = isShadedHeader(rows);
    const rowNodes: JSONContent[] = [];
    const open = new Map<number, JSONContent>();
    for (const [rowIndex, row] of rows.entries()) {
        const header = (onOff(wChild(row.trPr, 'tblHeader')) ?? false) || (rowIndex === 0 && shadedHeader);
        const cells: JSONContent[] = [];
        let column = int(w(wChild(row.trPr, 'gridBefore'), 'val')) ?? 0;
        if (column > 0)
            cells.push({
                type: 'tableCell',
                attrs: { colspan: column, colwidth: widths(grid, 0, column) },
                content: [{ type: 'paragraph' }],
            });
        for (const cell of row.cells) {
            const tcPr = wChild(cell, 'tcPr');
            const colspan = Math.max(1, int(w(wChild(tcPr, 'gridSpan'), 'val')) ?? 1);
            const vMerge = wChild(tcPr, 'vMerge');
            if (vMerge && w(vMerge, 'val') !== 'restart') {
                const above = open.get(column);
                if (above?.attrs) {
                    above.attrs['rowspan'] = Number(above.attrs['rowspan'] ?? 1) + 1;
                    column += colspan;
                    continue;
                }
            }
            const first = rowIndex === 0 && firstRowOn && tableStyle?.firstRowRun;
            const cellScope: Scope = { ...scope, tableRun: first ? mergeRun(tableRun ?? {}, first) : tableRun };
            const content = build(readBlocks(reader, cellContent(cell), cellScope));
            const fill = shadingOf(wChild(tcPr, 'shd'));
            const node: JSONContent = {
                type: header || fill === HEADER_CELL_LOOK.fill ? 'tableHeader' : 'tableCell',
                attrs: { colspan, rowspan: 1, colwidth: widths(grid, column, colspan), ...hoistAlignment(content) },
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
    const indent = int(w(wChild(tblPr, 'tblInd'), 'w')) ?? 0;
    return [{ kind: 'table', node: { type: 'table', content: rowNodes }, indent }];
}

function cellContent(cell: XmlElement): XmlElement[] {
    return xmlElements(cell).filter((child) => !is(child, W_NS, 'tcPr'));
}

function cellFill(cell: XmlElement): boolean {
    const fill = shadingOf(wChild(wChild(cell, 'tcPr'), 'shd'));
    return !!fill && fill !== 'FFFFFF';
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
function floatingFigure(
    reader: Reader,
    cell: XmlElement | undefined,
    float: XmlElement,
    grid: number[],
    scope: Scope,
): JSONContent | undefined {
    if (!cell) return undefined;
    const items = readBlocks(reader, cellContent(cell), scope);
    const paras = items.filter((item): item is Para => item.kind === 'para' && !item.empty);
    if (paras.length !== items.filter((item) => item.kind !== 'para' || !item.empty).length) return undefined;
    const [image, caption, ...rest] = paras;
    const figures = image?.inlines.filter((node) => node.type === 'figure') ?? [];
    const [figure] = figures;
    if (!figure || figures.length !== 1 || rest.length > 0) return undefined;
    if (image?.inlines.some((node) => node.type !== 'figure' && !isWhitespace(node))) return undefined;
    const spec = w(float, 'tblpXSpec');
    const x = int(w(float, 'tblpX')) ?? 0;
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
            else if (['customXml', 'ins', 'moveTo', 'smartTag'].includes(child.local))
                visitCells(xmlElements(child), cells);
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
            else if (['customXml', 'ins', 'moveTo'].includes(element.local)) visitRows(xmlElements(element));
        }
    };
    visitRows(xmlElements(table));
    return rows;
}

function widths(grid: number[], column: number, colspan: number): number[] | null {
    const spanned = grid.slice(column, column + colspan);
    if (spanned.length !== colspan || spanned.some((width) => !(width > 0))) return null;
    return spanned.map((width) => Math.max(1, Math.round(width / TWIPS_PER_PX)));
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
