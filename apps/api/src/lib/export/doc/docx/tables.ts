// The docx writer's tables: a doc's table as a Word table, its grid laid out as the editor lays it out.

import type { JSONContent } from '@tiptap/core';
import { MIN_TABLE_COLUMN_PX, readCellBackground } from '@workspace/lib/docs/eigendoc';
import { HEADER_CELL_LOOK, proseBorder, TABLE_CELL_PADDING, TABLE_MARGIN } from '../../../document/looks';
import {
    BORDER_SIDES,
    JUSTIFICATION,
    MAX_TABLE_COLUMNS,
    NO_STORED_WIDTH,
    STYLE_NAMES,
    TWIPS_PER_PX,
} from '../../../ooxml/wordml';
import type { Context } from './package';
import type { Block } from './paragraphs';
import { blocksOf, blocksXml, bordersXml, clampInt, paragraphXml, textProps } from './paragraphs';
import type { StyleDef } from './styles';

const CELL_TYPES = new Set(['tableCell', 'tableHeader']);

export const TABLE_BORDER_SIDES = [...BORDER_SIDES, 'insideH', 'insideV'] as const;

type GridCell = { node: JSONContent; content: JSONContent[]; column: number; colspan: number; rowspan: number };

// Far above any real table; a sum of MAX_TABLE_COLUMNS of them stays finite.
const MAX_COLWIDTH_PX = 1e6;

// Based on Normal, it looks as Normal does, and stays out of Word's gallery.
const TABLE_HEADER_STYLE: StyleDef = {
    type: 'paragraph',
    id: 'TableHeader',
    name: STYLE_NAMES.TableHeader,
    basedOn: 'Normal',
    semiHidden: true,
};

export const TABLE_LOOK = {
    border: { ...proseBorder('.eigen-prose td', 'border'), space: 0 },
    padding: TABLE_CELL_PADDING,
    margin: TABLE_MARGIN,
};

