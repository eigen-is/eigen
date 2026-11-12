// The engine's timing rows on the runtime that runs this script: full recalcs of five real workbooks, per-call rows,
// structural edits and collector rows, with the design's gates beside the rows that have one. Each row and round is
// a fresh process of the same runtime, which builds a fresh engine per run and reports its fastest; the table
// gives the minimum and median of the rounds. The workbooks are local xlsx files, not in the repo: without them
// their rows are skipped and the synthetic rows still run. A run with --help prints its usage.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { CellSink, LineEdit, SheetSource } from '../src/index';
import { Engine } from '../src/index';
import { sheetFinder, storedText } from '../src/text';
import type { Book, BookCell } from './xlsx';
import { readBook, sourcesOf } from './xlsx';

const USAGE = `bun packages/formula/scripts/bench.ts [options]
node: bun build --target node packages/formula/scripts/bench.ts --outfile /tmp/bench.mjs, then node /tmp/bench.mjs [options]
  --corpus <dir>      the xlsx corpus, holding rts, nfl, apportion and minibus under their corpus paths
  --reference <file>  the owner's reference workbook (test.xlsx)
  --rounds <n>        rounds per row, each a fresh process (default 7)
  --filter <regex>    only the rows whose name matches
  --list              the rows, without running them`;

const WORKBOOKS = new Map([
    [
        'rts',
        'govuk-stats/https_____assets.publishing.service.gov.uk__media__5f607f4b8fa8f51061921f0b__2020_Q2_RTS_Exports_Proportion_Interactive_Spreadsheet.xlsm',
    ],
    [
        'nfl',
        'zenodo-open/https_____zenodo.org__api__records__3569849__files__NFL_20Offensive_20Player_20stats_2C_201999-2013.xlsx__content',
    ],
    [
        'apportion',
        'govuk-stats/https_____assets.publishing.service.gov.uk__media__6ab0e966ce3f006bd4346d39__Apportion_and_allocation_26_finals_EQ_+_AQ_4.xlsm',
    ],
    [
        'minibus',
        'govuk-stats/https_____assets.publishing.service.gov.uk__media__69fc69168cc72d2f863ea5a8__dft-greener-minibus-tool.xlsm',
    ],
]);

type Measured = { readonly ms: number; readonly check: string };
type Row = {
    readonly group: string;
    readonly name: string;
    // The design's gate in ms, held by the fastest round.
    readonly gate?: number;
    readonly book?: string;
    readonly reps: number;
    readonly run: (reps: number) => Measured;
};

const { values: options } = parseArgs({
    options: {
        corpus: { type: 'string' },
        reference: { type: 'string' },
        rounds: { type: 'string', default: '7' },
        filter: { type: 'string', default: '' },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        row: { type: 'string' },
        reps: { type: 'string', default: '3' },
    },
});

const INF = Number.POSITIVE_INFINITY;
const ONE_SHEET = [{ id: 's1', name: 'Sheet1' }];
const TWO_SHEETS = [
    { id: 's', name: 'S' },
    { id: 't', name: 'T' },
];

function bookPath(name: string): string | undefined {
    const file =
        name === 'reference'
            ? options.reference
            : options.corpus && path.join(options.corpus, WORKBOOKS.get(name) ?? '');
    return file !== undefined && fs.existsSync(file) ? file : undefined;
}

function loadBook(name: string): Book {
    const file = bookPath(name);
    if (file === undefined) throw new Error(`No workbook ${name}`);
    return readBook(file);
}

// The fastest full recalc of a never-computed engine over `reps` fresh engines. The check says what the formulas
// of the last one computed, so two runs that should agree can be told apart.
function recalcOf(sheets: readonly SheetSource[], reps: number): Measured {
    let best = INF;
    let sum = 0;
    let texts = 0;
    let errors = 0;
    let formulas = 0;
    for (let rep = 0; rep < reps; rep += 1) {
        const engine = new Engine(sheets);
        const start = performance.now();
        engine.recalc(INF);
        best = Math.min(best, performance.now() - start);
        if (rep < reps - 1) continue;
        for (const sheet of sheets) {
            sheet.cells((row, column, _value, formula) => {
                if (formula === null) return;
                formulas += 1;
                const value = engine.valueOf(sheet.id, row, column);
                if (typeof value === 'number') sum += Number.isFinite(value) ? value % 1e9 : 1;
                else if (typeof value === 'string') texts += value.length;
                else if (value !== null && typeof value === 'object') errors += 1;
            });
        }
    }
    return { ms: best, check: `${formulas} formulas, sum ${sum.toPrecision(10)}, texts ${texts}, errors ${errors}` };
}

