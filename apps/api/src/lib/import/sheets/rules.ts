import { formatInputDate } from '@workspace/lib/date';
import type {
    ConditionalFormatConditionName,
    ConditionalFormatRule,
    DataVerificationRule,
    DefaultConditionalFormatRule,
    Sheet,
    SingleRange,
} from '@workspace/lib/sheets';
import { REFERENCE_COLUMN_COUNT, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { iscelldata, parseA1Range, toA1 } from '@workspace/sheet/engine';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlText } from '../../core/xml';
import { isOn, SML_NS, X14_NS, XM_NS } from '../../ooxml/ooxml';
import {
    CF_CELL_IS_CONDITION,
    DAY_MS,
    DAYS_1904,
    DUPLICATE_RULE,
    DV_DATE_OPERATOR,
    DV_OPERATOR,
    DV_TYPE,
    EXCEL_EPOCH_MS,
    inExcelGrid,
    NUMERIC,
    TOP10_CONDITION,
    withoutFuturePrefixes,
} from '../../ooxml/spreadsheetml';
import { colorOf, type DxfLook, dxfLook, resolveColor, type ThemePalette } from './styles';
import { cellKey } from './worksheet';

// A worksheet's conditional formats and data validations, read from the part beside its grid. Excel 2010 writes what
// the 2007 schema can't hold, a rule or a list over another sheet, into the extension list, read here too. What a rule
// emits is charged before it is built: the ranges a format holds, the cells a validation keys and their text.

export type RulesContext = {
    dxfs: DxfLook[];
    palette: ThemePalette;
    date1904: boolean;
    // The span of the grid's cells.
    rows: number;
    columns: number;
    // A 1904 workbook's date cells, by cellKey.
    dates: ReadonlySet<number>;
    // Throws past the budget: a range or a key counts as a cell, text as its characters.
    charge(cells: number, text: number): void;
    // Called with each reference of a sqref before it is parsed, whatever it emits; throws past the budget.
    chargeElements(count: number): void;
};

