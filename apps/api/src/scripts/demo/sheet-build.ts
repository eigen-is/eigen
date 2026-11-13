// Builds a demo workbook from its typed spec, such as the budget sheet or the quote a seeded mail attaches.
// The seeder writes the budget straight into its container's Y.Doc, as it builds the site plan and the deck, because
// frozen bytes cannot survive a change to the stored sheet shape and a spec can. The cells, rules and charts are the
// shapes the editor stores, and the formulas are computed here once, as the xlsx importer does, so the snapshot is
// stored as computed and opens with its values. Deterministic ids: a reseed builds the same workbook.

import { numberDisplay } from '@workspace/formula/format';
import { CHART_DEFAULT_SIZE, defaultChartSpec, newChartSpecParts } from '@workspace/lib/charts';
import { eigenColor } from '@workspace/lib/constants/colors';
import type {
    BorderSide,
    Cell,
    CellBorderSides,
    CellWithRowAndCol,
    ConditionalFormatRule,
    Sheet,
    SheetChart,
    SheetValidation,
    SingleRange,
} from '@workspace/lib/sheets';
import {
    encodeSheetsSnapshot,
    nextFloatingIndex,
    nextRuleOrder,
    sheetFloatingBox,
    writeSheetsSnapshot,
} from '@workspace/lib/sheets';
import type { CellRangeRef } from '@workspace/lib/types/chart';
import { normalizeSheetConfig, parseA1Range, recalcSheets } from '@workspace/sheet/engine';
import type * as Y from 'yjs';
import type { SheetCellSpec, SheetRowSpec, SheetSpec } from './content';

const RULE: BorderSide = { style: 1, color: '#000000' };

const ROW_STYLES: Record<NonNullable<SheetRowSpec['style']>, { cell: Cell; border: CellBorderSides }> = {
    header: { cell: { bl: 1 }, border: { b: RULE } },
    section: { cell: { it: 1, bg: '#ecfcca' }, border: { b: RULE } },
    total: { cell: { it: 1 }, border: { t: RULE } },
};

// The editor's blue data-bar preset, and the light red fill with dark red text Google offers for a rule, both from
// the Eigen palette as the editor's presets are.
const DATA_BAR_COLOR = eigenColor('blue', 400);
const BELOW_ZERO_FORMAT = { textColor: eigenColor('red', 700), cellColor: eigenColor('red', 100) };

// The workbook's sheets with every formula computed.
export function buildWorkbook(specs: readonly SheetSpec[]): Sheet[] {
    const ids = new Map(specs.map((spec, i) => [spec.name, sheetIdAt(i)]));
    return recalcSheets(specs.map((spec, i) => buildSheet(spec, i, ids)));
}

// The workbook as a sheets container's snapshot, written the way an import commits one.
export function buildWorkbookDoc(doc: Y.Doc, specs: readonly SheetSpec[]): void {
    writeSheetsSnapshot(doc, encodeSheetsSnapshot(buildWorkbook(specs), { computed: true }), null);
}

const sheetIdAt = (order: number) => `sheet-${order + 1}`;

function buildSheet(spec: SheetSpec, order: number, ids: ReadonlyMap<string, string>): Sheet {
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

    // The rules are numbered and ordered as the spec lists them, as the charts below are.
    const conditionalFormats: Record<string, ConditionalFormatRule> = {};
    const format = () => ({
        id: `format-${Object.keys(conditionalFormats).length + 1}`,
        order: nextRuleOrder(conditionalFormats),
    });
    for (const a1 of spec.dataBars ?? []) {
        const { id, order } = format();
        conditionalFormats[id] = { type: 'dataBar', ranges: [range(a1)], order, format: [DATA_BAR_COLOR] };
    }
    for (const a1 of spec.redBelowZero ?? []) {
        const { id, order } = format();
        conditionalFormats[id] = {
            type: 'default',
            ranges: [range(a1)],
            order,
            format: BELOW_ZERO_FORMAT,
            conditionName: 'lessThan',
            conditionRange: [],
            conditionValue: [0],
        };
    }
    const dataValidations: Record<string, SheetValidation> = {};
    for (const [i, { range: a1, options }] of (spec.dropdowns ?? []).entries()) {
        dataValidations[`validation-${i + 1}`] = {
            ranges: [range(a1)],
            order: nextRuleOrder(dataValidations),
            rule: {
                type: 'dropdown',
                type2: '',
                value1: options.join(','),
                value2: '',
                prohibitInput: false,
                hintShow: false,
                hintValue: '',
            },
        };
    }

    const charts: Record<string, SheetChart> = {};
    const sheet: Sheet = {
        name: spec.name,
        id: sheetIdAt(order),
        order,
        celldata,
        config: {
            columnlen: Object.fromEntries(spec.columns.map((column, c) => [c, column.width])),
            borderInfo,
        },
        conditionalFormats,
        dataValidations,
        charts,
    };
    // Each chart is a one-series range chart at Insert's default size, stacked above the ones before it, as a second
    // Insert would put it. One series needs no legend, and a pie names its own slices.
    for (const [i, chart] of (spec.charts ?? []).entries()) {
        const id = `chart-${i + 1}`;
        const defaults = defaultChartSpec(chart.type, {
            source: 'range',
            categories: chartRef(chart.categories, ids),
            series: [{ id: 's-1', name: chart.seriesName, values: chartRef(chart.values, ids) }],
        });
        charts[id] = {
            id,
            index: nextFloatingIndex(sheet),
            ...sheetFloatingBox({ x: chart.x, y: chart.y, ...CHART_DEFAULT_SIZE }),
            ...newChartSpecParts({ ...defaults, title: { text: chart.title }, legend: { position: 'none' } }),
        };
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

function range(a1: string): SingleRange {
    const parsed = parseA1Range(a1);
    if (!parsed) throw new Error(`Workbook spec names a bad range '${a1}'`);
    return { row: [parsed.start.row, parsed.end.row], column: [parsed.start.col, parsed.end.col] };
}

// A chart's ref names its sheet by id, so a renamed tab keeps its charts.
function chartRef(a1: string, ids: ReadonlyMap<string, string>): CellRangeRef {
    const sheetId = ids.get(parseA1Range(a1)?.sheet ?? '');
    if (!sheetId) throw new Error(`Chart range '${a1}' names no tab of its workbook`);
    const { row, column } = range(a1);
    return { sheetId, row: [row[0], row[1]], column: [column[0], column[1]] };
}
