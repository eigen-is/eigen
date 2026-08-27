import type {
    ColorGradationRule,
    ConditionalFormatConditionName,
    DataBarRule,
    DefaultConditionalFormatRule,
    SingleRange,
} from '@workspace/lib/sheets';
import { isNil } from 'es-toolkit/compat';
import type { CellFormatStyle, ComputeMap } from '../../engine/conditional-format';
import { evaluateConditionalFormat } from '../../engine/conditional-format';
import { functionCopy } from '../../engine/formula-shift';
import type { CellMatrix, ConditionalFormatRule } from '../../engine/types';
import { type Context, getFlowdata } from '../context';
import type { ConditionRulesProps } from '../types';
import { getSheetIndex } from '../utils';
import { getCellValue, getRangeByTxt } from './cell';
import { createContextResolver } from './formula-cache';
import { checkProtectionFormatCells } from './protection';

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

function isKnownConditionName(s: string): s is ConditionalFormatConditionName {
    return (KNOWN_CONDITION_NAMES as readonly string[]).includes(s);
}

// Coerce a raw cell value (which can be any of Cell['v'] = string | number |
// boolean | undefined) into the `(string | number)[]` shape stored on the rule.
function toRuleValue(raw: unknown): string | number {
    if (typeof raw === 'number' || typeof raw === 'string') return raw;
    if (raw == null) return '';
    return String(raw);
}

