// The speed workloads, built in code so they need nothing but the repo, and the child process that times one
// workload on one engine. A child builds a fresh engine per run, does the run up to three times and reports its
// fastest, so the first run warms the runtime up; it also reports the values of a sample of cells, which the run
// compares across engines before a time counts. A workload without an edit times the load and first compute; one
// with an edit times the edit and the recompute after it. formulajs takes part where the answers are plain calls.

import { parseArgs } from 'node:util';
import * as formulajs from '@formulajs/formulajs';
import type { ConfigParams } from 'hyperformula';
import type { CellEngine, Input, SheetInput, Value } from './engines';
import { formulajsValue, HyperFormulaEngine, IronCalcEngine, OursEngine, UniverEngine } from './engines';

export const ENGINES = ['ours', 'hyperformula', 'formulajs', 'ironcalc', 'univer'] as const;
export type EngineName = (typeof ENGINES)[number];
type Cell = readonly [number, number, number];

export type Workload = {
    readonly name: string;
    // One sentence for the README on what the workload is.
    readonly what: string;
    readonly sheets: () => SheetInput[];
    readonly edit?: (engine: CellEngine) => void;
    // The cells whose values are compared across engines, after the timed step.
    readonly reads: () => readonly Cell[];
    // A setting HyperFormula's documentation advises for this workload.
    readonly hyperformula?: Partial<ConfigParams>;
    // formulajs: work out the inputs from the sheets, untimed, and return the timed calls, which answer the reads.
    readonly formulajs?: (sheets: readonly SheetInput[]) => () => Value[];
    // Report the memory the engine holds after the load instead of a time.
    readonly memory?: boolean;
};
// `step` is the part of `ms` spent in the load or the edit, before the engine's own recalc call.
export type Measured = { readonly ms: number; readonly step: number; readonly values: readonly string[] };

// A child stops repeating a run once its runs took this long, so a slow engine is timed fewer times per process.
const ENOUGH_MS = 20_000;
const LOOKUP_INDEX: Partial<ConfigParams> = { useColumnIndex: true };

function grid(count: number, row: (r: number) => Input[]): SheetInput[] {
    return [{ name: 'Sheet1', rows: Array.from({ length: count }, (_, r) => row(r)) }];
}

function every(count: number, step: number, columns: readonly number[], shift = 0): Cell[] {
    const cells: Cell[] = [];
    for (let r = 0; r < count; r += step) for (const column of columns) cells.push([0, r + shift, column]);
    return cells;
}

// Column `column` of the first sheet, from row 0 down `count` rows.
function columnOf(sheets: readonly SheetInput[], column: number, count = sheets[0].rows.length): Input[] {
    return sheets[0].rows.slice(0, count).map((row) => row[column] ?? null);
}

function numbers(sheets: readonly SheetInput[], column: number, count?: number): number[] {
    return columnOf(sheets, column, count).map((input) => (typeof input === 'number' ? input : 0));
}

function texts(sheets: readonly SheetInput[], column: number, count?: number): string[] {
    return columnOf(sheets, column, count).map((input) => String(input ?? ''));
}

// Every answer is computed, as every formula is in the engines, and every `step`-th is kept for the comparison.
function sampled(answers: (i: number) => unknown, count: number, step: number): Value[] {
    const values: Value[] = [];
    for (let i = 0; i < count; i += 1) {
        const answer = answers(i);
        if (i % step === 0) values.push(formulajsValue(answer));
    }
    return values;
}

const shown = (count: number) => count.toLocaleString('en');

