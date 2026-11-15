// The one door where ops someone else wrote, such as a peer's batch in the log or a sheet in a stored snapshot, become
// ops the workbook trusts. `readBatch` parses a batch's text, and each check is pure and reads one op: every place on
// the grid, every object holding only the keys its type lists, every text, list and key within its bound. A batch with
// one op that fails is not read at all, so every reader skips the same batches. State, such as whether a sheet or a
// filter exists, is the applier's to check.

import { ERROR_LITERALS, GRID_COLUMNS, GRID_ROWS, LAST_SERIAL, MAX_STORED_LENGTH } from '@workspace/formula/text';
import { exceedsChartSpecBytes } from '../charts/limits';
import { isHexColor, parseRgb } from '../constants/colors';
import { isRecord } from '../core/guards';
import { isValidFractionalIndex } from '../vector/fractional-index';
import { isSafeMediaName } from '../vector/media-refs';
import { STROKE_STYLES } from '../vector/types';
import { BORDER_STYLES } from './borders';
import {
    MAX_BATCH_JSON,
    MAX_ID_LENGTH,
    MAX_ORDER_KEY,
    MAX_RECORDS_PER_TYPE,
    MAX_RUNS_PER_CELL,
    MAX_SHEETS,
    MAX_SHORT_TEXT,
    MAX_STYLE_RUNS,
    MAX_TEXT_LENGTH,
} from './limits';
import type {
    Batch,
    CellAttrs,
    CellContent,
    CellRecord,
    ChartRecord,
    ConditionalFormatRecord,
    FormatOp,
    ImageRecord,
    InputOp,
    LineAttrs,
    LinesOp,
    MoveOp,
    Op,
    RecordOp,
    Records,
    Rect,
    Run,
    RunStyle,
    SheetContent,
    SheetFields,
    SheetOp,
} from './ops';
import { MAX_RULE_RANGES } from './range-rules';
import { disjoint } from './rect';
import { isSheetName } from './sheet-name';
import type { BorderSide, CellLink, ConditionalFormatConditionName, DataValidationRule } from './types';
import { isCellLinkType } from './types';

type Check = (value: unknown) => boolean;
// The fields of a type, each with its check and whether the type requires it, so a field the table misses or a wrong
// flag fails the build.
type Fields<T> = {
    readonly [K in keyof T]-?: readonly [check: Check, required: Partial<Pick<T, K>> extends Pick<T, K> ? false : true];
};
// `of` is never set: it names the type the table describes, so a value that passes the table reads as one.
type Table<T> = {
    readonly checks: ReadonlyMap<string, Check>;
    readonly required: ReadonlySet<string>;
    readonly of?: T;
};

// A batch of ops from its JSON text when the text parses, fits the batch budget and every op in it is valid, else null.
// The budget is read before any op, so a text past it costs no more than its parse and one write of its other ops.
export function readBatch(text: string): Batch | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(value) || !Array.isArray(value['ops'])) return null;
    // A sheet's add is left out of the budget, since `fits` bounds it. The ops are read raw here and checked after.
    const isAdd = (op: unknown): op is Record<string, unknown> => isRecord(op) && op['kind'] === 'sheet' && 'add' in op;
    const ops: unknown[] = value['ops'];
    if (ops.filter(isAdd).length > MAX_SHEETS) return null;
    // Past the budget the parsed batch is weighed as JSON writes it, since a text can spell a value shorter.
    const weighed =
        text.length <= MAX_BATCH_JSON ||
        JSON.stringify({ ...value, ops: ops.map((op) => (isAdd(op) ? { ...op, add: null } : op)) }).length <=
            MAX_BATCH_JSON;
    return weighed && isOf(value, BATCH) ? value : null;
}

// A sheet whole, as a `sheet` op adds it and a snapshot holds it. Its caller hands it a value built from `JSON.parse`,
// so no getter, hole or `undefined` can stand in it.
export function isSheetContent(value: unknown): value is SheetContent {
    return isOf(value, SHEET_CONTENT) && isBands(value.bands, value.looks.length);
}

// The generation and the clock as a batch carries them, and a snapshot its last batch's.
export function isGeneration(value: unknown): value is number {
    return isCount(value, Number.MAX_SAFE_INTEGER);
}

export function isNow(value: unknown): value is number {
    return isFiniteNumber(value) && value >= 0 && value < LAST_SERIAL + 1;
}

