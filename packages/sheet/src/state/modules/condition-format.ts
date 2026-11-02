// Conditional formats in the editor: the check and the write of the rule the dialog builds for the selection, the
// per-cell format map the painter reads (getComputeMap, checkCF), and the color-scale and data-bar presets. The
// evaluation itself lives in the engine, which the server export shares.

import type {
    ColorGradationRule,
    ConditionalFormatConditionName,
    DataBarRule,
    DefaultConditionalFormatRule,
    SingleRange,
} from '@workspace/lib/sheets';
import { isNil } from 'es-toolkit/compat';
import type { CellFormatStyle, ComputeMap } from '../../engine/conditional-format';
import { createCfFormulaEvaluator, evaluateConditionalFormat } from '../../engine/conditional-format';
import type { CellMatrix, ConditionalFormatRule } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import { getFlowdata } from '../context';
import type { ConditionRulesProps } from '../types';
import { getSheetIndex } from '../utils';
import { getCellValue, getRangeByTxt } from './cell';
import { createContextResolver } from './formula-cache';
import { checkProtectionFormatCells } from './protection';
import { isRealNum } from './validation';

const KNOWN_CONDITION_NAMES = [
    'greaterThan',
    'greaterThanOrEqual',
    'lessThan',
    'lessThanOrEqual',
    'equal',
    'notEqual',
    'textContains',
    'between',
    'notBetween',
    'occurrenceDate',
    'duplicateValue',
    'top10',
    'top10_percent',
    'last10',
    'last10_percent',
    'aboveAverage',
    'belowAverage',
    'formula',
] as const satisfies readonly ConditionalFormatConditionName[];

const ONLY_SINGLE_CELL = 'Only a single cell can be referenced';
const VALUE_MUST_BE_NUMBER_OR_CELL = 'The condition value can only be a number or a single cell';
const VALUE_OR_CELL = 'Enter a value or a single cell';

// What a rule compares each cell against. A value read from a cell keeps that cell's range beside it.
type RuleValues = { conditionRange: SingleRange[]; conditionValue: (string | number)[] };

// Why the dialog's rule can't be saved, or null when it can. The dialog shows the reason under its fields and stays
// open, so the check runs before setConditionRules.
export function conditionRuleError(ctx: Context, rules: ConditionRulesProps): string | null {
    const values = readRuleValues(ctx, rules);
    return typeof values === 'string' ? values : null;
}

// Adds the dialog's rule over the selection, unless conditionRuleError refuses it or the sheet is protected.
export function setConditionRules(ctx: Context, rules: ConditionRulesProps) {
    if (!checkProtectionFormatCells(ctx)) return;
    // rulesType is a plain string, so a name the engine doesn't know would save a rule that never paints.
    if (!isKnownConditionName(rules.rulesType)) return;
    const values = readRuleValues(ctx, rules);
    if (typeof values === 'string') return;

    const rule: DefaultConditionalFormatRule = {
        type: 'default',
        cellrange: ctx.selections ?? [],
        format: {
            textColor: rules.textColor.check ? rules.textColor.color : null,
            cellColor: rules.cellColor.check ? rules.cellColor.color : null,
        },
        conditionName: rules.rulesType,
        ...values,
    };
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const ruleArr = ctx.sheets[index].conditionalFormatRules ?? [];
    ruleArr.push(rule);
    ctx.sheets[index].conditionalFormatRules = ruleArr;
}

function isKnownConditionName(s: string): s is ConditionalFormatConditionName {
    return (KNOWN_CONDITION_NAMES as readonly string[]).includes(s);
}

