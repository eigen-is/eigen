// A sheet's conditional formats and data validations as the xlsx writer writes them, the reader's mirror: each rule in
// the 2007 schema's form, which the reader reads as the rule it was. What Excel can't hold is dropped and counted.

import type {
    ConditionalFormatRule,
    DataValidationRule,
    DefaultConditionalFormatRule,
    Sheet,
    SheetValidation,
    SingleRange,
} from '@workspace/lib/sheets';
import {
    coalescedRanges,
    compareValidationIds,
    MAX_VALIDATION_RANGES,
    REFERENCE_COLUMN_COUNT,
    REFERENCE_ROW_COUNT,
    rangesOverlap,
} from '@workspace/lib/sheets';
import { escapeXml } from '@workspace/lib/xml';
import { cfSplitRange, iscelldata, isWellFormedCfRule, rangeToA1, toA1, withCfRanges } from '@workspace/sheet/engine';
import type { Lost } from '../../../document/transform/protocol';
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
import { cut } from './strings';
import type { StyleRegistry } from './styles';
import { argbOf } from './styles';

// A sheet's conditional formats and data validations: the slot CT_Worksheet keeps for them after mergeCells.
export function rulesXml(sheet: Sheet, styles: StyleRegistry, lost: Lost): string {
    return (
        conditionalFormattingXml(sheet.conditionalFormatRules ?? [], styles, lost) +
        dataValidationsXml(sheet.dataValidations ?? {}, lost)
    );
}

type CfRule = {
    type: string;
    look?: DefaultConditionalFormatRule['format'];
    attributes?: string;
    formulas?: string[];
    body?: string;
};

