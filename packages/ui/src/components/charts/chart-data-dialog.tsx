// Edit data: a chart's inline data as a small grid, categories down the first column and series across the
// first row. Google links a Sheet instead; this is the grid PowerPoint and Keynote offer. The grid edits a
// draft, so Save is one change of the spec and Cancel leaves it as it was. A chart past the grid's limits (an
// imported one) shows its data read-only rather than as thousands of inputs.

import {
    chartColor,
    chartLabel,
    exceedsInlineGridLimits,
    fitsInlineGrid,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_LABEL_LENGTH,
    MAX_CHART_POINTS,
} from '@workspace/lib/charts';
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
import { Input } from '@workspace/ui/components/input';
import { cn } from '@workspace/ui/lib/utils';
import { Plus, X } from 'lucide-react';
import { type ClipboardEvent, useState } from 'react';

type InlineChartSpec = ChartSpec & { data: InlineChartData };

// A cell holds what was typed, so a value that isn't a number stays on screen, flagged, instead of vanishing.
type GridColumn = { name: string; style: ChartSeriesStyle };
// A row carries its slice color, so a removed row takes its pie slice's color with it.
type GridRow = { category: string; color: string; cells: string[] };
type Grid = { columns: GridColumn[]; rows: GridRow[] };

const newColumn = (index: number): GridColumn => ({
    name: '',
    style: { color: chartColor(index), markers: false, smooth: false },
});
const newRow = (index: number, columns: number): GridRow => ({
    category: '',
    color: chartColor(index),
    cells: Array(columns).fill(''),
});

function gridOf({ data, sliceColors }: InlineChartSpec): Grid {
    const count = Math.max(data.categories.length, ...data.series.map((series) => series.values.length));
    return {
        columns: data.series.map(({ name, values, ...style }) => ({ name, style })),
        rows: Array.from({ length: count }, (_, i) => ({
            category: data.categories[i] ?? '',
            color: sliceColors[i] ?? chartColor(i),
            cells: data.series.map((series) => String(series.values[i] ?? '')),
        })),
    };
}

const isNumberText = (text: string) => text.trim() === '' || Number.isFinite(Number(text));
const numberOf = (text: string) => (text.trim() === '' ? null : Number(text));

// Pasted tab-separated text fills the grid from the cell it lands in (grid coordinates: row 0 is the series
// names, column 0 the categories), growing it as far as the limits allow; `clipped` says some didn't fit.
function pasteInto(grid: Grid, row: number, column: number, text: string): { grid: Grid; clipped: boolean } {
    const lines = text
        .replace(/\r?\n$/, '')
        .split(/\r?\n/)
        .map((line) => line.split('\t'));
    const width = Math.max(...lines.map((line) => line.length));
    let series = Math.max(grid.columns.length, Math.min(INLINE_GRID_MAX_SERIES, column + width - 1));
    let rows = Math.max(grid.rows.length, Math.min(INLINE_GRID_MAX_CATEGORIES, row + lines.length - 1));
    // The points limit holds the growth back, new series first.
    while (!fitsInlineGrid(series, rows) && series > grid.columns.length) series -= 1;
    while (!fitsInlineGrid(series, rows) && rows > grid.rows.length) rows -= 1;

    const columns = Array.from({ length: series }, (_, j) => ({ ...(grid.columns[j] ?? newColumn(j)) }));
    const next = Array.from({ length: rows }, (_, i) => {
        const source = grid.rows[i] ?? newRow(i, series);
        return { ...source, cells: Array.from({ length: series }, (_, j) => source.cells[j] ?? '') };
    });
    let clipped = false;
    for (const [i, line] of lines.entries()) {
        for (const [j, value] of line.entries()) {
            const r = row + i;
            const c = column + j;
            if (r > rows || c > series) clipped = true;
            else if (r === 0 && c > 0) columns[c - 1].name = chartLabel(value);
            else if (r > 0 && c === 0) next[r - 1].category = chartLabel(value);
            else if (r > 0) next[r - 1].cells[c - 1] = value.trim();
        }
    }
    return { grid: { columns, rows: next }, clipped };
}

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
            <DialogContent size="lg" showCloseButton={false}>
                <DialogHeader>
                    <DialogTitle>Edit data</DialogTitle>
                    <DialogDescription>
                        {readOnly
                            ? 'This chart has more data than the editor holds, so it opens read-only.'
                            : 'Categories go down the first column and series across the first row. Paste cells from a spreadsheet to fill several at once.'}
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

const CELL_INPUT = 'h-7 px-2 text-xs md:text-xs';

