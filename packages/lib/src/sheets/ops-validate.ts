// The one door where ops someone else wrote, such as a peer's batch in the log or a sheet in a stored snapshot, become
// ops the workbook trusts. Each check is pure and reads one op: every place on the grid, every object holding only the
// keys its type lists, every text and key within its bound. A batch with one op that fails is not read at all, so
// every reader skips the same batches. State, such as whether a sheet or a filter exists, is the applier's to check.

import { ERROR_LITERALS, GRID_COLUMNS, GRID_ROWS, MAX_STORED_LENGTH } from '@workspace/formula/text';
import { isHexColor, parseRgb } from '../constants/colors';
import { isRecord } from '../core/guards';
import { isValidFractionalIndex } from '../vector/fractional-index';
import { isSafeMediaName } from '../vector/media-refs';
import { STROKE_STYLES } from '../vector/types';
import { BORDER_STYLES } from './borders';
import {
    LAST_DATE_SERIAL,
    MAX_BATCH_JSON,
    MAX_ID_LENGTH,
    MAX_ORDER_KEY,
    MAX_RECORDS_PER_TYPE,
    MAX_RUNS_PER_CELL,
    MAX_SHORT_TEXT,
    MAX_STYLE_RUNS,
    MAX_TEXT_LENGTH,
} from './limits';
import type {
    Batch,
    CellAttrs,
    CellRecord,
    ChartRecord,
    ImageRecord,
    LineAttrs,
    Op,
    Records,
    RunStyle,
    SheetContent,
    SheetFields,
} from './ops';
import { isSheetName } from './sheet-name';
import type { ConditionalFormatConditionName, ConditionalFormatRule, DataValidationRule, SingleRange } from './types';
import { isCellLinkType } from './types';

type Check = (value: unknown) => boolean;
type Entries = Record<string, unknown>;

// A batch of ops from its JSON text, when the text parses, every op in it is valid and the text fits the batch budget,
// else null. A batch of sheet ops alone is left out of the budget, since a sheet's add has bounds of its own.
export function readBatch(text: string): Batch | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(value) || !hasOnlyKeys(value, BATCH_KEYS)) return null;
    const { g, now, seed, ops } = value;
    if (
        !isCount(g, Number.MAX_SAFE_INTEGER) ||
        !isFiniteNumber(now) ||
        now < 0 ||
        now >= LAST_DATE_SERIAL + 1 ||
        !isSeed(seed) ||
        !isOpList(ops)
    )
        return null;
    return text.length <= MAX_BATCH_JSON || ops.every((op) => op.kind === 'sheet') ? { g, now, seed, ops } : null;
}

// A sheet whole, as a `sheet` op adds it and a snapshot holds it. Its caller hands it a value fresh from `JSON.parse`,
// so no getter, hole or `undefined` can stand in it.
export function isSheetContent(value: unknown): value is SheetContent {
    if (!isRecord(value) || !hasOnlyKeys(value, SHEET_CONTENT_KEYS)) return false;
    const { id, fields, cells, looks, bands, rows, columns, records } = value;
    return (
        isSheetId(id) &&
        isWhole(fields, SHEET_FIELDS) &&
        isCellList(cells, isCellRecord) &&
        Array.isArray(looks) &&
        looks.length <= MAX_STYLE_RUNS &&
        looks.every(isLook) &&
        isBands(bands, looks.length) &&
        isLineRuns(rows, GRID_ROWS) &&
        isLineRuns(columns, GRID_COLUMNS) &&
        isSheetRecords(records)
    );
}

function isOpList(value: unknown): value is Op[] {
    return Array.isArray(value) && value.every(isOp);
}

function isOp(value: unknown): value is Op {
    if (!isRecord(value)) return false;
    switch (value['kind']) {
        case 'input':
            return isInputOp(value);
        case 'format':
            return value['lines'] === undefined ? isCellFormatOp(value) : isLineFormatOp(value);
        case 'record':
            return isRecordOp(value);
        case 'lines':
            return isLinesOp(value);
        case 'move':
            return isMoveOp(value);
        case 'sheet':
            return isSheetOp(value);
        default:
            return false;
    }
}

