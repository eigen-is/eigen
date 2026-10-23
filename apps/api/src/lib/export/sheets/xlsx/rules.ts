import type {
    ConditionalFormatRule,
    DataVerificationRule,
    DefaultConditionalFormatRule,
    Sheet,
    SingleRange,
} from '@workspace/lib/sheets';
import { parseCellKey } from '@workspace/lib/sheets';
import { escapeXml } from '@workspace/lib/xml';
import { iscelldata, rangeToA1, toA1 } from '@workspace/sheet/engine';
import type { CountedWarningCode } from '../../../document/transform/protocol';
import {
    CF_CELL_IS_CONDITION,
    DAY_MS,
    DUPLICATE_XLSX_RULE,
    DV_XLSX_DATE_OPERATOR,
    DV_XLSX_OPERATOR,
    DV_XLSX_TYPE,
    EXCEL_EPOCH_MS,
    inExcelGrid,
    MAX_FORMULA_LENGTH,
    MAX_FORMULA_STRING_LENGTH,
    MAX_PROMPT_LENGTH,
    NUMERIC,
    TOP10_CONDITION,
    withFuturePrefixes,
} from '../../../ooxml/spreadsheetml';
import { argbOf, type StyleRegistry } from './styles';

// The reader's mirror (import/sheets/rules.ts): each rule in the 2007 schema's form, which the reader reads as the
// rule it was. What Excel can't hold is dropped and counted.

// A sheet's conditional formats and data validations: the slot CT_Worksheet keeps for them after mergeCells.
export function rulesXml(sheet: Sheet, styles: StyleRegistry, lost: (code: CountedWarningCode) => void): string {
    return (
        conditionalFormattingXml(sheet.conditionalFormatRules ?? [], styles, lost) +
        dataValidationsXml(sheet.dataVerification ?? {}, lost)
    );
}

type CfRule = {
    type: string;
    look?: DefaultConditionalFormatRule['format'];
    attributes?: string;
    formulas?: string[];
    body?: string;
};

function conditionalFormattingXml(
    rules: ConditionalFormatRule[],
    styles: StyleRegistry,
    lost: (code: CountedWarningCode) => void,
): string {
    const written: { sqref: string; rule: CfRule }[] = [];
    for (const rule of rules) {
        const cfRule = cfRuleOf(rule);
        if (cfRule) written.push({ sqref: rule.cellrange.map((range) => rangeToA1(range)).join(' '), rule: cfRule });
        else lost('conditional-formats-dropped');
    }
    // Excel resolves overlapping rules by the lowest priority number, the engine by the last rule. Excel keeps the
    // rules of one range in one block.
    const blocks = new Map<string, string[]>();
    for (const [index, { sqref, rule }] of written.entries()) {
        const { type, look, attributes = '', formulas = [], body = '' } = rule;
        const dxf = look?.textColor || look?.cellColor ? ` dxfId="${styles.dxf(look)}"` : '';
        const content = body + formulas.map((formula) => `<formula>${escapeXml(formula)}</formula>`).join('');
        const open = `<cfRule type="${type}"${dxf} priority="${written.length - index}"${attributes}`;
        const xml = content ? `${open}>${content}</cfRule>` : `${open}/>`;
        const block = blocks.get(sqref);
        if (block) block.push(xml);
        else blocks.set(sqref, [xml]);
    }
    return [...blocks]
        .map(([sqref, xml]) => `<conditionalFormatting sqref="${sqref}">${xml.join('')}</conditionalFormatting>`)
        .join('');
}