// The rule's values as the dialog typed them, or the message that refuses them.
function readRuleValues(ctx: Context, rules: ConditionRulesProps): RuleValues | string {
    switch (rules.rulesType) {
        case 'greaterThan':
        case 'lessThan':
            return readTypedValues(ctx, [rules.rulesValue], isRealNum, VALUE_MUST_BE_NUMBER_OR_CELL);
        // These also compare text, so only an empty value is refused.
        case 'equal':
        case 'textContains':
            return readTypedValues(ctx, [rules.rulesValue], (v) => v !== '', VALUE_OR_CELL);
        case 'between':
            return readTypedValues(
                ctx,
                [rules.betweenValue.value1, rules.betweenValue.value2],
                isRealNum,
                VALUE_MUST_BE_NUMBER_OR_CELL,
            );
        case 'occurrenceDate':
            if (!rules.dateValue) return 'Please select a date';
            return { conditionRange: [], conditionValue: [rules.dateValue] };
        case 'duplicateValue':
            return { conditionRange: [], conditionValue: [rules.repeatValue] };
        case 'top10':
        case 'top10_percent':
        case 'last10':
        case 'last10_percent': {
            const n = parseInt(rules.projectValue, 10);
            if (n.toString() !== rules.projectValue || n < 1 || n > 1000) {
                return 'Please enter an integer between 1 and 1000';
            }
            return { conditionRange: [], conditionValue: [rules.projectValue] };
        }
        default:
            return { conditionRange: [], conditionValue: [] };
    }
}

// Each typed value is either one cell's reference, which reads that cell's value, or a value `accepts` takes as typed.
function readTypedValues(
    ctx: Context,
    typed: readonly string[],
    accepts: (value: string) => boolean,
    refusal: string,
): RuleValues | string {
    const values: RuleValues = { conditionRange: [], conditionValue: [] };
    for (const value of typed) {
        const ranges = getRangeByTxt(ctx, value);
        if (ranges.length === 0) {
            if (!accepts(value)) return refusal;
            values.conditionValue.push(value);
            continue;
        }
        const [range] = ranges;
        if (ranges.length > 1 || !range || range.row[0] !== range.row[1] || range.column[0] !== range.column[1]) {
            return ONLY_SINGLE_CELL;
        }
        // A reference that names a sheet, such as Data!A1, reads that sheet.
        const data = getFlowdata(ctx, range.sheetId);
        values.conditionRange.push({ row: range.row, column: range.column });
        values.conditionValue.push(toRuleValue(data && getCellValue(range.row[0], range.column[0], data)));
    }
    return values;
}

// A cell's value can be a boolean too, which the rule stores as text.
function toRuleValue(raw: unknown): string | number {
    if (typeof raw === 'number' || typeof raw === 'string') return raw;
    if (raw == null) return '';
    return String(raw);
}

// Cache for getComputeMap — avoids recomputing the entire CF map on every
// canvas paint / getStyleByCell call. Keyed per sheet: a single slot made every
// A→B→A tab switch a guaranteed miss, and on a sheet carrying formula rules that
// recompute costs seconds. Entries invalidate themselves — immer replaces `rules`
// and `data` by reference on any edit, rule change or row/col op, so both must
// stay in the key. Bounded by the workbook: a miss first drops every entry whose
// sheet the current workbook no longer has.
const _cfCache = new Map<
    string,
    {
        rules: ConditionalFormatRule[] | undefined;
        data: CellMatrix;
        result: ComputeMap;
    }
>();

export function getComputeMap(ctx: Context): ComputeMap | null {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return null;
    const ruleArr = ctx.sheets[index].conditionalFormatRules;
    const { data } = ctx.sheets[index];
    if (isNil(data)) return null;

    // Return cached result if inputs haven't changed (reference equality)
    const cached = _cfCache.get(ctx.currentSheetId);
    if (cached && cached.rules === ruleArr && cached.data === data) {
        return cached.result;
    }

    // Every entry pins a whole CellMatrix and a ComputeMap, so none may outlive its
    // usefulness: drop the ones this workbook can no longer address — sheets that
    // were deleted, and every sheet of a workbook this session has since closed —
    // and the ones whose sheet has moved on. Immer replaces `data`/`rules` by
    // reference on any edit, and sheets are edited while not current routinely
    // (cross-sheet recalc, a collab peer's edit, a row/col op), so such an entry can
    // never hit again yet pinned its matrix until you navigated back. A miss is the
    // moment to do it, the recompute below dwarfs the sweep, and the hot path (the
    // hit above) never pays for it.
    const live = new Map(ctx.sheets.map((sheet) => [sheet.id, sheet]));
    for (const [id, entry] of _cfCache) {
        const sheet = live.get(id);
        if (!sheet || sheet.data !== entry.data || sheet.conditionalFormatRules !== entry.rules) {
            _cfCache.delete(id);
        }
    }

    // Evaluate CF formulas through the engine directly, like the HTML export.
    // execfunction would assign ctx.calculateSheetId — painting runs against an
    // immer-frozen context, so that throws — and would register every CF formula into
    // the sheet's calc chain via insertUpdateFunctionGroup.
    const computeMap = evaluateConditionalFormat(ruleArr, data, {
        evaluateFormula: createCfFormulaEvaluator(
            ctx.formulaCache.engine,
            createContextResolver(ctx),
            ctx.currentSheetId,
        ),
    });
    _cfCache.set(ctx.currentSheetId, { rules: ruleArr, data, result: computeMap });
    return computeMap;
}