function isInputOp(op: Entries): boolean {
    if (!hasOnlyKeys(op, INPUT_OP_KEYS) || !isSheetId(op['sheet'])) return false;
    const { runs, cells } = op;
    if (runs !== undefined && !isRuns(runs)) return false;
    if (cells !== undefined && !isCellList(cells, isContentOrNull)) return false;
    return (Array.isArray(runs) ? runs.length : 0) + (Array.isArray(cells) ? cells.length : 0) > 0;
}

function isCellFormatOp(op: Entries): boolean {
    if (!hasOnlyKeys(op, CELL_FORMAT_OP_KEYS) || !isSheetId(op['sheet'])) return false;
    const { ranges, set, clear } = op;
    return (
        Array.isArray(ranges) &&
        ranges.length > 0 &&
        ranges.every(isRect) &&
        (set === undefined || isLookOf(set, FORMAT_CHECKS)) &&
        (clear === undefined || isKeyList(clear, FORMAT_CHECKS)) &&
        namesAKey(set, clear)
    );
}

function isLineFormatOp(op: Entries): boolean {
    if (!hasOnlyKeys(op, LINE_FORMAT_OP_KEYS) || !isSheetId(op['sheet'])) return false;
    const { lines, spans, set, clear } = op;
    if (lines !== 'rows' && lines !== 'columns') return false;
    const count = lines === 'rows' ? GRID_ROWS : GRID_COLUMNS;
    return (
        Array.isArray(spans) &&
        spans.length > 0 &&
        spans.every((span) => isSpan(span, count)) &&
        (set === undefined || isWhole(set, LINE_FIELDS)) &&
        (clear === undefined || isKeyList(clear, LINE_FIELDS.checks)) &&
        namesAKey(set, clear)
    );
}

function isRecordOp(op: Entries): boolean {
    if (!hasOnlyKeys(op, RECORD_OP_KEYS)) return false;
    const { sheet, type, id, set, whole } = op;
    const kind = typeof type === 'string' ? RECORD_KINDS.get(type) : undefined;
    if (!isSheetId(sheet) || !isId(id) || kind === undefined) return false;
    if (type === 'sheet') return sheet === id && whole === undefined && kind.change(set);
    if (whole !== undefined) return whole === 1 && kind.whole(set);
    return set === undefined || kind.change(set);
}

function isLinesOp(op: Entries): boolean {
    if (!hasOnlyKeys(op, LINES_OP_KEYS) || !isSheetId(op['sheet'])) return false;
    const { rows, insert, index, count, like } = op;
    if (typeof rows !== 'boolean' || typeof insert !== 'boolean') return false;
    const size = rows ? GRID_ROWS : GRID_COLUMNS;
    if (!isCount(index, size - 1) || !isCount(count, size) || count === 0 || index + count > size) return false;
    return like === undefined || (insert && (like === index - 1 || like === index) && like >= 0);
}

function isMoveOp(op: Entries): boolean {
    if (!hasOnlyKeys(op, MOVE_OP_KEYS) || !isSheetId(op['sheet']) || !isSheetId(op['toSheet'])) return false;
    const { from, toRow, toColumn } = op;
    if (!isRect(from) || !isRow(toRow) || !isColumn(toColumn)) return false;
    const [top, left, bottom, right] = from;
    return isRow(toRow + bottom - top) && isColumn(toColumn + right - left);
}

function isSheetOp(op: Entries): boolean {
    if (!hasOnlyKeys(op, SHEET_OP_KEYS)) return false;
    const { add, delete: deleted } = op;
    if (add !== undefined) return deleted === undefined && isSheetContent(add);
    return isSheetId(deleted);
}

// A cell as an op writes it, and a cell as a sheet's content holds it.
function isContentOrNull(value: unknown): boolean {
    return value === null || isCell(value, CONTENT_KEYS);
}