// Spans hold their columns; stray content gets a cell, one past the last column joins the cell there: no text is lost.
// A table wider than Word's 63 columns loses its last columns' layout, so it is counted once as simplified.
export function tableOf(rowNodes: JSONContent[], context: Context): Block[] {
    const rows = rowNodes.map((row) =>
        (row.type === 'tableRow' ? (row.content ?? []) : [row]).map((cell) =>
            CELL_TYPES.has(cell.type ?? '') ? cell : { type: 'tableCell', content: [cell] },
        ),
    );
    const columnPx = (context.column - context.indent) / TWIPS_PER_PX;
    const carry: number[] = [];
    const holders: GridCell[] = [];
    const widths: (number | undefined)[] = [];
    let cut = false;
    const grid = rows.map((cells, rowIndex) => {
        let column = 0;
        const placed: GridCell[] = [];
        for (const node of cells) {
            while ((carry[column] ?? 0) > 0) column++;
            const last = holders[MAX_TABLE_COLUMNS - 1];
            if (column >= MAX_TABLE_COLUMNS && last) {
                for (const block of node.content ?? []) last.content.push(block);
                cut = true;
                continue;
            }
            const colspan = clampInt(node.attrs?.['colspan'], 1, MAX_TABLE_COLUMNS - column, 1);
            cut ||= clampInt(node.attrs?.['colspan'], 1, Number.MAX_SAFE_INTEGER, 1) > colspan;
            const rowspan = clampInt(node.attrs?.['rowspan'], 1, rows.length - rowIndex, 1);
            const colwidth = node.attrs?.['colwidth'];
            const cell = { node, content: [...(node.content ?? [])], column, colspan, rowspan };
            for (let k = 0; k < colspan; k++) {
                const width: unknown = Array.isArray(colwidth) ? colwidth[k] : undefined;
                // At most MAX_COLWIDTH_PX, so 63 of them sum to a number and the ratios between them stay.
                widths[column + k] ??=
                    typeof width === 'number' && Number.isFinite(width) && width > 0
                        ? Math.min(width, MAX_COLWIDTH_PX)
                        : undefined;
                carry[column + k] = rowspan;
                holders[column + k] = cell;
            }
            column += colspan;
            placed.push(cell);
        }
        for (const [index, rowsLeft] of carry.entries()) carry[index] = Math.max(0, rowsLeft - 1);
        return placed;
    });
    if (widths.length === 0) return [];
    if (cut) context.pkg.lost('tables-simplified');

    const { dxa, fixed } = gridWidths(widths, columnPx);
    const spanWidth = (column: number, colspan: number) =>
        dxa.slice(column, column + colspan).reduce((sum, width) => sum + width, 0);
    // The merge each covered position continues.
    const covered = new Map<string, GridCell>();
    for (const [rowIndex, cells] of grid.entries()) {
        for (const cell of cells) {
            for (let k = 1; k < cell.rowspan; k++) covered.set(`${rowIndex + k}:${cell.column}`, cell);
        }
    }
    const rowsXml = grid.map((cells, rowIndex) => {
        const byColumn = new Map(cells.map((cell) => [cell.column, cell]));
        // Only an all-header row repeats; a reader may take an explicit off as on. A header cell beside a body cell is
        // marked by its paragraphs' style.
        const header = cells.length > 0 && cells.every((cell) => cell.node.type === 'tableHeader');
        const tcs: string[] = [];
        for (let column = 0; column < dxa.length; ) {
            const cell = byColumn.get(column);
            const merged = covered.get(`${rowIndex}:${column}`);
            const owner = cell ?? merged;
            const colspan = owner?.colspan ?? 1;
            const width = spanWidth(column, colspan);
            // Word draws a fill per cell, so a merge's covered cells carry it too; a cell's own wins over a header's gray.
            const fill =
                readCellBackground(owner?.node.attrs?.['backgroundColor'])?.slice(1).toUpperCase() ??
                (owner?.node.type === 'tableHeader' ? HEADER_CELL_LOOK.fill : undefined);
            // A cell over columns without a width has none either: the grid lays it out, and the reader reads it back unset.
            const tcW = widths.slice(column, column + colspan).every((known) => known === undefined)
                ? `<w:tcW w:w="0" w:type="${NO_STORED_WIDTH}"/>`
                : `<w:tcW w:w="${width}" w:type="dxa"/>`;
            const tcPr = (merge: string) =>
                `<w:tcPr>${tcW}${colspan > 1 ? `<w:gridSpan w:val="${colspan}"/>` : ''}${merge}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>`;
            if (cell) {
                const merge = cell.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : '';
                const marked = !header && cell.node.type === 'tableHeader';
                tcs.push(
                    `<w:tc>${tcPr(merge)}${cellXml(cell, width - 2 * TABLE_LOOK.padding.horizontal, context, marked)}</w:tc>`,
                );
            } else tcs.push(`<w:tc>${tcPr(merged === undefined ? '' : '<w:vMerge/>')}<w:p/></w:tc>`);
            column += colspan;
        }
        return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs.join('')}</w:tr>`;
    });

    const border = TABLE_LOOK.border;
    const margin = (side: string, width: number) => `<w:${side} w:w="${width}" w:type="dxa"/>`;
    const tblPr = [
        `<w:tblW w:w="${spanWidth(0, dxa.length)}" w:type="dxa"/>`,
        `<w:tblInd w:w="${context.indent}" w:type="dxa"/>`,
        `<w:tblBorders>${bordersXml(TABLE_BORDER_SIDES, { top: border, left: border, bottom: border, right: border, insideH: border, insideV: border })}</w:tblBorders>`,
        fixed ? '<w:tblLayout w:type="fixed"/>' : '',
        `<w:tblCellMar>${margin('top', TABLE_LOOK.padding.vertical)}${margin('left', TABLE_LOOK.padding.horizontal)}${margin('bottom', TABLE_LOOK.padding.vertical)}${margin('right', TABLE_LOOK.padding.horizontal)}</w:tblCellMar>`,
    ].join('');
    const tblGrid = dxa.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
    return [
        { table: `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${tblGrid}</w:tblGrid>${rowsXml.join('')}</w:tbl>` },
    ];
}

// As TableWidthClamp: known columns scale down to the column, floored; unknown ones share the rest, as width: 100%.
function gridWidths(widths: (number | undefined)[], columnPx: number): { dxa: number[]; fixed: boolean } {
    const known = widths.filter((width) => width !== undefined);
    const sum = known.reduce((total, width) => total + width, 0);
    const unknown = widths.length - known.length;
    const scale = sum > columnPx ? columnPx / sum : 1;
    const share = unknown > 0 ? Math.max(MIN_TABLE_COLUMN_PX, Math.floor((columnPx - sum * scale) / unknown)) : 0;
    const px = widths.map((width) =>
        width === undefined ? share : scale < 1 ? Math.max(MIN_TABLE_COLUMN_PX, Math.floor(width * scale)) : width,
    );
    return { dxa: px.map((width) => Math.round(width * TWIPS_PER_PX)), fixed: unknown === 0 };
}

// A cell is a flow of its own: no indent or list around it, its paragraphs flush and aligned as the cell is. Only an
// untyped list in it still numbers by the lists around the table, as eigen-prose.css draws it.
function cellXml(
    { node, content }: GridCell,
    column: number,
    { pkg, orderedListsAround }: Context,
    marked: boolean,
): string {
    const align = node.attrs?.['align'];
    const cell: Context = {
        pkg,
        firstInFlow: false,
        column,
        indent: 0,
        depth: 0,
        orderedListsAround,
        quotes: 0,
        after: 0,
        align: typeof align === 'string' ? JUSTIFICATION.get(align) : undefined,
    };
    const blocks = blocksOf(content, textProps({}, cell), cell, false);
    const empty = textProps({}, cell);
    if (marked) {
        pkg.styles.set('TableHeader', TABLE_HEADER_STYLE);
        for (const { props } of [...blocks.filter((block) => 'props' in block), { props: empty }])
            props.style ??= 'TableHeader';
    }
    return blocks.length > 0 ? blocksXml(blocks, pkg.styles) : paragraphXml({ props: empty, runs: '' });
}