export function readRules(
    rest: XmlElement | undefined,
    context: RulesContext,
): Pick<Sheet, 'conditionalFormatRules' | 'dataVerification'> {
    if (!rest) return {};
    const extensions = (name: string) =>
        xmlChildren(rest, SML_NS, 'extLst')
            .flatMap((list) => xmlChildren(list, SML_NS, 'ext'))
            .flatMap((ext) => xmlChildren(ext, X14_NS, name));
    const textOf = (element: XmlElement | undefined) => (element ? xmlText(element) : undefined);

    // The 2007 schema's elements and Excel 2010's, which hold the same rules in their own names; read lazily, as a
    // flood of rules costs only what is charged.
    const formatLists = [
        {
            blocks: xmlChildren(rest, SML_NS, 'conditionalFormatting'),
            sqrefOf: (block: XmlElement) => xmlAttr(block, '', 'sqref'),
            rulesOf: (block: XmlElement) => xmlChildren(block, SML_NS, 'cfRule'),
            formulasOf: (rule: XmlElement) => xmlChildren(rule, SML_NS, 'formula'),
            lookOf: (rule: XmlElement) => context.dxfs[Number(xmlAttr(rule, '', 'dxfId'))],
        },
        {
            blocks: extensions('conditionalFormattings').flatMap((list) =>
                xmlChildren(list, X14_NS, 'conditionalFormatting'),
            ),
            sqrefOf: (block: XmlElement) => textOf(xmlChild(block, XM_NS, 'sqref')),
            rulesOf: (block: XmlElement) => xmlChildren(block, X14_NS, 'cfRule'),
            formulasOf: (rule: XmlElement) => xmlChildren(rule, XM_NS, 'f'),
            lookOf: (rule: XmlElement) => dxfLook(xmlChild(rule, X14_NS, 'dxf'), context.palette),
        },
    ];
    const formats: { priority: number; format: ConditionalFormatRule }[] = [];
    for (const { blocks, sqrefOf, rulesOf, formulasOf, lookOf } of formatLists) {
        for (const block of blocks) {
            const rules = rulesOf(block);
            if (rules.length === 0) continue;
            // Every rule holds all the block's ranges, which a sqref can repeat by the million: a range is charged once
            // for each rule before it is built.
            const ranges: SingleRange[] = [];
            for (const range of rangesOf(sqrefOf(block) ?? '', context)) {
                context.charge(rules.length, 0);
                ranges.push(range);
            }
            if (ranges.length === 0) continue;
            for (const rule of rules) {
                const formulas = formulasOf(rule).map((formula) => withoutFuturePrefixes(xmlText(formula)));
                context.charge(
                    0,
                    formulas.reduce((text, formula) => text + formula.length, 0),
                );
                // A comparison with a date in a 1904 workbook counts from 1904, as its cells' serials did.
                const days = context.dates.has(cellKey(ranges[0].row[0], ranges[0].column[0])) ? DAYS_1904 : 0;
                const format = mapCfRule(rule, formulas, lookOf(rule), ranges, context.palette, days);
                if (format)
                    formats.push({ priority: Number.parseInt(xmlAttr(rule, '', 'priority') ?? '', 10), format });
            }
        }
    }
    // Excel resolves overlapping rules by priority, the lowest number winning a conflicting property; the engine
    // applies rules in order, the last write winning, so the rules come highest number first.
    formats.sort((a, b) => b.priority - a.priority);

    const validationLists = [
        {
            validations: xmlChildren(rest, SML_NS, 'dataValidations').flatMap((list) =>
                xmlChildren(list, SML_NS, 'dataValidation'),
            ),
            sqrefOf: (validation: XmlElement) => xmlAttr(validation, '', 'sqref'),
            formulaOf: (validation: XmlElement, name: string) => textOf(xmlChild(validation, SML_NS, name)),
        },
        {
            validations: extensions('dataValidations').flatMap((list) => xmlChildren(list, X14_NS, 'dataValidation')),
            sqrefOf: (validation: XmlElement) => textOf(xmlChild(validation, XM_NS, 'sqref')),
            formulaOf: (validation: XmlElement, name: string) => {
                const formula = xmlChild(validation, X14_NS, name);
                return textOf(formula && xmlChild(formula, XM_NS, 'f'));
            },
        },
    ];
    const dataVerification: NonNullable<Sheet['dataVerification']> = {};
    for (const { validations, sqrefOf, formulaOf } of validationLists) {
        for (const validation of validations) {
            const rule = mapDataValidation(
                validation,
                formulaOf(validation, 'formula1'),
                formulaOf(validation, 'formula2'),
                context.date1904,
            );
            if (!rule) continue;
            const text = rule.value1.length + rule.value2.length + (rule.hintValue ?? '').length;
            for (const { row, column } of rangesOf(sqrefOf(validation) ?? '', context)) {
                const bottom = Math.min(row[1], context.rows + DV_ROW_MARGIN - 1);
                const right = Math.min(column[1], context.columns + DV_COL_MARGIN - 1);
                if (row[0] > bottom || column[0] > right) continue;
                const cells = (bottom - row[0] + 1) * (right - column[0] + 1);
                context.charge(cells, cells * text);
                // One rule for every key, as the editor sets a range's: nothing edits a rule in place.
                for (let r = row[0]; r <= bottom; r++)
                    for (let c = column[0]; c <= right; c++) dataVerification[`${r}_${c}`] = rule;
            }
        }
    }

    return {
        ...(formats.length > 0 && { conditionalFormatRules: formats.map(({ format }) => format) }),
        ...(Object.keys(dataVerification).length > 0 && { dataVerification }),
    };
}

// A sqref's ranges, corners in order and cut to the grid; a piece that is no reference, or starts past the grid, is
// skipped.
function* rangesOf(sqref: string, context: RulesContext): Generator<SingleRange> {
    for (const [reference] of sqref.matchAll(/\S+/g)) {
        context.chargeElements(1);
        const parsed = parseA1Range(reference);
        if (!parsed) continue;
        const { start, end } = parsed;
        const top = Math.min(start.row, end.row);
        const left = Math.min(start.col, end.col);
        if (top >= REFERENCE_ROW_COUNT || left >= REFERENCE_COLUMN_COUNT) continue;
        yield {
            row: [top, Math.min(Math.max(start.row, end.row), REFERENCE_ROW_COUNT - 1)],
            column: [left, Math.min(Math.max(start.col, end.col), REFERENCE_COLUMN_COUNT - 1)],
        };
    }
}

const CELL_IS_FORMULA_OP = new Map([
    ['greaterThan', '>'],
    ['greaterThanOrEqual', '>='],
    ['lessThan', '<'],
    ['lessThanOrEqual', '<='],
    ['equal', '='],
    ['notEqual', '<>'],
]);

// The rules Excel stores a formula for beside their own attributes: evaluated through the engine's formula rule.
const FORMULA_BACKED_CF_TYPES = new Set([
    'expression',
    'containsText',
    'notContainsText',
    'beginsWith',
    'endsWith',
    'timePeriod',
    'containsBlanks',
    'notContainsBlanks',
    'containsErrors',
    'notContainsErrors',
]);