// The fastest edit plus the recalc after it, each on a fresh engine that `setup` made and computed.
function editOf(reps: number, setup: () => Engine, edit: (engine: Engine) => string): Measured {
    let best = INF;
    let check = '';
    for (let rep = 0; rep < reps; rep += 1) {
        const engine = setup();
        engine.recalc(INF);
        const start = performance.now();
        const note = edit(engine);
        const edited = performance.now();
        engine.recalc(INF);
        const end = performance.now();
        if (end - start < best) {
            best = end - start;
            check = `${note}; edit ${(edited - start).toFixed(2)} + recalc ${(end - edited).toFixed(2)}`;
        }
    }
    return { ms: best, check };
}

function pendingIn(engine: Engine, sheet: string, column: number, count: number): number {
    let waiting = 0;
    for (let row = 0; row < count; row += 1) if (engine.isPending(sheet, row, column)) waiting += 1;
    return waiting;
}

function sheetOf(id: string, cells: (sink: CellSink) => void): SheetSource {
    return { id, name: id, cells };
}

const LINE_EDITS = {
    'row-insert-top': (sheet) => ({ insert: true, index: 2, count: 1, sheet, rows: true }),
    'row-delete-top': (sheet) => ({ insert: false, index: 2, count: 1, sheet, rows: true }),
    'column-insert-D': (sheet) => ({ insert: true, index: 3, count: 1, sheet, rows: false }),
    'column-delete-D': (sheet) => ({ insert: false, index: 3, count: 1, sheet, rows: false }),
    'column-delete-A': (sheet) => ({ insert: false, index: 0, count: 1, sheet, rows: false }),
} satisfies Record<string, (sheet: string) => LineEdit>;

// One sheet of a workbook edited: by name, or the one with the most formulas. The engine starts with its index
// built by a far write, as in a workbook in use; with `stale`, an insert makes the timed edit rebuild it too.
function bookEdit(
    book: string,
    kind: keyof typeof LINE_EDITS | 'remove-sheet' | 'move-block',
    stale: boolean,
    sheetName?: string,
) {
    return (reps: number): Measured => {
        const loaded = loadBook(book);
        const formulasIn = (cells: readonly BookCell[]) => cells.filter((cell) => cell.formula).length;
        const target =
            sheetName === undefined
                ? [...loaded.sheets].sort((a, b) => formulasIn(b.cells) - formulasIn(a.cells))[0]
                : loaded.sheets.find((sheet) => sheet.name === sheetName);
        if (target === undefined) throw new Error(`No sheet ${sheetName}`);
        const sheet = target.id;
        const lastRow = target.cells.reduce((last, cell) => Math.max(last, cell.row), 0);
        const sources = sourcesOf(loaded, false);
        const result = editOf(
            reps,
            () => {
                const engine = new Engine(sources);
                engine.recalc(INF);
                engine.setValue(loaded.sheets[0].id, 1048000, 16000, 1);
                engine.recalc(INF);
                if (stale) engine.editLines({ insert: true, index: 5, count: 1, sheet, rows: true });
                return engine;
            },
            (engine) => {
                if (kind === 'remove-sheet') {
                    engine.removeSheet(sheet);
                    return '0 rewrites';
                }
                const done =
                    kind === 'move-block'
                        ? engine.moveCells({
                              fromSheet: sheet,
                              row: 1,
                              column: 0,
                              rows: 5,
                              columns: 2,
                              toSheet: sheet,
                              toRow: lastRow + 5,
                              toColumn: 0,
                          })
                        : engine.editLines(LINE_EDITS[kind](sheet));
                return `${done.rewrites.length} rewrites`;
            },
        );
        return { ms: result.ms, check: `${target.name}, ${result.check}` };
    };
}

// One formula per row in column H, down 100,000 rows of numbers.
function perCall(formula: string) {
    return (reps: number): Measured => {
        const text = storedText(`=${formula}`, 0, 7, sheetFinder(ONE_SHEET));
        const sheet = sheetOf('s1', (sink) => {
            for (let r = 0; r < 100_000; r += 1) {
                sink(r, 0, (r % 100) + 1, null);
                sink(r, 1, r % 7 === 0 ? 0 : (r % 7) + 0.125, null);
                sink(r, 2, r * 0.5, null);
                sink(r, 3, 3.25, null);
                sink(r, 4, (r % 13) - 6, null);
                if (r < 100) {
                    sink(r, 5, r + 1, null);
                    sink(r, 6, (r + 1) * 10, null);
                }
                sink(r, 7, null, text);
            }
        });
        return recalcOf([sheet], reps);
    };
}