// The workloads with every count divided by `scale`, so a quick run has the same shapes at a smaller size.
export function workloads(scale: number): readonly Workload[] {
    const ROWS = 100_000 / scale;
    const LOOKUPS = 2000 / scale;
    const SUMS = 200 / scale;
    const SPAN = 90_000 / scale;
    const TOTALS = 20_000 / scale;
    const CRITERIA = 200 / scale;
    const MIDDLE = ROWS / 2;

    // ROWS rows of two numbers and three formulas on each row.
    const threeFormulas = (): SheetInput[] =>
        grid(ROWS, (r) => {
            const n = r + 1;
            return [
                (r % 1000) + 0.5,
                (r * 7) % 13,
                `=A${n}*2+B${n}`,
                `=IF(C${n}>1000,C${n}-1000,C${n})`,
                `=ROUND(D${n}/3,2)`,
            ];
        });

    // A long column of keys in A and values in B, and lookup formulas in F of the keys in E.
    const lookups = (sorted: boolean, formula: (n: number) => string) => (): SheetInput[] =>
        grid(ROWS, (r) => {
            const key = sorted ? r * 2 : (r * 7919) % ROWS;
            const row: Input[] = [key, r * 3];
            if (r < LOOKUPS) row.push(null, null, sorted ? r * 17 + 1 : (r * 37) % ROWS, formula(r + 1));
            return row;
        });
    const lookupReads = () => every(LOOKUPS, 7, [5]);

    // Keys and values as formulajs takes a table: a list of rows.
    const table = (sheets: readonly SheetInput[]) => {
        const keys = numbers(sheets, 0);
        const values = numbers(sheets, 1);
        return { keys, rows: keys.map((key, i) => [key, values[i]]), wanted: numbers(sheets, 4, LOOKUPS) };
    };

    // The criteria data: amounts in A, ten keys in B, a number from 0 to 99 in C, and criteria for the formulas.
    const criteria = (formula: (n: number) => string) => (): SheetInput[] =>
        grid(ROWS, (r) => {
            const row: Input[] = [(r % 1000) / 4, `k${r % 10}`, r % 100];
            if (r < CRITERIA) row.push(null, `k${(r * 3) % 10}`, `>${r % 100}`, formula(r + 1));
            return row;
        });
    const criteriaInputs = (sheets: readonly SheetInput[]) => ({
        amounts: numbers(sheets, 0),
        keys: texts(sheets, 1),
        bands: numbers(sheets, 2),
        wantedKeys: texts(sheets, 4, CRITERIA),
        wantedBands: texts(sheets, 5, CRITERIA),
    });

    const chain = () => grid(ROWS, (r) => [r === 0 ? 1 : `=A${r}+1`]);
    const keys = `$A$1:$A$${ROWS}`;
    const lookup = `${shown(LOOKUPS)} over ${shown(ROWS)} rows`;
    return [
        {
            name: `load and compute ${shown(3 * ROWS)} formulas`,
            what: `${shown(ROWS)} rows, each with two numbers and three formulas (arithmetic, IF, ROUND), loaded and computed.`,
            sheets: threeFormulas,
            reads: () => every(ROWS, 97, [2, 3, 4]),
        },
        {
            name: 'edit a cell with 3 dependents',
            what: `In that workbook, one number in row ${shown(MIDDLE + 1)} changes, and the three formulas on its row recompute.`,
            sheets: threeFormulas,
            edit: (engine) => engine.write(0, MIDDLE, 0, 7.25),
            reads: () => [[0, MIDDLE, 2], [0, MIDDLE, 3], [0, MIDDLE, 4], ...every(ROWS, 997, [4])],
        },
        {
            name: `edit a cell read by ${shown(ROWS)} formulas`,
            what: `Cell A1 is read by ${shown(ROWS)} formulas (=B1*$A$1+1 and so on); A1 changes and every formula recomputes. This is a full recalculation.`,
            sheets: () => grid(ROWS, (r) => [r === 0 ? 2 : null, r, `=B${r + 1}*$A$1+1`]),
            edit: (engine) => engine.write(0, 0, 0, 3),
            reads: () => every(ROWS, 97, [2]),
        },
        {
            name: `load a chain of ${shown(ROWS)} formulas`,
            what: `A1 is 1 and each cell below adds 1 to the cell above it (=A1+1, =A2+1, ...), ${shown(ROWS)} cells deep.`,
            sheets: chain,
            reads: () => [...every(ROWS, 997, [0]), [0, ROWS - 1, 0]],
        },
        {
            name: `edit the start of a chain of ${shown(ROWS)}`,
            what: `In that chain, A1 changes, so all ${shown(ROWS)} cells below it recompute in order.`,
            sheets: chain,
            edit: (engine) => engine.write(0, 0, 0, 2),
            reads: () => [...every(ROWS, 997, [0]), [0, ROWS - 1, 0]],
        },
        {
            name: `${shown(SUMS)} sums of ${shown(SPAN)} cells each`,
            what: `${shown(SUMS)} formulas =SUM(A1:A${SPAN}), =SUM(A2:A${SPAN + 1}) and so on, over ${shown(ROWS)} numbers.`,
            sheets: () => grid(ROWS, (r) => [(r % 100) + 0.25, r < SUMS ? `=SUM(A${r + 1}:A${r + SPAN})` : null]),
            reads: () => every(SUMS, 1, [1]),
            formulajs: (sheets) => {
                const values = numbers(sheets, 0);
                return () => sampled((i) => formulajs.SUM(values.slice(i, i + SPAN)), SUMS, 1);
            },
        },
        {
            name: `running total down ${shown(TOTALS)} rows`,
            what: `Each of ${shown(TOTALS)} rows sums everything above it and itself: =SUM($A$1:A1), =SUM($A$1:A2) and so on.`,
            sheets: () => grid(TOTALS, (r) => [(r % 10) + 1, `=SUM($A$1:A${r + 1})`]),
            reads: () => every(TOTALS, 50, [1]),
            formulajs: (sheets) => {
                const values = numbers(sheets, 0);
                return () => sampled((i) => formulajs.SUM(values.slice(0, i + 1)), TOTALS, 50);
            },
        },
        {
            name: `exact VLOOKUP, ${lookup}`,
            what: `${shown(LOOKUPS)} formulas =VLOOKUP(E1,$A$1:$B$${ROWS},2,FALSE) over ${shown(ROWS)} keys in no order.`,
            sheets: lookups(false, (n) => `=VLOOKUP(E${n},$A$1:$B$${ROWS},2,FALSE)`),
            reads: lookupReads,
            hyperformula: LOOKUP_INDEX,
            formulajs: (sheets) => {
                const { rows, wanted } = table(sheets);
                return () => sampled((i) => formulajs.VLOOKUP(wanted[i], rows, 2, false), LOOKUPS, 7);
            },
        },
        {
            name: `approximate VLOOKUP, ${lookup}`,
            what: `${shown(LOOKUPS)} formulas =VLOOKUP(E1,$A$1:$B$${ROWS},2,TRUE) over ${shown(ROWS)} sorted keys; each key falls between two.`,
            sheets: lookups(true, (n) => `=VLOOKUP(E${n},$A$1:$B$${ROWS},2,TRUE)`),
            reads: lookupReads,
            hyperformula: LOOKUP_INDEX,
            formulajs: (sheets) => {
                const { rows, wanted } = table(sheets);
                return () => sampled((i) => formulajs.VLOOKUP(wanted[i], rows, 2, true), LOOKUPS, 7);
            },
        },
        {
            name: `exact MATCH, ${lookup}`,
            what: `${shown(LOOKUPS)} formulas =MATCH(E1,${keys},0) over ${shown(ROWS)} keys in no order.`,
            sheets: lookups(false, (n) => `=MATCH(E${n},${keys},0)`),
            reads: lookupReads,
            hyperformula: LOOKUP_INDEX,
            formulajs: (sheets) => {
                const { keys: column, wanted } = table(sheets);
                return () => sampled((i) => formulajs.MATCH(wanted[i], column, 0), LOOKUPS, 7);
            },
        },
        {
            name: `approximate MATCH, ${lookup}`,
            what: `${shown(LOOKUPS)} formulas =MATCH(E1,${keys},1) over ${shown(ROWS)} sorted keys.`,
            sheets: lookups(true, (n) => `=MATCH(E${n},${keys},1)`),
            reads: lookupReads,
            hyperformula: LOOKUP_INDEX,
            formulajs: (sheets) => {
                const { keys: column, wanted } = table(sheets);
                return () => sampled((i) => formulajs.MATCH(wanted[i], column, 1), LOOKUPS, 7);
            },
        },
        {
            name: `exact XLOOKUP, ${lookup}`,
            what: `${shown(LOOKUPS)} formulas =XLOOKUP(E1,${keys},$B$1:$B$${ROWS}) over ${shown(ROWS)} keys in no order.`,
            sheets: lookups(false, (n) => `=XLOOKUP(E${n},${keys},$B$1:$B$${ROWS})`),
            reads: lookupReads,
            hyperformula: LOOKUP_INDEX,
        },
        {
            name: `SUMIFS, ${shown(CRITERIA)} over ${shown(ROWS)} rows`,
            what: `${shown(CRITERIA)} formulas =SUMIFS($A$1:$A$${ROWS},$B$1:$B$${ROWS},E1,$C$1:$C$${ROWS},F1), each with its own pair of criteria such as "k3" and ">37".`,
            sheets: criteria((n) => `=SUMIFS($A$1:$A$${ROWS},$B$1:$B$${ROWS},E${n},$C$1:$C$${ROWS},F${n})`),
            reads: () => every(CRITERIA, 1, [6]),
            formulajs: (sheets) => {
                const { amounts, keys: column, bands, wantedKeys, wantedBands } = criteriaInputs(sheets);
                return () =>
                    sampled(
                        (i) => formulajs.SUMIFS(amounts, column, wantedKeys[i], bands, wantedBands[i]),
                        CRITERIA,
                        1,
                    );
            },
        },
        {
            name: `COUNTIFS, ${shown(CRITERIA)} over ${shown(ROWS)} rows`,
            what: `${shown(CRITERIA)} formulas =COUNTIFS($B$1:$B$${ROWS},E1,$C$1:$C$${ROWS},F1) on the same data.`,
            sheets: criteria((n) => `=COUNTIFS($B$1:$B$${ROWS},E${n},$C$1:$C$${ROWS},F${n})`),
            reads: () => every(CRITERIA, 1, [6]),
            formulajs: (sheets) => {
                const { keys: column, bands, wantedKeys, wantedBands } = criteriaInputs(sheets);
                return () =>
                    sampled((i) => formulajs.COUNTIFS(column, wantedKeys[i], bands, wantedBands[i]), CRITERIA, 1);
            },
        },
        {
            name: `text functions on ${shown(ROWS)} rows`,
            what: `${shown(ROWS)} formulas =UPPER(LEFT(A1,6))&"-"&LEN(TRIM(A1))&"-"&SUBSTITUTE(A1,"a","o") over short texts.`,
            sheets: () =>
                grid(ROWS, (r) => [
                    `item ${r}  alpha ${r % 3 === 0 ? 'Beta' : 'gamma'} `,
                    `=UPPER(LEFT(A${r + 1},6))&"-"&LEN(TRIM(A${r + 1}))&"-"&SUBSTITUTE(A${r + 1},"a","o")`,
                ]),
            reads: () => every(ROWS, 97, [1]),
            formulajs: (sheets) => {
                const values = texts(sheets, 0);
                const joined = (text: string) =>
                    [
                        formulajs.UPPER(formulajs.LEFT(text, 6)),
                        formulajs.LEN(formulajs.TRIM(text)),
                        formulajs.SUBSTITUTE(text, 'a', 'o'),
                    ].join('-');
                return () => sampled((i) => joined(values[i]), ROWS, 97);
            },
        },
        {
            name: 'insert a row near the top',
            what: `In the workbook of ${shown(3 * ROWS)} formulas, one row is inserted above row 2, so every formula below it moves and its references change.`,
            sheets: threeFormulas,
            edit: (engine) => engine.insertLines(0, 1, 1, true),
            reads: () => [[0, 0, 4], ...every(ROWS - 1, 97, [2, 3, 4], 2)],
        },
        {
            name: `memory after loading ${shown(3 * ROWS)} formulas`,
            what: 'The memory the engine holds after the load and first compute of that workbook, in MB.',
            sheets: threeFormulas,
            reads: () => every(ROWS, 997, [4]),
            memory: true,
        },
    ];
}

