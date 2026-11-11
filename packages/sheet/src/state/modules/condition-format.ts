// Conditional formats in the editor: the check and the write of the rule the dialog builds for the selection, the
// per-cell format map the painter reads (getComputeMap, checkCF), and the color-scale and data-bar presets. A sheet
// keeps its rules by id, so every write here adds or deletes one rule under its own id. The evaluation itself lives
// in the engine, which the server export shares.

import { eigenColor } from '@workspace/lib/constants/colors';
import type { ConditionalFormatConditionName, ConditionalFormatRule, Sheet } from '@workspace/lib/sheets';
import { MAX_CONDITIONAL_FORMATS, nextRuleOrder } from '@workspace/lib/sheets';
import { isNil } from 'es-toolkit/compat';
import { toA1 } from '../../engine/a1-notation';
import { createArrayResolver } from '../../engine/cell-resolver';
import type { CellFormatStyle, ComputeMap } from '../../engine/conditional-format';
import { createCfFormulaEvaluator, evaluateConditionalFormat } from '../../engine/conditional-format';
import type { CellMatrix } from '../../engine/types';
import { getSheet } from '../api/common';
import type { Context } from '../context';
import type { ConditionRulesProps } from '../types';
import { getSheetIndex } from '../utils';
import { getRangeByTxt } from './cell';
import { isRealNum } from './validation';

// The rules the conditional formatting dialog makes. The others, such as a formula rule, come from a file or from a
// value that reads a cell.
export type ConditionRuleType = Exclude<
    ConditionalFormatConditionName,
    'greaterThanOrEqual' | 'lessThanOrEqual' | 'notEqual' | 'notBetween' | 'formula'
>;

const SINGLE_CELL = 'Enter a single cell, such as =A1';
const NUMBER_OR_CELL = 'Enter a number, or a cell such as =A1';
const VALUE_OR_CELL = 'Enter a value, or a cell such as =A1';

// The formulas Excel writes for a rule whose value reads a cell, with the rule's top-left cell and its typed values.
// Like the xlsx import, the editor stores such a rule as a formula rule, so it reads the cell each time it paints.
const REFERENCE_FORMULAS: Partial<Record<ConditionRuleType, (cell: string, values: string[]) => string>> = {
    greaterThan: (cell, [value]) => `${cell}>${value}`,
    lessThan: (cell, [value]) => `${cell}<${value}`,
    equal: (cell, [value]) => `${cell}=${value}`,
    textContains: (cell, [value]) => `NOT(ISERROR(SEARCH(${value},${cell})))`,
    between: (cell, [lower, upper]) => `AND(${cell}>=${lower},${cell}<=${upper})`,
};

// Why the dialog's rule can't be saved, or undefined when it can. The dialog shows the reason under its fields and stays
// open, so the check runs before addConditionRule.
export function conditionRuleError(ctx: Context, rules: ConditionRulesProps): string | undefined {
    const values = readRuleValues(ctx, rules);
    return typeof values === 'string' ? values : undefined;
}

// Adds the dialog's rule over the selection, unless conditionRuleError refuses it.
export function addConditionRule(ctx: Context, rules: ConditionRulesProps) {
    const values = readRuleValues(ctx, rules);
    const ranges = ctx.selections ?? [];
    const [anchor] = ranges;
    if (typeof values === 'string' || !anchor) return;

    const formula = REFERENCE_FORMULAS[rules.rulesType];
    const readsCell = formula && values.some(isCellReference);
    const topLeft = toA1(anchor.row[0], anchor.column[0]);
    const operands = values.map((value) => value.replace(/^=/, ''));
    addRule(ctx, {
        type: 'default',
        ranges,
        order: lastOrder(ctx),
        format: {
            textColor: rules.textColor.check ? rules.textColor.color : null,
            cellColor: rules.cellColor.check ? rules.cellColor.color : null,
        },
        conditionName: readsCell ? 'formula' : rules.rulesType,
        conditionRange: [],
        conditionValue: readsCell ? [`=${formula(topLeft, operands)}`] : values,
    });
}

// The rule's values as the dialog typed them, or the message that refuses them.
function readRuleValues(ctx: Context, rules: ConditionRulesProps): string[] | string {
    switch (rules.rulesType) {
        case 'greaterThan':
        case 'lessThan':
            return checkTypedValues(ctx, [rules.rulesValue], isRealNum, NUMBER_OR_CELL);
        // These also compare text, so only an empty value is refused.
        case 'equal':
        case 'textContains':
            return checkTypedValues(ctx, [rules.rulesValue], (v) => v !== '', VALUE_OR_CELL);
        case 'between':
            return checkTypedValues(
                ctx,
                [rules.betweenValue.value1, rules.betweenValue.value2],
                isRealNum,
                NUMBER_OR_CELL,
            );
        case 'occurrenceDate':
            if (!rules.dateValue) return 'Select a date';
            return [rules.dateValue];
        case 'duplicateValue':
            return [rules.repeatValue];
        case 'top10':
        case 'top10_percent':
        case 'last10':
        case 'last10_percent': {
            const n = parseInt(rules.projectValue, 10);
            if (n.toString() !== rules.projectValue || n < 1 || n > 1000) {
                return 'Enter a whole number from 1 to 1000';
            }
            return [rules.projectValue];
        }
        default:
            return [];
    }
}

// As in Excel and Google Sheets, a value that starts with = names one cell, such as =A1 or =Data!A1. Any other value,
// FY2024 included, is the value itself, and `accepts` decides whether the rule takes it.
function checkTypedValues(
    ctx: Context,
    typed: string[],
    accepts: (value: string) => boolean,
    refusal: string,
): string[] | string {
    for (const value of typed) {
        if (!isCellReference(value)) {
            if (!accepts(value)) return refusal;
            continue;
        }
        const ranges = getRangeByTxt(ctx, value.slice(1));
        const [range] = ranges;
        if (ranges.length !== 1 || !range || range.row[0] !== range.row[1] || range.column[0] !== range.column[1]) {
            return SINGLE_CELL;
        }
    }
    return typed;
}