function cfRuleOf(rule: ConditionalFormatRule): CfRule | undefined {
    if (rule.type === 'dataBar') {
        const color = rule.format.length > 0 ? argbOf(rule.format[0]) : undefined;
        return color
            ? {
                  type: 'dataBar',
                  body: `<dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="${color}"/></dataBar>`,
              }
            : undefined;
    }
    if (rule.type === 'colorGradation') {
        // The engine lists a scale's stops from the maximum, Excel from the minimum.
        const colors = rule.format.map(argbOf).reverse();
        if ((colors.length !== 2 && colors.length !== 3) || colors.includes(undefined)) return undefined;
        const middle = colors.length === 3 ? '<cfvo type="percentile" val="50"/>' : '';
        const stops = colors.map((color) => `<color rgb="${color}"/>`).join('');
        return {
            type: 'colorScale',
            body: `<colorScale><cfvo type="min"/>${middle}<cfvo type="max"/>${stops}</colorScale>`,
        };
    }
    // An icon set has no evaluator to say what it shows.
    if (rule.type === 'icons') return undefined;

    const { conditionName: name, conditionValue: values, format: look } = rule;
    const fits = (cfRule: CfRule) => ((cfRule.formulas ?? []).every(fitsExcel) ? cfRule : undefined);
    if (CF_CELL_IS_CONDITION.has(name)) {
        const operands = values.slice(0, name === 'between' || name === 'notBetween' ? 2 : 1).map(String);
        // A number as Excel holds it; anything else a quoted string, as the reader's parseCfLiteral reads them.
        const formulas = operands.map((value) => (NUMERIC.test(value) ? value : quoted(value)));
        return fits({ type: 'cellIs', look, attributes: ` operator="${name}"`, formulas });
    }
    if (name === 'textContains') {
        const text = String(values[0]);
        const anchor = toA1(rule.cellrange[0].row[0], rule.cellrange[0].column[0]);
        return fits({
            type: 'containsText',
            look,
            attributes: ` operator="containsText" text="${escapeXml(text)}"`,
            formulas: [`NOT(ISERROR(SEARCH(${quoted(text)},${anchor})))`],
        });
    }
    if (name === 'formula') {
        const formula = String(values[0]);
        return fits({
            type: 'expression',
            look,
            formulas: [withFuturePrefixes(formula.startsWith('=') ? formula.slice(1) : formula)],
        });
    }
    const top = TOP10_CONDITION.get(name);
    if (top) {
        const { percent, bottom } = top;
        const rank = Number(values[0]);
        // Excel's ranks: 1 to 1000 items, or 1 to 100 percent.
        if (!Number.isInteger(rank) || rank < 1 || rank > (percent ? 100 : 1000)) return undefined;
        return {
            type: 'top10',
            look,
            attributes: `${percent ? ' percent="1"' : ''}${bottom ? ' bottom="1"' : ''} rank="${rank}"`,
        };
    }
    if (name === 'aboveAverage' || name === 'belowAverage')
        return { type: 'aboveAverage', look, attributes: name === 'belowAverage' ? ' aboveAverage="0"' : '' };
    if (name === 'duplicateValue') {
        const type = DUPLICATE_XLSX_RULE.get(String(values[0]));
        return type ? { type, look } : undefined;
    }
    // occurrenceDate: the editor's own, with no Excel rule.
    return undefined;
}

