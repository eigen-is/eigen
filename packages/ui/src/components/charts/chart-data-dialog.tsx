// Edit data: a chart's inline data as a small sheet, categories down column A and series across row 1, with
// Eigen Sheets' look and keys. Google links a Sheet instead; this is the grid PowerPoint and Keynote offer,
// empty rows and columns to grow into as far as the inline limits go. The grid edits a draft, so Save is one
// change of the spec and Cancel leaves it as it was. A chart past the grid's limits (an imported one) shows
// its data read-only rather than as thousands of cells.

import {
    chartLabel,
    DEFAULT_CHART_SERIES_STYLE,
    exceedsInlineGridLimits,
    fitsInlineGrid,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_POINTS,
} from '@workspace/lib/charts';
import { cellsToHtmlTable, cellsToTsv, htmlTableCells, parseTsv } from '@workspace/lib/clipboard';
import {
    columnIndexToLabel,
    SHEET_COLUMN_HEADER_HEIGHT,
    SHEET_DEFAULT_COL_WIDTH,
    SHEET_DEFAULT_FONT_SIZE,
    SHEET_DEFAULT_ROW_HEIGHT,
    SHEET_ROW_HEADER_WIDTH,
} from '@workspace/lib/sheets';
import type { ChartSeriesStyle, ChartSpec, InlineChartData } from '@workspace/lib/types/chart';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';
import {
    type ClipboardEvent,
    type KeyboardEvent,
    type MouseEvent,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { fromPercent } from './percent';

type InlineChartSpec = ChartSpec & { data: InlineChartData };

// A cell holds what was typed, so a value that isn't a number stays on screen, flagged, instead of vanishing.
type GridColumn = { name: string; style: ChartSeriesStyle };
// A row carries its slice color, so a removed row takes its pie slice's color with it. New series and rows
// are automatic (null), so the palette colors them by position.
type GridRow = { category: string; color: string | null; cells: string[] };
// The corner, A1, heads the categories column: the category axis title, as in Google.
type Grid = { corner: string; columns: GridColumn[]; rows: GridRow[] };

// Grid coordinates: row 0 is the series names (the sheet's row 1), column 0 the categories (column A), so
// (0, 0) is the corner.
type CellRef = { row: number; column: number };
// A header click selects whole rows or columns, which Delete removes rather than clears.
type GridSelection = { anchor: CellRef; focus: CellRef; whole?: 'rows' | 'columns' };
// Typing into a cell replaces it, and an arrow then commits; F2, Enter or a double-click edit in place,
// where an arrow moves the caret. As in Sheets.
type Editing = { mode: 'replace' | 'in-place'; text: string };

const newColumn = (): GridColumn => ({ name: '', style: DEFAULT_CHART_SERIES_STYLE });
const newRow = (columns: number): GridRow => ({ category: '', color: null, cells: Array(columns).fill('') });

function gridOf({ data, sliceColors, categoryAxis }: InlineChartSpec): Grid {
    const count = Math.max(data.categories.length, ...data.series.map((series) => series.values.length));
    return {
        corner: categoryAxis.title,
        columns: data.series.map(({ name, values, ...style }) => ({ name, style })),
        rows: Array.from({ length: count }, (_, i) => ({
            category: data.categories[i] ?? '',
            color: sliceColors[i] ?? null,
            cells: data.series.map((series) => String(series.values[i] ?? '')),
        })),
    };
}

// A number as Sheets shows one in the en convention: grouped (1,234), after a currency symbol ($1,234.00,
// -€5) or a percent (12% is 0.12). An empty cell is a gap; anything else is NaN, and flagged.
const NUMBER_TEXT = /^([-+]?)[$€£¥]?(\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d*\.?\d+(?:e[-+]?\d+)?)(%?)$/i;
function numberOf(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const match = NUMBER_TEXT.exec(trimmed);
    if (!match) return Number.NaN;
    const [, sign, digits, percent] = match;
    const value = Number(`${sign}${digits.replaceAll(',', '')}`);
    return percent ? fromPercent(value) : value;
}
const isNumberText = (text: string) => {
    const value = numberOf(text);
    return value === null || Number.isFinite(value);
};

function cellText(grid: Grid, { row, column }: CellRef): string {
    if (row === 0) return column === 0 ? grid.corner : (grid.columns[column - 1]?.name ?? '');
    const source = grid.rows[row - 1];
    if (!source) return '';
    return column === 0 ? source.category : (source.cells[column - 1] ?? '');
}

// The grid as shown, the header row and category column included: every column a series can go in, and
// rows to the ones the view reaches or one past the data, up to the category limit.
function shownSize({ rows }: Grid, reach: number) {
    return {
        rows: Math.min(INLINE_GRID_MAX_CATEGORIES + 1, Math.max(rows.length + 2, reach)),
        columns: INLINE_GRID_MAX_SERIES + 1,
    };
}

function rangeOf({ anchor, focus }: GridSelection) {
    return {
        top: Math.min(anchor.row, focus.row),
        bottom: Math.max(anchor.row, focus.row),
        left: Math.min(anchor.column, focus.column),
        right: Math.max(anchor.column, focus.column),
    };
}
type Range = ReturnType<typeof rangeOf>;

// A block of text fills the grid from (row, column), growing it as far as the limits allow; `clipped` says
// some didn't fit. A paste and a committed cell both land through here.
function fill(grid: Grid, row: number, column: number, block: string[][]): { grid: Grid; clipped: boolean } {
    const width = widthOf(block);
    let series = Math.max(grid.columns.length, Math.min(INLINE_GRID_MAX_SERIES, column + width - 1));
    let rows = Math.max(grid.rows.length, Math.min(INLINE_GRID_MAX_CATEGORIES, row + block.length - 1));
    // The points limit holds the growth back, new series first.
    while (!fitsInlineGrid(series, rows) && series > grid.columns.length) series -= 1;
    while (!fitsInlineGrid(series, rows) && rows > grid.rows.length) rows -= 1;

    const columns = Array.from({ length: series }, (_, j) => ({ ...(grid.columns[j] ?? newColumn()) }));
    const next = Array.from({ length: rows }, (_, i) => {
        const source = grid.rows[i] ?? newRow(series);
        return { ...source, cells: Array.from({ length: series }, (_, j) => source.cells[j] ?? '') };
    });
    let corner = grid.corner;
    let clipped = false;
    for (const [i, line] of block.entries()) {
        for (const [j, value] of line.entries()) {
            const r = row + i;
            const c = column + j;
            if (r > rows || c > series) clipped = true;
            else if (r === 0 && c === 0) corner = chartLabel(value);
            else if (r === 0) columns[c - 1].name = chartLabel(value);
            else if (r > 0 && c === 0) next[r - 1].category = chartLabel(value);
            else if (r > 0) next[r - 1].cells[c - 1] = value.trim();
        }
    }
    return { grid: { corner, columns, rows: next }, clipped };
}

// A loop, not Math.max(...): a pasted block can have more rows than a call takes arguments.
function widthOf(block: string[][]): number {
    let width = 0;
    for (const line of block) width = Math.max(width, line.length);
    return width;
}

// An empty value typed past the data adds nothing.
function writeCell(grid: Grid, { row, column }: CellRef, text: string): { grid: Grid; clipped: boolean } {
    if (text === '' && (row > grid.rows.length || column > grid.columns.length)) return { grid, clipped: false };
    return fill(grid, row, column, [[text]]);
}

function clearRange(grid: Grid, { top, bottom, left, right }: Range): Grid {
    const inside = (r: number, c: number) => r >= top && r <= bottom && c >= left && c <= right;
    return {
        corner: inside(0, 0) ? '' : grid.corner,
        columns: grid.columns.map((column, j) => (inside(0, j + 1) ? { ...column, name: '' } : column)),
        rows: grid.rows.map((row, i) => ({
            ...row,
            category: inside(i + 1, 0) ? '' : row.category,
            cells: row.cells.map((cell, j) => (inside(i + 1, j + 1) ? '' : cell)),
        })),
    };
}

// Whole rows or columns go, the header row or category column among them clears instead; the last row or
// series empties rather than leaving a chart with none.
function removeWhole(grid: Grid, whole: 'rows' | 'columns', range: Range): Grid {
    const cleared = clearRange(grid, whole === 'rows' ? { ...range, bottom: 0 } : { ...range, right: 0 });
    if (whole === 'rows') {
        const rows = cleared.rows.filter((_, i) => i + 1 < range.top || i + 1 > range.bottom);
        return { ...cleared, rows: rows.length > 0 ? rows : [newRow(grid.columns.length)] };
    }
    const keep = (j: number) => j + 1 < range.left || j + 1 > range.right;
    const columns = cleared.columns.filter((_, j) => keep(j));
    if (columns.length === 0) return clearRange(cleared, { ...range, left: 1, top: 0, bottom: grid.rows.length });
    return {
        ...cleared,
        columns,
        rows: cleared.rows.map((row) => ({ ...row, cells: row.cells.filter((_, j) => keep(j)) })),
    };
}

const plural = (n: number, noun: string) => `${n.toLocaleString('en')} ${noun}${n === 1 ? '' : 's'}`;

type ChartDataDialogProps = {
    spec: InlineChartSpec;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (spec: ChartSpec) => void;
};

export function ChartDataDialog({ spec, open, onOpenChange, onSave }: ChartDataDialogProps) {
    const readOnly = exceedsInlineGridLimits(spec.data);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                size="lg"
                showCloseButton={false}
                // Escape while a cell is open cancels the edit, not the dialog. Radix hears Escape on the
                // document before the cell editor's own keydown does.
                onEscapeKeyDown={(e) => {
                    if (e.target instanceof Element && e.target.matches('[data-cell-editor][data-editing]')) {
                        e.preventDefault();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>Edit data</DialogTitle>
                    <DialogDescription>
                        {readOnly
                            ? 'This chart has more data than the editor holds, so it opens read-only.'
                            : 'Categories go down column A and series across row 1. Type in an empty row or column to add one, and paste cells from a spreadsheet to fill several at once.'}
                    </DialogDescription>
                </DialogHeader>
                {readOnly ? (
                    <ReadOnlyGrid data={spec.data} />
                ) : (
                    <EditableGrid
                        spec={spec}
                        onCancel={() => onOpenChange(false)}
                        onSave={(next) => {
                            onSave(next);
                            onOpenChange(false);
                        }}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

type InlineChartDataDialogProps = {
    spec: ChartSpec | null;
    onSave: (spec: ChartSpec) => void;
    onClose: () => void;
};

// Edit data opened by a double-click: open at once, closed on Cancel or Save. A chart that can't be drawn, or
// that a collaborator deleted or broke meanwhile, has no grid to show, so it closes itself.
export function InlineChartDataDialog({ spec, onSave, onClose }: InlineChartDataDialogProps) {
    const data = spec?.data.source === 'inline' ? spec.data : null;
    const editable = data !== null;
    useEffect(() => {
        if (!editable) onClose();
    }, [editable, onClose]);
    if (!spec || !data) return null;
    return (
        <ChartDataDialog
            spec={{ ...spec, data }}
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
            onSave={onSave}
        />
    );
}

const columnLeft = (column: number) => SHEET_ROW_HEADER_WIDTH + column * SHEET_DEFAULT_COL_WIDTH;
const rowTop = (row: number) => SHEET_COLUMN_HEADER_HEIGHT + row * SHEET_DEFAULT_ROW_HEIGHT;
const ARROWS: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
};
const GRID_LINES = 'border-r border-b border-(--sheet-grid-line)';
const HEADER = cn(
    GRID_LINES,
    'flex items-center justify-center bg-(--sheet-header-background) text-(--sheet-header-text)',
);
// The highlight is translucent, as Sheets lays it over its header; painted over the header's own
// background, a sticky header stays opaque over the cells scrolling under it.
const HIGHLIGHT = 'bg-linear-to-r from-(--sheet-header-highlight) to-(--sheet-header-highlight)';

// Mounted with the dialog, so every opening starts from the chart as stored. One input sits on the active
// cell and keeps the focus, invisible until a cell is edited, as Sheets' cell input does: a key lands in
// it, and a canvas host's clipboard and keys stand down for a focused input.
function EditableGrid({
    spec,
    onCancel,
    onSave,
}: {
    spec: InlineChartSpec;
    onCancel: () => void;
    onSave: (spec: ChartSpec) => void;
}) {
    // As the chart was when the dialog opened, so Save keeps a peer's axis title its corner didn't change.
    const [opened] = useState(() => gridOf(spec));
    const [grid, setGrid] = useState(opened);
    const [selection, setSelection] = useState<GridSelection>({
        anchor: { row: 0, column: 0 },
        focus: { row: 0, column: 0 },
    });
    const [editing, setEditing] = useState<Editing | null>(null);
    // What the last paste or typed value lost to the limits: the pasted block's size, or 'typed'.
    const [clipped, setClipped] = useState<{ rows: number; columns: number } | 'typed' | null>(null);
    // The rows the view reaches, two views deep so there is always more to scroll into, as a sheet goes on.
    const [reach, setReach] = useState(0);
    const scroller = useRef<HTMLDivElement>(null);
    const input = useRef<HTMLInputElement>(null);
    const dragging = useRef(false);

    const { rows } = grid;
    const shown = shownSize(grid, reach);
    const active = selection.anchor;
    const range = rangeOf(selection);
    const invalid = rows.some((row) => !row.cells.every(isNumberText));

    // The active cell scrolls into view below the header strip and right of the row numbers.
    useLayoutEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const x = columnLeft(selection.focus.column);
        const y = rowTop(selection.focus.row);
        if (x - SHEET_ROW_HEADER_WIDTH < el.scrollLeft) el.scrollLeft = x - SHEET_ROW_HEADER_WIDTH;
        else if (x + SHEET_DEFAULT_COL_WIDTH > el.scrollLeft + el.clientWidth)
            el.scrollLeft = x + SHEET_DEFAULT_COL_WIDTH - el.clientWidth;
        if (y - SHEET_COLUMN_HEADER_HEIGHT < el.scrollTop) el.scrollTop = y - SHEET_COLUMN_HEADER_HEIGHT;
        else if (y + SHEET_DEFAULT_ROW_HEIGHT > el.scrollTop + el.clientHeight)
            el.scrollTop = y + SHEET_DEFAULT_ROW_HEIGHT - el.clientHeight;
    }, [selection.focus]);

    const measure = () => {
        const el = scroller.current;
        if (!el) return;
        const rows = Math.ceil((el.scrollTop + 2 * el.clientHeight) / SHEET_DEFAULT_ROW_HEIGHT);
        setReach((current) => Math.max(current, rows));
    };
    useLayoutEffect(measure, []);

    // The open edit lands in the grid; Save and every move go from the committed grid.
    const committed = () => {
        if (!editing) return grid;
        const written = writeCell(grid, active, editing.text);
        if (written.clipped) setClipped('typed');
        return written.grid;
    };

    const selectCell = (next: Grid, cell: CellRef) => {
        const size = shownSize(next, reach);
        const clamped = {
            row: Math.min(Math.max(cell.row, 0), size.rows - 1),
            column: Math.min(Math.max(cell.column, 0), size.columns - 1),
        };
        setGrid(next);
        setEditing(null);
        setSelection({ anchor: clamped, focus: clamped });
    };
    const commitAndMove = (rowDelta: number, columnDelta: number) =>
        selectCell(committed(), { row: active.row + rowDelta, column: active.column + columnDelta });
    const extend = (focus: CellRef) =>
        setSelection({
            anchor: active,
            focus: {
                row: Math.min(Math.max(focus.row, 0), shown.rows - 1),
                column: Math.min(Math.max(focus.column, 0), shown.columns - 1),
            },
        });
    const startEditing = (cell: CellRef) => setEditing({ mode: 'in-place', text: cellText(grid, cell) });

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) return;
        const arrow = ARROWS[e.key];
        if (editing) {
            if (e.key === 'Escape') {
                setEditing(null);
            } else if (e.key === 'Enter') {
                commitAndMove(e.shiftKey ? -1 : 1, 0);
            } else if (e.key === 'Tab') {
                commitAndMove(0, e.shiftKey ? -1 : 1);
            } else if (arrow && editing.mode === 'replace' && !e.shiftKey) {
                commitAndMove(...arrow);
            } else {
                return;
            }
            e.preventDefault();
            return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (arrow) {
            if (e.shiftKey) extend({ row: selection.focus.row + arrow[0], column: selection.focus.column + arrow[1] });
            else commitAndMove(...arrow);
        } else if (e.key === 'Tab') {
            // Past the grid's edge Tab leaves it, so the keyboard reaches Save.
            const column = active.column + (e.shiftKey ? -1 : 1);
            if (column < 0 || column >= shown.columns) return;
            commitAndMove(0, e.shiftKey ? -1 : 1);
        } else if (e.key === 'Enter' || e.key === 'F2') {
            startEditing(active);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selection.whole) selectCell(removeWhole(grid, selection.whole, range), active);
            else setGrid(clearRange(grid, range));
        } else {
            // A printable key types into the empty input, and onChange opens the cell.
            return;
        }
        e.preventDefault();
    };

    const onChange = (text: string) => setEditing({ mode: editing?.mode ?? 'replace', text });

    const selectedCells = () =>
        Array.from({ length: range.bottom - range.top + 1 }, (_, i) =>
            Array.from({ length: range.right - range.left + 1 }, (_, j) =>
                cellText(grid, { row: range.top + i, column: range.left + j }),
            ),
        );
    const onCopy = (e: ClipboardEvent<HTMLInputElement>) => {
        // While a cell is open, its text copies as any input's does.
        if (editing) return;
        e.preventDefault();
        const cells = selectedCells();
        e.clipboardData.setData('text/plain', cellsToTsv(cells));
        e.clipboardData.setData('text/html', cellsToHtmlTable(cells));
    };
    const onCut = (e: ClipboardEvent<HTMLInputElement>) => {
        if (editing) return;
        onCopy(e);
        setGrid(clearRange(grid, range));
    };
    // Cells from a spreadsheet arrive as TSV. Without a tab, an HTML table wins over the plain text: a Docs
    // table's text/plain is its cells on lines of their own, which would paste down one column.
    const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData.getData('text/plain');
        const block = text.includes('\t')
            ? parseTsv(text)
            : (htmlTableCells(e.clipboardData.getData('text/html')) ?? (text ? parseTsv(text) : []));
        // An open cell takes a single value as typing does.
        if (block.length === 0 || (editing && block.length === 1 && block[0].length === 1)) return;
        e.preventDefault();
        const width = widthOf(block);
        // One row and column past the limits is enough for fill to see what it can't hold.
        const cut = block
            .slice(0, INLINE_GRID_MAX_CATEGORIES + 2)
            .map((line) => line.slice(0, INLINE_GRID_MAX_SERIES + 2));
        const pasted = fill(grid, active.row, active.column, cut);
        setClipped(pasted.clipped ? { rows: block.length, columns: width } : null);
        setEditing(null);
        setGrid(pasted.grid);
        const size = shownSize(pasted.grid, reach);
        setSelection({
            anchor: active,
            focus: {
                row: Math.min(active.row + block.length - 1, size.rows - 1),
                column: Math.min(active.column + width - 1, size.columns - 1),
            },
        });
    };

    const pointTo = (e: MouseEvent, cell: CellRef, whole?: GridSelection['whole'], focus = cell) => {
        // The input keeps the focus, so the next key lands in it.
        e.preventDefault();
        input.current?.focus();
        dragging.current = true;
        if (e.shiftKey) {
            setSelection({ anchor: active, focus, whole });
            return;
        }
        const next = committed();
        setGrid(next);
        setEditing(null);
        setSelection({ anchor: cell, focus, whole });
    };
    const lastRow = shown.rows - 1;
    const lastColumn = shown.columns - 1;

    const save = () => {
        const final = committed();
        // An open cell that isn't a number is flagged, as Enter would have left it.
        if (final.rows.some((row) => !row.cells.every(isNumberText))) {
            setGrid(final);
            setEditing(null);
            return;
        }
        onSave({
            ...spec,
            categoryAxis:
                final.corner === opened.corner ? spec.categoryAxis : { ...spec.categoryAxis, title: final.corner },
            sliceColors: final.rows.map((row) => row.color),
            data: {
                source: 'inline',
                categories: final.rows.map((row) => row.category),
                series: final.columns.map(({ name, style }, j) => ({
                    ...style,
                    name,
                    values: final.rows.map((row) => numberOf(row.cells[j])),
                })),
            },
        });
    };

    const activeText = cellText(grid, active);
    const label = `${columnIndexToLabel(active.column)}${active.row + 1}${activeText ? `: ${activeText}` : ''}`;
    const box = (top: number, left: number, bottom: number, right: number) => ({
        top: rowTop(top),
        left: columnLeft(left),
        width: (right - left + 1) * SHEET_DEFAULT_COL_WIDTH,
        height: (bottom - top + 1) * SHEET_DEFAULT_ROW_HEIGHT,
    });

    return (
        <>
            {/* eigen-paper: the grid keeps Sheets' light look in dark mode, as the workbook does. isolate
                keeps the sticky headers' stacking inside the grid. */}
            <div
                ref={scroller}
                className="eigen-paper relative isolate h-[60vh] w-full overflow-auto rounded-md border bg-background font-sans select-none"
                style={{ fontSize: `${SHEET_DEFAULT_FONT_SIZE}pt` }}
                onScroll={measure}
                onMouseUp={() => {
                    dragging.current = false;
                }}
            >
                <div
                    role="grid"
                    aria-label="Chart data"
                    aria-rowcount={shown.rows + 1}
                    aria-colcount={shown.columns + 1}
                    aria-multiselectable
                    className="grid w-max text-(--sheet-cell-text)"
                    style={{
                        gridTemplateColumns: `${SHEET_ROW_HEADER_WIDTH}px repeat(${shown.columns}, ${SHEET_DEFAULT_COL_WIDTH}px)`,
                        gridAutoRows: SHEET_DEFAULT_ROW_HEIGHT,
                    }}
                >
                    <div role="row" aria-rowindex={1} className="contents">
                        {/* The corner selects every cell. */}
                        <div
                            role="columnheader"
                            aria-colindex={1}
                            className={cn(HEADER, 'sticky top-0 left-0 z-30')}
                            onMouseDown={(e) =>
                                pointTo(e, { row: 0, column: 0 }, undefined, { row: lastRow, column: lastColumn })
                            }
                        />
                        {Array.from({ length: shown.columns }, (_, column) => {
                            const selected = column >= range.left && column <= range.right;
                            return (
                                <div
                                    key={column}
                                    role="columnheader"
                                    aria-colindex={column + 2}
                                    aria-selected={selected}
                                    className={cn(
                                        HEADER,
                                        'sticky top-0 z-20',
                                        selected && cn(HIGHLIGHT, 'shadow-[inset_0_-1px_0_var(--selection-handle)]'),
                                    )}
                                    onMouseDown={(e) =>
                                        pointTo(e, { row: 0, column }, 'columns', { row: lastRow, column })
                                    }
                                >
                                    {columnIndexToLabel(column)}
                                </div>
                            );
                        })}
                    </div>
                    {Array.from({ length: shown.rows }, (_, row) => {
                        const rowSelected = row >= range.top && row <= range.bottom;
                        return (
                            <div key={row} role="row" aria-rowindex={row + 2} className="contents">
                                <div
                                    role="rowheader"
                                    aria-selected={rowSelected}
                                    className={cn(
                                        HEADER,
                                        'sticky left-0 z-10',
                                        rowSelected && cn(HIGHLIGHT, 'shadow-[inset_-1px_0_0_var(--selection-handle)]'),
                                    )}
                                    onMouseDown={(e) =>
                                        pointTo(e, { row, column: 0 }, 'rows', { row, column: lastColumn })
                                    }
                                >
                                    {row + 1}
                                </div>
                                {Array.from({ length: shown.columns }, (_, column) => {
                                    const cell = { row, column };
                                    const text = cellText(grid, cell);
                                    const bad = row > 0 && column > 0 && !isNumberText(text);
                                    return (
                                        <div
                                            key={column}
                                            role="gridcell"
                                            aria-colindex={column + 2}
                                            aria-selected={rowSelected && column >= range.left && column <= range.right}
                                            aria-invalid={bad || undefined}
                                            className={cn(
                                                GRID_LINES,
                                                'truncate px-1 leading-[19px]',
                                                (row === 0 || column === 0) && 'font-bold',
                                                bad && 'bg-destructive/10 text-destructive',
                                            )}
                                            onMouseDown={(e) => pointTo(e, cell)}
                                            onMouseEnter={(e) => {
                                                if (dragging.current && e.buttons === 1) extend(cell);
                                            }}
                                            onDoubleClick={() => {
                                                setSelection({ anchor: cell, focus: cell });
                                                startEditing(cell);
                                            }}
                                        >
                                            {text}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
                <div
                    aria-hidden
                    className="pointer-events-none absolute -mt-px -ml-px box-content border border-selection-handle bg-(--sheet-selection-fill)"
                    style={box(range.top, range.left, range.bottom, range.right)}
                />
                <div
                    aria-hidden
                    className="pointer-events-none absolute bg-(--sheet-selection-fill)"
                    style={box(active.row, active.column, active.row, active.column)}
                />
                <input
                    ref={input}
                    data-cell-editor
                    data-editing={editing ? '' : undefined}
                    aria-label={label}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(
                        'absolute border border-(--sheet-editor-border) bg-background px-1 leading-[19px] outline-none select-text',
                        editing ? 'shadow-[0_2px_5px_var(--sheet-editor-shadow)]' : 'pointer-events-none opacity-0',
                        (active.row === 0 || active.column === 0) && 'font-bold',
                    )}
                    style={box(active.row, active.column, active.row, active.column)}
                    value={editing?.text ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={onKeyDown}
                    onCopy={onCopy}
                    onCut={onCut}
                    onPaste={onPaste}
                />
            </div>
            {clipped && (
                <p className="text-xs text-muted-foreground">
                    {clipped === 'typed'
                        ? 'The chart'
                        : `Pasted ${plural(clipped.rows, 'row')} × ${plural(clipped.columns, 'column')}; the chart`}{' '}
                    holds up to {INLINE_GRID_MAX_SERIES} series and {INLINE_GRID_MAX_CATEGORIES} categories,{' '}
                    {MAX_CHART_POINTS.toLocaleString('en')} values in all, so{' '}
                    {clipped === 'typed' ? 'that value was' : 'the rest was'} left out.
                </p>
            )}
            {invalid && <p className="text-xs text-destructive">Values must be numbers.</p>}
            <DialogFooter>
                <Button variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
                <Button disabled={invalid} onClick={save}>
                    Save
                </Button>
            </DialogFooter>
        </>
    );
}

function ReadOnlyGrid({ data }: { data: InlineChartData }) {
    const count = Math.max(data.categories.length, ...data.series.map((series) => series.values.length));
    return (
        <>
            <div className="max-h-[60vh] overflow-auto rounded-md border">
                <table className="text-xs tabular-nums">
                    <thead>
                        <tr>
                            <th />
                            {data.series.map((series, j) => (
                                <th key={j} className="px-2 py-1 text-left font-medium whitespace-nowrap">
                                    {series.name}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: count }, (_, i) => (
                            <tr key={i}>
                                <td className="px-2 py-1 whitespace-nowrap">{data.categories[i]}</td>
                                {data.series.map((series, j) => (
                                    <td key={j} className="px-2 py-1 text-right">
                                        {series.values[i] ?? ''}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <DialogFooter showCloseButton />
        </>
    );
}