// A draw's seed is read as a signed 32-bit integer.
export function isSeed(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31;
}

function isOp(value: unknown): value is Op {
    if (!isRecord(value)) return false;
    switch (value['kind']) {
        case 'input':
            return isOf(value, INPUT) && (value.runs?.length ?? 0) + (value.cells?.length ?? 0) > 0;
        case 'format':
            if (!('lines' in value)) return isOf(value, CELL_FORMAT) && namesKeys(value.set, value.clear);
            // Every span is held to the rows, the longer line, so columns hold it to theirs here.
            return (
                isOf(value, LINE_FORMAT) &&
                namesKeys(value.set, value.clear) &&
                (value.lines === 'rows' || value.spans.every(([, last]) => last < GRID_COLUMNS))
            );
        case 'record': {
            if (!isOf(value, RECORD_OP)) return false;
            const { sheet, type, id, set, whole } = value;
            const kind = RECORD_KINDS[type];
            if (type === 'sheet') return sheet === id && whole === undefined && kind.change(set);
            return whole === 1 ? kind.whole(set) : set === undefined || kind.change(set);
        }
        case 'lines': {
            if (!isOf(value, LINES)) return false;
            const { rows, insert, index, count, like } = value;
            if (index + count > (rows ? GRID_ROWS : GRID_COLUMNS)) return false;
            return like === undefined || (insert && (like === index - 1 || like === index));
        }
        case 'move': {
            if (!isOf(value, MOVE)) return false;
            const [top, left, bottom, right] = value.from;
            return isRow(value.toRow + bottom - top) && isColumn(value.toColumn + right - left);
        }
        case 'sheet':
            return 'add' in value ? isOf(value, SHEET_ADD) : isOf(value, SHEET_DELETE);
        default:
            return false;
    }
}

// A format names a key, and never one it both sets and clears, which would read as either by which a reader applies
// first.
function namesKeys(set: object | undefined, clear: readonly string[] = []): boolean {
    if (set !== undefined && clear.some((key) => Object.hasOwn(set, key))) return false;
    return clear.length > 0 || (set !== undefined && Object.keys(set).length > 0);
}

// `v` with `e` is an error literal, `s` stands with neither `v` nor `f`, and `spill` stands on a value with no `f`. An
// empty cell is null in an input and absent from a sheet's cells, so a cell names a key.
function isCell(value: unknown, fields: Table<CellRecord>): boolean {
    if (!isOf(value, fields)) return false;
    const { v, e, f, s, link, qp, spill } = value;
    if (v === undefined && f === undefined && s === undefined && link === undefined && qp === undefined) return false;
    if (e !== undefined && (typeof v !== 'string' || !ERRORS.has(v))) return false;
    if (s !== undefined && (v !== undefined || f !== undefined)) return false;
    return spill === undefined || (f === undefined && v !== undefined);
}

function isContentOrNull(value: unknown): boolean {
    return value === null || isCell(value, CONTENT);
}

// A snapshot writes the negative zero as zero, so a reader that replayed it and one that loaded it would differ.
function isScalar(value: unknown): boolean {
    return typeof value === 'boolean' || (isFiniteNumber(value) && !Object.is(value, -0)) || isLongText(value);
}

function isStoredKey(value: unknown): boolean {
    return typeof value === 'string' && value.length <= MAX_STORED_LENGTH && value.startsWith('=');
}

// The runs' texts join into the cell's value, so together they keep the bound of one text.
function isRichText(value: unknown): boolean {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RUNS_PER_CELL) return false;
    let length = 0;
    for (const run of value) {
        if (!isOf(run, RUN)) return false;
        length += run.v.length;
    }
    return length <= MAX_TEXT_LENGTH;
}

// A list of placed cells, sorted by column then row with no place twice.
function isCellList(value: unknown, isCellAt: Check): boolean {
    if (!Array.isArray(value)) return false;
    let lastRow = -1;
    let lastColumn = -1;
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 3) return false;
        const [row, column, cell] = entry;
        if (!isRow(row) || !isColumn(column) || !isCellAt(cell)) return false;
        if (column < lastColumn || (column === lastColumn && row <= lastRow)) return false;
        lastRow = row;
        lastColumn = column;
    }
    return true;
}

function isRuns(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const rects: Rect[] = [];
    for (const run of value) {
        if (!Array.isArray(run) || run.length !== 2 || !isRect(run[0]) || !isContentOrNull(run[1])) return false;
        rects.push(run[0]);
    }
    return disjoint(rects);
}

