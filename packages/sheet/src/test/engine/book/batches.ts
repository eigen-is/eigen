// Random books and random batches of ops for the laws of the workbook's appliers, seeded so a failing case runs
// again. A book comes with every formula still to be computed, so its values are the engine's own and stay the same
// when an edit computes them again. An op is drawn against the model of the book: it mostly names sheets, cells and
// records that are there, and now and then one that is not, a name in use, a merge over a merge or the last sheet.
// Every batch passes the validators.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
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
    Rect,
    Run,
    SheetFields,
    SheetOp,
    Span,
} from '@workspace/lib/sheets/ops';
import type { CellLink } from '@workspace/lib/sheets/types';
import type { Book, Random } from './book-fixtures';
import { below, FORMULAS, randomBook } from './book-fixtures';
import type { Model, ModelSheet } from './model';
import { chartOf, formulaRule, ref } from './records-fixtures';

// A formula typed with the name of a sheet that is not there: a rename or an add of a sheet to that name binds it. A
// book holds it, never an input: typed while a sheet has the name, the engine leaves it unbound (a todo of the laws).
export const LATER = 'Later';
const TYPED_WITH_NAME = "='Later'!R1C1+1";
const ORDERS = ['a0', 'a1', 'a2', 'a3', 'a1V'];
const LINK: CellLink = { type: 'webpage', address: 'https://eigen.is' };
const RICH: Run[] = [
    { v: 'bold ', bl: 1 },
    { v: 'and red', fc: '#ff0000', fs: 14 },
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
];
const LINE_PARTS: readonly LineAttrs[] = [{ size: 30 }, { size: 44.5, custom: 1 }, { hidden: 1 }, { custom: 1 }];

function pick<T>(random: Random, list: readonly T[]): T {
    return list[below(random, list.length)];
}

