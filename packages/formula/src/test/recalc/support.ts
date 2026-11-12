import type { Entry } from '../../eval/signature';
import { FUNCTIONS } from '../../functions/library';
import type { Literal, SheetSource } from '../../index';
import { Engine } from '../../index';
import { Recalc } from '../../recalc/recalc';
import { Workbook } from '../../store/workbook';
import { parseA1, printStored, sheetFinder } from '../../text';

export type Cells = Readonly<Record<string, Literal>>;

const NAMES: Readonly<Record<string, string>> = { s1: 'Sheet1', s2: 'Sheet2', data: 'Data' };
const findSheet = sheetFinder(Object.entries(NAMES).map(([id, name]) => ({ id, name })));

// "N1" → [row, column], both from 0.
export function at(label: string): [number, number] {
    const letters = label.replace(/\d+/, '');
    let column = 0;
    for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
    return [Number(label.slice(letters.length)) - 1, column - 1];
}

// The stored text a formula typed at a cell becomes.
export function stored(formula: string, host: string): string {
    const [row, column] = at(host);
    const tree = parseA1(formula, row, column, findSheet);
    return 'reason' in tree ? `=${formula}` : printStored(tree);
}

function source(id: string, cells: Cells): SheetSource {
    return {
        id,
        name: NAMES[id] ?? id,
        cells: (cell) => {
            for (const [label, input] of Object.entries(cells)) {
                const [row, column] = at(label);
                if (typeof input === 'string' && input.startsWith('=')) cell(row, column, null, stored(input, label));
                else cell(row, column, input, null);
            }
        },
    };
}

// An engine over sheets of typed cells: a text that starts with = is a formula that was never computed.
export function engineOf(sheets: Readonly<Record<string, Cells>>): Engine {
    return new Engine(Object.entries(sheets).map(([id, cells]) => source(id, cells)));
}

export function valueAt(engine: Engine, label: string, sheet = 's1') {
    const [row, column] = at(label);
    return engine.valueOf(sheet, row, column);
}

// The value of one formula typed at `host` on a sheet that holds `cells`.
export function evaluate(formula: string, cells: Cells = {}, host = 'N1') {
    const engine = engineOf({ s1: { ...cells, [host]: formula }, s2: { D3: 300 } });
    engine.recalc(Number.POSITIVE_INFINITY);
    return valueAt(engine, host);
}

// The same, in a recalc whose functions are those of this build and `rows`: for what no function of it does yet.
export function evaluateWith(rows: readonly Entry[], formula: string, cells: Cells = {}, host = 'N1') {
    const workbook = new Workbook([source('s1', { ...cells, [host]: formula })]);
    const functions = new Map([...FUNCTIONS, ...rows.map((entry) => [entry.name, entry] as const)]);
    new Recalc(workbook, functions).pass(Number.POSITIVE_INFINITY);
    return workbook.value(workbook.sheets[0].columns[at(host)[1]], at(host)[0]);
}