// Bands are flat: first column, n, then n pairs of start row and look index, columns and rows ascending.
function isBands(value: readonly unknown[], lookCount: number): boolean {
    let at = 0;
    let lastColumn = -1;
    while (at < value.length) {
        const first = value[at];
        const count = value[at + 1];
        if (!isColumn(first) || first <= lastColumn || !isCount(count, GRID_ROWS)) return false;
        let lastRow = -1;
        for (let pair = at + 2; pair < at + 2 + 2 * count; pair += 2) {
            const start = value[pair];
            if (!isRow(start) || start <= lastRow || !isCount(value[pair + 1], lookCount)) return false;
            lastRow = start;
        }
        lastColumn = first;
        at += 2 + 2 * count;
    }
    return true;
}

// A list of spans of `count` lines, ascending and disjoint, each read from its item by `spanOf`.
function isAscending(value: unknown, count: number, spanOf: (item: unknown) => unknown): boolean {
    if (!Array.isArray(value)) return false;
    let last = -1;
    for (const item of value) {
        const span = spanOf(item);
        if (!isSpan(span, count) || span[0] <= last) return false;
        last = span[1];
    }
    return true;
}

// A line run's span, when the run is a span beside the attributes of its lines.
function lineSpan(run: unknown): unknown {
    return Array.isArray(run) && run.length === 2 && isOf(run[1], LINE) ? run[0] : undefined;
}

// Merges share no cell: the applier refuses a merge over another, so no edit makes a sheet where two do.
function isSheetRecords(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const merges: Rect[] = [];
    for (const type in value) {
        const records = value[type];
        if (type === 'sheet' || !Object.hasOwn(RECORD_KINDS, type) || !isRecord(records)) return false;
        let count = 0;
        for (const id in records) {
            count += 1;
            const record = records[id];
            if (count > MAX_RECORDS_PER_TYPE || !isId(id) || !RECORD_KINDS[type].whole(record)) return false;
            if (type === 'merge' && isRecord(record) && isRect(record.rect)) merges.push(record.rect);
        }
    }
    return disjoint(merges);
}

function table<T>(fields: Fields<T>): Table<T> {
    const entries = Object.entries<readonly [Check, boolean]>(fields);
    return {
        checks: new Map(entries.map(([key, [check]]) => [key, check])),
        required: new Set(entries.filter(([, [, required]]) => required).map(([key]) => key)),
    };
}

// A value of the table's type: only its fields, each valid, every required one present. An optional field it lacks is
// absent, never null, so a value has one form.
function isOf<T>(value: unknown, { checks, required }: Table<T>): value is T {
    if (!isRecord(value)) return false;
    let present = 0;
    for (const key in value) {
        if (!checks.get(key)?.(value[key])) return false;
        if (required.has(key)) present += 1;
    }
    return present === required.size;
}

// A change of named fields: at least one, and null clears only a field the type does not require.
function isChange<T>(value: unknown, { checks, required }: Table<T>): boolean {
    if (!isRecord(value)) return false;
    let named = 0;
    for (const key in value) {
        const item = value[key];
        const check = checks.get(key);
        if (check === undefined || (item === null ? required.has(key) : !check(item))) return false;
        named += 1;
    }
    return named > 0;
}

function isKeyList<T>(value: unknown, { checks }: Table<T>): boolean {
    return Array.isArray(value) && value.every((key) => typeof key === 'string' && checks.has(key));
}

function isConditionalFormat(value: unknown): boolean {
    if (isOf(value, DATA_BAR) || isOf(value, COLOR_GRADATION)) return true;
    if (!isOf(value, DEFAULT_RULE)) return false;
    return value.conditionName !== 'formula' || isStoredKey(value.conditionValue[0]);
}

// A JSON object key `__proto__` reaches no own property when a reader writes it back into an object.
function isId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && value !== '__proto__';
}

// A sheet id stands in a stored key's sheet prefix, which a bracket would end.
function isSheetId(value: unknown): value is string {
    return isId(value) && !value.includes('[') && !value.includes(']');
}

function isCount(value: unknown, most: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= most;
}

function isRow(value: unknown): value is number {
    return isCount(value, GRID_ROWS - 1);
}

function isColumn(value: unknown): value is number {
    return isCount(value, GRID_COLUMNS - 1);
}