// `count` formulas in column H beside `rows` rows of numbers and text keys.
function aggregates(rows: number, count: number, formula: (i: number) => string) {
    return (reps: number): Measured => {
        const find = sheetFinder(ONE_SHEET);
        const sheet = sheetOf('s1', (sink) => {
            for (let r = 0; r < rows; r += 1) {
                sink(r, 0, r * 1.5 + 0.25, null);
                sink(r, 1, (r % 97) + 0.5, null);
                sink(r, 2, r % 10, null);
                sink(r, 3, `k${r % 7}`, null);
                sink(r, 4, r + 1, null);
                sink(r, 5, `v${r}`, null);
                sink(r, 6, 1 + (r % 5) / 1000, null);
            }
            for (let i = 0; i < count; i += 1) sink(i, 7, null, storedText(formula(i), i, 7, find));
        });
        return recalcOf([sheet], reps);
    };
}

// `count` formulas beside columns of the given lengths, for the SUMPRODUCT and collector rows.
function products(lengths: readonly number[], count: number, formula: string) {
    return (reps: number): Measured => {
        const at = lengths.length >= 2000 ? 3000 : 300;
        const text = storedText(formula, 0, at, sheetFinder(TWO_SHEETS));
        const sheet = sheetOf('s', (sink) => {
            for (const [k, length] of lengths.entries()) {
                for (let r = 0; r < length; r += 1) sink(r, k, ((r * 31 + k * 17) % 97) + 1.25, null);
            }
            for (let r = 0; r < count; r += 1) sink(r, at, null, text);
        });
        return recalcOf([sheet], reps);
    };
}

// One formula over whole columns of a sheet whose few cells sit far apart.
function far(formula: string, cells: (sink: CellSink) => void) {
    return (reps: number): Measured => {
        const text = storedText(formula, 0, 9, sheetFinder(TWO_SHEETS));
        return recalcOf(
            [
                { id: 's', name: 'S', cells: (sink) => sink(0, 9, null, text) },
                { id: 't', name: 'T', cells },
            ],
            reps,
        );
    };
}

// 4,000 readers of a 50,000-row column on another sheet, and one line edit inside it.
function readers(formula: string, insert: boolean) {
    return (reps: number): Measured =>
        editOf(
            reps,
            () => {
                const engine = new Engine([
                    sheetOf('d', (sink) => {
                        for (let r = 0; r < 50_000; r += 1) sink(r, 0, r % 97, null);
                    }),
                    sheetOf('a', (sink) => {
                        for (let r = 0; r < 4000; r += 1) sink(r, 0, r, null);
                    }),
                ]);
                engine.fillFormula('a', 0, 2, 3999, 2, formula);
                return engine;
            },
            (engine) => {
                engine.editLines({ insert, index: 100, count: 1, sheet: 'd', rows: true });
                return `${pendingIn(engine, 'a', 2, 4000)} of 4000 to compute`;
            },
        );
}

function ownShapes(engine: Engine): Engine {
    engine.setValue('a', 0, 0, 1);
    for (let r = 0; r < 10_000; r += 1) engine.setFormula('a', r + 1, 1, `=R1C1+${r}`);
    return engine;
}

const EMPTY = () => {};