// Set condition rules
export function setConditionRules(ctx: Context, conditionformat: Record<string, string>, rules: ConditionRulesProps) {
    if (!checkProtectionFormatCells(ctx)) {
        return;
    }

    // The dialog seeds rules.rulesType from a substring of the rangeDialog type
    // (`conditionRules` prefix stripped) and never validates against the engine's
    // canonical name set. Bail out on names the engine doesn't recognise rather
    // than persisting a rule that would silently no-op on every paint.
    if (!isKnownConditionName(rules.rulesType)) {
        return;
    }
    const conditionName = rules.rulesType;

    const conditionRange: SingleRange[] = [];
    const conditionValue: (string | number)[] = [];

    if (
        conditionName === 'greaterThan' ||
        conditionName === 'lessThan' ||
        conditionName === 'equal' ||
        conditionName === 'textContains'
    ) {
        const rangeArr = getRangeByTxt(ctx, rules.rulesValue);
        // check whether the condition value is a selection range
        if (rangeArr.length > 1) {
            const first = rangeArr[0];
            if (!first) return;
            const [r1, r2] = first.row;
            const [c1, c2] = first.column;
            if (r1 === r2 && c1 === c2) {
                const d = getFlowdata(ctx);
                if (!d || isNil(r1) || isNil(c1)) return;
                conditionRange.push({ row: first.row, column: first.column });
                conditionValue.push(toRuleValue(getCellValue(r1, c1, d)));
            } else {
                ctx.warnDialog = conditionformat.onlySingleCell;
            }
        } else if (rangeArr.length === 0) {
            const v = rules.rulesValue;
            if (Number.isNaN(v) || v === '') {
                ctx.warnDialog = conditionformat.conditionValueCanOnly;
                return;
            }
            conditionValue.push(v);
        }
    } else if (conditionName === 'between') {
        const v1 = rules.betweenValue.value1;
        const v2 = rules.betweenValue.value2;

        const rangeArr1 = getRangeByTxt(ctx, v1);
        if (rangeArr1.length > 1) {
            ctx.warnDialog = conditionformat.onlySingleCell;
            return;
        }
        if (rangeArr1.length === 1) {
            const first = rangeArr1[0];
            if (!first) return;
            const [r1, r2] = first.row;
            const [c1, c2] = first.column;
            if (r1 === r2 && c1 === c2) {
                const d = getFlowdata(ctx);
                if (!d || isNil(r1) || isNil(c1)) return;
                conditionRange.push({ row: first.row, column: first.column });
                conditionValue.push(toRuleValue(getCellValue(r1, c1, d)));
            } else {
                ctx.warnDialog = conditionformat.onlySingleCell;
                return;
            }
        } else if (rangeArr1.length === 0) {
            if (Number.isNaN(v1) || v1 === '') {
                ctx.warnDialog = conditionformat.conditionValueCanOnly;
                return;
            }
            conditionValue.push(v1);
        }
        const rangeArr2 = getRangeByTxt(ctx, v2);
        if (rangeArr2.length > 1) {
            ctx.warnDialog = conditionformat.onlySingleCell;
            return;
        }
        if (rangeArr2.length === 1) {
            const first = rangeArr2[0];
            if (!first) return;
            const [r1, r2] = first.row;
            const [c1, c2] = first.column;
            if (r1 === r2 && c1 === c2) {
                const d = getFlowdata(ctx);
                if (!d || isNil(r1) || isNil(c1)) return;
                conditionRange.push({ row: first.row, column: first.column });
                conditionValue.push(toRuleValue(getCellValue(r1, c1, d)));
            } else {
                ctx.warnDialog = conditionformat.onlySingleCell;
                return;
            }
        } else if (rangeArr2.length === 0) {
            if (Number.isNaN(v2) || v2 === '') {
                ctx.warnDialog = conditionformat.conditionValueCanOnly;
            } else {
                conditionValue.push(v2);
            }
        }
    } else if (conditionName === 'occurrenceDate') {
        const v = rules.dateValue;
        if (!v) {
            ctx.warnDialog = conditionformat.pleaseSelectADate;
            return;
        }
        conditionValue.push(v);
    } else if (conditionName === 'duplicateValue') {
        conditionValue.push(rules.repeatValue);
    } else if (
        conditionName === 'top10' ||
        conditionName === 'top10_percent' ||
        conditionName === 'last10' ||
        conditionName === 'last10_percent'
    ) {
        const v = rules.projectValue;
        const n = parseInt(v, 10);
        if (n.toString() !== v || n < 1 || n > 1000) {
            ctx.warnDialog = conditionformat.pleaseEnterInteger;
            return;
        }
        conditionValue.push(v);
    }

    const textColor = rules.textColor.check ? rules.textColor.color : null;
    const cellColor = rules.cellColor.check ? rules.cellColor.color : null;

    const rule: DefaultConditionalFormatRule = {
        type: 'default',
        cellrange: ctx.selections ?? [],
        format: { textColor, cellColor },
        conditionName,
        conditionRange,
        conditionValue,
    };
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return;
    const ruleArr = ctx.sheets[index].conditionalFormatRules ?? [];
    ruleArr.push(rule);

    ctx.sheets[index].conditionalFormatRules = ruleArr;
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

    // Every entry pins a whole CellMatrix, so none may outlive its sheet: drop
    // the ones this workbook can no longer address — sheets that were deleted,
    // and every sheet of a workbook this session has since closed. A miss is the
    // moment to do it, the recompute below dwarfs the sweep, and the hot path
    // (the hit above) never pays for it.
    const live = new Set(ctx.sheets.map((sheet) => sheet.id));
    for (const id of _cfCache.keys()) {
        if (!live.has(id)) _cfCache.delete(id);
    }

    // Evaluate CF formulas through the engine directly (same shape as the HTML export's
    // buildCfFormulaEvaluator). execfunction would assign ctx.calculateSheetId — painting
    // runs against an immer-frozen context, so that throws — and would register every CF
    // formula into the sheet's calc chain via insertUpdateFunctionGroup.
    const resolver = createContextResolver(ctx);
    const computeMap = evaluateConditionalFormat(ruleArr, data, {
        evaluateFormula: (formula, anchorRow, anchorCol, targetRow, targetCol) => {
            const offsetRow = targetRow - anchorRow;
            const offsetCol = targetCol - anchorCol;
            let shifted = formula;
            if (offsetRow > 0) {
                shifted = `=${functionCopy(shifted, 'down', offsetRow)}`;
            }
            if (offsetCol > 0) {
                shifted = `=${functionCopy(shifted, 'right', offsetCol)}`;
            }
            return ctx.formulaCache.engine.evaluate(shifted, ctx.currentSheetId, targetRow, targetCol, resolver).value;
        },
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
// Numbers match the locale keys colorGradation_1..12 / solidColorDataBar_1..6
// in state/locale/en.ts.
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
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    ctx.sheets[index].conditionalFormatRules = [];
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
    const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
    const rule: ColorGradationRule | DataBarRule = {
        type,
        cellrange: ctx.selections ?? [],
        format,
    };
    const existing = ctx.sheets[index].conditionalFormatRules ?? [];
    existing.push(rule);
    ctx.sheets[index].conditionalFormatRules = existing;
}