function mapCfRule(
    rule: XmlElement,
    formulas: string[],
    look: DxfLook | undefined,
    ranges: SingleRange[],
    palette: ThemePalette,
    days: number,
): ConditionalFormatRule | undefined {
    const type = xmlAttr(rule, '', 'type') ?? '';
    const flag = (name: string) => isOn(xmlAttr(rule, '', name));
    if (type === 'colorScale' || type === 'dataBar') {
        const scale = xmlChild(rule, SML_NS, type);
        const stops = scale ? xmlChildren(scale, SML_NS, 'color') : [];
        const colors = stops.map((stop) => resolveColor(colorOf(stop), palette)).filter((color) => color !== null);
        // A data bar is solid, as the editor's presets are.
        if (type === 'dataBar') return colors.length > 0 ? { type, cellrange: ranges, format: [colors[0]] } : undefined;
        if (colors.length !== stops.length || (colors.length !== 2 && colors.length !== 3)) return undefined;
        // Excel lists a scale's stops from the minimum, the engine from the maximum.
        return { type: 'colorGradation', cellrange: ranges, format: colors.reverse() };
    }

    const format = { ...(look ?? { textColor: null, cellColor: null }) };
    const condition = (conditionName: ConditionalFormatConditionName, conditionValue: string[]) => ({
        type: 'default' as const,
        cellrange: ranges,
        format,
        conditionName,
        conditionRange: [],
        conditionValue,
    });
    const operator = xmlAttr(rule, '', 'operator') ?? '';
    const comparison = CF_CELL_IS_CONDITION.get(operator);
    if (type === 'cellIs' && comparison) {
        if (formulas.length === 0) return undefined;
        const literals = formulas.map(parseCfLiteral);
        if (literals.every((value) => value !== null))
            return condition(
                comparison,
                literals.map((value) => (days > 0 && NUMERIC.test(value) ? String(Number(value) + days) : value)),
            );
        // The engine's comparisons hold literals only, so a reference compares in a formula.
        const tl = toA1(ranges[0].row[0], ranges[0].column[0]);
        if (operator === 'between' || operator === 'notBetween') {
            if (formulas.length < 2) return undefined;
            const within = `AND(${tl}>=${formulas[0]},${tl}<=${formulas[1]})`;
            return cfFormulaRule(operator === 'between' ? within : `NOT(${within})`, ranges, format);
        }
        return cfFormulaRule(`${tl}${CELL_IS_FORMULA_OP.get(operator)}${formulas[0]}`, ranges, format);
    }
    if (type === 'containsText') {
        const text = extractSearchText(formulas[0]);
        if (text !== null) return condition('textContains', [text]);
    }
    if (FORMULA_BACKED_CF_TYPES.has(type))
        return formulas.length > 0 ? cfFormulaRule(formulas[0], ranges, format) : undefined;
    if (type === 'top10') {
        const bottom = flag('bottom') === true;
        const percent = flag('percent') === true;
        const rank = xmlAttr(rule, '', 'rank');
        const top = [...TOP10_CONDITION].find(([, flags]) => flags.percent === percent && flags.bottom === bottom);
        if (top) return condition(top[0], [String(rank === undefined ? 10 : Number.parseInt(rank, 10))]);
    }
    // aboveAverage is on unless written off.
    if (type === 'aboveAverage') return condition(flag('aboveAverage') === false ? 'belowAverage' : 'aboveAverage', []);
    const duplicate = DUPLICATE_RULE.get(type);
    if (duplicate) return condition('duplicateValue', [duplicate]);
    // An icon set has no evaluator, a blank or error rule without its formula nothing to evaluate: a dropped rule is
    // honest, a wrong one is not.
    return undefined;
}

// Excel anchors a CF formula's relative refs at the first range's top-left, and so does the engine.
function cfFormulaRule(
    formula: string,
    ranges: SingleRange[],
    format: DefaultConditionalFormatRule['format'],
): DefaultConditionalFormatRule {
    return {
        type: 'default',
        cellrange: ranges,
        format,
        conditionName: 'formula',
        conditionRange: [],
        conditionValue: [`=${formula}`],
    };
}

// Excel string literals arrive wrapped in double quotes with embedded quotes
// doubled ('"say ""hi"""'). Returns the unescaped inner text, or null when the
// operand isn't a quoted literal.
function unquoteXlsxLiteral(txt: string): string | null {
    if (!(txt.startsWith('"') && txt.endsWith('"') && txt.length >= 2)) return null;
    return txt.slice(1, -1).replace(/""/g, '"');
}