const ROWS: Row[] = [
    ...(
        [
            ['reference', 60],
            ['rts', 100],
            ['nfl', 500],
            ['apportion', 250],
            ['minibus', 100],
        ] as const
    ).map(([name, gate]) => ({
        group: 'full recalc',
        name,
        gate,
        book: name,
        reps: 3,
        run: (reps: number) => recalcOf(sourcesOf(loadBook(name), true), reps),
    })),
    ...[
        ['IF', 'IF(A1>0,B1,C1)'],
        ['ROUND', 'ROUND(A1,2)'],
        ['IFERROR', 'IFERROR(A1/B1,0)'],
        ['&', 'A1&B1'],
        ['SUM(A1:E1) (5 cells)', 'SUM(A1:E1)'],
        ['SUM($A$1:$A$14)', 'SUM($A$1:$A$14)'],
        ['VLOOKUP', 'VLOOKUP(A1,$F$1:$G$100,2,0)'],
        ['INDEX', 'INDEX($F$1:$G$100,A1,2)'],
        ['SUMIF', 'SUMIF($F$1:$F$100,A1,$G$1:$G$100)'],
    ].map(([name, formula]) => ({ group: 'per-call rows', name, reps: 3, run: perCall(formula) })),
    ...(
        [
            [
                'SUMIFS x3 (5000)',
                1000,
                5000,
                (i: number) => `=SUMIFS(A1:A1000,C1:C1000,${i % 10},D1:D1000,"k${i % 7}",B1:B1000,">20")`,
            ],
            ['SUBTOTAL (5000)', 1000, 5000, () => '=SUBTOTAL(9,A1:A1000)'],
            ['PRODUCT (5000)', 1000, 5000, () => '=PRODUCT(G1:G1000)'],
            ['SUMPRODUCT(A*1,B) lifted (200)', 10_000, 200, () => '=SUMPRODUCT(A1:A10000*1,B1:B10000)'],
            ['SUM(A:A*B:B) lifted (200)', 10_000, 200, () => '=SUM(A:A*B:B)'],
            ['SUM(ABS(A1:A10000)) lifted (200)', 10_000, 200, () => '=SUM(ABS(A1:A10000))'],
        ] as const
    ).map(([name, rows, count, formula]) => ({
        group: 'per-call rows',
        name,
        reps: 3,
        run: aggregates(rows, count, formula),
    })),
    ...(
        [
            ['reference MASTER DATA row insert (index stale)', 'reference', 'row-insert-top', true, 'MASTER DATA', 8],
            ['reference MASTER DATA row insert (index fresh)', 'reference', 'row-insert-top', false, 'MASTER DATA'],
            ['reference MASTER DATA row delete', 'reference', 'row-delete-top', false, 'MASTER DATA'],
            ['reference MASTER DATA column delete (index stale)', 'reference', 'column-delete-D', true, 'MASTER DATA'],
            ['reference MASTER DATA column delete (index fresh)', 'reference', 'column-delete-D', false, 'MASTER DATA'],
            ['reference MASTER DATA column insert', 'reference', 'column-insert-D', false, 'MASTER DATA'],
            ['reference remove sheet MASTER DATA', 'reference', 'remove-sheet', false, 'MASTER DATA'],
            ['reference remove sheet Incurred', 'reference', 'remove-sheet', false, 'Incurred'],
            ['reference MASTER DATA move block', 'reference', 'move-block', false, 'MASTER DATA'],
            ['apportion worst edit (column delete, stale)', 'apportion', 'column-delete-D', true, undefined, 250],
            ['nfl worst edit (column delete, stale)', 'nfl', 'column-delete-A', true, undefined, 150],
            ['rts worst edit (column delete, stale)', 'rts', 'column-delete-D', true, undefined, 5],
            ['rts row insert (stale)', 'rts', 'row-insert-top', true, undefined, 5],
        ] as const
    ).map(([name, book, kind, stale, sheet, gate]) => ({
        group: 'structural edits',
        name,
        gate,
        book,
        reps: 5,
        run: bookEdit(book, kind, stale, sheet),
    })),
    {
        group: 'structural edits',
        name: 'one cell read by 100,000 formulas, moved',
        reps: 5,
        run: (reps) =>
            editOf(
                reps,
                () => {
                    const engine = new Engine([sheetOf('a', EMPTY), sheetOf('b', EMPTY)]);
                    engine.setValue('a', 0, 0, 2);
                    engine.fillFormula('a', 0, 2, 99_999, 2, '=R1C1+RC[-1]');
                    return engine;
                },
                (engine) => {
                    const move = {
                        fromSheet: 'a',
                        row: 0,
                        column: 0,
                        rows: 1,
                        columns: 1,
                        toSheet: 'a',
                        toRow: 5,
                        toColumn: 6,
                    };
                    const { rewrites } = engine.moveCells(move);
                    return `${rewrites.length} classes rewritten, ${pendingIn(engine, 'a', 2, 100_000)} pending`;
                },
            ),
    },
    {
        group: 'structural edits',
        name: '1,000,000-row pair, one row insert',
        reps: 5,
        run: (reps) =>
            editOf(
                reps,
                () => {
                    const engine = new Engine([
                        sheetOf('a', (sink) => {
                            for (let r = 0; r < 1_000_000; r += 1) sink(r, 0, r, null);
                        }),
                    ]);
                    engine.fillFormula('a', 0, 1, 999_999, 1, '=RC[-1]*2');
                    return engine;
                },
                (engine) => {
                    const { rewrites } = engine.editLines({ insert: true, index: 1, count: 1, sheet: 'a', rows: true });
                    return `${rewrites.length} rewrites, ${pendingIn(engine, 'a', 1, 1_000_000)} pending`;
                },
            ),
    },
    {
        group: 'structural edits',
        name: '10,000 own shapes, one edit',
        reps: 5,
        run: (reps) =>
            editOf(
                reps,
                () => ownShapes(new Engine([sheetOf('a', EMPTY)])),
                (engine) =>
                    `${engine.editLines({ insert: true, index: 0, count: 1, sheet: 'a', rows: true }).rewrites.length} rewrites`,
            ),
    },
    {
        group: 'structural edits',
        name: '10,000 own shapes, 100 edits (heap after)',
        reps: 1,
        run: () => {
            const engine = ownShapes(new Engine([sheetOf('a', EMPTY)]));
            engine.recalc(INF);
            const before = process.memoryUsage();
            const start = performance.now();
            for (let i = 0; i < 100; i += 1)
                engine.editLines({ insert: true, index: 0, count: 1, sheet: 'a', rows: true });
            const ms = performance.now() - start;
            const after = process.memoryUsage();
            const mb = (bytes: number) => (bytes / 1e6).toFixed(0);
            return {
                ms,
                check: `heap ${mb(before.heapUsed)} to ${mb(after.heapUsed)} MB, rss ${mb(before.rss)} to ${mb(after.rss)} MB`,
            };
        },
    },
    ...(
        [
            ['SUMPRODUCT(A:A,B:B) 10k rows (1000)', [10_000, 10_000], 1000, '=SUMPRODUCT(A:A,B:B)'],
            [
                'SUMPRODUCT bounded $A$1:$A$10000 (1000)',
                [10_000, 10_000],
                1000,
                '=SUMPRODUCT($A$1:$A$10000,$B$1:$B$10000)',
            ],
            ['SUMPRODUCT three ranges 10k rows (1000)', [10_000, 10_000, 10_000], 1000, '=SUMPRODUCT(A:A,B:B,C:C)'],
            [
                'SUMPRODUCT wide 1000 cols x 100 rows (20)',
                Array(2000).fill(100),
                20,
                '=SUMPRODUCT($A$1:$ALL$100,$ALM$1:$BXX$100)',
            ],
            [
                'SUMPRODUCT arrays only (*1) (200)',
                [10_000, 10_000],
                200,
                '=SUMPRODUCT($A$1:$A$10000*1,$B$1:$B$10000*1)',
            ],
            ['SUM(A:B) (1000)', [10_000, 10_000], 1000, '=SUM(A:B)'],
        ] as const
    ).map(([name, lengths, count, formula]) => ({
        group: 'SUMPRODUCT and collector rows',
        name,
        reps: 3,
        run: products(lengths, count, formula),
    })),
    {
        group: 'SUMPRODUCT and collector rows',
        name: 'two far cells SUMPRODUCT(T!A:P,T!A:P)',
        reps: 3,
        run: far('=SUMPRODUCT(T!A:P,T!A:P)', (sink) => {
            sink(1_048_575, 0, 3, null);
            sink(0, 702, 4, null);
        }),
    },
    {
        group: 'SUMPRODUCT and collector rows',
        name: 'criteria far cells (SUMIFS+SUMPRODUCT)',
        reps: 3,
        run: far('=SUMIFS(T!C:C,T!C:C,">0",T!D:D,"x")+SUMPRODUCT(--(T!C:C>0),T!C:C)', (sink) => {
            sink(2, 2, 1, null);
            sink(3, 2, 2, null);
            sink(2, 3, 'x', null);
            sink(1_048_575, 2, 0.3, null);
            sink(2, 16_383, 0.7, null);
        }),
    },
    {
        group: 'SUMPRODUCT and collector rows',
        name: 'whole-column below, 4000 readers',
        reps: 3,
        run: (reps) =>
            editOf(
                reps,
                () => {
                    const engine = new Engine([
                        sheetOf('a', (sink) => {
                            for (let r = 0; r < 50_000; r += 1) sink(r, 0, r % 97, null);
                        }),
                    ]);
                    engine.fillFormula('a', 0, 2, 3999, 2, '=SUM(C1:C1)+MATCH(40,C1:C1,0)');
                    return engine;
                },
                (engine) => {
                    engine.editLines({ insert: true, index: 60_000, count: 1, sheet: 'a', rows: true });
                    return `${pendingIn(engine, 'a', 2, 4001)} of 4000 readers to compute`;
                },
            ),
    },
    {
        group: 'SUMPRODUCT and collector rows',
        name: 'SUM reader, insert inside, 4000',
        reps: 3,
        run: readers('=SUM([d]!C1:C1)+RC[-2]', true),
    },
    {
        group: 'SUMPRODUCT and collector rows',
        name: 'MATCH reader, insert inside, 4000',
        reps: 3,
        run: readers('=MATCH(RC[-2],[d]!C1:C1,0)', true),
    },
    {
        group: 'SUMPRODUCT and collector rows',
        name: 'SUM reader, delete inside, 4000',
        reps: 3,
        run: readers('=SUM([d]!C1:C1)+RC[-2]', false),
    },
];

