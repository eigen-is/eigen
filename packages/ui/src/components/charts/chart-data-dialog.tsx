// Edit data: a chart's inline data as a small sheet, categories down column A and series across row 1, with
// Eigen Sheets' look and keys. Google links a Sheet instead; this is the grid PowerPoint and Keynote offer,
// empty rows and columns to grow into as far as the inline limits go. The grid edits a draft, so Save is one
// change of the spec, what the grid changed since it opened, and Cancel leaves it as it was. A chart past the
// grid's limits (an imported one), or whose data holds what this build can't edit, shows its data read-only.

import {
    chartPointMoves,
    chartSpecChange,
    exceedsInlineGridLimits,
    holdsUnknownChartData,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    inlineRowCount,
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
import type { ChartSpec, ChartSpecChange, InlineChartData, StoredChartSpec } from '@workspace/lib/types/chart';
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
import type { ClipboardEvent, KeyboardEvent, MouseEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CellRef, Grid, GridSelection, InlineChartSpec } from './chart-data-grid';
import {
    cellText,
    clearRange,
    fill,
    gridOf,
    isNumberText,
    rangeOf,
    removeWhole,
    shownSize,
    specOf,
    widthOf,
    writeCell,
} from './chart-data-grid';

// Typing into a cell replaces it, and an arrow then commits; F2, Enter or a double-click edit in place,
// where an arrow moves the caret. As in Sheets.
type Editing = { mode: 'replace' | 'in-place'; text: string };

// Shown wherever a chart's data can't be edited because it holds a key this build doesn't know.
export const NEWER_CHART_DATA_NOTICE = 'This chart was made in a newer version of Eigen. Reload to edit its data.';

const plural = (n: number, noun: string) => `${n.toLocaleString('en')} ${noun}${n === 1 ? '' : 's'}`;

type ChartDataDialogProps = {
    spec: InlineChartSpec;
    stored: StoredChartSpec;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (change: ChartSpecChange) => void;
};

export function ChartDataDialog({ spec, stored, open, onOpenChange, onSave }: ChartDataDialogProps) {
    const unknown = holdsUnknownChartData(stored, spec);
    const readOnly = unknown || exceedsInlineGridLimits(spec.data);
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
                        {unknown
                            ? NEWER_CHART_DATA_NOTICE
                            : readOnly
                              ? 'This chart has more data than the editor holds, so it opens read-only.'
                              : 'Categories go down column A and series across row 1. Type in an empty row or column to add one, and paste cells from a spreadsheet to fill several at once.'}
                    </DialogDescription>
                </DialogHeader>
                {readOnly ? (
                    <ReadOnlyGrid data={spec.data} />
                ) : (
                    <EditableGrid
                        spec={spec}
                        stored={stored}
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
    stored: StoredChartSpec;
    onSave: (change: ChartSpecChange) => void;
    onClose: () => void;
};

// Edit data opened by a double-click: open at once, closed on Cancel or Save. A chart that can't be drawn, or
// that a collaborator deleted or broke meanwhile, has no grid to show, so it closes itself.
export function InlineChartDataDialog({ spec, stored, onSave, onClose }: InlineChartDataDialogProps) {
    const data = spec?.data.source === 'inline' ? spec.data : null;
    const editable = data !== null;
    useEffect(() => {
        if (!editable) onClose();
    }, [editable, onClose]);
    if (!spec || !data) return null;
    return (
        <ChartDataDialog
            spec={{ ...spec, data }}
            stored={stored}
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
// A cell's line of text is its row's height less the 1 px grid line under it.
const CELL_TEXT = { lineHeight: `${SHEET_DEFAULT_ROW_HEIGHT - 1}px` };
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
    stored,
    onCancel,
    onSave,
}: {
    spec: InlineChartSpec;
    stored: StoredChartSpec;
    onCancel: () => void;
    onSave: (change: ChartSpecChange) => void;
}) {
    // As the chart was when the dialog opened, so Save writes only what the grid changed since.
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

    const growReach = () => {
        const el = scroller.current;
        if (!el) return;
        const rows = Math.ceil((el.scrollTop + 2 * el.clientHeight) / SHEET_DEFAULT_ROW_HEIGHT);
        setReach((current) => Math.max(current, rows));
    };
    useLayoutEffect(growReach, []);

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
        // Every stored point follows its row: a deleted row's go, and the rows after it, past the data too, take
        // theirs along.
        const target = new Map(final.rows.flatMap((row, i) => (row.origin === null ? [] : [[row.origin, i]])));
        const deleted = opened.rows.length - target.size;
        const moves = chartPointMoves(stored, (index) =>
            index < opened.rows.length ? (target.get(index) ?? null) : index - deleted,
        );
        onSave([...chartSpecChange(specOf(opened, spec), specOf(final, spec)), ...moves]);
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
                onScroll={growReach}
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
                                                'truncate px-1',
                                                (row === 0 || column === 0) && 'font-bold',
                                                bad && 'bg-destructive/10 text-destructive',
                                            )}
                                            style={CELL_TEXT}
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
                        'absolute border border-(--sheet-editor-border) bg-background px-1 outline-none select-text',
                        editing ? 'shadow-[0_2px_5px_var(--sheet-editor-shadow)]' : 'pointer-events-none opacity-0',
                        (active.row === 0 || active.column === 0) && 'font-bold',
                    )}
                    style={{ ...box(active.row, active.column, active.row, active.column), ...CELL_TEXT }}
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
    const count = inlineRowCount(data);
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