function isRect(value: unknown): value is Rect {
    if (!Array.isArray(value) || value.length !== 4) return false;
    const [top, left, bottom, right] = value;
    return isRow(top) && isColumn(left) && isRow(bottom) && isColumn(right) && top <= bottom && left <= right;
}

function isSpan(value: unknown, count: number): value is readonly number[] {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const [first, last] = value;
    return isCount(first, count - 1) && isCount(last, count - 1) && first <= last;
}

function isRuleRanges(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0 && value.length <= MAX_RULE_RANGES && value.every(isRect);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isShort(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_SHORT_TEXT;
}

function isText(value: unknown): value is string {
    return typeof value === 'string';
}

function isLongText(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

function isOne(value: unknown): boolean {
    return value === 1;
}

function isBoolean(value: unknown): boolean {
    return typeof value === 'boolean';
}

function isSize(value: unknown): boolean {
    return isFiniteNumber(value) && value >= 0;
}

function isColor(value: unknown): boolean {
    return isShort(value) && (isHexColor(value, [3, 4, 6, 8]) || parseRgb(value) !== undefined);
}

function isOrderKey(value: unknown): boolean {
    return (
        typeof value === 'string' &&
        value.length <= MAX_ORDER_KEY &&
        isValidFractionalIndex(value, undefined, undefined)
    );
}

function isListOf(value: unknown, check: Check): boolean {
    return Array.isArray(value) && value.every(check);
}

const ERRORS: ReadonlySet<string> = new Set(ERROR_LITERALS);

const RUN_STYLE: Fields<RunStyle> = {
    bl: [isOne, false],
    it: [isOne, false],
    ff: [(value) => isFiniteNumber(value) || isShort(value), false],
    fs: [(value) => isFiniteNumber(value) && value > 0, false],
    fc: [isShort, false],
    cl: [isOne, false],
    un: [isOne, false],
};
const RUN = table<Run>({ ...RUN_STYLE, v: [(value) => typeof value === 'string', true] });
const BORDER_SIDE = table<BorderSide>({
    style: [(value) => isCount(value, Number.MAX_SAFE_INTEGER) && Object.hasOwn(BORDER_STYLES, value), true],
    color: [isColor, true],
});
const isBorderSide: Check = (value) => isOf(value, BORDER_SIDE);
const LOOK_FIELDS: Fields<CellAttrs> = {
    ...RUN_STYLE,
    fa: [isShort, false],
    ht: [isFiniteNumber, false],
    vt: [isFiniteNumber, false],
    tb: [isShort, false],
    bg: [isShort, false],
    rt: [(value) => value === 'vertical' || (isFiniteNumber(value) && value >= -90 && value <= 90), false],
    bdt: [isBorderSide, false],
    bdb: [isBorderSide, false],
    bdl: [isBorderSide, false],
    bdr: [isBorderSide, false],
    bdd: [isBorderSide, false],
};
const LOOK = table(LOOK_FIELDS);
const LINK = table<CellLink>({ type: [isCellLinkType, true], address: [isLongText, true] });
const LINE = table<LineAttrs>({ size: [isSize, false], custom: [isOne, false], hidden: [isOne, false] });

const CONTENT_FIELDS: Fields<CellContent> = {
    v: [isScalar, false],
    e: [isOne, false],
    f: [isStoredKey, false],
    s: [isRichText, false],
    link: [(value) => isOf(value, LINK), false],
    qp: [isOne, false],
};
const CONTENT = table(CONTENT_FIELDS);
const CELL_RECORD = table<CellRecord>({ ...CONTENT_FIELDS, spill: [isOne, false] });

type CellFormatOp = Extract<FormatOp, { ranges: unknown }>;
type LineFormatOp = Extract<FormatOp, { lines: unknown }>;
// A record op before its `set` is read by its type and `whole`.
type RecordOpShape = Omit<RecordOp, 'set'> & { set?: Record<string, unknown> };

const FORMAT = table<NonNullable<CellFormatOp['set']>>({ ...LOOK_FIELDS, link: [(value) => isOf(value, LINK), false] });
const BATCH = table<Batch>({
    g: [isGeneration, true],
    now: [isNow, true],
    seed: [isSeed, true],
    ops: [(value) => isListOf(value, isOp), true],
});
const INPUT = table<InputOp>({
    kind: [(value) => value === 'input', true],
    sheet: [isSheetId, true],
    runs: [isRuns, false],
    cells: [(value) => isCellList(value, isContentOrNull), false],
});
const CELL_FORMAT = table<CellFormatOp>({
    kind: [(value) => value === 'format', true],
    sheet: [isSheetId, true],
    ranges: [(value) => Array.isArray(value) && value.length > 0 && value.every(isRect), true],
    set: [(value) => isOf(value, FORMAT), false],
    clear: [(value) => isKeyList(value, FORMAT), false],
});
const LINE_FORMAT = table<LineFormatOp>({
    kind: [(value) => value === 'format', true],
    sheet: [isSheetId, true],
    lines: [(value) => value === 'rows' || value === 'columns', true],
    spans: [
        (value) => Array.isArray(value) && value.length > 0 && value.every((span) => isSpan(span, GRID_ROWS)),
        true,
    ],
    set: [(value) => isOf(value, LINE), false],
    clear: [(value) => isKeyList(value, LINE), false],
});
const RECORD_OP = table<RecordOpShape>({
    kind: [(value) => value === 'record', true],
    sheet: [isSheetId, true],
    type: [(value) => typeof value === 'string' && Object.hasOwn(RECORD_KINDS, value), true],
    id: [isId, true],
    set: [isRecord, false],
    whole: [isOne, false],
});
const LINES = table<LinesOp>({
    kind: [(value) => value === 'lines', true],
    sheet: [isSheetId, true],
    rows: [isBoolean, true],
    insert: [isBoolean, true],
    index: [isRow, true],
    count: [(value) => isCount(value, GRID_ROWS) && value > 0, true],
    like: [isRow, false],
});
const MOVE = table<MoveOp>({
    kind: [(value) => value === 'move', true],
    sheet: [isSheetId, true],
    from: [isRect, true],
    toSheet: [isSheetId, true],
    toRow: [isRow, true],
    toColumn: [isColumn, true],
});
const SHEET_ADD = table<Extract<SheetOp, { add: unknown }>>({
    kind: [(value) => value === 'sheet', true],
    add: [isSheetContent, true],
});
const SHEET_DELETE = table<Extract<SheetOp, { delete: unknown }>>({
    kind: [(value) => value === 'sheet', true],
    delete: [isSheetId, true],
});

const SHEET_FIELDS: Fields<SheetFields> = {
    name: [(value) => typeof value === 'string' && isSheetName(value), true],
    order: [isOrderKey, true],
    hide: [isOne, false],
    color: [isShort, false],
    grid: [(value) => value === 0, false],
    defaultRowHeight: [isSize, false],
    defaultColWidth: [isSize, false],
    frozenRows: [(value) => isCount(value, GRID_ROWS), false],
    frozenColumns: [(value) => isCount(value, GRID_COLUMNS), false],
};
const SHEET = table(SHEET_FIELDS);
const SHEET_CONTENT = table<SheetContent>({
    id: [isSheetId, true],
    fields: [(value) => isOf(value, SHEET), true],
    cells: [(value) => isCellList(value, (cell) => isCell(cell, CELL_RECORD)), true],
    looks: [
        (value) => Array.isArray(value) && value.length <= MAX_STYLE_RUNS && value.every((look) => isOf(look, LOOK)),
        true,
    ],
    // Its look indexes are read against the looks once the rest holds.
    bands: [Array.isArray, true],
    rows: [(value) => isAscending(value, GRID_ROWS, lineSpan), true],
    columns: [(value) => isAscending(value, GRID_COLUMNS, lineSpan), true],
    records: [isSheetRecords, true],
});

const CONDITION_NAMES: Record<ConditionalFormatConditionName, true> = {
    greaterThan: true,
    greaterThanOrEqual: true,
    lessThan: true,
    lessThanOrEqual: true,
    equal: true,
    notEqual: true,
    textContains: true,
    between: true,
    notBetween: true,
    occurrenceDate: true,
    duplicateValue: true,
    top10: true,
    top10_percent: true,
    last10: true,
    last10_percent: true,
    aboveAverage: true,
    belowAverage: true,
    formula: true,
};
type DefaultRule = Extract<ConditionalFormatRecord, { type: 'default' }>;
const DATA_BAR = table<Extract<ConditionalFormatRecord, { type: 'dataBar' }>>({
    ranges: [isRuleRanges, true],
    order: [isOrderKey, true],
    type: [(value) => value === 'dataBar', true],
    format: [(value) => isListOf(value, isShort), true],
});
const COLOR_GRADATION = table<Extract<ConditionalFormatRecord, { type: 'colorGradation' }>>({
    ranges: [isRuleRanges, true],
    order: [isOrderKey, true],
    type: [(value) => value === 'colorGradation', true],
    format: [(value) => isListOf(value, isColor), true],
});
const COLORS = table<DefaultRule['format']>({
    textColor: [(value) => value === null || isShort(value), false],
    cellColor: [(value) => value === null || isShort(value), false],
});
const DEFAULT_RULE = table<DefaultRule>({
    ranges: [isRuleRanges, true],
    order: [isOrderKey, true],
    type: [(value) => value === 'default', true],
    format: [(value) => isOf(value, COLORS), true],
    conditionName: [(value) => typeof value === 'string' && Object.hasOwn(CONDITION_NAMES, value), true],
    conditionValue: [(value) => isListOf(value, (item) => isFiniteNumber(item) || isLongText(item)), true],
});

const RULE = table<DataValidationRule>({
    type: [isShort, true],
    type2: [isShort, true],
    value1: [isLongText, true],
    value2: [isLongText, true],
    hintShow: [isBoolean, false],
    hintValue: [isLongText, false],
    prohibitInput: [isBoolean, false],
});
const CONDITION = table<NonNullable<Records['filterColumn']['condition']>>({
    name: [isShort, true],
    values: [(value) => isListOf(value, isShort), true],
});

const FLOATING: Fields<Omit<ImageRecord, 'mediaName'>> = {
    index: [isOrderKey, true],
    x: [isFiniteNumber, true],
    y: [isFiniteNumber, true],
    width: [isFiniteNumber, true],
    height: [isFiniteNumber, true],
    angle: [isFiniteNumber, false],
};
const CHART = table<ChartRecord>({
    ...FLOATING,
    fill: [isLongText, false],
    color: [isShort, false],
    strokeColor: [isShort, false],
    strokeWidth: [isFiniteNumber, false],
    seriesStrokeWidth: [isFiniteNumber, false],
    strokeStyle: [(value) => STROKE_STYLES.some((style) => style === value), false],
    roughness: [isFiniteNumber, false],
    seed: [isFiniteNumber, false],
    specChart: [isText, true],
    specTitle: [isText, true],
    specLegend: [isText, true],
    specAxes: [isText, true],
    specPlots: [isText, true],
    specSeries: [isText, true],
    specPoints: [isText, true],
    specData: [isText, true],
});

const FIELDS: { readonly [T in Exclude<keyof Records, 'conditionalFormat' | 'chart'>]: Fields<Records[T]> } = {
    sheet: SHEET_FIELDS,
    merge: { rect: [isRect, true] },
    filter: { rect: [isRect, true] },
    filterColumn: {
        filter: [isId, true],
        column: [isColumn, true],
        condition: [(value) => isOf(value, CONDITION), false],
        rows: [(value) => isAscending(value, GRID_ROWS, (span) => span), true],
    },
    comment: { row: [isRow, true], column: [isColumn, true] },
    validation: {
        ranges: [isRuleRanges, true],
        order: [isOrderKey, true],
        rule: [(value) => isOf(value, RULE), true],
    },
    image: { ...FLOATING, mediaName: [(value) => isShort(value) && isSafeMediaName(value), true] },
};

// How a record op's `set` is read for each type: as a whole record, or as a change of some of its fields.
type RecordKind = { readonly whole: Check; readonly change: Check };
const RECORD_KINDS: { readonly [type: string]: RecordKind } = {
    ...Object.fromEntries(
        Object.entries(FIELDS).map(([type, fields]): [string, RecordKind] => {
            const fieldTable = table<unknown>(fields);
            return [
                type,
                { whole: (value) => isOf(value, fieldTable), change: (value) => isChange(value, fieldTable) },
            ];
        }),
    ),
    // A rule changes only whole: a field of one kind of rule merged into a rule of another would leave one of neither.
    conditionalFormat: { whole: isConditionalFormat, change: () => false },
    // A reader draws nothing of a chart past the byte bound over all its parts, so a part alone holds no other bound.
    chart: {
        whole: (value) => isOf(value, CHART) && !exceedsChartSpecBytes(value),
        change: (value) => isRecord(value) && isChange(value, CHART) && !exceedsChartSpecBytes(value),
    },
};