function ms(value: number): string {
    return value < 10 ? value.toFixed(2) : value.toFixed(1);
}

function load(): string {
    return os
        .loadavg()
        .map((average) => average.toFixed(2))
        .join(' ');
}

if (options.help) {
    console.log(USAGE);
} else if (options.row !== undefined) {
    const row = ROWS.find((candidate) => candidate.name === options.row);
    if (row === undefined) throw new Error(`No row ${options.row}`);
    console.log(JSON.stringify(row.run(Number(options.reps))));
} else {
    const filter = new RegExp(options.filter);
    const rows = ROWS.filter((row) => filter.test(row.name));
    if (options.list) {
        for (const row of rows) console.log(`${row.group}\t${row.name}`);
    } else {
        const runtime = process.versions.bun === undefined ? `Node ${process.version}` : `Bun ${process.versions.bun}`;
        const passed: string[] = [];
        if (options.corpus !== undefined) passed.push('--corpus', options.corpus);
        if (options.reference !== undefined) passed.push('--reference', options.reference);
        const rounds = Number(options.rounds);
        const started = Date.now();
        console.log(
            `${runtime}, ${rounds} rounds per row, a fresh process each; load averages (1, 5, 15 min) before: ${load()}`,
        );
        console.log('\n| group | row | min | median | gate | | check |\n|---|---|---|---|---|---|---|');
        let busiest = 0;
        for (const row of rows) {
            if (row.book !== undefined && bookPath(row.book) === undefined) {
                console.log(`| ${row.group} | ${row.name} | | | | | skipped: no ${row.book} workbook |`);
                continue;
            }
            const times: number[] = [];
            let check = '';
            for (let round = 0; round < rounds; round += 1) {
                busiest = Math.max(busiest, os.loadavg()[0]);
                const child = spawnSync(
                    process.execPath,
                    [process.argv[1], '--row', row.name, '--reps', String(row.reps), ...passed],
                    { encoding: 'utf8', maxBuffer: 1 << 26 },
                );
                const last = child.stdout.trim().split('\n').pop() ?? '';
                if (child.status !== 0 || !last.startsWith('{')) {
                    check = `FAILED: ${(child.stderr || last).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`;
                    break;
                }
                const measured: Measured = JSON.parse(last);
                times.push(measured.ms);
                check = measured.check;
            }
            times.sort((a, b) => a - b);
            const half = times.length >> 1;
            const median = times.length % 2 === 1 ? times[half] : (times[half - 1] + times[half]) / 2;
            const fastest = times.length === rounds ? times[0] : Number.NaN;
            const verdict =
                row.gate === undefined || Number.isNaN(fastest) ? '' : fastest <= row.gate ? 'PASS' : 'FAIL';
            const gate = row.gate === undefined ? '' : `<= ${row.gate} ms`;
            const shown = Number.isNaN(fastest) ? ['', ''] : [ms(fastest), ms(median)];
            console.log(
                `| ${row.group} | ${row.name} | ${shown[0]} | ${shown[1]} | ${gate} | ${verdict} | ${check.replace(/\|/g, '/')} |`,
            );
        }
        const seconds = Math.round((Date.now() - started) / 1000);
        console.log(
            `\nIn ms. Load averages after: ${load()}; highest 1-minute load sampled ${busiest.toFixed(2)}; ${seconds} s.`,
        );
    }
}
