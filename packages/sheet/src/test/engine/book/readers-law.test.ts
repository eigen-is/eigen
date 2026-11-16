import { describe, expect, test } from 'bun:test';
import { GRID_ROWS } from '@workspace/formula/text';
import { encodeBook } from '@workspace/lib/sheets/book-codec';
import type { Batch, CellContent, CellRecord, Op, Placed, Rect } from '@workspace/lib/sheets/ops';
import type { RefusalKey } from '@workspace/lib/sheets/refusal';
import { Refusal } from '@workspace/lib/sheets/refusal';
import { applyOps } from '../../../engine/book/apply-ops';
import { Workbook } from '../../../engine/book/workbook';
import {
    batchOf,
    LATER,
    randomAnyOp,
    randomBookContent,
    randomInputOp,
    randomLinesOp,
    randomMoveOp,
    someSheet,
} from './batches';
import type { Book, Random } from './book-fixtures';
import { below, randomOf } from './book-fixtures';
import { bytes, decoded, fold } from './bytes';
import type { Model } from './model';
import { modelOf } from './model';

// The shapes a computed load must meet before its first pass, on every sheet of the start: a formula that holds
// #REF! until its switch turns, one that reads it, one that always holds #REF!, a loop and a reader of it, the clock
// and a draw, and a formula that waits for a sheet named `LATER`. The switch is R21C5.
const TRAP: readonly Placed<CellRecord>[] = [
    [20, 2, { f: '=IF(R21C5,5,#REF!)' }],
    [21, 2, { f: '=IFERROR(R[-1]C,7)' }],
    [22, 2, { f: '=#REF!+R21C5' }],
    [23, 2, { f: '=R[1]C+R21C5' }],
    [24, 2, { f: '=R[-1]C' }],
    [25, 2, { f: '=IFERROR(R[-2]C,R[-1]C)' }],
    [26, 2, { f: '=NOW()+R21C5' }],
    [27, 2, { f: '=RAND()' }],
    [28, 2, { f: "=IFERROR('Later'!R1C1,R21C5)" }],
    [20, 4, { v: false }],
];
const TRAP_BLOCK: Rect = [20, 2, 28, 4];
const SWITCH = /^=IF\(R(\d+)C(\d+),5,#REF!\)$/;
const LOOP = /^=R\[1\]C\+R\d+C\d+$/;
const CAPS = [1, 2, 5, Number.MAX_SAFE_INTEGER];
const SEEDS = Number(process.env['READERS_LAW_SEEDS'] ?? 200);
const LAW_7_SEEDS = Number(process.env['READERS_LAW_SEEDS'] ?? 100);
// Four cells on the grid's last row hold more slots than the limit, as each column then holds every row.
const PAST_SLOTS: Op = {
    kind: 'input',
    sheet: 's0',
    cells: [1, 2, 3, 4].map((column) => [GRID_ROWS - 1, column, { v: 1 }] as const),
};

type Landed = { refused: RefusalKey; inverse?: undefined } | { refused?: undefined; inverse: Op[] };

// A batch as a host lands it: its ops, then its clock, which a refused batch never reaches.
function land(book: Workbook, { ops, now, seed }: Batch): Landed {
    try {
        const inverse = applyOps(book, ops);
        book.setClock(now, seed);
        return { inverse };
    } catch (error) {
        if (error instanceof Refusal) return { refused: error.key };
        throw error;
    }
}

function pick<T>(random: Random, list: readonly T[]): T {
    return list[below(random, list.length)];
}

// A random book with the trap on every sheet, to be computed whole, and half the time its computed fold.
function startOf(random: Random): Book {
    const base = randomBookContent(random);
    const sheets = base.sheets.map((sheet) => ({
        ...sheet,
        cells: [...sheet.cells, ...TRAP].sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    }));
    const start = { ...base, computed: false, sheets };
    return random() < 0.5 ? decoded(fold(encodeBook(start), [])) : start;
}

// Where the traps of a sheet stand now: each switch formula with the cell it reads, each loop's first cell.
function trapsOf(model: Model, sheet: string): { switches: [number, number][]; loops: [number, number][] } {
    const switches: [number, number][] = [];
    const loops: [number, number][] = [];
    for (const [place, { f }] of model.sheets.get(sheet)?.cells ?? []) {
        const [row, column] = place.split(',').map(Number);
        const read = SWITCH.exec(f ?? '');
        if (read) switches.push([Number(read[1]) - 1, Number(read[2]) - 1]);
        if (LOOP.test(f ?? '')) loops.push([row, column]);
    }
    return { switches, loops };
}

// The ops of a batch that lands on a load before its first pass: the switch turned first, then writes into the loop,
// a rename to the name a formula waits for, line edits and moves through the trap and anywhere, and other writes.
function afterLoadBatch(random: Random, model: Model, tags: Map<Op, string>): Batch {
    const tagged = (tag: string, op: Op) => {
        tags.set(op, tag);
        return op;
    };
    const switchOp = (): Op => {
        const { id } = someSheet(random, model);
        const { switches } = trapsOf(model, id);
        if (switches.length === 0) return randomInputOp(random, model);
        const [row, column] = pick(random, switches);
        const content = pick<CellContent | null>(random, [
            { v: true },
            { v: false },
            { v: 3 },
            null,
            { f: '=RAND()>0.5' },
        ]);
        return tagged('switch', { kind: 'input', sheet: id, cells: [[row, column, content]] });
    };
    const loopOp = (): Op => {
        const { id } = someSheet(random, model);
        const { loops } = trapsOf(model, id);
        if (loops.length === 0) return randomInputOp(random, model);
        const [row, column] = pick(random, loops);
        const content = pick<CellContent>(random, [{ v: 1 }, { f: '=R[-1]C' }, { f: '=R[-1]C*2' }]);
        return tagged('loop', { kind: 'input', sheet: id, cells: [[row + 1, column, content]] });
    };
    const chooser: (() => Op)[] = [
        switchOp,
        loopOp,
        () => {
            const { id } = someSheet(random, model);
            const name = random() < 0.6 ? LATER : `Tab ${below(random, 6)}`;
            return tagged('rename', { kind: 'record', sheet: id, type: 'sheet', id, set: { name } });
        },
        () => tagged('lines', randomLinesOp(random, model)),
        () => {
            const { id } = someSheet(random, model);
            const insert = random() < 0.5;
            const index = 18 + below(random, 10);
            return tagged('lines', {
                kind: 'lines',
                sheet: id,
                rows: random() < 0.7,
                insert,
                index,
                count: 1 + below(random, 2),
            });
        },
        () => tagged('move', randomMoveOp(random, model)),
        () => {
            const { id } = someSheet(random, model);
            const toSheet = random() < 0.7 ? id : someSheet(random, model).id;
            const from: Rect = random() < 0.5 ? TRAP_BLOCK : [20, 4, 20, 4];
            const toRow = 15 + below(random, 20);
            return tagged('move', { kind: 'move', sheet: id, from, toSheet, toRow, toColumn: below(random, 6) });
        },
        () => randomInputOp(random, model),
    ];
    const batch = batchOf(random, model, () => pick(random, chooser)(), 5);
    return { ...batch, ops: [switchOp(), ...batch.ops] };
}

// Cells of a sheet add an inverse carries hold the values of the reader's last pass: a reader that has not run one
// carries older ones, which the add computes again.
function withoutValues(inverse: readonly Op[]): Op[] {
    return inverse.map((op): Op => {
        if (op.kind !== 'sheet' || !('add' in op)) return op;
        const cells = op.add.cells.map(([row, column, cell]): Placed<CellRecord> => {
            if (cell.f === undefined) return [row, column, cell];
            const { v: _, e: __, ...rest } = cell;
            return [row, column, rest];
        });
        return { ...op, add: { ...op.add, cells } };
    });
}

// Now and then a batch that ends past the limit on cells, which only the weigh after its last op refuses.
function pastNowAndThen(random: Random, batch: Batch): Batch {
    return random() < 0.03 ? { ...batch, ops: [...batch.ops, PAST_SLOTS] } : batch;
}

function count(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

describe('engine/book — LAW 5: a fold then a join equals a replay', () => {
    test(
        'from one snapshot and one log, a reader that loads a fold and replays the rest reads as one that replays all',
        () => {
            const counts = new Map<string, number>();
            for (let seed = 1; seed <= SEEDS; seed += 1) {
                const random = randomOf(seed);
                const start = startOf(random);
                count(counts, start.computed ? 'start computed' : 'start not computed');
                const length = 6;
                // The batches a fold takes in: the first at `folds[0]`, and now and then a second fold later.
                const folds = [below(random, length)];
                if (folds[0] < length - 1 && random() < 0.4)
                    folds.push(folds[0] + 1 + below(random, length - 1 - folds[0]));
                let snapshot = encodeBook(start);
                let since = 0;
                const replay = new Workbook(start);
                let loaded: Workbook | undefined;
                let lazy: Workbook | undefined;
                const log: Batch[] = [];
                for (let at = 0; at < length; at += 1) {
                    const model = modelOf(replay.content());
                    const tags = new Map<Op, string>();
                    if (folds.includes(at)) {
                        const cap = pick(random, CAPS);
                        const stops = { n: 0 };
                        snapshot = fold(snapshot, log.slice(since), cap, stops);
                        since = at;
                        const content = decoded(snapshot);
                        expect(content.computed).toBe(true);
                        if (stops.n > 0) count(counts, 'capped fold');
                        const cells = content.sheets.flatMap((sheet) => sheet.cells.map(([, , cell]) => cell));
                        if (cells.some(({ f, v, e }) => f !== undefined && e === 1 && v === '#REF!'))
                            count(counts, 'fold holds #REF!');
                        if (cells.some(({ f }) => f === '=NOW()+R21C5' || f === '=RAND()'))
                            count(counts, 'fold holds clock');
                        loaded = new Workbook(content);
                        lazy ??= new Workbook(content);
                    }
                    const batch = folds.includes(at)
                        ? afterLoadBatch(random, model, tags)
                        : batchOf(random, model, randomAnyOp, 6);
                    log.push(batch);
                    const expected = land(replay, batch);
                    // The replaying reader runs its pass after every batch, as a tab does.
                    const replayed = bytes(replay);
                    if (lazy) {
                        const got = land(lazy, batch);
                        expect(got.refused).toBe(expected.refused);
                        if (got.inverse && expected.inverse) {
                            expect(withoutValues(got.inverse)).toEqual(withoutValues(expected.inverse));
                        }
                    }
                    if (!loaded) continue;
                    const got = land(loaded, batch);
                    expect(got.refused).toBe(expected.refused);
                    expect(got.inverse).toEqual(expected.inverse);
                    expect(bytes(loaded)).toBe(replayed);
                    if (expected.refused) count(counts, `refused ${expected.refused}`);
                    if (expected.inverse) for (const op of batch.ops) count(counts, `checked ${op.kind}`);
                    if (!folds.includes(at)) continue;
                    // The batch that met the load before its first pass.
                    count(counts, expected.refused ? 'after load refused' : 'after load landed');
                    if (expected.refused) continue;
                    for (const op of batch.ops) count(counts, `after load ${op.kind}`);
                    for (const tag of new Set(batch.ops.map((op) => tags.get(op))))
                        if (tag) count(counts, `after load ${tag}`);
                }
                if (lazy) expect(bytes(lazy)).toBe(bytes(replay));
            }
            const floors: [string, number][] = [
                ['start computed', SEEDS / 3],
                ['start not computed', SEEDS / 3],
                ['capped fold', SEEDS / 4],
                ['fold holds #REF!', SEEDS * 0.8],
                ['fold holds clock', SEEDS * 0.8],
                ['after load landed', SEEDS / 2],
                ['after load refused', 5],
                ['after load switch', SEEDS / 2],
                ['after load loop', SEEDS / 10],
                ['after load rename', SEEDS / 10],
                ['after load lines', SEEDS / 10],
                ['after load move', SEEDS / 10],
                ['after load input', SEEDS / 2],
                ['after load record', SEEDS / 10],
                ...['input', 'format', 'record', 'lines', 'move', 'sheet'].map((kind): [string, number] => [
                    `checked ${kind}`,
                    SEEDS / 2,
                ]),
                ...['grid-end', 'merge-overlap', 'merge-cut', 'last-sheet'].map((key): [string, number] => [
                    `refused ${key}`,
                    1,
                ]),
            ];
            const short = floors.filter(([key, floor]) => (counts.get(key) ?? 0) < floor);
            expect(short.map(([key, floor]) => `${key}: ${counts.get(key) ?? 0} < ${floor}`)).toEqual([]);
            if (process.env['READERS_LAW_SEEDS']) console.log(Object.fromEntries([...counts].sort()));
        },
        SEEDS * 400,
    );
});

describe('engine/book — LAW 7: every reader refuses alike', () => {
    test(
        'a replaying reader, one that loads a fold, and one that lands and takes back batches of its own refuse alike',
        () => {
            const counts = new Map<string, number>();
            for (let seed = 1; seed <= LAW_7_SEEDS; seed += 1) {
                const random = randomOf(100_000 + seed);
                const start = startOf(random);
                const length = 6;
                const folded = 1 + below(random, length - 1);
                const replay = new Workbook(start);
                const taking = new Workbook(start);
                let loaded: Workbook | undefined;
                const log: Batch[] = [];
                const refusals: Record<'replay' | 'loaded' | 'taking', (RefusalKey | undefined)[]> = {
                    replay: [],
                    loaded: [],
                    taking: [],
                };
                for (let at = 0; at < length; at += 1) {
                    if (at === folded) loaded = new Workbook(decoded(fold(encodeBook(start), log, pick(random, CAPS))));
                    // Batches of its own, landed and taken back newest first with the clock they found.
                    const { now, seed: drawn } = taking.content();
                    const own: Op[][] = [];
                    for (let extra = below(random, 3); extra > 0; extra -= 1) {
                        const landed = land(
                            taking,
                            pastNowAndThen(random, batchOf(random, modelOf(taking.content()), randomAnyOp, 4)),
                        );
                        count(counts, landed.refused ? 'own refused' : 'own landed');
                        if (landed.inverse) own.push(landed.inverse);
                    }
                    for (const inverse of own.reverse()) {
                        expect(land(taking, { g: start.g, now, seed: drawn, ops: inverse }).refused).toBeUndefined();
                        count(counts, 'own taken back');
                    }
                    const batch = pastNowAndThen(random, batchOf(random, modelOf(replay.content()), randomAnyOp, 6));
                    log.push(batch);
                    refusals.replay.push(land(replay, batch).refused);
                    refusals.taking.push(land(taking, batch).refused);
                    if (loaded) refusals.loaded.push(land(loaded, batch).refused);
                    if (random() < 0.5) bytes(replay);
                }
                expect(refusals.taking).toEqual(refusals.replay);
                expect(refusals.loaded).toEqual(refusals.replay.slice(folded));
                const replayed = bytes(replay);
                expect(bytes(taking)).toBe(replayed);
                expect(loaded && bytes(loaded)).toBe(replayed);
                for (const key of refusals.replay) count(counts, key ? `refused ${key}` : 'landed');
            }
            const floors: [string, number][] = [
                ['own landed', LAW_7_SEEDS * 2],
                ['own refused', LAW_7_SEEDS / 10],
                ['own taken back', LAW_7_SEEDS * 2],
                ['landed', LAW_7_SEEDS * 4],
                ...['grid-end', 'merge-cut', 'last-sheet', 'too-many-cells'].map((key): [string, number] => [
                    `refused ${key}`,
                    1,
                ]),
            ];
            const short = floors.filter(([key, floor]) => (counts.get(key) ?? 0) < floor);
            expect(short.map(([key, floor]) => `${key}: ${counts.get(key) ?? 0} < ${floor}`)).toEqual([]);
            if (process.env['READERS_LAW_SEEDS']) console.log(Object.fromEntries([...counts].sort()));
        },
        LAW_7_SEEDS * 600,
    );
});

describe('engine/book — a kept formula typed with no value', () => {
    // It holds #REF! from the write, so its inverse carries that #REF! as given whether a pass ran or not.
    test('is taken back alike before a pass and after one', () => {
        const inverses = [false, true].map((pass) => {
            const sheet = {
                id: 'a',
                fields: { name: 'a', order: 'a0' },
                cells: [],
                looks: [],
                bands: [],
                rows: [],
                columns: [],
                records: {},
            };
            const book = new Workbook({ g: 1, now: 1, seed: 1, computed: false, sheets: [sheet] });
            applyOps(book, [{ kind: 'input', sheet: 'a', cells: [[0, 0, { f: "='[b.xlsx]S'!R1C1" }]] }]);
            if (pass) bytes(book);
            return applyOps(book, [{ kind: 'input', sheet: 'a', cells: [[0, 0, { v: 1 }]] }]);
        });
        expect(inverses[1]).toEqual(inverses[0]);
        expect(inverses[0]).toEqual([
            { kind: 'input', sheet: 'a', cells: [[0, 0, { v: '#REF!', e: 1, f: "='[b.xlsx]S'!R1C1" }]] },
        ]);
    });
});