function isCellRecord(value: unknown): value is CellRecord {
    return isCell(value, CELL_RECORD_KEYS);
}

// `v` with `e` is an error literal; `s` stands with neither `v` nor `f`; `spill` stands on a value with no `f`.
function isCell(value: unknown, keys: ReadonlySet<string>): boolean {
    if (!isRecord(value) || !hasOnlyKeys(value, keys)) return false;
    const { v, e, f, s, link, qp, spill } = value;
    // An empty cell is null in an input and absent from a sheet's cells, so a cell names a key.
    if (v === undefined && f === undefined && s === undefined && link === undefined && qp === undefined) return false;
    if (v !== undefined && !isScalar(v)) return false;
    if (e !== undefined && (e !== 1 || typeof v !== 'string' || !ERRORS.has(v))) return false;
    if (f !== undefined && !isStoredKey(f)) return false;
    if (s !== undefined && (v !== undefined || f !== undefined || !isRichText(s))) return false;
    if (link !== undefined && !isLink(link)) return false;
    if (qp !== undefined && qp !== 1) return false;
    return spill === undefined || (spill === 1 && f === undefined && v !== undefined);
}

function isScalar(value: unknown): boolean {
    return typeof value === 'boolean' || isFiniteNumber(value) || isText(value, MAX_TEXT_LENGTH);
}

function isStoredKey(value: unknown): boolean {
    return typeof value === 'string' && value.length <= MAX_STORED_LENGTH && value.startsWith('=');
}

// The runs' texts join into the cell's value, so together they keep the bound of one text.
function isRichText(value: unknown): boolean {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RUNS_PER_CELL) return false;
    let length = 0;
    for (const run of value) {
        if (!isRecord(run) || typeof run['v'] !== 'string') return false;
        for (const key in run) if (key !== 'v' && !RUN_CHECKS.get(key)?.(run[key])) return false;
        length += run['v'].length;
    }
    return length <= MAX_TEXT_LENGTH;
}

function isLink(value: unknown): boolean {
    if (!isRecord(value) || !hasOnlyKeys(value, LINK_KEYS)) return false;
    return isCellLinkType(value['type']) && isText(value['address'], MAX_TEXT_LENGTH);
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
    const rects: (readonly number[])[] = [];
    for (const run of value) {
        if (!Array.isArray(run) || run.length !== 2 || !isRect(run[0]) || !isContentOrNull(run[1])) return false;
        rects.push(run[0]);
    }
    return disjoint(rects);
}

// Two rectangles meet where a column holds both over a shared row. A sweep across the columns counts how many
// rectangles cover each row, in a tree over the rows where rectangles start and end, so the check is n log n.
function disjoint(rects: readonly (readonly number[])[]): boolean {
    if (rects.length < 2) return true;
    const edges = [...new Set(rects.flatMap(([top, , bottom]) => [top, bottom + 1]))].sort((a, b) => a - b);
    const slot = (row: number) => {
        let low = 0;
        let high = edges.length - 1;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (edges[middle] < row) low = middle + 1;
            else high = middle;
        }
        return low;
    };
    // An event is a rectangle entering at its left column or leaving after its right one; leaving sorts first.
    const at = (event: number) =>
        event < rects.length ? rects[event][1] * 2 + 1 : (rects[event - rects.length][3] + 1) * 2;
    const events = Array.from({ length: rects.length * 2 }, (_, event) => event).sort((a, b) => at(a) - at(b));
    const covers = new Coverage(edges.length - 1);
    for (const event of events) {
        const entering = event < rects.length;
        const [top, , bottom] = rects[entering ? event : event - rects.length];
        const from = slot(top);
        const to = slot(bottom + 1);
        if (entering && covers.most(from, to) > 0) return false;
        covers.add(from, to, entering ? 1 : -1);
    }
    return true;
}