// A book whose formulas hold no value yet, with a formula typed with the name of a sheet that is not there.
export function randomBookContent(random: Random): Book {
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
            return { ...sheet, cells };
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

function someSheet(random: Random, model: Model): ModelSheet {
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

function content(random: Random): CellContent | null {
    return pick<() => CellContent | null>(random, [
        () => null,
        () => ({ v: below(random, 400) / 4 }),
        () => ({ v: pick(random, ['text', '', '=not a formula']) }),
        () => ({ v: random() < 0.5 }),
        () => ({ v: pick(random, ['#DIV/0!', '#N/A']), e: 1 }),
        () => ({ f: pick(random, FORMULAS) }),
        () => ({ f: pick(random, FORMULAS), link: LINK }),
        () => ({ s: RICH }),
        () => ({ v: 'x', link: LINK }),
        () => ({ v: 'typed', qp: 1 }),
        () => ({ link: LINK }),
    ])();
}

export function randomInputOp(random: Random, model: Model): InputOp {
    const places = new Set<number>();
    for (let i = 1 + below(random, 5); i > 0; i -= 1) places.add(below(random, 9) * GRID_ROWS + below(random, 16));
    const cells = [...places]
        .sort((a, b) => a - b)
        .map(
            (place): Placed<CellContent | null> => [place % GRID_ROWS, Math.floor(place / GRID_ROWS), content(random)],
        );
    const op: InputOp = { kind: 'input', sheet: sheetId(random, model), cells };
    // The rectangles of the runs stand in columns of their own, so they are disjoint.
    if (random() < 0.4) {
        op.runs = Array.from({ length: 1 + below(random, 2) }, (_, at) => {
            const [top, left, bottom, right] = smallRect(random, 14, 2);
            const filled = pick(random, [null, { v: 7 }, { f: pick(random, FORMULAS) }, { s: RICH }]);
            return [[top, 10 + at * 6 + left, bottom, 10 + at * 6 + right], filled] as const;
        });
        if (random() < 0.3) delete op.cells;
    }
    return op;
}

export function randomFormatOp(random: Random, model: Model): FormatOp {
    const sheet = sheetId(random, model);
    if (random() < 0.3) {
        const set = pick(random, [...LINE_PARTS, undefined]);
        const free = (['size', 'custom', 'hidden'] as const).filter((name) => set?.[name] === undefined);
        const clear = set === undefined ? [pick(random, free)] : free.filter(() => random() < 0.3);
        const spans = Array.from({ length: 1 + below(random, 2) }, (): Span => {
            const first = below(random, 16);
            return [first, first + below(random, 4)];
        });
        return { kind: 'format', sheet, lines: random() < 0.5 ? 'rows' : 'columns', spans, set, clear };
    }
    const column = below(random, 8);
    const row = below(random, 14);
    const whole: Rect = random() < 0.5 ? [0, column, GRID_ROWS - 1, column] : [row, 0, row, GRID_COLUMNS - 1];
    // A link is written cell by cell, so it goes over small rectangles only.
    const linked = random() < 0.15;
    const ranges = Array.from({ length: 1 + below(random, 2) }, () =>
        !linked && random() < 0.2 ? whole : smallRect(random),
    );
    const set: CellAttrs & { link?: CellLink } = { ...pick(random, LOOK_PARTS) };
    const clear: NonNullable<Extract<FormatOp, { ranges: unknown }>['clear']> = [];
    for (const name of Object.keys(pick(random, LOOK_PARTS))) {
        if (!(name in set) && (name === 'bl' || name === 'it' || name === 'fc' || name === 'bg' || name === 'fa')) {
            clear.push(name);
        }
    }
    if (linked && random() < 0.5) set.link = LINK;
    else if (linked) clear.push('link');
    return { kind: 'format', sheet, ranges, set, clear };
}

export function randomRecordOp(random: Random, model: Model): RecordOp {
    const held = someSheet(random, model);
    const sheet = random() < 0.04 ? 'nosheet' : held.id;
    // The id of a record of the type the sheet holds, or a new one.
    const idOf = (ids: Iterable<string>, fresh: string) => (random() < 0.7 ? pick(random, [...ids, fresh]) : fresh);
    const fresh = (prefix: string) => `${held.id}${prefix}${below(random, 5)}`;
    // Now and then a rectangle that reaches the grid's last row or column, which stays reaching it.
    const reaching = (): Rect => {
        const [top, left, bottom, right] = smallRect(random);
        if (random() < 0.8) return [top, left, bottom, right];
        return random() < 0.5 ? [top, left, GRID_ROWS - 1, right] : [top, left, bottom, GRID_COLUMNS - 1];
    };
    const range = () => {
        const [top, left, bottom, right] = reaching();
        return { row: [top, bottom], column: [left, right] };
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
            const id = idOf(records.merge.keys(), fresh('m'));
            const [top, left, bottom, right] = smallRect(random);
            const rect: Rect = [top, left, bottom, right + 1];
            if (mode === 0) return { kind: 'record', sheet, type: 'merge', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'merge', id, set: { rect } };
            return { kind: 'record', sheet, type: 'merge', id, set: { rect }, whole: 1 };
        }
        case 3: {
            const id = idOf(records.filter.keys(), fresh('f'));
            const rect = reaching();
            if (mode === 0) return { kind: 'record', sheet, type: 'filter', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'filter', id, set: { rect } };
            return { kind: 'record', sheet, type: 'filter', id, set: { rect }, whole: 1 };
        }
        case 4: {
            const id = idOf(records.filterColumn.keys(), fresh('k'));
            const filter = idOf(records.filter.keys(), 'nofilter');
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
            const id = idOf(records.comment.keys(), fresh('c'));
            const set = { row: below(random, 14), column: below(random, 8) };
            if (mode === 0) return { kind: 'record', sheet, type: 'comment', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'comment', id, set: { row: set.row } };
            return { kind: 'record', sheet, type: 'comment', id, set, whole: 1 };
        }
        case 6: {
            const id = idOf(records.conditionalFormat.keys(), fresh('r'));
            if (mode === 0) return { kind: 'record', sheet, type: 'conditionalFormat', id };
            const set = formulaRule([range(), range()], pick(random, ['=RC>1', '=R[1]C[1]="x"', '=[s0]!R1C1>0']));
            return { kind: 'record', sheet, type: 'conditionalFormat', id, set, whole: 1 };
        }
        case 7: {
            const id = idOf(records.validation.keys(), fresh('v'));
            const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
            if (mode === 0) return { kind: 'record', sheet, type: 'validation', id };
            if (mode === 1) {
                const set = random() < 0.5 ? { order: pick(random, ORDERS) } : { ranges: [range()] };
                return { kind: 'record', sheet, type: 'validation', id, set };
            }
            const set = { ranges: [range()], order: pick(random, ORDERS), rule };
            return { kind: 'record', sheet, type: 'validation', id, set, whole: 1 };
        }
        case 8: {
            const id = idOf(records.image.keys(), fresh('i'));
            const box = { index: pick(random, ORDERS), x: below(random, 90), y: 2, width: 30, height: 40 };
            if (mode === 0) return { kind: 'record', sheet, type: 'image', id };
            if (mode === 1) {
                const set = { x: below(random, 90), angle: random() < 0.5 ? 30 : null };
                return { kind: 'record', sheet, type: 'image', id, set };
            }
            return { kind: 'record', sheet, type: 'image', id, set: { ...box, mediaName: `${id}.png` }, whole: 1 };
        }
        default: {
            const id = idOf(records.chart.keys(), fresh('g'));
            if (mode === 0) return { kind: 'record', sheet, type: 'chart', id };
            if (mode === 1) return { kind: 'record', sheet, type: 'chart', id, set: { x: below(random, 90) } };
            const values = ref(held.id, [below(random, 5), 6 + below(random, 5)], [0, 0]);
            const set = chartOf({ categories: null, series: [{ id: 's', name: 'n', values }] });
            return { kind: 'record', sheet, type: 'chart', id, set, whole: 1 };
        }
    }
}

export function randomLinesOp(random: Random, model: Model): LinesOp {
    const rows = random() < 0.6;
    const insert = random() < 0.5;
    const index = below(random, rows ? 20 : 9);
    const op: LinesOp = {
        kind: 'lines',
        sheet: sheetId(random, model),
        rows,
        insert,
        index,
        count: 1 + below(random, 3),
    };
    if (insert && random() < 0.7) op.like = index > 0 && random() < 0.6 ? index - 1 : index;
    return op;
}

export function randomMoveOp(random: Random, model: Model): MoveOp {
    const sheet = sheetId(random, model);
    return {
        kind: 'move',
        sheet,
        from: smallRect(random),
        toSheet: random() < 0.7 ? sheet : sheetId(random, model),
        toRow: below(random, 16),
        toColumn: below(random, 9),
    };
}

// An add of a random sheet under a new id, now and then with a name in use or the name a formula waits for, or a
// delete of a sheet.
export function randomSheetOp(random: Random, model: Model): SheetOp {
    if (random() < 0.4) return { kind: 'sheet', delete: sheetId(random, model) };
    const [sheet] = randomBookContent(random).sheets;
    const name = pick(random, [`New ${below(random, 6)}`, LATER, someSheet(random, model).fields.name]);
    const id = random() < 0.05 ? someSheet(random, model).id : `n${below(random, 1_000_000)}`;
    return { kind: 'sheet', add: { ...sheet, id, fields: { ...sheet.fields, name, order: pick(random, ORDERS) } } };
}
