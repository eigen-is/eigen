// Judges one engine on every recorded row, or on every n-th for a quick look: the formula goes into cell U21 of the
// row's sheets in a fresh engine, and its value is compared with Excel's by the oracle's own rule, numbers at 15
// significant digits. An array is judged by its size and each element, each read through INDEX in a fresh engine,
// as the oracle does. The run starts one process per engine.

import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { Expected } from '../scripts/oracle-rows';
import { equalsRecorded } from '../scripts/oracle-rows';
import type { Literal } from '../src/index';
import { parseA1Range } from '../src/text';
import type { CellEngine, Input, SheetInput, Value } from './engines';
import { HyperFormulaEngine, IRONCALC_UNKNOWN, IronCalcEngine, OursEngine, UniverEngine } from './engines';
import type { DataRow, RowSheet } from './rows';
import { readData } from './rows';

export const VERDICTS = ['equal', 'differs', 'not supported', 'crashed'] as const;
export type Verdict = (typeof VERDICTS)[number];

const [HOST_ROW, HOST_COLUMN] = [20, 20];
// An engine that answers these where Excel did not lacks the function or the syntax. IronCalc has an error of its own
// for a function it knows but does not implement.
const UNSUPPORTED = new Set(['#NAME?', '#ERROR!', ...IRONCALC_UNKNOWN]);

type Check = { readonly formula: string; readonly equal: (value: Value) => boolean; readonly wanted: string };

function sheetInputs(sheets: readonly RowSheet[], formula: string): SheetInput[] {
    return sheets.map(({ name, cells }, place) => {
        const rows: Input[][] = [];
        const put = (row: number, column: number, input: Input) => {
            while (rows.length <= row) rows.push([]);
            const line = rows[row];
            while (line.length < column) line.push(null);
            line[column] = input;
        };
        for (const [label, value] of Object.entries(cells)) {
            const range = parseA1Range(label);
            if (range && typeof value !== 'object') put(range.start.row, range.start.column, value);
        }
        if (place === 0) put(HOST_ROW, HOST_COLUMN, formula);
        return { name, rows };
    });
}

function shown(value: Value): string {
    if (value === null) return '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return typeof value === 'object' ? value.text : String(value);
}

// The formulas a row is judged by, as the oracle's rows mode probes them.
function checksOf(row: DataRow, equals: (value: Literal | null, expected: Expected) => boolean): Check[] {
    const [, , formula, expected, extra] = row;
    if (!('rows' in expected)) return [{ formula, equal: (value) => equals(value, expected), wanted: expected.text }];
    const body = formula.slice(1);
    const wanted = `${expected.rows}x${expected.columns}`;
    const size = { formula: `=ROWS(${body})&"x"&COLUMNS(${body})`, equal: (v: Value) => shown(v) === wanted, wanted };
    if (expected.elements === null) {
        const checks: Check[] = [size];
        const { isref, sum } = extra;
        if (isref === 'TRUE' || isref === 'FALSE')
            checks.push({ formula: `=ISREF(${body})`, equal: (value) => shown(value) === isref, wanted: isref });
        if (sum !== undefined && sum !== 'n/a' && sum !== '')
            checks.push({ formula: `=SUM(${body})`, equal: (value) => equals(value, { text: sum }), wanted: sum });
        return checks;
    }
    const { columns } = expected;
    return [
        size,
        ...expected.elements.map((element, i) => ({
            formula: `=INDEX(${body},${Math.floor(i / columns) + 1},${(i % columns) + 1})`,
            equal: (value: Value) => equals(value, element),
            wanted: element.text,
        })),
    ];
}

function verdictOf(value: Value, check: Check): Verdict {
    if (check.equal(value)) return 'equal';
    const error = value !== null && typeof value === 'object' ? value.text : '';
    return UNSUPPORTED.has(error) && error !== check.wanted ? 'not supported' : 'differs';
}

// The worst verdict of a row's checks: a crash, then a missing feature, then a wrong value.
function worst(verdicts: readonly Verdict[]): Verdict {
    for (const verdict of ['crashed', 'not supported', 'differs'] as const)
        if (verdicts.includes(verdict)) return verdict;
    return 'equal';
}

// One row on one engine: each check in a fresh engine, the worst verdict of them.
async function judgeRow(
    make: () => CellEngine,
    row: DataRow,
    fixtures: readonly (readonly RowSheet[])[],
    equals: (value: Literal | null, expected: Expected) => boolean,
): Promise<Verdict> {
    const verdicts: Verdict[] = [];
    for (const check of checksOf(row, equals)) {
        try {
            const engine = make();
            engine.load(sheetInputs(fixtures[row[1]], check.formula));
            await engine.recalc();
            verdicts.push(verdictOf(engine.read(0, HOST_ROW, HOST_COLUMN), check));
        } catch {
            verdicts.push('crashed');
        }
    }
    return worst(verdicts);
}

// The rows a run judges: every row, or for a quick look every `every`-th by its place in the file.
export function sampled(place: number, every: number): boolean {
    return place % every === 0;
}

const MAKE: Readonly<Record<string, () => CellEngine>> = {
    ours: () => new OursEngine(),
    hyperformula: () => new HyperFormulaEngine(),
    ironcalc: () => new IronCalcEngine(),
    univer: () => new UniverEngine(),
};

// A child process judges one engine from a row on and prints a line per row as it is done, its place and verdict,
// so the run can tell a row that never answers and go on after it.
if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            engine: { type: 'string', default: '' },
            from: { type: 'string', default: '0' },
            every: { type: 'string', default: '1' },
        },
    });
    const { header, rows } = readData();
    const from = Number(values.from);
    const every = Number(values.every);
    const make = MAKE[values.engine];
    for (const [place, row] of rows.entries())
        if (place >= from && sampled(place, every))
            fs.writeSync(1, `${place}\t${await judgeRow(make, row, header.fixtures, equalsRecorded)}\n`);
}