// How many rectangles cover each slot, in a segment tree: a node holds the count added over its whole span and the most
// any slot under it is covered.
class Coverage {
    private readonly added: Int32Array;
    private readonly peak: Int32Array;

    public constructor(private readonly size: number) {
        this.added = new Int32Array(4 * size);
        this.peak = new Int32Array(4 * size);
    }

    public add(from: number, to: number, delta: number, node = 1, low = 0, high = this.size): void {
        if (to <= low || high <= from) return;
        if (from <= low && high <= to) {
            this.added[node] += delta;
            this.peak[node] += delta;
            return;
        }
        const middle = (low + high) >> 1;
        this.add(from, to, delta, 2 * node, low, middle);
        this.add(from, to, delta, 2 * node + 1, middle, high);
        this.peak[node] = this.added[node] + Math.max(this.peak[2 * node], this.peak[2 * node + 1]);
    }

    public most(from: number, to: number, node = 1, low = 0, high = this.size): number {
        if (to <= low || high <= from) return 0;
        if (from <= low && high <= to) return this.peak[node];
        const middle = (low + high) >> 1;
        const below = Math.max(
            this.most(from, to, 2 * node, low, middle),
            this.most(from, to, 2 * node + 1, middle, high),
        );
        return this.added[node] + below;
    }
}

