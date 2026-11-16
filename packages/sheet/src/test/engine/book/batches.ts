// Random books and random batches of ops for the laws of the workbook's appliers, seeded so a failing case runs
// again. A book comes with every formula still to be computed, or about half the time as the server's fold of it,
// computed and trusted whole, so its values are the engine's own and stay the same when an edit computes them again.
// An op is drawn against the model of the book: it mostly names sheets, cells and records that are there, and now and
// then one that is not, a name in use, a merge over a merge or the last sheet. Every batch passes the validators.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import { encodeBook } from '@workspace/lib/sheets/book-codec';
import type {
    Batch,
    CellAttrs,
    CellContent,
    FieldsOf,
    FormatOp,
    InputOp,
    LineAttrs,
    LinesOp,
    MoveOp,
    Op,
    Placed,
    RecordOp,
    RecordType,
    Rect,
    Run,
    SheetContent,
    SheetFields,
    SheetOp,
    Span,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import type { CellLink } from '@workspace/lib/sheets/types';
import type { Book, Random } from './book-fixtures';
import { below, FORMULAS, randomBook, randomSheet } from './book-fixtures';
import { decoded, fold } from './bytes';
import type { Model, ModelSheet } from './model';
import { chartData, chartOf, formulaRule, ref } from './records-fixtures';

// A formula typed with the name of a sheet that is not there: a rename or an add of a sheet to that name binds it,
// and its inverse writes the typed text back. An input typed with the name of a sheet the book holds is bound.
export const LATER = 'Later';
const TYPED_WITH_NAME = "='Later'!R1C1+1";
// Formulas this build cannot evaluate, which keep the value they are given.
const KEPT = ["='[b.xlsx]S'!R1C1", "=SUM('N:M'!R1C1)"];
const ORDERS = ['a0', 'a1', 'a2', 'a3', 'a1V'];
// A name as long as a name may be: a sheet added with it in use takes a suffix within the same 31 characters.
const LONG_NAME = 'Quarterly results by region (b)';
const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is' };
const OTHER_LINK: CellLink = { type: 'cellrange', address: 'A1:B2' };
// Runs that disagree on bold, color and size; runs that agree with a plain look; runs that agree with each other only.
const RICH: Run[] = [
    { v: 'bold ', bl: 1 },
    { v: 'and red', fc: '#ff0000', fs: 14 },
];
const PLAIN_RICH: Run[] = [{ v: 'one ' }, { v: 'two' }];
const ITALIC_RICH: Run[] = [
    { v: 'one ', it: 1 },
    { v: 'two', it: 1 },
];
const SIDE = { style: 1, color: '#000000' };
const LOOK_PARTS: readonly CellAttrs[] = [
    { bl: 1 },
    { it: 1, fc: '#ff0000' },
    { bg: '#00ff00', bdt: SIDE },
    { fa: '0.00', ht: 1 },
    { fs: 12, ff: 'Inter', un: 1 },
    { cl: 1, vt: 2, tb: '2' },
    { rt: 'vertical', bdb: SIDE, bdl: SIDE },
    { bdr: SIDE, bdd: { style: 2, color: '#ff0000' } },
    { fs: 9, cl: 1 },
];
const LINE_PARTS: readonly LineAttrs[] = [{ size: 30 }, { size: 44.5, custom: 1 }, { hidden: 1 }, { custom: 1 }];

function pick<T>(random: Random, list: readonly T[]): T {
    return list[below(random, list.length)];
}

// A book whose formulas hold no value yet, or about half the time its computed fold, with a formula typed with the
// name of a sheet that is not there, and its filter, where it has one, often from the first line or to the last.
export function randomBookContent(random: Random): Book {
    const book = uncomputedBook(random);
    // Told by the generation, already drawn, so the choice takes no draw of its own.
    return book.g % 2 === 1 ? decoded(fold(encodeBook(book), [])) : book;
}

function uncomputedBook(random: Random): Book {
    const book = randomBook(random);
    return {
        ...book,
        sheets: book.sheets.map((sheet) => {
            const cells = sheet.cells.map(([row, column, cell]): (typeof sheet.cells)[number] => {
                if (cell.f === undefined) return [row, column, cell];
                const { v: _, e: __, ...rest } = cell;
                return [row, column, rest];
            });
            if (random() < 0.5) cells.push([70, 3, { f: TYPED_WITH_NAME }]);
            cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
            const [filter] = Object.keys(sheet.records.filter ?? {});
            if (!filter) return { ...sheet, cells };
            // A filter often runs from the first line, or to the last, where its header moves and its end stays.
            const rect = pick<Rect>(random, [
                [2, 0, 20, 4],
                [0, 0, GRID_ROWS - 1, 4],
                [2, 0, GRID_ROWS - 1, 4],
                [0, 0, 20, GRID_COLUMNS - 1],
            ]);
            return { ...sheet, cells, records: { ...sheet.records, filter: { [filter]: { rect } } } };
        }),
    };
}

// A batch of one to `most` ops, each drawn by `make` against the model as it is before the batch.
export function batchOf<O extends Op>(
    random: Random,
    model: Model,
    make: (random: Random, model: Model) => O,
    most = 4,
): Omit<Batch, 'ops'> & { ops: O[] } {
    const ops = Array.from({ length: 1 + below(random, most) }, () => make(random, model));
    return { g: model.g, now: 40_000 + below(random, 90_000) / 7, seed: below(random, 2 ** 31), ops };
}

export function randomOp(random: Random, model: Model): Op {
    return pick(random, [randomInputOp, randomFormatOp, randomRecordOp, randomLinesOp, randomMoveOp, randomSheetOp])(
        random,
        model,
    );
}

// An op in the mix the general laws draw: every kind, with formulas that read the lines and blocks an edit moves and
// things put at the grid's end, which an insert then pushes.
export function randomAnyOp(random: Random, model: Model): Op {
    const draw = random();
    if (draw < 0.15) return randomInputOp(random, model);
    if (draw < 0.19) return randomLineReaderOp(random, model);
    if (draw < 0.23) return randomLandingReaderOp(random, model);
    if (draw < 0.36) return randomFormatOp(random, model);
    if (draw < 0.47) return randomLinesOp(random, model);
    if (draw < 0.52) return randomEndOp(random, model);
    if (draw < 0.66) return randomMoveOp(random, model);
    if (draw < 0.7) return randomMergeOp(random, model);
    return draw < 0.89 ? randomRecordOp(random, model) : randomSheetOp(random, model);
}

// A merge made over a cell of a merge of its sheet, which the store refuses, or made fresh where a sheet holds none.
function randomMergeOp(random: Random, model: Model): RecordOp {
    const merged = [...model.sheets.values()].filter(({ records }) => records.merge.size > 0);
    const n = below(random, 5);
    if (merged.length === 0) {
        const { id: sheet } = someSheet(random, model);
        return {
            kind: 'record',
            sheet,
            type: 'merge',
            id: `${sheet}m${n}`,
            set: { rect: smallRect(random) },
            whole: 1,
        };
    }
    const { id: sheet, records } = pick(random, merged);
    const id = `${sheet}m${n}`;
    const [top, left, bottom, right] = pick(random, [...records.merge.values()]).rect;
    const row = top + below(random, bottom - top + 1);
    const column = left + below(random, right - left + 1);
    return { kind: 'record', sheet, type: 'merge', id, set: { rect: [row, column, row + 1, column] }, whole: 1 };
}

export function someSheet(random: Random, model: Model): ModelSheet {
    return pick(random, [...model.sheets.values()]);
}

// The id of a sheet of the book, or now and then of one it does not hold.
function sheetId(random: Random, model: Model): string {
    return random() < 0.04 ? 'nosheet' : someSheet(random, model).id;
}

function smallRect(random: Random, rows = 14, columns = 8): Rect {
    const top = below(random, rows);
    const left = below(random, columns);
    return [top, left, top + below(random, 4), left + below(random, 3)];
}

function content(random: Random, model: Model): CellContent | null {
    return pick<() => CellContent | null>(random, [
        () => null,
        () => ({ v: below(random, 400) / 4 }),
        () => ({ v: pick(random, ['text', '', '=not a formula']) }),
        () => ({ v: random() < 0.5 }),
        () => ({ v: pick(random, ['#DIV/0!', '#N/A']), e: 1 }),
        () => ({ f: pick(random, FORMULAS) }),
        () => ({ f: pick(random, FORMULAS), link: LINK }),
        () => ({ f: typedWithName(random, model) }),
        () => ({ f: TYPED_WITH_NAME, qp: 1 }),
        () => ({ f: pick(random, KEPT), v: below(random, 9) }),
        () => ({ f: pick(random, KEPT), v: '#N/A', e: 1 }),
        () => ({ f: pick(random, KEPT) }),
        // A value beside a formula this build evaluates is not kept.
        () => ({ f: '=R[1]C+1', v: 5 }),
        () => ({ s: RICH }),
        () => ({ s: RICH, link: LINK, qp: 1 }),
        () => ({ s: PLAIN_RICH }),
        () => ({ s: ITALIC_RICH, qp: 1 }),
        () => ({ v: 'x', link: LINK }),
        () => ({ v: 'typed', qp: 1 }),
        () => ({ link: LINK }),
    ])();
}

// A formula typed with the name of a sheet of the book, in any letter case, or of the sheet a formula waits for.
function typedWithName(random: Random, model: Model): string {
    const name = random() < 0.3 ? LATER : someSheet(random, model).fields.name;
    return `='${random() < 0.5 ? name : name.toUpperCase()}'!R1C1+1`;
}

export function randomInputOp(random: Random, model: Model): InputOp {
    const places = new Set<number>();
    for (let i = 1 + below(random, 5); i > 0; i -= 1) places.add(below(random, 9) * GRID_ROWS + below(random, 16));
    const cells = [...places]
        .sort((a, b) => a - b)
        .map(
            (place): Placed<CellContent | null> => [
                place % GRID_ROWS,
                Math.floor(place / GRID_ROWS),
                content(random, model),
            ],
        );
    const op: InputOp = { kind: 'input', sheet: sheetId(random, model), cells };
    // The rectangles of the runs stand in columns of their own, right of the cells, so they are disjoint and an op
    // says a place once.
    if (random() < 0.4) {
        op.runs = Array.from({ length: 1 + below(random, 2) }, (_, at) => {
            const [top, left, bottom, right] = smallRect(random, 14, 2);
            const filled = pick<() => CellContent | null>(random, [
                () => null,
                () => ({ v: 7 }),
                () => ({ f: pick(random, FORMULAS) }),
                () => ({ f: typedWithName(random, model) }),
                () => ({ f: pick(random, KEPT), v: 3 }),
                () => ({ s: RICH }),
                () => ({ s: PLAIN_RICH, link: OTHER_LINK }),
                () => ({ v: 'x', link: LINK, qp: 1 }),
            ])();
            return [[top, 10 + at * 6 + left, bottom, 10 + at * 6 + right], filled] as const;
        });
        if (random() < 0.3) delete op.cells;
    }
    return op;
}

// A line format over spans that may overlap, or a cell format over one to five rectangles that may overlap: single
// cells, small blocks, whole columns, whole rows or the whole sheet. Now and then it sets or clears a link, over
// blocks that hold rich, marked and plain cells, or clears every look key it does not set, as a paste does.
export function randomFormatOp(random: Random, model: Model): FormatOp {
    const sheet = sheetId(random, model);
    if (random() < 0.3) {
        const set = pick(random, [...LINE_PARTS, undefined]);
        const free = (['size', 'custom', 'hidden'] as const).filter((name) => set?.[name] === undefined);
        const clear = set === undefined ? [pick(random, free)] : free.filter(() => random() < 0.3);
        const spans = Array.from({ length: 1 + below(random, 3) }, (): Span => {
            const first = below(random, 16);
            return [first, first + below(random, 4)];
        });
        return { kind: 'format', sheet, lines: random() < 0.5 ? 'rows' : 'columns', spans, set, clear };
    }
    // The model writes a link cell by cell, so a link goes over blocks of a few hundred cells at most.
    const linked = random() < 0.2;
    const shape = (): Rect => {
        const row = below(random, 14);
        const column = below(random, 8);
        if (linked)
            return random() < 0.5 ? smallRect(random) : [0, column, 4 + below(random, 60), column + below(random, 8)];
        return pick<() => Rect>(random, [
            () => smallRect(random),
            () => smallRect(random),
            () => [row, column, row, column],
            () => [0, column, GRID_ROWS - 1, column],
            () => [row, 0, row, GRID_COLUMNS - 1],
            () => [0, 0, GRID_ROWS - 1, GRID_COLUMNS - 1],
        ])();
    };
    const ranges = Array.from({ length: 1 + below(random, random() < 0.2 ? 5 : 2) }, shape);
    const set: CellAttrs & { link?: CellLink } = random() < 0.15 ? {} : { ...pick(random, LOOK_PARTS) };
    const clear: NonNullable<Extract<FormatOp, { ranges: unknown }>['clear']> = [];
    const rest = random() < 0.1;
    for (const name of LOOK_KEYS) {
        if (!(name in set) && (rest || random() < 0.08)) clear.push(name);
    }
    if (linked && random() < 0.5) set.link = pick(random, [LINK, OTHER_LINK]);
    else if (linked) clear.push('link');
    if (Object.keys(set).length === 0 && clear.length === 0) clear.push(pick(random, LOOK_KEYS));
    return { kind: 'format', sheet, ranges, ...(Object.keys(set).length > 0 && { set }), clear };
}

export function randomRecordOp(random: Random, model: Model): RecordOp {
    const held = someSheet(random, model);
    const sheet = random() < 0.04 ? 'nosheet' : held.id;
    // The id of a record of the type the sheet holds, or a new one, or now and then one another sheet holds for the
    // type, which a make may not take.
    const idOf = (type: Exclude<RecordType, 'sheet'>, prefix: string) => {
        const fresh = `${held.id}${prefix}${below(random, 5)}`;
        const elsewhere = [...model.sheets.values()].flatMap((other) =>
            other === held ? [] : [...other.records[type].keys()],
        );
        if (elsewhere.length > 0 && random() < 0.05) return pick(random, elsewhere);
        return random() < 0.7 ? pick(random, [...held.records[type].keys(), fresh]) : fresh;
    };
    // Now and then a rectangle that reaches the grid's last row or column, which stays reaching it.
    const reaching = (): Rect => {
        const [top, left, bottom, right] = smallRect(random);
        if (random() < 0.8) return [top, left, bottom, right];
        return random() < 0.5 ? [top, left, GRID_ROWS - 1, right] : [top, left, bottom, GRID_COLUMNS - 1];
    };
    const mode = below(random, 3);
    const { records } = held;
    switch (below(random, 10)) {
        case 0:
        case 1: {
            const others = [...model.sheets.values()].filter((other) => other !== held);
            const set: FieldsOf<SheetFields> = pick<() => FieldsOf<SheetFields>>(random, [
                () => ({ name: `Tab ${below(random, 6)}` }),
                () => ({ name: LATER }),
                () => ({ name: others.length > 0 ? pick(random, others).fields.name.toUpperCase() : 'Solo' }),
                () => ({ name: held.fields.name.toLowerCase() }),
                () => ({ order: pick(random, ORDERS) }),
                () => ({ order: pick(random, ORDERS), name: `Tab ${below(random, 6)}`, color: '#abcdef' }),
                () => ({ hide: random() < 0.6 ? 1 : null }),
                () => ({ color: random() < 0.5 ? '#123456' : null, grid: random() < 0.5 ? 0 : null }),
                () => ({ frozenRows: random() < 0.5 ? 1 + below(random, 3) : null, defaultRowHeight: 24 }),
            ])();
            return { kind: 'record', sheet, type: 'sheet', id: sheet, set };
        }
        case 2: {
            const id = idOf('merge', 'm');
            const [top, left, bottom, right] = smallRect(random);
            // Now and then over another merge of the sheet, which it may not overlap.
            const others = [...records.merge].filter(([other]) => other !== id);
            const rect: Rect =
                others.length > 0 && random() < 0.3 ? pick(random, others)[1].rect : [top, left, bottom, right + 1];
            if (mode === 0) return { kind: 'record', sheet, type: 'merge', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'merge', id, set: { rect } };
            return { kind: 'record', sheet, type: 'merge', id, set: { rect }, whole: 1 };
        }
        case 3: {
            const id = idOf('filter', 'f');
            // Often from the first row or column to the last, where the header moves and the end stays.
            const [top, left, bottom, right] = smallRect(random);
            const rect = pick<() => Rect>(random, [
                reaching,
                () => [0, left, GRID_ROWS - 1, right],
                () => [top, 0, bottom, GRID_COLUMNS - 1],
                () => [0, left, bottom, right],
                () => [top, left, GRID_ROWS - 1, right],
            ])();
            if (mode === 0) return { kind: 'record', sheet, type: 'filter', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'filter', id, set: { rect } };
            return { kind: 'record', sheet, type: 'filter', id, set: { rect }, whole: 1 };
        }
        case 4: {
            const id = idOf('filterColumn', 'k');
            const filter = random() < 0.7 ? pick(random, [...records.filter.keys(), 'nofilter']) : 'nofilter';
            const first = below(random, 9);
            const rows: Span[] = pick(random, [
                [],
                [[first, first + 1]],
                [
                    [first, first],
                    [first + 3, first + 5],
                ],
            ]);
            if (mode === 0) return { kind: 'record', sheet, type: 'filterColumn', id };
            if (mode === 1) {
                const set = pick(random, [{ rows }, { condition: null }, { filter }, { column: below(random, 5) }]);
                return { kind: 'record', sheet, type: 'filterColumn', id, set };
            }
            const condition = { name: 'values', values: ['a', 'b'] };
            const set = { filter, column: below(random, 5), rows, ...(random() < 0.5 && { condition }) };
            return { kind: 'record', sheet, type: 'filterColumn', id, set, whole: 1 };
        }
        case 5: {
            const id = idOf('comment', 'c');
            const set = { row: below(random, 14), column: below(random, 8) };
            if (mode === 0) return { kind: 'record', sheet, type: 'comment', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'comment', id, set: { row: set.row } };
            return { kind: 'record', sheet, type: 'comment', id, set, whole: 1 };
        }
        case 6: {
            const id = idOf('conditionalFormat', 'r');
            if (mode === 0) return { kind: 'record', sheet, type: 'conditionalFormat', id };
            const set = formulaRule([reaching(), reaching()], pick(random, ['=RC>1', '=R[1]C[1]="x"', '=[s0]!R1C1>0']));
            return { kind: 'record', sheet, type: 'conditionalFormat', id, set, whole: 1 };
        }
        case 7: {
            const id = idOf('validation', 'v');
            const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
            if (mode === 0) return { kind: 'record', sheet, type: 'validation', id };
            if (mode === 1) {
                const set = random() < 0.5 ? { order: pick(random, ORDERS) } : { ranges: [reaching()] };
                return { kind: 'record', sheet, type: 'validation', id, set };
            }
            const set = { ranges: [reaching()], order: pick(random, ORDERS), rule };
            return { kind: 'record', sheet, type: 'validation', id, set, whole: 1 };
        }
        case 8: {
            const id = idOf('image', 'i');
            const box = { index: pick(random, ORDERS), x: below(random, 90), y: 2, width: 30, height: 40 };
            if (mode === 0) return { kind: 'record', sheet, type: 'image', id };
            if (mode === 1) {
                const set = { x: below(random, 90), angle: random() < 0.5 ? 30 : null };
                return { kind: 'record', sheet, type: 'image', id, set };
            }
            return { kind: 'record', sheet, type: 'image', id, set: { ...box, mediaName: `${id}.png` }, whole: 1 };
        }
        default: {
            const id = idOf('chart', 'g');
            if (mode === 0) return { kind: 'record', sheet, type: 'chart', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'chart', id, set: { x: below(random, 90) } };
            const values = ref(held.id, [below(random, 5), 6 + below(random, 5)], [0, 0]);
            const set = chartOf({ categories: null, series: [{ id: 's', name: 'n', values }] });
            return { kind: 'record', sheet, type: 'chart', id, set, whole: 1 };
        }
    }
}

// Rows or columns inserted or deleted: mostly among the cells of the book, now and then at the grid's first line or
// among its last, where an insert pushes lines off the grid and a delete lets lines in.
export function randomLinesOp(random: Random, model: Model): LinesOp {
    const rows = random() < 0.6;
    const insert = random() < 0.5;
    const count = 1 + below(random, 3);
    const place = random();
    const end = (rows ? GRID_ROWS : GRID_COLUMNS) - count;
    const index = place < 0.1 ? 0 : place < 0.3 ? end - below(random, 4) : below(random, rows ? 20 : 9);
    const op: LinesOp = { kind: 'lines', sheet: sheetId(random, model), rows, insert, index, count };
    if (insert && random() < 0.7) op.like = index > 0 && random() < 0.6 ? index - 1 : index;
    return op;
}

// One thing put on one of the last three rows or columns of a sheet, which an insert then pushes off the grid: a link
// or a mark alone, content, a line key, a look, a comment, a merge, a filter, filtered rows or a rule range. Now and
// then the comment goes again.
export function randomEndOp(random: Random, model: Model): InputOp | FormatOp | RecordOp {
    const { id: sheet, records } = someSheet(random, model);
    const row = GRID_ROWS - 1 - below(random, 3);
    const column = GRID_COLUMNS - 1 - below(random, 3);
    const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
    const filter = [...records.filter.keys()][0] ?? 'nofilter';
    return pick<() => InputOp | FormatOp | RecordOp>(random, [
        () => ({ kind: 'input', sheet, cells: [[row, below(random, 4), random() < 0.5 ? { link: LINK } : { qp: 1 }]] }),
        () => ({ kind: 'input', sheet, cells: [[below(random, 9), column, content(random, model)]] }),
        () => ({ kind: 'format', sheet, lines: 'rows', spans: [[row, row]], set: { size: 30 } }),
        () => ({ kind: 'format', sheet, lines: 'columns', spans: [[column, column]], set: { hidden: 1 } }),
        () => ({ kind: 'format', sheet, ranges: [[row, 0, row, 2]], set: { bl: 1 } }),
        () => ({ kind: 'format', sheet, ranges: [[0, column, 5, column]], set: { it: 1 } }),
        () => ({ kind: 'record', sheet, type: 'comment', id: `${sheet}e`, set: { row, column: 1 }, whole: 1 }),
        () => ({ kind: 'record', sheet, type: 'comment', id: `${sheet}e`, set: { row: 1, column }, whole: 1 }),
        () => ({ kind: 'record', sheet, type: 'comment', id: `${sheet}e` }),
        () => ({
            kind: 'record',
            sheet,
            type: 'merge',
            id: `${sheet}e`,
            set: { rect: [row - 1, 12, row, 13] },
            whole: 1,
        }),
        () => ({
            kind: 'record',
            sheet,
            type: 'merge',
            id: `${sheet}e`,
            set: { rect: [12, column - 1, 12, column] },
            whole: 1,
        }),
        () => ({ kind: 'record', sheet, type: 'filter', id: `${sheet}f`, set: { rect: [2, 0, row, 4] }, whole: 1 }),
        () => ({
            kind: 'record',
            sheet,
            type: 'filterColumn',
            id: `${sheet}ke`,
            set: { filter, column: 1, rows: [[row - 1, row]] },
            whole: 1,
        }),
        () => ({
            kind: 'record',
            sheet,
            type: 'validation',
            id: `${sheet}ve`,
            set: { ranges: [[row, 0, row, 1]], order: 'a2', rule },
            whole: 1,
        }),
        () => ({
            kind: 'record',
            sheet,
            type: 'conditionalFormat',
            id: `${sheet}re`,
            set: formulaRule([[0, column, 2, column]], '=RC>1'),
            whole: 1,
        }),
    ])();
}

// Formulas that read whole lines, lines beside their own and lines of another sheet, typed one cell at a time or
// filled over a block: a line edit moves, stops or breaks what they read, on their sheet and from another.
const READERS = [
    '=SUM(R1C1:R1048576C1)',
    '=SUM(R1C1:R1C16384)',
    '=R[-2]C+1',
    '=SUM(R[-3]C:R[-1]C)',
    '=RC[-1]*2',
    '=[s0]!R4C2+1',
    '=SUM([s0]!R2C1:R1048576C2)',
    '=SUM([s0]!R1C3:R9C16384)',
    '=[s1]!R[1]C[1]',
];

export function randomLineReaderOp(random: Random, model: Model): InputOp {
    const sheet = someSheet(random, model).id;
    const top = 3 + below(random, 12);
    const left = 1 + below(random, 8);
    const f = pick(random, READERS);
    if (random() < 0.7) return { kind: 'input', sheet, cells: [[top, left, { f }]] };
    return { kind: 'input', sheet, runs: [[[top, left, top + 1 + below(random, 4), left + below(random, 2)], { f }]] };
}

// A block of a sheet moved on it or to another: a single cell, a small block, the rectangle of a merge, a rule range,
// a comment or a chart's series, one a little larger, or a whole column or row. Half the moves land near where they
// start, so the block overlaps itself in every direction; now and then either sheet is one the book does not hold.
export function randomMoveOp(random: Random, model: Model): MoveOp {
    const held = someSheet(random, model);
    const sheet = random() < 0.04 ? 'nosheet' : held.id;
    const { merge, comment, conditionalFormat, validation } = held.records;
    const toSheet = random() < 0.6 ? sheet : sheetId(random, model);
    const placed: Rect[] = [
        ...[...merge.values()].map(({ rect }) => rect),
        ...[...comment.values()].map(({ row, column }): Rect => [row, column, row, column]),
        ...[...conditionalFormat.values(), ...validation.values()].flatMap(({ ranges }) => ranges),
        ...chartRefsOn(model, held.id),
    ].filter(([top, left, bottom, right]) => bottom - top < 40 && right - left < 40);
    const row = below(random, 14);
    const column = below(random, 8);
    const from = pick<() => Rect>(random, [
        () => smallRect(random),
        () => smallRect(random),
        () => smallRect(random),
        () => smallRect(random),
        () => [row, column, row, column],
        () => {
            if (placed.length === 0) return smallRect(random);
            const [top, left, bottom, right] = pick(random, placed);
            const grow = random() < 0.5 ? 0 : 1;
            return [
                Math.max(0, top - grow),
                Math.max(0, left - grow),
                Math.min(GRID_ROWS - 1, bottom + grow),
                Math.min(GRID_COLUMNS - 1, right + grow),
            ];
        },
        () =>
            random() < 0.5 ? [0, column, GRID_ROWS - 1, column + below(random, 2)] : [row, 0, row, GRID_COLUMNS - 1],
    ])();
    const [top, left, bottom, right] = from;
    // A move near its start lands less than its own size away, so it overlaps itself when it stays on its sheet.
    const near = random() < 0.6;
    const toward = (start: number, size: number, room: number) =>
        Math.min(room, Math.max(0, near ? start + below(random, 2 * size + 1) - size : below(random, 16)));
    // Now and then the block lands on a chart's series it is large enough to cover, where it fits on the grid.
    const covered = chartRefsOn(model, toSheet).filter(
        ([t, l, b, r]) =>
            b - t <= bottom - top &&
            r - l <= right - left &&
            t + bottom - top < GRID_ROWS &&
            l + right - left < GRID_COLUMNS,
    );
    if (covered.length > 0 && random() < 0.2) {
        const [toRow, toColumn] = pick(random, covered);
        return { kind: 'move', sheet, from, toSheet, toRow, toColumn };
    }
    return {
        kind: 'move',
        sheet,
        from,
        toSheet,
        toRow: toward(top, Math.max(1, bottom - top), GRID_ROWS - 1 - (bottom - top)),
        toColumn: toward(left, Math.max(1, right - left), GRID_COLUMNS - 1 - (right - left)),
    };
}

// The rectangles the series of every chart of the book read on one sheet.
export function chartRefsOn(model: Model, sheet: string): Rect[] {
    const charts = [...model.sheets.values()].flatMap(({ records }) => [...records.chart.values()]);
    return charts.flatMap((chart) =>
        (chartData(chart)?.series ?? []).flatMap(({ values }): Rect[] =>
            values?.sheetId === sheet ? [[values.row[0], values.column[0], values.row[1], values.column[1]]] : [],
        ),
    );
}

// A sheet copied whole under a new id, as a writer copies one: its records take ids of their own, as an id names one
// record of its type in the whole book, and a filter's columns the new id of their filter.
export function copyOf(sheet: SheetContent, id: string): SheetContent {
    let made = 0;
    const fresh = () => `${id}.${made++}`;
    const { records } = sheet;
    const filters = new Map(Object.keys(records.filter ?? {}).map((old) => [old, fresh()]));
    const renamed = <R>(of: { [id: string]: R } | undefined, change: (record: R) => R = (record) => record) =>
        of && Object.fromEntries(Object.values(of).map((record) => [fresh(), change(record)]));
    return {
        ...sheet,
        id,
        records: {
            merge: renamed(records.merge),
            filter:
                records.filter &&
                Object.fromEntries(
                    Object.entries(records.filter).map(([old, filter]) => [filters.get(old) ?? old, filter]),
                ),
            filterColumn: renamed(records.filterColumn, (column) => ({
                ...column,
                filter: filters.get(column.filter) ?? column.filter,
            })),
            comment: renamed(records.comment),
            conditionalFormat: renamed(records.conditionalFormat),
            validation: renamed(records.validation),
            image: renamed(records.image),
            chart: renamed(records.chart),
        },
    };
}

// Formulas that read cells where blocks move from and land, on their own sheet and on another, so a move makes some
// follow it and some lossy.
export function randomLandingReaderOp(random: Random, model: Model): InputOp {
    const cells = Array.from({ length: 1 + below(random, 4) }, (_, at): Placed<CellContent | null> => {
        const row = 1 + below(random, 16);
        const column = 1 + below(random, 9);
        const read = `R${row}C${column}`;
        const f = pick(random, [
            `=${read}+1`,
            `=[${someSheet(random, model).id}]!${read}*2`,
            `=SUM(${read}:R${row + below(random, 4)}C${column + below(random, 3)})`,
            '=R[-1]C+R[1]C',
        ]);
        return [at * 5 + below(random, 5), 12 + below(random, 4), { f }];
    });
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return { kind: 'input', sheet: sheetId(random, model), cells };
}

// An add of a random sheet with something of every part, now and then under an id the book holds, with record ids a
// sheet of the book holds, a name in use in any letter case or at its 31 characters, the name a formula waits for, or
// hidden; or a delete of a sheet, shown or
// hidden, the last shown one, one that formulas read, or one the book does not hold.
export function randomSheetOp(random: Random, model: Model): SheetOp {
    if (random() < 0.4) return { kind: 'sheet', delete: sheetId(random, model) };
    const id = random() < 0.05 ? someSheet(random, model).id : `n${below(random, 1_000_000)}`;
    // A writer that copies a sheet mints new ids for its records; now and then one keeps the ids of a sheet the book
    // holds.
    const sheet = randomSheet(random, 0, random() < 0.1 ? someSheet(random, model).id : id);
    const held = someSheet(random, model).fields.name;
    const name = pick(random, [
        `New ${below(random, 6)}`,
        LATER,
        held,
        held.toUpperCase(),
        LONG_NAME,
        LONG_NAME.toUpperCase(),
    ]);
    const cells = [...sheet.cells];
    if (random() < 0.5) cells.push([71, 3, { f: typedWithName(random, model) }]);
    if (random() < 0.3) cells.push([72, 3, { v: 5, spill: 1 }]);
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const fields: SheetFields = { ...sheet.fields, name, order: pick(random, ORDERS) };
    if (random() < 0.2) fields.hide = 1;
    return { kind: 'sheet', add: { ...sheet, id, cells, fields } };
}