// A value as the engines are compared on it: numbers at 10 significant digits, since HyperFormula rounds what it
// gives out to 10 unless told otherwise.
function key(value: Value): string {
    if (typeof value === 'number') return String(Number(value.toPrecision(10)));
    if (value !== null && typeof value === 'object') return value.text;
    return JSON.stringify(value);
}

function heap(): number {
    if (process.versions.bun !== undefined) Bun.gc(true);
    else globalThis.gc?.();
    const { heapUsed, external } = process.memoryUsage();
    // Bun counts typed arrays in heapUsed; Node counts them in external. Both count WebAssembly memory there too.
    return process.versions.bun !== undefined ? heapUsed : heapUsed + external;
}

function makeEngine(name: Exclude<EngineName, 'formulajs'>, workload: Workload): CellEngine {
    if (name === 'ours') return new OursEngine();
    if (name === 'ironcalc') return new IronCalcEngine();
    if (name === 'univer') return new UniverEngine();
    return new HyperFormulaEngine(workload.hyperformula);
}

// The fastest of up to `reps` runs, each timed by `run`, which builds what it needs untimed.
async function fastest(reps: number, run: () => Promise<Timed>): Promise<Timed> {
    let best: Timed = { ms: Number.POSITIVE_INFINITY, step: 0 };
    for (let rep = 0, spent = 0; rep < reps && spent < ENOUGH_MS; rep += 1) {
        const began = performance.now();
        const timed = await run();
        if (timed.ms < best.ms) best = timed;
        spent += performance.now() - began;
    }
    return best;
}
type Timed = { readonly ms: number; readonly step: number };

