// Judges one engine on every recorded row: the formula goes into cell U21 of the row's sheets in a fresh engine,
// and its value is compared with Excel's by the oracle's own rule, numbers at 15 significant digits. An array is
// judged by its size and each element, each read through INDEX in a fresh engine, as the oracle does. formulajs is
// judged only on the rows that are one call with plain literal arguments. The run starts one process per engine.

import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { Literal } from '../src/index';
import type { FormulaNode } from '../src/text';
import { NodeKind, parseA1, parseA1Range, Token } from '../src/text';
import type { CellEngine, Input, SheetInput, Value } from './engines';
import { formulajsFunction, formulajsValue, HyperFormulaEngine, OursEngine } from './engines';
import type { Expected } from './recorded';
import { loadOracle } from './recorded';
import type { DataRow, RowSheet } from './rows';
import { readData } from './rows';

export const VERDICTS = ['equal', 'differs', 'not supported', 'crashed'] as const;
export type Verdict = (typeof VERDICTS)[number];

const [HOST_ROW, HOST_COLUMN] = [20, 20];
// An engine that answers these where Excel did not lacks the function or the syntax.
const UNSUPPORTED = new Set(['#NAME?', '#ERROR!']);

type SingleCall = {
    readonly place: number;
    readonly expected: Expected;
    readonly name: string;
    readonly args: readonly unknown[];
};
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

// One row on a cell engine: each check in a fresh engine, the worst verdict of them.
export function judgeRow(
    make: () => CellEngine,
    row: DataRow,
    fixtures: readonly (readonly RowSheet[])[],
    equals: (value: Literal | null, expected: Expected) => boolean,
): Verdict {
    const verdicts = checksOf(row, equals).map((check) => {
        try {
            const engine = make();
            engine.load(sheetInputs(fixtures[row[1]], check.formula));
            engine.recalc();
            return verdictOf(engine.read(0, HOST_ROW, HOST_COLUMN), check);
        } catch {
            return 'crashed' as const;
        }
    });
    return worst(verdicts);
}

// A literal argument as formulajs takes it, or undefined for anything else.
function literalOf(node: FormulaNode): number | string | boolean | undefined {
    if (node.kind === NodeKind.Number) return node.value;
    if (node.kind === NodeKind.String) return node.text;
    if (node.kind === NodeKind.Boolean) return node.value === 1;
    if (node.kind === NodeKind.Prefix && node.op === Token.Minus && node.children[0].kind === NodeKind.Number)
        return -node.children[0].value;
    return undefined;
}

// The rows that are one call of a function with plain literal arguments: their place, name and arguments.
export function singleCalls(rows: readonly DataRow[]): SingleCall[] {
    const calls: SingleCall[] = [];
    for (const [place, row] of rows.entries()) {
        const [, , formula, expected] = row;
        if ('rows' in expected) continue;
        const tree = parseA1(formula, HOST_ROW, HOST_COLUMN, () => undefined);
        if ('reason' in tree || tree.kind !== NodeKind.Call) continue;
        const args = tree.children.map(literalOf);
        if (args.every((arg) => arg !== undefined)) calls.push({ place, expected, name: tree.text, args });
    }
    return calls;
}

export function judgeCall(
    { expected, name, args }: SingleCall,
    equals: (value: Literal | null, expected: Expected) => boolean,
): Verdict {
    const call = formulajsFunction(name);
    if (call === undefined) return 'not supported';
    try {
        const equal = (value: Value) => equals(value, expected);
        return verdictOf(formulajsValue(call(...args)), { formula: name, equal, wanted: expected.text });
    } catch {
        return 'crashed';
    }
}

// A child process judges one engine from a row on and prints a line per row as it is done, its place and verdict,
// so the run can tell a row that never answers and go on after it.
if (import.meta.main) {
    const { values } = parseArgs({ options: { engine: { type: 'string' }, from: { type: 'string', default: '0' } } });
    const { header, rows } = readData();
    const { equalsRecorded } = await loadOracle();
    const from = Number(values.from);
    const make = () => (values.engine === 'ours' ? new OursEngine() : new HyperFormulaEngine());
    const jobs: [number, () => Verdict][] =
        values.engine === 'formulajs'
            ? singleCalls(rows).map((call) => [call.place, () => judgeCall(call, equalsRecorded)])
            : rows.map((row, place) => [place, () => judgeRow(make, row, header.fixtures, equalsRecorded)]);
    for (const [place, judge] of jobs) if (place >= from) fs.writeSync(1, `${place}\t${judge()}\n`);
}