// Bands are flat: first column, n, then n pairs of start row and look index, columns and rows ascending.
function isBands(value: unknown, lookCount: number): boolean {
    if (!Array.isArray(value)) return false;
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

function isLineRuns(value: unknown, count: number): boolean {
    if (!Array.isArray(value)) return false;
    let last = -1;
    for (const run of value) {
        if (!Array.isArray(run) || run.length !== 2) return false;
        const [span, attrs] = run;
        if (!isSpan(span, count) || span[0] <= last || !isWhole(attrs, LINE_FIELDS)) return false;
        last = span[1];
    }
    return true;
}

function isSheetRecords(value: unknown): boolean {
    if (!isRecord(value)) return false;
    for (const type in value) {
        const kind = type === 'sheet' ? undefined : RECORD_KINDS.get(type);
        const records = value[type];
        if (kind === undefined || !isRecord(records)) return false;
        let count = 0;
        for (const id in records) {
            count += 1;
            if (count > MAX_RECORDS_PER_TYPE || !isId(id) || !kind.whole(records[id])) return false;
        }
    }
    return true;
}

// The fields a record type holds, each with its check and whether the type requires it.
type Fields<T> = {
    readonly [K in keyof T]-?: readonly [check: Check, required: Partial<Pick<T, K>> extends Pick<T, K> ? false : true];
};
type Table = { readonly checks: ReadonlyMap<string, Check>; readonly required: ReadonlySet<string> };

function table(fields: { readonly [key: string]: readonly [Check, boolean] }): Table {
    const entries = Object.entries(fields);
    return {
        checks: new Map(entries.map(([key, [check]]) => [key, check])),
        required: new Set(entries.filter(([, [, required]]) => required).map(([key]) => key)),
    };
}

// A record whole: only its fields, every required one present. An optional field it lacks is absent, never null, so a
// record has one form.
function isWhole(value: unknown, { checks, required }: Table): boolean {
    if (!isRecord(value)) return false;
    let present = 0;
    for (const key in value) {
        const item = value[key];
        if (!checks.get(key)?.(item)) return false;
        if (required.has(key)) present += 1;
    }
    return present === required.size;
}

// A change of named fields: at least one, and null clears only a field the type does not require.
function isChange(value: unknown, { checks, required }: Table): boolean {
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

function isLookOf(value: unknown, checks: ReadonlyMap<string, Check>): boolean {
    if (!isRecord(value)) return false;
    for (const key in value) if (!checks.get(key)?.(value[key])) return false;
    return true;
}

function isLook(value: unknown): value is CellAttrs {
    return isLookOf(value, LOOK_CHECKS);
}

function isKeyList(value: unknown, checks: ReadonlyMap<string, Check>): boolean {
    return Array.isArray(value) && value.every((key) => typeof key === 'string' && checks.has(key));
}

// A key both set and cleared would read as either, by which the reader applies first.
function namesAKey(set: unknown, clear: unknown): boolean {
    if (
        isRecord(set) &&
        Array.isArray(clear) &&
        clear.some((key) => typeof key === 'string' && Object.hasOwn(set, key))
    )
        return false;
    return (isRecord(set) && Object.keys(set).length > 0) || (Array.isArray(clear) && clear.length > 0);
}

function isConditionalFormat(value: unknown): boolean {
    if (isWhole(value, DATA_BAR_FIELDS) || isWhole(value, COLOR_GRADATION_FIELDS)) return true;
    if (!isRecord(value) || !isWhole(value, DEFAULT_RULE_FIELDS)) return false;
    const { conditionName, conditionValue } = value;
    return conditionName !== 'formula' || (Array.isArray(conditionValue) && isStoredKey(conditionValue[0]));
}

function hasOnlyKeys(value: Entries, keys: ReadonlySet<string>): boolean {
    for (const key in value) if (!keys.has(key)) return false;
    return true;
}

function keysOf<T>(...keys: (keyof T & string)[]): ReadonlySet<string> {
    return new Set(keys);
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

// A draw's seed is read as a signed 32-bit integer.
function isSeed(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31;
}

function isRow(value: unknown): value is number {
    return isCount(value, GRID_ROWS - 1);
}

function isColumn(value: unknown): value is number {
    return isCount(value, GRID_COLUMNS - 1);
}

function isRect(value: unknown): value is readonly number[] {
    if (!Array.isArray(value) || value.length !== 4) return false;
    const [top, left, bottom, right] = value;
    return isRow(top) && isColumn(left) && isRow(bottom) && isColumn(right) && top <= bottom && left <= right;
}

function isSpan(value: unknown, count: number): value is readonly number[] {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const [first, last] = value;
    return isCount(first, count - 1) && isCount(last, count - 1) && first <= last;
}

function isSortedSpans(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    let last = -1;
    for (const span of value) {
        if (!isSpan(span, GRID_ROWS) || span[0] <= last) return false;
        last = span[1];
    }
    return true;
}

function isRanges(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0 && value.every(isRange);
}

function isRange(value: unknown): boolean {
    if (!isRecord(value) || !hasOnlyKeys(value, RANGE_KEYS)) return false;
    return isSpan(value['row'], GRID_ROWS) && isSpan(value['column'], GRID_COLUMNS);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isText(value: unknown, most: number): value is string {
    return typeof value === 'string' && value.length <= most;
}

function isShort(value: unknown): value is string {
    return isText(value, MAX_SHORT_TEXT);
}

function isLongText(value: unknown): value is string {
    return isText(value, MAX_TEXT_LENGTH);
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
    return isText(value, MAX_ORDER_KEY) && isValidFractionalIndex(value, undefined, undefined);
}

function isTexts(value: unknown, check: Check): boolean {
    return Array.isArray(value) && value.every(check);
}

function isBorderSide(value: unknown): boolean {
    if (!isRecord(value) || !hasOnlyKeys(value, BORDER_SIDE_KEYS)) return false;
    const { style, color } = value;
    return isCount(style, Number.MAX_SAFE_INTEGER) && Object.hasOwn(BORDER_STYLES, style) && isColor(color);
}

const ERRORS: ReadonlySet<string> = new Set(ERROR_LITERALS);

const BATCH_KEYS = keysOf<Batch>('g', 'now', 'seed', 'ops');
const INPUT_OP_KEYS = keysOf<Extract<Op, { kind: 'input' }>>('kind', 'sheet', 'runs', 'cells');
const CELL_FORMAT_OP_KEYS = keysOf<Extract<Op, { ranges: unknown }>>('kind', 'sheet', 'ranges', 'set', 'clear');
const LINE_FORMAT_OP_KEYS = keysOf<Extract<Op, { spans: unknown }>>('kind', 'sheet', 'lines', 'spans', 'set', 'clear');
const RECORD_OP_KEYS = keysOf<Extract<Op, { kind: 'record' }>>('kind', 'sheet', 'type', 'id', 'set', 'whole');
const LINES_OP_KEYS = keysOf<Extract<Op, { kind: 'lines' }>>(
    'kind',
    'sheet',
    'rows',
    'insert',
    'index',
    'count',
    'like',
);
const MOVE_OP_KEYS = keysOf<Extract<Op, { kind: 'move' }>>('kind', 'sheet', 'from', 'toSheet', 'toRow', 'toColumn');
const SHEET_OP_KEYS: ReadonlySet<string> = new Set(['kind', 'add', 'delete']);
const SHEET_CONTENT_KEYS = keysOf<SheetContent>(
    'id',
    'fields',
    'cells',
    'looks',
    'bands',
    'rows',
    'columns',
    'records',
);
const CONTENT_KEYS = keysOf<CellRecord>('v', 'e', 'f', 's', 'link', 'qp');
const CELL_RECORD_KEYS = keysOf<CellRecord>('v', 'e', 'f', 's', 'link', 'qp', 'spill');
const LINK_KEYS = keysOf<NonNullable<CellRecord['link']>>('type', 'address');
const BORDER_SIDE_KEYS = keysOf<NonNullable<CellAttrs['bdt']>>('style', 'color');
const RANGE_KEYS = keysOf<SingleRange>('row', 'column');

const RUN_STYLE: { readonly [K in keyof RunStyle]-?: Check } = {
    bl: isOne,
    it: isOne,
    ff: (value) => isFiniteNumber(value) || isShort(value),
    fs: (value) => isFiniteNumber(value) && value > 0,
    fc: isShort,
    cl: isOne,
    un: isOne,
};
const LOOK: { readonly [K in keyof CellAttrs]-?: Check } = {
    ...RUN_STYLE,
    fa: isShort,
    ht: isFiniteNumber,
    vt: isFiniteNumber,
    tb: isShort,
    bg: isShort,
    rt: (value) => value === 'vertical' || (isFiniteNumber(value) && value >= -90 && value <= 90),
    bdt: isBorderSide,
    bdb: isBorderSide,
    bdl: isBorderSide,
    bdr: isBorderSide,
    bdd: isBorderSide,
};
const RUN_CHECKS: ReadonlyMap<string, Check> = new Map(Object.entries(RUN_STYLE));
const LOOK_CHECKS: ReadonlyMap<string, Check> = new Map(Object.entries(LOOK));
const FORMAT_CHECKS: ReadonlyMap<string, Check> = new Map([...LOOK_CHECKS, ['link', isLink]]);

const LINE: Fields<LineAttrs> = { size: [isSize, false], custom: [isOne, false], hidden: [isOne, false] };
const LINE_FIELDS = table(LINE);

const SHEET: Fields<SheetFields> = {
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
const SHEET_FIELDS = table(SHEET);

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
const DATA_BAR: Fields<Extract<ConditionalFormatRule, { type: 'dataBar' }>> = {
    ranges: [isRanges, true],
    order: [isOrderKey, true],
    type: [(value) => value === 'dataBar', true],
    format: [(value) => isTexts(value, isShort), true],
};
const COLOR_GRADATION: Fields<Extract<ConditionalFormatRule, { type: 'colorGradation' }>> = {
    ranges: [isRanges, true],
    order: [isOrderKey, true],
    type: [(value) => value === 'colorGradation', true],
    format: [(value) => isTexts(value, isColor), true],
};
const COLORS: Fields<Extract<ConditionalFormatRule, { type: 'default' }>['format']> = {
    textColor: [(value) => value === null || isShort(value), false],
    cellColor: [(value) => value === null || isShort(value), false],
};
const COLORS_FIELDS = table(COLORS);
const DEFAULT_RULE: Fields<Extract<ConditionalFormatRule, { type: 'default' }>> = {
    ranges: [isRanges, true],
    order: [isOrderKey, true],
    type: [(value) => value === 'default', true],
    format: [(value) => isWhole(value, COLORS_FIELDS), true],
    conditionName: [(value) => typeof value === 'string' && Object.hasOwn(CONDITION_NAMES, value), true],
    conditionRange: [isRanges, false],
    conditionValue: [(value) => isTexts(value, (item) => isFiniteNumber(item) || isLongText(item)), true],
};
const DATA_BAR_FIELDS = table(DATA_BAR);
const COLOR_GRADATION_FIELDS = table(COLOR_GRADATION);
const DEFAULT_RULE_FIELDS = table(DEFAULT_RULE);

const RULE: Fields<DataValidationRule> = {
    type: [isShort, true],
    type2: [isShort, true],
    value1: [isLongText, true],
    value2: [isLongText, true],
    hintShow: [isBoolean, false],
    hintValue: [isLongText, false],
    prohibitInput: [isBoolean, false],
};
const RULE_FIELDS = table(RULE);

const FLOATING: Fields<Omit<ImageRecord, 'mediaName'>> = {
    index: [isOrderKey, true],
    x: [isFiniteNumber, true],
    y: [isFiniteNumber, true],
    width: [isFiniteNumber, true],
    height: [isFiniteNumber, true],
    angle: [isFiniteNumber, false],
};
const CHART: Fields<ChartRecord> = {
    ...FLOATING,
    fill: [isLongText, false],
    color: [isShort, false],
    strokeColor: [isShort, false],
    strokeWidth: [isFiniteNumber, false],
    seriesStrokeWidth: [isFiniteNumber, false],
    strokeStyle: [(value) => STROKE_STYLES.some((style) => style === value), false],
    roughness: [isFiniteNumber, false],
    seed: [isFiniteNumber, false],
    specChart: [isLongText, true],
    specTitle: [isLongText, true],
    specLegend: [isLongText, true],
    specAxes: [isLongText, true],
    specPlots: [isLongText, true],
    specSeries: [isLongText, true],
    specPoints: [isLongText, true],
    specData: [isLongText, true],
};

const FIELDS: { readonly [T in Exclude<keyof Records, 'conditionalFormat'>]: Fields<Records[T]> } = {
    sheet: SHEET,
    merge: { rect: [isRect, true] },
    filter: { rect: [isRect, true] },
    filterColumn: {
        filter: [isId, true],
        column: [isColumn, true],
        condition: [
            (value) =>
                isRecord(value) &&
                hasOnlyKeys(value, CONDITION_KEYS) &&
                isShort(value['name']) &&
                isTexts(value['values'], isShort),
            false,
        ],
        rows: [isSortedSpans, true],
    },
    comment: { row: [isRow, true], column: [isColumn, true] },
    validation: {
        ranges: [isRanges, true],
        order: [isOrderKey, true],
        rule: [(value) => isWhole(value, RULE_FIELDS), true],
    },
    image: { ...FLOATING, mediaName: [(value) => isShort(value) && isSafeMediaName(value), true] },
    chart: CHART,
};
const CONDITION_KEYS = keysOf<NonNullable<Records['filterColumn']['condition']>>('name', 'values');

// How a record op's `set` is read for each type: as a whole record, or as a change of some of its fields.
type RecordKind = { readonly whole: Check; readonly change: Check };
const RECORD_KINDS: ReadonlyMap<string, RecordKind> = new Map([
    ...Object.entries(FIELDS).map(([type, fields]): [string, RecordKind] => {
        const fieldTable = table(fields);
        return [type, { whole: (value) => isWhole(value, fieldTable), change: (value) => isChange(value, fieldTable) }];
    }),
    // A rule changes only whole: a field of one kind of rule merged into a rule of another would leave one of neither.
    ['conditionalFormat', { whole: isConditionalFormat, change: () => false }],
]);
