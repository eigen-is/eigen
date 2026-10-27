// Builds a demo workbook from its typed spec (content.ts), such as the budget sheet or the quote a seeded mail attaches.
// The seeder writes the budget straight into its container's Y.Doc, as it builds the site plan and the deck, because
// frozen bytes cannot survive a change to the stored sheet shape and a spec can. The cells, rules and charts are the
// shapes the editor stores, and the formulas are computed here once, as the xlsx importer does, so the snapshot is
// stored as computed and opens with its values. Deterministic ids: a reseed builds the same workbook.

import { CHART_DEFAULT_SIZE, defaultChartSpec, newSheetChartSpecParts } from '@workspace/lib/charts';
import type {
    BorderSide,
    Cell,
    CellBorderSides,
    CellWithRowAndCol,
    ConditionalFormatRule,
    DataVerificationRule,
    Sheet,
    SheetChart,
    SingleRange,
} from '@workspace/lib/sheets';
import { encodeSheetsSnapshot, nextFloatingIndex, sheetFloatingBox } from '@workspace/lib/sheets';
import type { CellRangeRef, ChartSpec } from '@workspace/lib/types/chart';
import { normalizeSheetConfig, numberDisplay, parseA1Range, recalcSheets } from '@workspace/sheet/engine';
import type * as Y from 'yjs';
import { writeSheetsSnapshotToYjs } from '../../lib/document/sheets';
import type { SheetCellSpec, SheetChartSpec, SheetRowSpec, SheetSpec } from './content';

const RULE: BorderSide = { style: 1, color: '#000000' };

const ROW_STYLES: Record<NonNullable<SheetRowSpec['style']>, { cell: Cell; border: CellBorderSides }> = {
    header: { cell: { bl: 1 }, border: { b: RULE } },
    section: { cell: { it: 1, bg: '#ecfcca' }, border: { b: RULE } },
    total: { cell: { it: 1 }, border: { t: RULE } },
};

// The editor's first data-bar preset, and the light red fill with dark red text Google offers for a rule.
const DATA_BAR_COLOR = '#638ec6';
const BELOW_ZERO_FORMAT = { textColor: '#c92a2a', cellColor: '#ffe3e3' };

// The workbook's sheets with every formula computed.
export function buildWorkbook(specs: SheetSpec[]): Sheet[] {
    const ids = new Map(specs.map((spec, i) => [spec.name, `sheet-${i + 1}`]));
    return recalcSheets(specs.map((spec, i) => buildSheet(spec, i, ids)));
}

// The workbook as a sheets container's snapshot, written the way an import commits one.
export function buildWorkbookDoc(doc: Y.Doc, specs: SheetSpec[]): void {
    writeSheetsSnapshotToYjs(doc, encodeSheetsSnapshot(buildWorkbook(specs), { computed: true }));
}

function buildSheet(spec: SheetSpec, order: number, ids: Map<string, string>): Sheet {
    const celldata: CellWithRowAndCol[] = [];
    const borderInfo: Record<string, CellBorderSides> = {};
    for (const [r, row] of spec.rows.entries()) {
        const style = row.style && ROW_STYLES[row.style];
        for (const [c, column] of spec.columns.entries()) {
            const cell = buildCell(row.cells[c] ?? null, column.format, style ? style.cell : {});
            if (cell) celldata.push({ r, c, v: cell });
            if (style) borderInfo[`${r}_${c}`] = style.border;
        }
    }

    const dataBars = (spec.dataBars ?? []).map(
        (a1): ConditionalFormatRule => ({ type: 'dataBar', cellrange: [range(a1)], format: [DATA_BAR_COLOR] }),
    );
    const belowZero = (spec.redBelowZero ?? []).map(
        (a1): ConditionalFormatRule => ({
            type: 'default',
            cellrange: [range(a1)],
            format: BELOW_ZERO_FORMAT,
            conditionName: 'lessThan',
            conditionRange: [],
            conditionValue: [0],
        }),
    );
    // A list rule on every cell of its range, keyed by the cell as the editor's dialog writes it.
    const dataVerification: Record<string, DataVerificationRule> = {};
    for (const { range: a1, options } of spec.dropdowns ?? []) {
        const { row, column } = range(a1);
        const rule: DataVerificationRule = {
            type: 'dropdown',
            type2: '',
            value1: options.join(','),
            value2: '',
            prohibitInput: false,
            hintShow: false,
            hintValue: '',
        };
        for (let r = row[0]; r <= row[1]; r++) {
            for (let c = column[0]; c <= column[1]; c++) dataVerification[`${r}_${c}`] = { ...rule };
        }
    }

    const charts: Record<string, SheetChart> = {};
    const sheet: Sheet = {
        name: spec.name,
        id: ids.get(spec.name),
        order,
        celldata,
        config: {
            columnlen: Object.fromEntries(spec.columns.map((column, c) => [c, column.width])),
            borderInfo,
        },
        conditionalFormatRules: [...dataBars, ...belowZero],
        dataVerification,
        charts,
    };
    // Each chart is stacked above the ones before it, as a second Insert would put it.
    for (const [i, chart] of (spec.charts ?? []).entries()) {
        const id = `chart-${i + 1}`;
        charts[id] = buildChart(chart, id, nextFloatingIndex(sheet), ids);
    }
    normalizeSheetConfig(sheet);
    return sheet;
}

// A formula cell holds only its text and format here: the recalc writes its value and display string.
function buildCell(value: SheetCellSpec, format: string | undefined, style: Cell): Cell | null {
    const fa = format ?? 'General';
    if (value === null) return Object.keys(style).length > 0 ? { ...style } : null;
    if (typeof value === 'number') return { ...style, v: value, m: numberDisplay(value, fa), ct: { fa, t: 'n' } };
    if (value.startsWith('=')) return { ...style, f: value, ct: { fa, t: 'n' } };
    return { ...style, v: value, m: value, ct: { fa: 'General', t: 's' } };
}

// A one-series range chart at Insert's default size. One series needs no legend, and a pie names its own slices.
function buildChart(spec: SheetChartSpec, id: string, index: string, ids: Map<string, string>): SheetChart {
    const defaults = defaultChartSpec(spec.type, {
        source: 'range',
        categories: chartRef(spec.categories, ids),
        series: [{ id: 's-1', name: spec.seriesName, values: chartRef(spec.values, ids) }],
    });
    const chartSpec: ChartSpec = { ...defaults, title: { text: spec.title }, legend: { position: 'none' } };
    return {
        id,
        index,
        ...sheetFloatingBox({ x: spec.x, y: spec.y, ...CHART_DEFAULT_SIZE }),
        ...newSheetChartSpecParts(chartSpec),
    };
}

function range(a1: string): SingleRange {
    const parsed = parseA1Range(a1);
    if (!parsed) throw new Error(`Workbook spec names a bad range '${a1}'`);
    return { row: [parsed.start.row, parsed.end.row], column: [parsed.start.col, parsed.end.col] };
}

// A chart's ref names its sheet by id, so a renamed tab keeps its charts.
function chartRef(a1: string, ids: Map<string, string>): CellRangeRef {
    const sheetId = ids.get(parseA1Range(a1)?.sheet ?? '');
    if (!sheetId) throw new Error(`Chart range '${a1}' names no tab of its workbook`);
    const { row, column } = range(a1);
    return { sheetId, row: [row[0], row[1]], column: [column[0], column[1]] };
}