function dataValidationsXml(
    verification: NonNullable<Sheet['dataVerification']>,
    lost: (code: CountedWarningCode) => void,
): string {
    // The editor stores a copy of a rule per cell, so equal rules are one validation over their cells' rectangles,
    // ordered by their first cell.
    const cells = Object.keys(verification)
        .map((key) => ({ key, cell: parseCellKey(key) }))
        .sort((a, b) => a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1]);
    const groups = new Map<string, { rule: DataVerificationRule; cells: [number, number][] }>();
    for (const { key, cell } of cells) {
        const rule = verification[key];
        const id = JSON.stringify([
            rule.type,
            rule.type2,
            rule.value1,
            rule.value2,
            rule.prohibitInput === true,
            promptOf(rule),
        ]);
        const group = groups.get(id);
        if (group) group.cells.push(cell);
        else groups.set(id, { rule, cells: [cell] });
    }

    const validations: string[] = [];
    for (const { rule, cells } of groups.values()) {
        const ranges = rectanglesOf(cells);
        const validation = validationOf(rule, toA1(ranges[0].row[0], ranges[0].column[0]));
        if (!validation) {
            lost('validations-dropped');
            continue;
        }
        let prompt = promptOf(rule);
        if (prompt.length > MAX_PROMPT_LENGTH) {
            prompt = prompt.slice(0, MAX_PROMPT_LENGTH);
            lost('validation-prompts-cut');
        }
        const { type, operator, formulas } = validation;
        const sqref = ranges.map((range) => rangeToA1(range)).join(' ');
        validations.push(
            `<dataValidation type="${type}"${operator ? ` operator="${operator}"` : ''} allowBlank="1"` +
                `${prompt ? ' showInputMessage="1"' : ''}${rule.prohibitInput ? ' showErrorMessage="1"' : ''}` +
                `${prompt ? ` prompt="${escapeXml(prompt)}"` : ''} sqref="${sqref}">` +
                formulas
                    .map((formula, index) => `<formula${index + 1}>${escapeXml(formula)}</formula${index + 1}>`)
                    .join('') +
                '</dataValidation>',
        );
    }
    return validations.length > 0
        ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`
        : '';
}

function promptOf(rule: DataVerificationRule): string {
    return rule.hintShow && rule.hintValue ? rule.hintValue : '';
}

// A validation's type, its operator when not Excel's default between, and its formulas; relative references read
// from the anchor, its first cell.
function validationOf(
    rule: DataVerificationRule,
    anchor: string,
): { type: string; operator?: string; formulas: string[] } | undefined {
    if (rule.type === 'dropdown') {
        // A range reads the same list for every cell, as the engine reads it, where Excel would shift a relative one.
        // A ref past Excel's grid is a defined name an older import kept, which no list here resolves.
        if (iscelldata(rule.value1) && !inExcelGrid(rule.value1)) return undefined;
        const source = iscelldata(rule.value1) ? absoluteRef(rule.value1) : quoted(rule.value1);
        return rule.value1 && fitsExcel(source) ? { type: 'list', formulas: [source] } : undefined;
    }
    if (rule.type === 'text_content') {
        // Excel has no text rule; Google Sheets writes one as this custom formula, which the reader drops.
        const text = quoted(rule.value1);
        const formula = {
            include: `ISNUMBER(SEARCH(${text},${anchor}))`,
            exclude: `NOT(ISNUMBER(SEARCH(${text},${anchor})))`,
            equal: `EXACT(${anchor},${text})`,
        }[rule.type2];
        return formula && fitsExcel(formula) ? { type: 'custom', formulas: [formula] } : undefined;
    }
    // checkbox and validity: the editor's own.
    const type = DV_XLSX_TYPE.get(rule.type);
    if (!type) return undefined;
    const operator = (type === 'date' ? DV_XLSX_DATE_OPERATOR : DV_XLSX_OPERATOR).get(rule.type2);
    if (!operator) return undefined;
    const values = operator === 'between' || operator === 'notBetween' ? [rule.value1, rule.value2] : [rule.value1];
    const formulas: string[] = [];
    for (const value of values) {
        // A date as its serial from YYYY-MM-DD at UTC, the reader's inverse.
        const number = type === 'date' ? (Date.parse(`${value}T00:00:00Z`) - EXCEL_EPOCH_MS) / DAY_MS : Number(value);
        if (value.trim() === '' || !Number.isFinite(number)) return undefined;
        formulas.push(String(number));
    }
    return { type, ...(operator !== 'between' && { operator }), formulas };
}

// A row's run of adjacent cells extends the rectangle of the same columns that ends on the row above; cells come in
// row order, so the rectangles come in order of their first cell.
function rectanglesOf(cells: [number, number][]): SingleRange[] {
    const rectangles: SingleRange[] = [];
    const open = new Map<string, SingleRange>();
    let start = 0;
    for (const [index, [row, column]] of cells.entries()) {
        const next = cells[index + 1];
        if (next && next[0] === row && next[1] === column + 1) continue;
        const left = cells[start][1];
        start = index + 1;
        const columns = `${left}:${column}`;
        const above = open.get(columns);
        if (above && above.row[1] === row - 1) above.row[1] = row;
        else {
            const rectangle: SingleRange = { row: [row, row], column: [left, column] };
            rectangles.push(rectangle);
            open.set(columns, rectangle);
        }
    }
    return rectangles;
}

function absoluteRef(ref: string): string {
    const at = ref.lastIndexOf('!') + 1;
    const ends = ref
        .slice(at)
        .split(':')
        .map((end) =>
            end.replace(
                /^\$?([A-Za-z]*)\$?(\d*)$/,
                (_, column: string, row: string) => `${column && `$${column}`}${row && `$${row}`}`,
            ),
        );
    return ref.slice(0, at) + ends.join(':');
}

function quoted(text: string): string {
    return `"${text.replace(/"/g, '""')}"`;
}

// Excel refuses a formula past its length, or one quoting a string past its own.
function fitsExcel(formula: string): boolean {
    if (formula.length > MAX_FORMULA_LENGTH) return false;
    for (const [, text] of formula.matchAll(/"((?:[^"]|"")*)"/g))
        if (text.replace(/""/g, '"').length > MAX_FORMULA_STRING_LENGTH) return false;
    return true;
}