// Mounted with the dialog, so every opening starts from the chart as stored.
function EditableGrid({
    spec,
    onCancel,
    onSave,
}: {
    spec: InlineChartSpec;
    onCancel: () => void;
    onSave: (spec: ChartSpec) => void;
}) {
    const [grid, setGrid] = useState(() => gridOf(spec));
    const [clipped, setClipped] = useState(false);
    const { columns, rows } = grid;
    const invalid = rows.some((row) => !row.cells.every(isNumberText));

    const setColumns = (next: GridColumn[]) => setGrid({ columns: next, rows });
    const setRows = (next: GridRow[]) => setGrid({ columns, rows: next });
    const setCell = (i: number, j: number, text: string) =>
        setRows(
            rows.map((row, r) => (r === i ? { ...row, cells: row.cells.map((c, k) => (k === j ? text : c)) } : row)),
        );

    // A single value pastes as typing does; several cells fill the grid.
    const onPaste = (row: number, column: number) => (e: ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData.getData('text/plain');
        if (!/[\t\n]/.test(text)) return;
        e.preventDefault();
        const pasted = pasteInto(grid, row, column, text);
        setGrid(pasted.grid);
        setClipped(pasted.clipped);
    };

    const save = () =>
        onSave({
            ...spec,
            sliceColors: rows.map((row) => row.color),
            data: {
                source: 'inline',
                categories: rows.map((row) => row.category),
                series: columns.map(({ name, style }, j) => ({
                    ...style,
                    name,
                    values: rows.map((row) => numberOf(row.cells[j])),
                })),
            },
        });

    return (
        <>
            <div className="max-h-[60vh] overflow-auto rounded-md border">
                <table className="border-separate border-spacing-1">
                    <thead>
                        <tr>
                            <th />
                            {columns.map((column, j) => (
                                <th key={j} className="font-normal">
                                    <div className="flex items-center gap-0.5">
                                        <Input
                                            aria-label={`Series ${j + 1} name`}
                                            className={cn(CELL_INPUT, 'w-24 font-medium')}
                                            value={column.name}
                                            maxLength={MAX_CHART_LABEL_LENGTH}
                                            onChange={(e) =>
                                                setColumns(
                                                    columns.map((c, k) =>
                                                        k === j ? { ...c, name: e.target.value } : c,
                                                    ),
                                                )
                                            }
                                            onPaste={onPaste(0, j + 1)}
                                        />
                                        <Button
                                            variant="ghost"
                                            size="icon-xs"
                                            aria-label="Remove column"
                                            disabled={columns.length === 1}
                                            onClick={() =>
                                                setGrid({
                                                    columns: columns.filter((_, k) => k !== j),
                                                    rows: rows.map((row) => ({
                                                        ...row,
                                                        cells: row.cells.filter((_, k) => k !== j),
                                                    })),
                                                })
                                            }
                                        >
                                            <X />
                                        </Button>
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, i) => (
                            <tr key={i}>
                                <td>
                                    <Input
                                        aria-label={`Row ${i + 1} label`}
                                        className={cn(CELL_INPUT, 'w-32')}
                                        value={row.category}
                                        maxLength={MAX_CHART_LABEL_LENGTH}
                                        onChange={(e) =>
                                            setRows(
                                                rows.map((r, k) => (k === i ? { ...r, category: e.target.value } : r)),
                                            )
                                        }
                                        onPaste={onPaste(i + 1, 0)}
                                    />
                                </td>
                                {row.cells.map((cell, j) => (
                                    <td key={j}>
                                        <Input
                                            aria-label={`Row ${i + 1}, series ${j + 1}`}
                                            aria-invalid={!isNumberText(cell)}
                                            inputMode="decimal"
                                            className={cn(CELL_INPUT, 'w-24 text-right tabular-nums')}
                                            value={cell}
                                            onChange={(e) => setCell(i, j, e.target.value)}
                                            onPaste={onPaste(i + 1, j + 1)}
                                        />
                                    </td>
                                ))}
                                <td>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="Remove row"
                                        disabled={rows.length === 1}
                                        onClick={() => setRows(rows.filter((_, k) => k !== i))}
                                    >
                                        <X />
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    disabled={!fitsInlineGrid(columns.length, rows.length + 1)}
                    onClick={() => setRows([...rows, newRow(rows.length, columns.length)])}
                >
                    <Plus /> Add row
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={!fitsInlineGrid(columns.length + 1, rows.length)}
                    onClick={() =>
                        setGrid({
                            columns: [...columns, newColumn(columns.length)],
                            rows: rows.map((row) => ({ ...row, cells: [...row.cells, ''] })),
                        })
                    }
                >
                    <Plus /> Add column
                </Button>
            </div>
            {clipped && (
                <p className="text-xs text-muted-foreground">
                    Some pasted cells didn't fit: a chart holds up to {INLINE_GRID_MAX_SERIES} series,{' '}
                    {INLINE_GRID_MAX_CATEGORIES} rows and {MAX_CHART_POINTS.toLocaleString('en')} values.
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