export function checkCF(r: number, c: number, computeMap: ComputeMap | null): CellFormatStyle | null {
    if (!isNil(computeMap) && `${r}_${c}` in computeMap) {
        return computeMap[`${r}_${c}`];
    }
    return null;
}

// 12 color-scale + 6 solid-data-bar presets, ported from luckysheet upstream.
// Numbers match the preset keys COLOR_SCALE_PRESETS / DATA_BAR_PRESETS offer in
// components/MenuBar/format-menu.tsx.
export const CF_PRESETS: Record<string, string[]> = {
    // 3-color gradients (max → mid → min)
    colorGradation_1: ['#f8696b', '#ffeb84', '#63be7b'],
    colorGradation_2: ['#63be7b', '#ffeb84', '#f8696b'],
    colorGradation_3: ['#f8696b', '#ffffff', '#63be7b'],
    colorGradation_4: ['#63be7b', '#ffffff', '#f8696b'],
    colorGradation_5: ['#f8696b', '#ffffff', '#5a8ac6'],
    colorGradation_6: ['#5a8ac6', '#ffffff', '#f8696b'],
    // 2-color gradients (max → min)
    colorGradation_7: ['#f8696b', '#ffffff'],
    colorGradation_8: ['#ffffff', '#f8696b'],
    colorGradation_9: ['#ffffff', '#63be7b'],
    colorGradation_10: ['#63be7b', '#ffffff'],
    colorGradation_11: ['#ffeb84', '#63be7b'],
    colorGradation_12: ['#63be7b', '#ffeb84'],
    // Solid data-bar colors (single bar color; negative bars hardcode red)
    solidColorDataBar_1: ['#638ec6'],
    solidColorDataBar_2: ['#63be7b'],
    solidColorDataBar_3: ['#f8696b'],
    solidColorDataBar_4: ['#ffb628'],
    solidColorDataBar_5: ['#a3c8ff'],
    solidColorDataBar_6: ['#a085ff'],
};

export function clearSheetRules(ctx: Context) {
    if (!checkProtectionFormatCells(ctx)) return;
    getSheet(ctx).conditionalFormatRules = [];
}

export function applyColorScalePreset(ctx: Context, presetKey: string) {
    if (!checkProtectionFormatCells(ctx)) return;
    const format = CF_PRESETS[presetKey];
    if (!format) return;
    appendRule(ctx, 'colorGradation', format);
}

export function applyDataBarPreset(ctx: Context, presetKey: string) {
    if (!checkProtectionFormatCells(ctx)) return;
    const format = CF_PRESETS[presetKey];
    if (!format) return;
    appendRule(ctx, 'dataBar', format);
}

function appendRule(ctx: Context, type: 'colorGradation' | 'dataBar', format: string[]) {
    const sheet = getSheet(ctx);
    const rule: ColorGradationRule | DataBarRule = {
        type,
        cellrange: ctx.selections ?? [],
        format,
    };
    const existing = sheet.conditionalFormatRules ?? [];
    existing.push(rule);
    sheet.conditionalFormatRules = existing;
}