export async function measure(workload: Workload, name: EngineName, reps: number): Promise<Measured | null> {
    if (name === 'formulajs') {
        if (workload.formulajs === undefined || workload.memory) return null;
        const calls = workload.formulajs(workload.sheets());
        let values: Value[] = [];
        const timed = await fastest(reps, async () => {
            const start = performance.now();
            values = calls();
            const ms = performance.now() - start;
            return { ms, step: ms };
        });
        return { ...timed, values: values.map(key) };
    }
    let engine = makeEngine(name, workload);
    const read = () => workload.reads().map(([sheet, row, column]) => key(engine.read(sheet, row, column)));
    if (workload.memory) {
        const before = heap();
        engine.load(workload.sheets());
        await engine.recalc();
        const ms = (heap() - before) / 1e6;
        return { ms, step: ms, values: read() };
    }
    const { edit } = workload;
    const timed = await fastest(reps, async () => {
        engine = makeEngine(name, workload);
        const sheets = workload.sheets();
        if (edit !== undefined) {
            engine.load(sheets);
            await engine.recalc();
        }
        const start = performance.now();
        if (edit === undefined) engine.load(sheets);
        else edit(engine);
        const step = performance.now() - start;
        await engine.recalc();
        return { ms: performance.now() - start, step };
    });
    return { ...timed, values: read() };
}

// A child process: one workload on one engine, its fastest run and its values as one line of JSON. It checks its
// arguments itself, so that a Node bundle of this file runs it too.
const { values: child } = parseArgs({
    options: {
        workload: { type: 'string' },
        engine: { type: 'string' },
        reps: { type: 'string', default: '3' },
        scale: { type: 'string', default: '1' },
    },
    strict: false,
});
if (typeof child.workload === 'string') {
    const workload = workloads(Number(child.scale)).find((candidate) => candidate.name === child.workload);
    const engine = ENGINES.find((name) => name === child.engine);
    if (workload === undefined || engine === undefined)
        throw new Error(`No workload ${child.workload} on ${child.engine}`);
    console.log(JSON.stringify(await measure(workload, engine, Number(child.reps))));
}