function conditionalFormattingXml(rules: ConditionalFormatRule[], styles: StyleRegistry, lost: Lost): string {
    const written: { sqref: string; rule: CfRule }[] = [];
    for (const rule of rules) {
        const cellrange = rangesInGrid(rule);
        const cfRule = cellrange.length > 0 ? cfRuleOf(withCfRanges(rule, cellrange)) : undefined;
        if (cfRule) written.push({ sqref: cellrange.map((range) => rangeToA1(range)).join(' '), rule: cfRule });
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

// A rule's ranges cut to Excel's grid, which drops one outside it. A peer can store anything, so a rule whose shape
// the engine can't read has none.
function rangesInGrid(rule: ConditionalFormatRule): SingleRange[] {
    if (!isWellFormedCfRule(rule)) return [];
    return rule.cellrange.flatMap(({ row, column }) => {
        const rows = [Math.max(0, row[0]), Math.min(REFERENCE_ROW_COUNT - 1, row[1])];
        const columns = [Math.max(0, column[0]), Math.min(REFERENCE_COLUMN_COUNT - 1, column[1])];
        return rows[0] <= rows[1] && columns[0] <= columns[1] ? [{ row: rows, column: columns }] : [];
    });
}

function cfRuleOf(rule: ConditionalFormatRule): CfRule | undefined {
    if (rule.type === 'dataBar') {
        const color = argbOf(rule.format[0]);
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

function dataValidationsXml(rules: Record<string, SheetValidation>, lost: Lost): string {
    // Each rule is one validation over its ranges. The ranges go in order of their top-left cells, and the rules in
    // order of their first range, so one workbook always writes the same file. A relative reference reads from the
    // first range's top-left cell, as Excel reads it.
    const topLeft = (a: SingleRange, b: SingleRange) => a.row[0] - b.row[0] || a.column[0] - b.column[0];
    const entries = Object.entries(withoutOverlaps(rules, lost))
        .map(([id, { ranges, rule }]) => ({ id, ranges: [...ranges].sort(topLeft), rule }))
        .sort((a, b) => topLeft(a.ranges[0], b.ranges[0]) || compareValidationIds(a.id, b.id));

    const validations: string[] = [];
    for (const { rule, ranges } of entries) {
        const validation = validationOf(rule, toA1(ranges[0].row[0], ranges[0].column[0]));
        if (!validation) {
            lost('validations-dropped');
            continue;
        }
        let prompt = promptOf(rule);
        if (prompt.length > MAX_PROMPT_LENGTH) {
            prompt = cut(prompt, MAX_PROMPT_LENGTH);
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

// Where rules overlap, the highest id wins the cell, but a file read back numbers its rules in the file's order. So
// each rule loses the cells a higher id holds, and no two rules overlap in the file. A rule left with no cell goes,
// and loses nothing: it held no cell. A rule the cuts leave with more ranges than a rule may hold is dropped and
// counted, since the importer would drop it.
export function withoutOverlaps(rules: Record<string, SheetValidation>, lost: Lost): Record<string, SheetValidation> {
    const kept: Record<string, SheetValidation> = {};
    // The rules from the highest id down. The index holds the ranges of the rules already walked, the higher ones.
    const above = rangeIndex();
    const aboveBounds: SingleRange[] = [];
    for (const id of Object.keys(rules).sort((a, b) => compareValidationIds(b, a))) {
        const { ranges } = rules[id];
        const bounds = boundsOf(ranges);
        let cut = ranges;
        // A rule whose bounds meet no higher rule's bounds loses no cell, and asks the index nothing.
        if (aboveBounds.some((higher) => rangesOverlap(higher, bounds))) {
            let cuts = false;
            const pieces = ranges.flatMap((range) => {
                const overlapping = above.overlapping(range);
                if (overlapping.length === 0) return [range];
                cuts = true;
                return cutOut(range, overlapping);
            });
            if (cuts) cut = coalescedRanges(pieces);
        }
        aboveBounds.push(bounds);
        for (const range of ranges) above.add(range);
        if (cut.length > MAX_VALIDATION_RANGES) lost('validations-dropped');
        else if (cut.length > 0) kept[id] = { ...rules[id], ranges: cut };
    }
    return kept;
}

// The smallest range around a rule's ranges. A spread would overflow the stack on a rule of many ranges.
function boundsOf(ranges: readonly SingleRange[]): SingleRange {
    const bounds = { row: [...ranges[0].row], column: [...ranges[0].column] };
    for (const { row, column } of ranges) {
        bounds.row = [Math.min(bounds.row[0], row[0]), Math.max(bounds.row[1], row[1])];
        bounds.column = [Math.min(bounds.column[0], column[0]), Math.max(bounds.column[1], column[1])];
    }
    return bounds;
}

// The index keeps each range in one of three grids: square tiles of this many rows and columns for a small range, bands
// this many rows tall across the sheet for a wide one, such as a whole row, and bands this many columns wide down the
// sheet for a tall one, such as a whole column. A range goes in the first grid where it covers at most MAX_TILES tiles.
const TILE = 64;
const MAX_TILES = 16;

// The ranges added so far, which a range asks for the ones it overlaps without a check against each of them. A range
// checks only the ranges in the tiles it covers of each grid. A range too large for every grid, such as the whole
// sheet, is kept in a list every lookup checks. Such ranges are rare, and a rule of them mostly meets no other rule's
// bounds.
function rangeIndex() {
    const grids = [tileGrid(TILE, TILE), tileGrid(TILE, REFERENCE_COLUMN_COUNT), tileGrid(REFERENCE_ROW_COUNT, TILE)];
    const large: SingleRange[] = [];
    return {
        add(range: SingleRange): void {
            const grid = grids.find((candidate) => candidate.tileCount(range) <= MAX_TILES);
            if (grid) grid.add(range);
            else large.push(range);
        },
        overlapping(range: SingleRange): SingleRange[] {
            // A range over several tiles is in each of them, and is found once.
            const hits = new Set(large.filter((other) => rangesOverlap(other, range)));
            for (const grid of grids) {
                for (const tile of grid.tilesNear(range)) {
                    for (const other of tile) if (rangesOverlap(other, range)) hits.add(other);
                }
            }
            return [...hits];
        },
    };
}

// Ranges kept in every tile of `rows` by `columns` cells they cover.
function tileGrid(rows: number, columns: number) {
    const tiles = new Map<number, SingleRange[]>();
    const across = Math.ceil(REFERENCE_COLUMN_COUNT / columns);
    // A range past the sheet's last column is kept in the last tile across, so no two tiles share a key.
    const spanOf = ({ row, column }: SingleRange) => ({
        top: Math.floor(row[0] / rows),
        bottom: Math.floor(row[1] / rows),
        left: Math.min(across - 1, Math.floor(column[0] / columns)),
        right: Math.min(across - 1, Math.floor(column[1] / columns)),
    });
    type Span = ReturnType<typeof spanOf>;
    const tileCount = ({ top, bottom, left, right }: Span) => (bottom - top + 1) * (right - left + 1);
    const keysOf = ({ top, bottom, left, right }: Span) => {
        const keys: number[] = [];
        for (let r = top; r <= bottom; r += 1) for (let c = left; c <= right; c += 1) keys.push(r * across + c);
        return keys;
    };
    return {
        tileCount: (range: SingleRange): number => tileCount(spanOf(range)),
        add(range: SingleRange): void {
            for (const key of keysOf(spanOf(range))) {
                const tile = tiles.get(key);
                if (tile) tile.push(range);
                else tiles.set(key, [range]);
            }
        },
        // The tiles a range covers that hold a range. A range over more tiles than the grid holds walks the grid's
        // tiles instead, so a whole row asks a grid of a few small ranges only those.
        tilesNear(range: SingleRange): SingleRange[][] {
            const span = spanOf(range);
            const near: SingleRange[][] = [];
            if (tileCount(span) <= tiles.size) {
                for (const key of keysOf(span)) {
                    const tile = tiles.get(key);
                    if (tile) near.push(tile);
                }
                return near;
            }
            for (const [key, tile] of tiles) {
                const r = Math.floor(key / across);
                const c = key % across;
                if (r >= span.top && r <= span.bottom && c >= span.left && c <= span.right) near.push(tile);
            }
            return near;
        },
    };
}

// A range without the cells of the ranges above it that overlap it.
function cutOut(range: SingleRange, above: readonly SingleRange[]): SingleRange[] {
    let pieces = [range];
    for (const higher of above) {
        pieces = pieces.flatMap((piece) =>
            rangesOverlap(higher, piece) ? cfSplitRange(piece, higher, higher, 'restPart') : [piece],
        );
    }
    return pieces;
}

function promptOf(rule: DataValidationRule): string {
    return rule.hintShow && rule.hintValue ? rule.hintValue : '';
}

// A validation's type, its operator when not Excel's default between, and its formulas; relative references read
// from the anchor, its first cell.
function validationOf(
    rule: DataValidationRule,
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