function isCellReference(value: string): boolean {
    return value.startsWith('=');
}

// The computed map per sheet, so a canvas paint doesn't evaluate every rule again. A single slot missed on every
// switch between two sheets, which costs seconds on a sheet with formula rules. Immer replaces a sheet's rules and data
// on any edit, so an entry is fresh while both are the same objects.
const _cfCache = new Map<string, { rules: Sheet['conditionalFormats']; data: CellMatrix; result: ComputeMap }>();

export function getComputeMap(ctx: Context): ComputeMap | null {
    const index = getSheetIndex(ctx, ctx.currentSheetId);
    if (index == null) return null;
    const rules = ctx.sheets[index].conditionalFormats;
    const { data } = ctx.sheets[index];
    if (isNil(data)) return null;

    const cached = _cfCache.get(ctx.currentSheetId);
    if (cached && cached.rules === rules && cached.data === data) {
        return cached.result;
    }

    // Each entry holds a whole matrix, so a miss drops the entries that can't hit again: a sheet that is gone, such as
    // one of a workbook this session closed, and a sheet edited since, such as by a peer or a cross-sheet recalc. The
    // recompute below costs far more than this sweep.
    const live = new Map(ctx.sheets.map((sheet) => [sheet.id, sheet]));
    for (const [id, entry] of _cfCache) {
        const sheet = live.get(id);
        if (!sheet || sheet.data !== entry.data || sheet.conditionalFormats !== entry.rules) {
            _cfCache.delete(id);
        }
    }

    // A paint reads a frozen context, so formula rules evaluate through the engine directly, as the HTML export does.
    const computeMap = evaluateConditionalFormat(rules, data, {
        evaluateFormula: createCfFormulaEvaluator(
            ctx.formulaCache.engine,
            createArrayResolver(ctx.sheets),
            ctx.currentSheetId,
        ),
    });
    _cfCache.set(ctx.currentSheetId, { rules, data, result: computeMap });
    return computeMap;
}

export function checkCF(r: number, c: number, computeMap: ComputeMap | null): CellFormatStyle | null {
    if (!isNil(computeMap) && `${r}_${c}` in computeMap) {
        return computeMap[`${r}_${c}`];
    }
    return null;
}

// The color scales and data bars the Format menu offers, by the preset keys it lists. A scale's stops run from the
// highest value to the lowest. The colors are Eigen's palette and white, the closest to the presets Excel offers;
// where the match was in doubt, the lighter, less saturated step. A rule keeps the colors it was made with, so
// changing one here changes only the rules made after.
const RED = eigenColor('red', 400);
const YELLOW = eigenColor('yellow', 200);
const GREEN = eigenColor('emerald', 400);
const BLUE = eigenColor('blue', 400);
const WHITE = '#ffffff';

export const CF_PRESETS: Record<string, string[]> = {
    colorGradation_1: [RED, YELLOW, GREEN],
    colorGradation_2: [GREEN, YELLOW, RED],
    colorGradation_3: [RED, WHITE, GREEN],
    colorGradation_4: [GREEN, WHITE, RED],
    colorGradation_5: [RED, WHITE, BLUE],
    colorGradation_6: [BLUE, WHITE, RED],
    colorGradation_7: [RED, WHITE],
    colorGradation_8: [WHITE, RED],
    colorGradation_9: [WHITE, GREEN],
    colorGradation_10: [GREEN, WHITE],
    colorGradation_11: [YELLOW, GREEN],
    colorGradation_12: [GREEN, YELLOW],
    // A data bar has one color. A negative value's bar is always red.
    solidColorDataBar_1: [BLUE],
    solidColorDataBar_2: [GREEN],
    solidColorDataBar_3: [RED],
    solidColorDataBar_4: [eigenColor('amber', 400)],
    solidColorDataBar_5: [eigenColor('blue', 300)],
    solidColorDataBar_6: [eigenColor('violet', 400)],
};

// Each rule goes under its own id, so a rule a peer added at the same time stays.
export function clearSheetRules(ctx: Context) {
    const rules = getSheet(ctx).conditionalFormats ?? {};
    for (const id of Object.keys(rules)) delete rules[id];
}

export function deleteSheetRule(ctx: Context, id: string) {
    delete getSheet(ctx).conditionalFormats?.[id];
}

export function applyColorScalePreset(ctx: Context, presetKey: string) {
    const format = CF_PRESETS[presetKey];
    if (!format) return;
    addRule(ctx, { type: 'colorGradation', ranges: ctx.selections ?? [], order: lastOrder(ctx), format });
}

export function applyDataBarPreset(ctx: Context, presetKey: string) {
    const format = CF_PRESETS[presetKey];
    if (!format) return;
    addRule(ctx, { type: 'dataBar', ranges: ctx.selections ?? [], order: lastOrder(ctx), format });
}

// A new rule goes last, so it wins the cells it shares with the rules before it.
function lastOrder(ctx: Context): string {
    return nextRuleOrder(getSheet(ctx).conditionalFormats);
}

// Every peer, the server and a reload drop a rule past the cap or over no range, so none is written.
function addRule(ctx: Context, rule: ConditionalFormatRule) {
    const rules = (getSheet(ctx).conditionalFormats ??= {});
    if (rule.ranges.length === 0 || Object.keys(rules).length >= MAX_CONDITIONAL_FORMATS) return;
    rules[crypto.randomUUID()] = rule;
}