// A cellIs operand's literal, a number or a quoted string; null for a reference or a function, which compares in a
// formula. A quoted percent ("5%"), as Google Sheets writes a percent threshold, is the number the engine compares.
function parseCfLiteral(operand: string): string | null {
    const txt = operand.trim();
    if (NUMERIC.test(txt)) return txt;
    const inner = unquoteXlsxLiteral(txt);
    if (inner == null) return null;
    const pct = inner.match(/^(-?\d+(?:\.\d+)?)%$/);
    return pct ? String(Number(pct[1]) / 100) : inner;
}

// A containsText rule's text, from the formula Excel stores for it: NOT(ISERROR(SEARCH("<text>",<topLeftRef>))).
function extractSearchText(formula: string | undefined): string | null {
    if (formula === undefined) return null;
    const match = formula.match(/^NOT\(ISERROR\(SEARCH\("(.*)",/);
    return match ? match[1].replace(/""/g, '"') : null;
}

// Column-wide validations ("D2:D1048576") are common in real workbooks, while the grid
// covers only the data extent: a rule per cell of the column would put a multi-hundred-MB
// dataVerification map into the snapshot JSON. DV-only blank rows below the data are a
// legit pattern (pre-validated entry rows), hence the generous margins.
const DV_ROW_MARGIN = 1000;
const DV_COL_MARGIN = 100;

function mapDataValidation(
    validation: XmlElement,
    formula1: string | undefined,
    formula2: string | undefined,
    date1904: boolean,
): DataVerificationRule | undefined {
    const type = DV_TYPE.get(xmlAttr(validation, '', 'type') ?? '');
    if (!type) return undefined;
    const flag = (name: string) => isOn(xmlAttr(validation, '', name)) === true;
    const errorStyle = xmlAttr(validation, '', 'errorStyle');
    const prompt = flag('showInputMessage') ? (xmlAttr(validation, '', 'prompt') ?? '') : '';
    const rule: DataVerificationRule = {
        type,
        type2: '',
        value1: '',
        value2: '',
        // Excel's default stop style blocks invalid input, a warning or information lets it through. The error's text
        // is dropped: the engine words its own.
        prohibitInput: flag('showErrorMessage') && (errorStyle === undefined || errorStyle === 'stop'),
        hintShow: prompt !== '',
        hintValue: prompt,
    };

    if (type === 'dropdown') {
        // type2 '' is the dialog's single-select, as an Excel dropdown always is.
        const source = listSource(formula1);
        if (source === null) return undefined;
        rule.value1 = source;
        return rule;
    }

    const operator = xmlAttr(validation, '', 'operator') ?? 'between';
    const type2 = (type === 'date' ? DV_DATE_OPERATOR : DV_OPERATOR).get(operator);
    if (!type2) return undefined;
    rule.type2 = type2;
    // A literal: a whole number or length to its integer, a date serial to the YYYY-MM-DD
    // the engine's validateCellData parses. A reference has no literal to validate against, so the rule goes.
    const operand = (text: string | undefined): string | null => {
        if (text === undefined) return null;
        if (type === 'date') {
            const serial = Number.parseFloat(text) + (date1904 ? DAYS_1904 : 0);
            const date = new Date(Math.round(serial * DAY_MS + EXCEL_EPOCH_MS));
            return Number.isNaN(date.getTime()) ? null : formatInputDate(date);
        }
        const value = type === 'number' ? Number.parseFloat(text) : Number.parseInt(text, 10);
        return Number.isNaN(value) ? null : String(value);
    };
    const value1 = operand(formula1);
    if (value1 === null) return undefined;
    rule.value1 = value1;
    if (operator === 'between' || operator === 'notBetween') {
        const value2 = operand(formula2);
        if (value2 === null) return undefined;
        rule.value2 = value2;
    }
    return rule;
}

// A quoted literal ('"Red,Green,Blue"') becomes the engine's comma-list form; anything
// else is kept as a live range ref when valid — getDropdownList resolves refs (incl.
// quoted cross-sheet names) natively, so source edits keep propagating. Defined names
// are dropped program-wide; a garbage one-option dropdown is worse than no rule.
function listSource(raw: string | undefined): string | null {
    if (!raw) return null;
    const inner = unquoteXlsxLiteral(raw);
    if (inner != null) return inner.length > 0 ? inner : null;
    const ref = raw.startsWith('=') ? raw.slice(1) : raw;
    return iscelldata(ref) && inExcelGrid(ref) ? ref : null;
}
