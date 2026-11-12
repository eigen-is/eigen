// The engine against Excel, in two modes. `rows` runs every row Excel answered in the recorded oracle files through
// a fresh Engine on that file's fixture and counts per file what is equal and what differs. `corpus` loads every
// workbook of a corpus with the values Excel cached, recalculates it, and sorts each formula cell into four columns:
// equal, differs, not built, not comparable; it attributes differences to the engine's decided picks and lists the
// rest. Both run on Bun, or on Node from a bundle. A run with --help prints its usage and the rules it counts by.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FUNCTIONS } from '../src/functions/library';
import type { Literal, SheetSource } from '../src/index';
import { Engine } from '../src/index';
import { isExcelFunction } from '../src/names';
import type { FormulaNode } from '../src/text';
import {
    GRID_COLUMNS,
    GRID_ROWS,
    NodeKind,
    parseA1,
    printA1,
    printStored,
    RefFlag,
    RefKind,
    SheetKind,
    sheetFinder,
    Token,
    toA1,
} from '../src/text';
import type { Book, BookCell } from './xlsx';
import { readBook, sourcesOf } from './xlsx';

const USAGE = `bun packages/formula/scripts/oracle.ts rows <oracle dir> [--out <file>]
bun packages/formula/scripts/oracle.ts corpus <dir or file>... [--out <file>] [--timeout <s>]
node: bun build --target node packages/formula/scripts/oracle.ts --outfile /tmp/oracle.mjs, then node /tmp/oracle.mjs ...

rows: every row with Excel's answer in the oracle's family and batch files that have a fixture plan here, each in a
fresh engine; numbers equal at 15 significant digits. Skipped: rows Excel refused at entry and volatile ones.
--out gets the differing rows.

corpus: one child process per workbook. A formula cell is
  NOT COMPARABLE  with no cached value, a volatile or environment function (NOW, TODAY, RAND, RANDBETWEEN,
                  RANDARRAY, CELL, INFO), another workbook, a sheet the file does not have, a cell on a loop
                  under iterative calculation, a 1904 workbook, or reading such a cell;
  NOT BUILT       refused by the dialect, calling a function of Excel's the engine lacks, a user function or a
                  LAMBDA named in the workbook, a 3-D reference, a name or table reference left unresolved, or
                  reading such a cell (a name no one has is #NAME? in both, so compared);
  then EQUAL or DIFFERS: numbers at 15 significant digits (at 10, the digits Google Sheets writes, in a file that
  Microsoft Excel did not write, by docProps/app.xml), texts, booleans and errors exactly.
"Reading" is a reference in the text: a cell reached only through INDIRECT or OFFSET is not followed.
A differing cell is put on a pick by its own formula, in this order, else by a differing cell it reads:
  empty text   it reads a cell holding an empty text and does arithmetic or Excel's value is #VALUE!, or it
               does arithmetic on a "" of its own and Excel's value is #VALUE! or an empty text (ours reads 0)
  day line     it calls a date function and its value, Excel's, or a cell it reads is blank or a serial under 61
  MATCH -1     it calls MATCH(...,-1), XMATCH(...,-2) or XLOOKUP(...,-2)
  approximate  it runs an approximate lookup over a range whose values are not strictly ascending
  blank        ours is 0 where the file cached an empty text (a blank result stored as 0)
The rest is the residue, by function: a cell counts under every function it calls.
The blank pick's other count, "would change", is the equal cells whose result is a blank stored as 0, the cells
Google's rule (keep it blank) would change: counted by asking ISBLANK of the formula over the computed values.
--out gets the report as markdown.`;

const { values: options, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        out: { type: 'string' },
        timeout: { type: 'string', default: '900' },
        book: { type: 'string' },
        help: { type: 'boolean', default: false },
    },
});

// ---------------------------------------------------------------------------------------------- rows

type Cells = Readonly<Record<string, Literal>>;
type Fixture = { readonly host: Cells; readonly hostName?: string; readonly others?: Readonly<Record<string, Cells>> };
type Plan = readonly (readonly [RegExp, Fixture])[];
// One expected value as recorded: Excel's text of it, whether it was a quoted text, and TYPE where it was taken.
type Expected = {
    readonly text: string;
    readonly quoted?: boolean;
    readonly type?: string;
    readonly element?: boolean;
    readonly exact15?: boolean;
};
type Probe = { readonly rows: number; readonly columns: number; readonly elements: readonly Expected[] | null };
type Outcome = {
    readonly file: string;
    readonly section: string;
    readonly formula: string;
    readonly excel: string;
    readonly ours: string;
    readonly equal: boolean;
};

const HOST = 'U21';
// The recorder's machine date, 12 Nov 2026, for the rows that read the clock and were not skipped.
const NOW = 46338.5;
const VOLATILE = /\b(RAND|RANDBETWEEN|RANDARRAY|NOW|TODAY)\(/;

function column(label: string, values: readonly Literal[], from = 1): Record<string, Literal> {
    const cells: Record<string, Literal> = {};
    for (const [i, value] of values.entries()) if (value !== '') cells[`${label}${i + from}`] = value;
    return cells;
}

const COMMON: Cells = {
    A1: 1.5,
    A2: -2.5,
    A3: 0,
    A4: 10,
    A5: 1e300,
    B2: '3',
    B3: true,
    B4: '=1/0',
    B5: 'abc',
    B6: '=""',
    C1: 2,
    C2: 4,
    C3: 6,
};
const REFERENCE: Cells = {
    ...COMMON,
    B7: '=NA()',
    ...column('D', ['k1', 'k2', 'k3', 'k4']),
    ...column('E', [10, 20, 30, 40]),
};
const STATISTICAL: Cells = {
    ...COMMON,
    ...column('D', [3, 1, 4, 1, 5, 9, 2, 6]),
    ...column('E', [3, 'x', '', true, 5, '=1/0', 2, '7']),
    ...column('F', ['x', 'y', 'z']),
    ...column('G', [10, 20, '=1/0', '=SUBTOTAL(9,D1:D3)', 40, 50]),
    ...column('H', [2, 7, 1, 8, 2, 8, 1, 8]),
    ...column('I', [1, 2, 3, 4, 5, 6, 7, 8]),
    ...column('J', [5, 5, 5, 5, 5]),
    ...column('K', [1, 2, '=NA()', 4, 5, 6, 7, 8]),
    ...column('N', [1, 1, 2, 2, 3, 4]),
};
const TEXT: Cells = {
    ...COMMON,
    ...column('D', [
        'Hello World',
        '  two  spaces  ',
        'straße',
        'ÀÉÎõü',
        'a~*?b',
        'x'.repeat(300),
        '1,234.50',
        '12:30',
        '2024-03-15',
        '😀a',
    ]),
};
const DATES: Cells = {
    ...COMMON,
    ...column('D', [
        45351,
        45000.75,
        0,
        60,
        61,
        -1,
        2958465,
        2958466,
        '2024-03-15',
        '15 March 2024',
        '3/15',
        '12:30 PM',
        0.999999999,
        1.5,
    ]),
    ...column('F', [45002, 'x', '', '=1/0', 45002, 45003]),
    ...column('G', [45002, 45003, 45003]),
};
const TENS = column('A', [10, 20, 30, 40, 50]);
const F1: Cells = {
    ...column('A', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
    ...column('B', [40, 50, 60]),
    ...column('C', [0.1, 0.2, -0.3]),
    D1: '=TRUE',
    D2: '="TRUE"',
    ...column('E', [1, '=1/0', 3]),
};
const B10: Cells = {
    ...TENS,
    ...column('B', [40, 50, 60]),
    ...column('C', [0.1, 0.2, -0.3]),
    D1: '=TRUE',
    E1: 1,
    E2: '=1/0',
    E3: 3,
    G1: 'abc',
    H1: '=""',
};
const X12: Cells = { A1: 1, B1: 2, A2: 3, B2: 4 };
const B12: Cells = {
    ...column('A', [10, 20, 30]),
    ...column('B', [40, 50, 60]),
    ...column('D', ['k1', 'k2', 'k3', 'k4']),
    ...column('E', [10, 20, 30, 40]),
    G5: 'abc',
};
const PAIR: Cells = { ...TENS, ...column('B', [12, 19, 33, 38, 55]) };
const { A3: _, ...PAIR_WITHOUT_A3 } = PAIR;
const HUGE: Cells = { A1: 1e200, A2: 1e200, B1: 1e200, B2: 1e200, C1: 1e200, C2: -1e200, F1: 0 };

// Per file, the fixture of each section: the first pattern that matches the section's heading wins.
const PLANS: ReadonlyMap<string, readonly [string, Plan]> = new Map([
    ['family-math.md', ['math', [[/./, { host: COMMON }]]]],
    ['family-statistical.md', ['statistical', [[/./, { host: STATISTICAL }]]]],
    ['family-date.md', ['date', [[/./, { host: DATES }]]]],
    ['family-logical.md', ['logical', [[/./, { host: REFERENCE }]]]],
    ['family-reference.md', ['reference', [[/./, { host: REFERENCE }]]]],
    ['family-text.md', ['text', [[/./, { host: TEXT }]]]],
    [
        'excel-batch6.md',
        [
            'b6',
            [
                [/^Group [123]:/, { host: F1, hostName: 'b6_f1' }],
                [
                    /^Group 4:/,
                    {
                        host: {
                            ...column('A', [10, 20, '', 40, 50]),
                            ...column('B', ['a', 'b', 'c', 'd', 'e']),
                            ...column('D', [1, '="3"', 5, '', 3]),
                            ...column('E', [0, 1, 2, 'x']),
                            ...column('G', [-100, 30, 40, 50, 60]),
                            ...column('I', [10, 20, 30, '=1/0', 50]),
                            ...column('J', ['a', 'b', 'c', 'd', 'e']),
                        },
                        hostName: 'b6_f2',
                    },
                ],
                [/^Group 5:/, { host: { ...HUGE, G1: 'x', H1: true, J1: 5 }, hostName: 'b6_ovf' }],
                [
                    /^Group 6:/,
                    {
                        host: {
                            ...column('A', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
                            ...column('B', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
                            A11: '=IF(TRUE,SUBTOTAL(9,A1:A10))',
                            B11: '=SUM(SUBTOTAL(9,B1:B10))',
                            G1: 10,
                            G2: 20,
                            G4: 5,
                            G5: '=SUBTOTAL(1,Y1:Y2)',
                            C1: 1,
                            C2: 2,
                            C4: '=SUBTOTAL(1,Y1:Y2)',
                            H1: 1,
                            H2: 2,
                            H4: '=SUBTOTAL(9,H1)/0',
                        },
                        hostName: 'b6_nest',
                    },
                ],
                [
                    /^Group 8:/,
                    {
                        host: Object.fromEntries([...'BCDEFGHIJKLMNOPQR'].map((letter, i) => [`${letter}1`, i + 1])),
                        hostName: 'b6_wide',
                    },
                ],
                [/^Group 7:/, { host: X12, hostName: 'b6_typed', others: { b6_x1: X12, b6_x2: X12, b6_x3: X12 } }],
            ],
        ],
    ],
    [
        'excel-batch7.md',
        [
            'b7',
            [
                [
                    /^Group (1|2|3|4|5|6|7|8|9|10):/,
                    {
                        host: {
                            ...F1,
                            G1: 10,
                            G2: 20,
                            G4: 5,
                            G5: '=SUBTOTAL(1,Y1:Y2)',
                            H1: 1,
                            H2: '=SUBTOTAL(9,H1)/0',
                            H3: 2,
                        },
                        hostName: 'b7_f1',
                    },
                ],
                [
                    /^Group 11:/,
                    { host: { A1: 'a', A3: 'c', B1: 'd', B2: 'e', E1: 'x', E2: '=1/0', E3: 'y' }, hostName: 'b7_t' },
                ],
                [
                    /^Group 12:/,
                    {
                        host: {
                            ...column('A', [1, 2, 4, 3, 5, 7]),
                            ...column('B', [2, 1, 5, 4, 6, 9]),
                            ...column('H', [1, '=1/0', 3]),
                            ...column('I', ['=TRUE', 2, 3]),
                            ...column('J', [1, 2, 3]),
                            ...column('K', ['x', 2, 3]),
                            ...column('L', [1, '=""', 3]),
                        },
                        hostName: 'b7_c',
                    },
                ],
                [/^Group 13:/, { host: { ...HUGE, K1: 1, K2: 1e200, L1: 1, L2: 1e200 }, hostName: 'b7_ovf' }],
                [/^Group 14:/, { host: { A1: '=""', A2: 5, B1: 'x' }, hostName: 'b7_empty' }],
            ],
        ],
    ],
    [
        'excel-batch10.md',
        [
            'b10',
            [
                [
                    /^Group 7/,
                    {
                        host: { K1: '😀a', K2: '="e"&UNICHAR(769)', K3: '=UNICHAR(127475)&UNICHAR(127473)' },
                        hostName: 'b10_emoji',
                    },
                ],
                [/^Group 6/, { host: {}, hostName: 'b10_parse' }],
                [/^Group 5 \/ cnt/, { host: { A2: '=""', A3: 0, A4: 'x' }, hostName: 'b10_cnt' }],
                [/./, { host: B10, hostName: 'b10_ref' }],
            ],
        ],
    ],
    [
        'excel-batch11.md',
        [
            'b11',
            [
                [/fanout-statistical/, { host: { ...STATISTICAL, ...TENS }, hostName: 'b11_stat' }],
                [/fanout-text/, { host: { ...TEXT, B7: '=NA()' }, hostName: 'b11_text' }],
                [/fanout-logical/, { host: { ...REFERENCE, K1: '=SEQUENCE(3)', K2: 1 }, hostName: 'b11_logic' }],
                [/^Part 1/, { host: REFERENCE }],
                [
                    /^Part 2a/,
                    { host: { L1: '=REPT("a",300)', L2: '=REPT("a",255)', L3: '=REPT("a",256)', L4: 'b'.repeat(300) } },
                ],
                [/2c\.7/, { host: { ...PAIR, A3: 'x' } }],
                [/2c\.8/, { host: PAIR_WITHOUT_A3 }],
                [/2c\.9/, { host: { ...PAIR, A3: '=1/0' } }],
                [/^Part 2c/, { host: PAIR }],
                [/2d\.1/, { host: TENS }],
                [/2d\.2/, { host: { A1: 10, A2: 'x', A3: true, A5: 50 } }],
                [/./, { host: {} }],
            ],
        ],
    ],
    [
        'excel-batch12.md',
        [
            'b12',
            [
                [/^Part C/, { host: { ...B12, H1: 5, H2: '=AGGREGATE(9,0,A1:A3)', H3: '=SUBTOTAL(9,A1:A3)' } }],
                [/^Part B/, { host: B12 }],
                [/./, { host: {} }],
            ],
        ],
    ],
    [
        'excel-batch13.md',
        [
            'b13',
            [
                [/^Part 1/, { host: { A1: 10, A2: 20, A3: 30, B1: 40, B2: 50, B3: 60, C1: 1, C2: 2, C3: 4 } }],
                [
                    /2c:/,
                    {
                        host: {
                            ...column('A', [1.1, 2.3, 2.9, 4.2, 5.7, 6.1]),
                            ...column('B', [2.2, 3.9, 6.1, 8.3, 9.8, 12.4]),
                            ...column('C', [1000000.1, 1000000.3, 1000000.2, 1000000.7, 1000000.5, 1000000.9]),
                            ...column('D', [0.1, 0.7, 0.2, 0.9]),
                            ...column('E', [3, 1, 4, 1]),
                        },
                    },
                ],
                [/2e:/, { host: { G1: 1, G2: 2, G4: 3, G5: 4 } }],
                [/./, { host: {} }],
            ],
        ],
    ],
]);

function cellAt(label: string): [number, number] {
    const letters = label.replace(/\d+/, '');
    let index = 0;
    for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
    return [Number(label.slice(letters.length)) - 1, index - 1];
}

// The host cell's value for each formula, each in a fresh engine on the fixture, with every sheet the formula names.
function evaluateAll(formulas: readonly string[], fixture: Fixture, named: readonly string[]): unknown[] {
    const hostName = fixture.hostName ?? named[0] ?? 'Sheet1';
    const others: Record<string, Cells> = { ...fixture.others };
    for (const name of named) if (name !== hostName && !(name in others)) others[name] = fixture.host;
    if (Object.keys(others).length === 0) others.Sheet2 = fixture.host;
    const sheets = [{ id: 's1', name: hostName }, ...Object.keys(others).map((name, i) => ({ id: `o${i}`, name }))];
    const find = sheetFinder(sheets);
    const stored = (formula: string, label: string): string | undefined => {
        const tree = parseA1(formula, ...cellAt(label), find);
        return 'reason' in tree ? undefined : printStored(tree);
    };
    const fill = (sink: Parameters<SheetSource['cells']>[0], cells: Cells) => {
        for (const [label, input] of Object.entries(cells)) {
            const [row, at] = cellAt(label);
            const text = typeof input === 'string' && input.startsWith('=') ? stored(input, label) : null;
            if (text === undefined) throw new Error(`fixture ${input} refused`);
            sink(row, at, text === null ? input : null, text);
        }
    };
    const [hostRow, hostColumn] = cellAt(HOST);
    return formulas.map((formula) => {
        const text = stored(formula, HOST);
        if (text === undefined) return 'PARSE-REFUSED';
        try {
            const engine = new Engine([
                {
                    id: 's1',
                    name: hostName,
                    cells: (sink) => {
                        fill(sink, fixture.host);
                        sink(hostRow, hostColumn, null, text);
                    },
                },
                ...Object.entries(others).map(([name, cells], i) => ({
                    id: `o${i}`,
                    name,
                    cells: (sink: Parameters<SheetSource['cells']>[0]) => fill(sink, cells),
                })),
            ]);
            engine.recalc(Number.POSITIVE_INFINITY, NOW, 7);
            return engine.valueOf('s1', hostRow, hostColumn);
        } catch (error) {
            return `THROW ${error instanceof Error ? error.message : error}`;
        }
    });
}

function shown(value: unknown): string {
    if (value === null) return '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'object' && 'text' in value) return String(value.text);
    return String(value);
}

function equalsRecorded(ours: unknown, expected: Expected): boolean {
    if (typeof ours === 'string' && ours.startsWith('THROW')) return false;
    const { type, text } = expected;
    if (expected.quoted || type === '2') return ours === text;
    if (type === '4') return typeof ours === 'boolean' && shown(ours) === text;
    if (type === '16') return ours !== null && typeof ours === 'object' && shown(ours) === text;
    if (typeof ours === 'number') {
        // A blank cell read through the INDEX probe is the 0 a formula shows for it.
        if (text === '' && type === undefined && expected.element) return ours === 0;
        const number = Number(text);
        if (text.trim() === '' || Number.isNaN(number)) return false;
        // ARRAYTOTEXT prints 14 digits when the exponent has three.
        const huge = !expected.exact15 && number !== 0 && (Math.abs(number) >= 1e100 || Math.abs(number) < 1e-99);
        const digits = huge ? 14 : 15;
        return Number(ours.toPrecision(digits)) === Number(number.toPrecision(digits));
    }
    if (type === '1') return ours === null && Number(text) === 0;
    if (ours === null) return text === '' || text === '0';
    return shown(ours) === text;
}

// The elements of a strict ARRAYTOTEXT, {a,"b";c}, row by row; null for any other text.
function arrayElements(text: string): Expected[][] | null {
    if (!text.startsWith('{') || !text.endsWith('}')) return null;
    const rows: Expected[][] = [[]];
    const end = text.length - 1;
    let i = 1;
    while (i < end) {
        let element = '';
        if (text[i] === '"') {
            i += 1;
            for (;;) {
                if (i >= end) return null;
                if (text[i] === '"' && !(text[i + 1] === '"' && i + 1 < end)) break;
                element += text[i];
                i += text[i] === '"' ? 2 : 1;
            }
            i += 1;
            rows[rows.length - 1].push({ text: element, quoted: true });
        } else {
            while (i < end && text[i] !== ',' && text[i] !== ';') element += text[(i += 1) - 1];
            rows[rows.length - 1].push({ text: element });
        }
        if (i < end) {
            if (text[i] === ';') rows.push([]);
            else if (text[i] !== ',') return null;
            i += 1;
            if (i === end) rows[rows.length - 1].push({ text: '' });
        }
    }
    return rows;
}

// The cells of a markdown table row, with escaped bars and bars inside backticks kept.
function tableCells(line: string): string[] {
    const cells: string[] = [];
    let cell = '';
    let ticked = false;
    for (let i = 1; i < line.length; i += 1) {
        const char = line[i];
        if (char === '\\' && line[i + 1] === '|') {
            cell += '|';
            i += 1;
        } else if (char === '|' && !ticked) {
            cells.push(cell.trim());
            cell = '';
        } else {
            if (char === '`') ticked = !ticked;
            cell += char;
        }
    }
    return cells;
}

function unticked(cell: string): string {
    return cell.replace(/^`+ ?| ?`+$/g, '');
}

function decoded(text: string): string {
    return text.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

// Every row of one file: the formula in the host cell, and for an array each element through INDEX and its size;
// ISREF and SUM columns where the file has them must agree too.
function runFile(file: string, tag: string, plan: Plan, outcomes: Outcome[], skipped: Map<string, number>): void {
    const skip = (why: string) => skipped.set(`${tag}: ${why}`, (skipped.get(`${tag}: ${why}`) ?? 0) + 1);
    const record = (
        section: string,
        formula: string,
        fixture: Fixture,
        expected: Expected | Probe,
        excel: string,
        extra: { isref?: string; sum?: string } = {},
    ) => {
        if (VOLATILE.test(formula)) return skip('volatile (RAND, NOW, TODAY)');
        const sheets = [...new Set(formula.match(/b\d+_[a-z]+\d*/g) ?? [])].sort();
        const done = (ours: string, equal: boolean) =>
            outcomes.push({ file: tag, section, formula, excel, ours, equal });
        if (!('rows' in expected)) {
            const [value] = evaluateAll([formula], fixture, sheets);
            const quote = typeof value === 'string' && expected.type !== '2' && !expected.quoted;
            return done(quote ? `"${value}"` : shown(value), equalsRecorded(value, expected));
        }
        const { rows, columns, elements } = expected;
        const body = formula.slice(1);
        const size = `=ROWS(${body})&"x"&COLUMNS(${body})`;
        const wanted = `${rows}x${columns}`;
        if (elements === null && excel === '#CALC!') {
            // Where Excel answered #CALC!, the size and the ISREF and SUM of the formula are what can be compared.
            const isref = extra.isref === 'TRUE' || extra.isref === 'FALSE';
            const sum = extra.sum !== undefined && extra.sum !== 'n/a' && extra.sum !== '';
            const probes = [formula, `=ISREF(${body})`, `=SUM(${body})`, size];
            const [value, isrefOurs, sumOurs, sized] = evaluateAll(probes, fixture, sheets);
            const sides =
                (!isref || shown(isrefOurs) === extra.isref) &&
                (!sum || equalsRecorded(sumOurs, { text: extra.sum ?? '' }));
            return done(`host ${shown(value)}, ${shown(sized)}`, shown(sized) === wanted && sides);
        }
        if (elements === null)
            return done(`${shown(evaluateAll([formula], fixture, sheets)[0])} (array not probed)`, false);
        const indexes = elements.map((_, i) => `=INDEX(${body},${Math.floor(i / columns) + 1},${(i % columns) + 1})`);
        const [, ...values] = evaluateAll([formula, ...indexes, size], fixture, sheets);
        const sized = shown(values.pop());
        const equal = sized === wanted && elements.every((element, i) => equalsRecorded(values[i], element));
        return done(`{${values.map(shown).join(',')}} ${sized}`, equal);
    };
    let section = '';
    let header: string[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.startsWith('## ') || line.startsWith('### ')) {
            section = line.startsWith('## ')
                ? line.slice(3).trim()
                : `${section.split(' / ')[0]} / ${line.slice(4).trim()}`;
            if (/^(Settles|Mishaps|Not run|Formulas Excel refused|Checks not run|Sheets created)/.test(section))
                section = `END ${section}`;
            header = [];
            continue;
        }
        if (!line.startsWith('| ') || section.startsWith('END') || /^\|\s*-/.test(line)) continue;
        const cells = tableCells(line);
        const lower = cells.map((cell) => cell.toLowerCase());
        const first = lower[0];
        if (
            lower.includes('formula') ||
            first === 'list' ||
            first === 'edit' ||
            first === 'cell' ||
            /^(mark|formula|check)/.test(first)
        ) {
            header = lower;
            continue;
        }
        if (header.length === 0) continue;
        if (header[0] === 'list') {
            // Batch 12's part A: one list and key per row, eleven lookups across.
            const key = unticked(cells[1]);
            const list = unticked(cells[2]);
            const vertical = `{${list.slice(1, -1).replace(/,/g, ';')}}`;
            const forms = [
                `MATCH(${key},${list},1)`,
                `MATCH(${key},${list},-1)`,
                `MATCH(${key},${list},0)`,
                `XMATCH(${key},${list},0,2)`,
                `XMATCH(${key},${list},0,-2)`,
                `XMATCH(${key},${list},-1,2)`,
                `XMATCH(${key},${list},1,2)`,
                `XMATCH(${key},${list},-1,-2)`,
                `XMATCH(${key},${list},1,-2)`,
                `LOOKUP(${key},${list})`,
                `VLOOKUP(${key},${vertical},1,TRUE)`,
            ];
            const types = cells[14].split(',');
            for (const [i, form] of forms.entries())
                record('Part A', `=${form}`, { host: {} }, { text: cells[3 + i], type: types[i] }, cells[3 + i]);
            continue;
        }
        const at = header.indexOf('formula');
        if (at < 0) {
            skip(`table without a formula column (${section.slice(0, 40)})`);
            continue;
        }
        let formula = decoded(unticked(cells[at] ?? ''));
        if (!formula.startsWith('=')) {
            skip('not a formula (typed entry or text)');
            continue;
        }
        let fixture = (plan.find(([pattern]) => pattern.test(section)) ?? plan[plan.length - 1])[1];
        if (tag === 'b10' && /^Group 5/.test(section) && /^5\.1[3-6]$/.test(cells[0])) fixture = plan[2][1];
        // The markdown lost a backtick in batch 13's part 2a.
        if (
            tag === 'b13' &&
            (/^=\("k"&""\)<"k[1a]"$/.test(formula) || /"k"&""[,)]/.test(formula) || /^=""<"/.test(formula))
        )
            formula = formula.replace('""', '"`"');
        const next = header[at + 1] ?? '';
        if (
            next === 'excel' ||
            next.startsWith('excel (array') ||
            next === 'value shown' ||
            (next === 'value' && header[0] === 'formula' && header[2] !== 'type')
        ) {
            // The family form: formula, Excel, shape, notes.
            const excel = cells[at + 1] === '(empty text)' ? '' : (cells[at + 1] ?? '');
            const shapeAt = header.findIndex((name) => name.startsWith('shape'));
            const shape = cells[shapeAt] ?? cells[at + 2] ?? '';
            const notes = cells[header.indexOf('notes')] ?? '';
            if (/refused/i.test(notes) || /refused/i.test(excel) || shape.startsWith('='))
                skip('refused on entry by Excel');
            else if (shapeAt < 0) skip(`table without a shape column (${section.slice(0, 40)})`);
            else if (shape === '') skip('no shape recorded');
            else {
                const extra = { isref: cells[header.indexOf('isref')], sum: cells[header.indexOf('sum')] };
                const size = /^(\d+)x(\d+) \(type 64\)/.exec(shape);
                if (size) {
                    const [rows, columns] = [Number(size[1]), Number(size[2])];
                    const braced = excel.startsWith('{');
                    let flat = braced
                        ? excel
                              .slice(1, -1)
                              .split(';')
                              .flatMap((part) => part.split(','))
                        : excel.split(', ');
                    if (!braced && flat.length !== rows * columns) flat = excel.split(',').map((part) => part.trim());
                    const fits = excel !== '#CALC!' && flat.length === rows * columns && rows * columns <= 256;
                    const elements = fits
                        ? flat.map((part) => ({ text: part.replace(/^"(.*)"$/, '$1'), element: true }))
                        : null;
                    record(section, formula, fixture, { rows, columns, elements }, excel, extra);
                } else {
                    const type = /type (\d+)/.exec(shape)?.[1] ?? (shape.includes('error') ? '16' : undefined);
                    record(
                        section,
                        formula,
                        fixture,
                        { text: excel, type: type && ['1', '2', '4', '16'].includes(type) ? type : undefined },
                        excel,
                        extra,
                    );
                }
            }
            continue;
        }
        // The label form: formula, value, TYPE, then maybe the array text and size and a 15-digit text.
        const value = cells[at + 1] ?? '';
        const type = cells[at + 2] ?? '';
        const arrayText = header[at + 3]?.startsWith('array') ? decoded(cells[at + 3] ?? '') : '';
        const digitsAt = header.findIndex((name) => name.startsWith('15-digit'));
        const digits = digitsAt >= 0 ? (cells[digitsAt] ?? '') : '';
        if (/refused/i.test(value) || type === '' || /refused/i.test(cells[cells.length - 1] ?? '')) {
            skip('refused on entry by Excel');
        } else if (type === '64') {
            const sized = /^(.*)\s\[(\d+)x(\d+)\]$/.exec(arrayText);
            const parsed = sized && arrayElements(sized[1]);
            const [rows, columns] = sized ? [Number(sized[2]), Number(sized[3])] : [0, 0];
            const elements =
                parsed && parsed.flat().length === rows * columns && rows * columns <= 256 ? parsed.flat() : null;
            record(section, formula, fixture, { rows, columns, elements: sized ? elements : null }, arrayText);
        } else {
            let text = decoded(value);
            if (type === '1') text = digits !== '' ? digits : (/^\{(.*)\}$/.exec(arrayText)?.[1] ?? value);
            if (type === '2') {
                const parsed = arrayElements(arrayText);
                if (parsed && parsed.flat().length === 1 && parsed[0][0].quoted) text = parsed[0][0].text;
                else if (value === '(empty text)') text = '';
                else if (/\.\.\./.test(value)) {
                    skip('text too long to be recorded whole');
                    continue;
                }
            }
            record(section, formula, fixture, { text, type, exact15: type === '1' && digits !== '' }, text);
        }
    }
}

function rowsMode(dir: string): string {
    const outcomes: Outcome[] = [];
    const skipped = new Map<string, number>();
    const lines = ['| file | run | equal | differs | skipped |', '|---|---|---|---|---|'];
    const unplanned: string[] = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const planned = PLANS.get(name);
        if (planned === undefined) {
            if (/^(family-[a-z]+|excel-batch\d+)\.md$/.test(name)) unplanned.push(name);
            continue;
        }
        const [tag, plan] = planned;
        const from = outcomes.length;
        runFile(path.join(dir, name), tag, plan, outcomes, skipped);
        const run = outcomes.slice(from);
        const equal = run.filter((outcome) => outcome.equal).length;
        const skips = [...skipped].filter(([why]) => why.startsWith(`${tag}: `));
        const skipText = skips.map(([why, count]) => `${why.slice(tag.length + 2)} ${count}`).join('; ');
        lines.push(`| ${name} | ${run.length} | ${equal} | ${run.length - equal} | ${skipText} |`);
    }
    const equal = outcomes.filter((outcome) => outcome.equal).length;
    lines.push(
        `| total | ${outcomes.length} | ${equal} | ${outcomes.length - equal} | ${[...skipped.values()].reduce((a, b) => a + b, 0)} |`,
    );
    if (unplanned.length > 0)
        lines.push(
            '',
            `Not run, no fixture plan here (their fixtures are prose in each file): ${unplanned.join(', ')}.`,
        );
    if (options.out !== undefined) {
        const differing = outcomes.filter((outcome) => !outcome.equal);
        fs.writeFileSync(
            options.out,
            `${differing.map((o) => `[${o.file} / ${o.section.slice(0, 60)}] ${o.formula} | Excel ${o.excel} | ours ${o.ours}`).join('\n')}\n`,
        );
    }
    return lines.join('\n');
}

// --------------------------------------------------------------------------------------------- corpus

const PICKS = ['empty text', 'day line', 'MATCH -1', 'approximate', 'blank'] as const;
type Pick = (typeof PICKS)[number];
const RESIDUE = 'residue';
// The writers whose cached values are Excel's own; openpyxl, for one, calls itself "Microsoft Excel Compatible".
const EXCEL = /^Microsoft (Macintosh )?Excel( Online)?$/;
const VOLATILE_CALLS = new Set(['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'RANDARRAY', 'CELL', 'INFO']);
const DATE_CALLS = new Set([
    'DATE',
    'DATEVALUE',
    'DATEDIF',
    'DAY',
    'DAYS',
    'DAYS360',
    'EDATE',
    'EOMONTH',
    'ISOWEEKNUM',
    'MONTH',
    'NETWORKDAYS',
    'NETWORKDAYS.INTL',
    'TEXT',
    'WEEKNUM',
    'WORKDAY',
    'WORKDAY.INTL',
    'YEAR',
    'YEARFRAC',
]);
const ARITHMETIC = new Set<number>([Token.Plus, Token.Minus, Token.Multiply, Token.Divide, Token.Power, Token.Percent]);
const EXAMPLES = 20;
// The most cells a pick's rule reads of one range.
const MOST_READ = 200_000;
const SMALL_AREA = 4096;

type Rect = {
    readonly sheet: number;
    readonly top: number;
    readonly left: number;
    readonly bottom: number;
    readonly right: number;
};
// What a formula's tree says, once per stored text: what it calls, and the references and lookups a pick reads.
type Facts = {
    readonly calls: ReadonlySet<string>;
    readonly own: string;
    readonly refs: readonly FormulaNode[];
    readonly arithmetic: boolean;
    // Whether the text holds an empty text, "".
    readonly emptyText: boolean;
    readonly descending: boolean;
    // The reference whose line an approximate lookup searches, and whether it is searched along a row.
    readonly lookups: readonly { readonly ref: FormulaNode; readonly row: boolean }[];
};
const NO_FACTS: Facts = {
    calls: new Set(),
    own: '',
    refs: [],
    arithmetic: false,
    emptyText: false,
    descending: false,
    lookups: [],
};
type Formula = {
    readonly sheet: number;
    readonly cell: BookCell;
    readonly facts: Facts;
    readonly rects: readonly Rect[];
};
type BookReport = {
    readonly file: string;
    readonly application: string;
    readonly formulas: number;
    readonly equal: number;
    readonly differs: number;
    readonly notBuilt: number;
    readonly notComparable: number;
    readonly why: Record<string, number>;
    readonly picks: Record<string, number>;
    readonly residueRoots: number;
    readonly residueDownstream: number;
    readonly classes: Record<string, number>;
    // The first cell of each residue class, as workbook, cell, formula, Excel's value and ours.
    readonly examples: Record<string, string>;
    readonly matchDescending: number;
    readonly wouldChange: number;
    readonly named: number;
    readonly seconds: number;
};

// Cells that carry a label, per sheet, asked whether any lies in a rectangle.
class Marks {
    private readonly labels = new Map<number, string>();
    private readonly columns = new Map<number, Map<number, number[]>>();

    public get size(): number {
        return this.labels.size;
    }

    public set(sheet: number, row: number, column: number, label: string): void {
        const key = keyOf(sheet, row, column);
        if (this.labels.has(key)) return;
        this.labels.set(key, label);
        const columns = this.columns.get(sheet) ?? new Map<number, number[]>();
        this.columns.set(sheet, columns);
        const rows = columns.get(column) ?? [];
        columns.set(column, rows);
        rows.push(row);
    }

    public get(sheet: number, row: number, column: number): string | undefined {
        return this.labels.get(keyOf(sheet, row, column));
    }

    private within(rect: Rect): string | undefined {
        const { sheet, top, left, bottom, right } = rect;
        if ((bottom - top + 1) * (right - left + 1) <= SMALL_AREA) {
            for (let row = top; row <= bottom; row += 1) {
                for (let column = left; column <= right; column += 1) {
                    const label = this.labels.get(keyOf(sheet, row, column));
                    if (label !== undefined) return label;
                }
            }
            return undefined;
        }
        for (const [column, rows] of this.columns.get(sheet) ?? []) {
            if (column < left || column > right) continue;
            const row = rows.find((candidate) => candidate >= top && candidate <= bottom);
            if (row !== undefined) return this.labels.get(keyOf(sheet, row, column));
        }
        return undefined;
    }

    // The label of the first marked cell a formula reads.
    public read(formula: Formula): string | undefined {
        for (const rect of formula.rects) {
            const label = this.within(rect);
            if (label !== undefined) return label;
        }
        return undefined;
    }
}

function keyOf(sheet: number, row: number, column: number): number {
    return (sheet * GRID_ROWS + row) * GRID_COLUMNS + column;
}

// The nodes of a tree, by an explicit stack: a long sum is thousands of nodes deep.
function nodesOf(tree: FormulaNode): FormulaNode[] {
    const nodes: FormulaNode[] = [];
    const stack = [tree];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        nodes.push(node);
        stack.push(...node.children);
    }
    return nodes;
}

function numberOf(node: FormulaNode | undefined): number | undefined {
    if (node?.kind === NodeKind.Number) return node.value;
    if (node?.kind === NodeKind.Boolean) return node.value;
    if (node?.kind === NodeKind.Prefix && node.op === Token.Minus) {
        const inner = numberOf(node.children[0]);
        return inner === undefined ? undefined : -inner;
    }
    return undefined;
}

function factsOf(tree: FormulaNode, names: ReadonlySet<string>): Facts {
    const calls = new Set<string>();
    const refs: FormulaNode[] = [];
    const lookups: { ref: FormulaNode; row: boolean }[] = [];
    let own = '';
    let arithmetic = false;
    let emptyText = false;
    let descending = false;
    const ownly = (why: string) => {
        own ||= why;
    };
    for (const node of nodesOf(tree)) {
        const { kind, children } = node;
        if (kind === NodeKind.Ref) {
            if (node.sheetKind === SheetKind.External) ownly('NC another workbook');
            else if (node.sheetKind === SheetKind.Name) ownly('NC a sheet the file does not have');
            else if (node.sheetKind === SheetKind.Span) ownly('NB a 3-D reference');
            else refs.push(node);
        } else if (kind === NodeKind.Name && names.has(node.text.toLowerCase())) {
            ownly('NB a defined name left unresolved');
        } else if (kind === NodeKind.Name && node.sheetKind === SheetKind.External) {
            ownly('NC another workbook');
        } else if (kind === NodeKind.Table) {
            ownly('NB a table reference left unresolved');
        } else if (kind === NodeKind.Invoke) {
            ownly(children[0].sheetKind === SheetKind.External ? 'NC another workbook' : 'NB a call of a LAMBDA value');
        } else if (
            (kind === NodeKind.Binary || kind === NodeKind.Prefix || kind === NodeKind.Postfix) &&
            ARITHMETIC.has(node.op)
        ) {
            arithmetic = true;
        } else if (kind === NodeKind.String && node.text === '') {
            emptyText = true;
        } else if (kind === NodeKind.Call) {
            const name = node.text;
            calls.add(name);
            // A name neither Excel nor the engine has is #NAME? in both, so only a function of Excel's is missing.
            if (VOLATILE_CALLS.has(name)) ownly(`NC volatile or environment (${name})`);
            else if (names.has(name.toLowerCase())) ownly('NB a call of a defined name (a LAMBDA)');
            else if (/^_*XL(UDF|L)\./.test(name)) ownly('NB a user function');
            else if (!FUNCTIONS.has(name) && isExcelFunction(name)) ownly(`NB missing ${name}`);
            const [, second, third, fourth, , sixth] = children;
            if (
                (name === 'MATCH' && numberOf(third) === -1) ||
                (name === 'XMATCH' && numberOf(fourth) === -2) ||
                (name === 'XLOOKUP' && numberOf(sixth) === -2)
            ) {
                descending = true;
            }
            const approximate =
                ((name === 'VLOOKUP' || name === 'HLOOKUP') &&
                    (fourth === undefined || (numberOf(fourth) ?? 1) !== 0)) ||
                (name === 'MATCH' && (third === undefined || (numberOf(third) ?? 0) > 0)) ||
                name === 'LOOKUP' ||
                (name === 'XMATCH' && numberOf(fourth) === 2) ||
                (name === 'XLOOKUP' && numberOf(sixth) === 2);
            if (approximate && second?.kind === NodeKind.Ref) lookups.push({ ref: second, row: name === 'HLOOKUP' });
        }
    }
    return { calls, own, refs, arithmetic, emptyText, descending, lookups };
}

// Where a reference points from a cell, or null when it leaves the grid.
function rectOf(node: FormulaNode, sheet: number, row: number, column: number): Rect | null {
    const at = (value: number, flag: number, host: number) => (node.flags & flag ? value : host + value);
    const rows = node.op === RefKind.Columns;
    const columns = node.op === RefKind.Rows;
    const second = node.op === RefKind.Cell ? 0 : 1;
    const r1 = rows ? 0 : at(node.row, RefFlag.RowAbsolute, row);
    const r2 = rows ? GRID_ROWS - 1 : second ? at(node.row2, RefFlag.Row2Absolute, row) : r1;
    const c1 = columns ? 0 : at(node.column, RefFlag.ColumnAbsolute, column);
    const c2 = columns ? GRID_COLUMNS - 1 : second ? at(node.column2, RefFlag.Column2Absolute, column) : c1;
    const place =
        node.sheetKind === SheetKind.Host ? sheet : node.sheetKind === SheetKind.Id ? Number(node.sheet.slice(1)) : -1;
    const rect = {
        sheet: place,
        top: Math.min(r1, r2),
        left: Math.min(c1, c2),
        bottom: Math.max(r1, r2),
        right: Math.max(c1, c2),
    };
    return place < 0 || rect.top < 0 || rect.left < 0 || rect.bottom >= GRID_ROWS || rect.right >= GRID_COLUMNS
        ? null
        : rect;
}

// Numbers are equal within half a unit of their last significant digit, so two that round apart are not told apart.
function sameValue(ours: unknown, cached: Literal, digits: number): boolean {
    if (typeof cached === 'number') {
        if (typeof ours !== 'number') return false;
        const unit = 10 ** (Math.floor(Math.log10(Math.max(Math.abs(ours), Math.abs(cached)))) - digits + 1);
        const rounded = Number(ours.toPrecision(digits)) === Number(cached.toPrecision(digits));
        return ours === cached || rounded || Math.abs(ours - cached) <= 0.5000001 * unit;
    }
    if (typeof cached === 'object') return ours !== null && typeof ours === 'object' && shown(ours) === cached.text;
    if (ours === null) return cached === '';
    return ours === cached;
}

function kindOf(value: unknown): string {
    if (value !== null && typeof value === 'object') return shown(value);
    return value === '' ? 'empty text' : value === null ? 'blank' : typeof value;
}

// Runs `visit` over the cells of a rectangle, at most MOST_READ of them, until it returns true.
function anyCell(rect: Rect, visit: (row: number, column: number) => boolean): boolean {
    let read = 0;
    for (let row = rect.top; row <= rect.bottom; row += 1) {
        for (let column = rect.left; column <= rect.right; column += 1) {
            if (visit(row, column)) return true;
            if ((read += 1) >= MOST_READ) return false;
        }
    }
    return false;
}

function bookMode(file: string): BookReport {
    const started = performance.now();
    const book = readBook(file);
    const ids = book.sheets.map((sheet) => sheet.id);
    const facts = new Map<string, Facts>();
    const formulas: Formula[] = [];
    const why: Record<string, number> = {};
    const bump = (counts: Record<string, number>, key: string) => {
        counts[key] = (counts[key] ?? 0) + 1;
    };
    let named = 0;
    for (const [place, sheet] of book.sheets.entries()) {
        for (const cell of sheet.cells) {
            const { formula } = cell;
            if (formula === null) continue;
            if (formula.named) named += 1;
            const { tree, stored } = formula;
            const known = stored === null ? undefined : facts.get(stored);
            const found =
                known ?? (tree === null ? { ...NO_FACTS, own: `NB ${formula.refused}` } : factsOf(tree, book.names));
            if (stored !== null && known === undefined) facts.set(stored, found);
            const rects: Rect[] = [];
            for (const ref of found.refs) {
                const rect = rectOf(ref, place, cell.row, cell.column);
                if (rect) rects.push(rect);
            }
            formulas.push({ sheet: place, cell, facts: found, rects });
        }
    }
    const engine = new Engine(sourcesOf(book, true));
    const { loops } = engine.recalc(Number.POSITIVE_INFINITY);
    const looped = new Set(loops.map((loop) => keyOf(ids.indexOf(loop.sheet), loop.row, loop.column)));
    const value = (sheet: number, row: number, column: number) => engine.valueOf(ids[sheet], row, column);

    // Not comparable, then not built: the formula's own reason, or a cell it reads that has one.
    const excluded = new Marks();
    for (const { sheet, cell, facts: own } of formulas) {
        const reason = book.date1904
            ? 'NC a 1904 workbook'
            : cell.value === null
              ? 'NC no cached value'
              : book.iterate && looped.has(keyOf(sheet, cell.row, cell.column))
                ? 'NC a loop under iterative calculation'
                : own.own;
        if (reason !== '') excluded.set(sheet, cell.row, cell.column, reason);
    }
    spread(formulas, excluded, (label) =>
        label.startsWith('NC') ? 'NC reads a cell not comparable' : 'NB reads a cell not built',
    );

    const digits = EXCEL.test(book.application) ? 15 : 10;
    let equal = 0;
    const differing = new Marks();
    const candidates: Formula[] = [];
    for (const formula of formulas) {
        const { sheet, cell } = formula;
        const reason = excluded.get(sheet, cell.row, cell.column);
        if (reason !== undefined) {
            bump(why, reason);
            continue;
        }
        const ours = value(sheet, cell.row, cell.column);
        const cached = cell.value ?? '';
        if (sameValue(ours, cached, digits)) {
            equal += 1;
            if (ours === 0) candidates.push(formula);
            continue;
        }
        differing.set(sheet, cell.row, cell.column, pickOf(formula, ours, cached, value) ?? '');
    }
    // A differing cell with no pick of its own takes the label of a differing cell it reads; one that reads none is
    // a root of the residue.
    const labelled = new Marks();
    for (const { sheet, cell } of formulas) {
        const label = differing.get(sheet, cell.row, cell.column);
        if (label !== undefined && label !== '') labelled.set(sheet, cell.row, cell.column, label);
    }
    const unlabelled = formulas.filter(({ sheet, cell }) => differing.get(sheet, cell.row, cell.column) === '');
    for (const formula of unlabelled)
        if (differing.read(formula) === undefined)
            labelled.set(formula.sheet, formula.cell.row, formula.cell.column, RESIDUE);
    spread(unlabelled, labelled, (label) => (label === RESIDUE ? `${RESIDUE} downstream` : label));

    const picks: Record<string, number> = Object.fromEntries(PICKS.map((pick) => [pick, 0]));
    const classes: Record<string, number> = {};
    const examples: Record<string, string> = {};
    let residueRoots = 0;
    let residueDownstream = 0;
    let matchDescending = 0;
    for (const formula of formulas) {
        const { sheet, cell, facts: own } = formula;
        if (own.descending) matchDescending += 1;
        if (differing.get(sheet, cell.row, cell.column) === undefined) continue;
        const label = labelled.get(sheet, cell.row, cell.column) ?? `${RESIDUE} downstream`;
        if (label === `${RESIDUE} downstream`) residueDownstream += 1;
        else if (label !== RESIDUE) bump(picks, label);
        else {
            residueRoots += 1;
            const ours = value(sheet, cell.row, cell.column);
            const near =
                typeof ours === 'number' &&
                typeof cell.value === 'number' &&
                Math.abs(ours - cell.value) <= 1e-12 * Math.abs(cell.value);
            const kind = near
                ? "a number within 1e-12 of Excel's"
                : `${kindOf(ours)} where Excel has ${kindOf(cell.value)}`;
            const tree = cell.formula?.tree;
            const text = tree ? printA1(tree, cell.row, cell.column, (id) => book.sheets[ids.indexOf(id)]?.name) : '';
            const where = `${path.basename(file).slice(-50)} ${book.sheets[sheet].name}!${toA1(cell.row, cell.column)}`;
            for (const name of own.calls.size > 0 ? own.calls : ['no function']) {
                bump(classes, `${name}: ${kind}`);
                examples[`${name}: ${kind}`] ??=
                    `${where}: ${text.slice(0, 140)}; Excel ${shown(cell.value)}, ours ${shown(ours)}`;
            }
        }
    }
    const counted = (prefix: string) =>
        Object.entries(why).reduce((sum, [reason, count]) => sum + (reason.startsWith(prefix) ? count : 0), 0);
    return {
        file,
        application: book.application,
        formulas: formulas.length,
        equal,
        differs: differing.size,
        notBuilt: counted('NB'),
        notComparable: counted('NC'),
        why,
        picks,
        residueRoots,
        residueDownstream,
        classes,
        examples,
        matchDescending,
        wouldChange: wouldChange(book, engine, candidates),
        named,
        seconds: (performance.now() - started) / 1000,
    };
}

// Marks every formula that reads a marked cell, in passes down the sheets until nothing changes.
function spread(formulas: readonly Formula[], marks: Marks, label: (read: string) => string): void {
    for (let changed = true; changed; ) {
        changed = false;
        for (const formula of formulas) {
            const { sheet, cell } = formula;
            if (marks.get(sheet, cell.row, cell.column) !== undefined) continue;
            const read = marks.read(formula);
            if (read === undefined) continue;
            marks.set(sheet, cell.row, cell.column, label(read));
            changed = true;
        }
    }
}

// The pick a differing cell's own formula explains, by the rules in the usage, in their order.
function pickOf(
    formula: Formula,
    ours: unknown,
    cached: Literal,
    value: (sheet: number, row: number, column: number) => unknown,
): Pick | undefined {
    const { facts: own, rects } = formula;
    const refused = typeof cached === 'object' && cached.text === '#VALUE!';
    const reads = rects.some((rect) => anyCell(rect, (row, column) => value(rect.sheet, row, column) === ''));
    const typed = own.emptyText && own.arithmetic && (refused || cached === '');
    if ((reads && (own.arithmetic || refused)) || typed) return 'empty text';
    if ([...own.calls].some((name) => DATE_CALLS.has(name))) {
        const early = (v: unknown) => v === null || (typeof v === 'number' && v >= 0 && v < 61);
        const reads = rects.some(
            (rect) =>
                rect.top === rect.bottom && rect.left === rect.right && early(value(rect.sheet, rect.top, rect.left)),
        );
        if (reads || (typeof ours === 'number' && early(ours)) || (typeof cached === 'number' && early(cached)))
            return 'day line';
    }
    if (own.descending) return 'MATCH -1';
    for (const { ref, row } of own.lookups) {
        const rect = rectOf(ref, formula.sheet, formula.cell.row, formula.cell.column);
        if (rect === null) continue;
        const line = row ? { ...rect, bottom: rect.top } : { ...rect, right: rect.left };
        let last: unknown = null;
        const unsorted = anyCell(line, (r, c) => {
            const next = value(line.sheet, r, c);
            if (next === null || next === '') return false;
            const comparable = typeof next === typeof last && (typeof next === 'number' || typeof next === 'string');
            const before =
                comparable &&
                (typeof next === 'string' && typeof last === 'string'
                    ? next.toLowerCase() <= last.toLowerCase()
                    : Number(next) <= Number(last));
            last = next;
            return before;
        });
        if (unsorted) return 'approximate';
    }
    if (ours === 0 && cached === '') return 'blank';
    return undefined;
}

// The equal cells whose value 0 is a blank result: each such formula asked ISBLANK over the computed values, in an
// engine where every other formula is its value.
function wouldChange(book: Book, engine: Engine, candidates: readonly Formula[]): number {
    if (candidates.length === 0) return 0;
    const probes = new Set(candidates.map(({ sheet, cell }) => keyOf(sheet, cell.row, cell.column)));
    const probe = new Engine(probeSources(book, engine, probes));
    probe.recalc(Number.POSITIVE_INFINITY);
    return candidates.filter(({ sheet, cell }) => probe.valueOf(book.sheets[sheet].id, cell.row, cell.column) === true)
        .length;
}

// The book with every formula as the value it computed, but the probed ones, which ask ISBLANK of themselves.
function probeSources(book: Book, engine: Engine, probes: ReadonlySet<number>): SheetSource[] {
    return book.sheets.map((sheet, place) => ({
        id: sheet.id,
        name: sheet.name,
        cells: (sink) => {
            for (const { row, column, value, formula } of sheet.cells) {
                const stored = formula?.stored ?? null;
                if (stored === null) sink(row, column, value, null);
                else if (probes.has(keyOf(place, row, column))) sink(row, column, null, `=ISBLANK(${stored.slice(1)})`);
                else sink(row, column, engine.valueOf(sheet.id, row, column), null);
            }
        },
    }));
}

function workbooksUnder(paths: readonly string[]): string[] {
    const files: string[] = [];
    for (const start of paths) {
        if (fs.statSync(start).isFile()) files.push(start);
        else {
            for (const entry of fs.readdirSync(start, { recursive: true, encoding: 'utf8' })) {
                if (/\.(xlsx|xlsm|xltx|xltm)(__content)?$/i.test(entry) && !path.basename(entry).startsWith('~$'))
                    files.push(path.join(start, entry));
            }
        }
    }
    return files.sort();
}

function corpusMode(paths: readonly string[]): string {
    const reports: BookReport[] = [];
    const failed: string[] = [];
    for (const file of workbooksUnder(paths)) {
        const child = spawnSync(process.execPath, [process.argv[1], '--book', file], {
            encoding: 'utf8',
            maxBuffer: 1 << 28,
            timeout: Number(options.timeout) * 1000,
        });
        const last = child.stdout?.trim().split('\n').pop() ?? '';
        if (child.status === 0 && last.startsWith('{')) {
            const report: BookReport = JSON.parse(last);
            if (report.formulas > 0) reports.push(report);
        } else {
            failed.push(
                `${path.basename(file)}: ${child.error ? 'timed out' : (/\berror: .*$/im.exec(child.stderr)?.[0] ?? last).slice(0, 160)}`,
            );
        }
        process.stderr.write(
            `${reports.length} with formulas, ${failed.length} failed: ${path.basename(file).slice(0, 70)}\n`,
        );
    }
    const sum = (pick: (report: BookReport) => number, among = reports) =>
        among.reduce((total, report) => total + pick(report), 0);
    const byExcel = reports.filter((report) => EXCEL.test(report.application));
    const merged = (pick: (report: BookReport) => Record<string, number>) => {
        const counts: Record<string, number> = {};
        for (const report of reports)
            for (const [key, count] of Object.entries(pick(report))) counts[key] = (counts[key] ?? 0) + count;
        return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    };
    const share = (pick: (report: BookReport) => number, among = reports) =>
        `${sum(pick, among)} (${((100 * sum(pick, among)) / sum((report) => report.formulas, among)).toFixed(2)}%)`;
    const column = (name: string, pick: (report: BookReport) => number) =>
        `| ${name} | ${share(pick)} | ${share(pick, byExcel)} |`;
    const lines = [
        `${reports.length} workbooks with formulas (${byExcel.length} written by Microsoft Excel), ${failed.length} that could not be run; ${sum((report) => report.named)} formula cells used a defined name.`,
        '',
        '| | all workbooks | written by Microsoft Excel |',
        '|---|---|---|',
        column('formula cells', (report) => report.formulas),
        column('EQUAL', (report) => report.equal),
        column('DIFFERS', (report) => report.differs),
        column('NOT BUILT', (report) => report.notBuilt),
        column('NOT COMPARABLE', (report) => report.notComparable),
        '',
        '| inside DIFFERS | cells |',
        '|---|---|',
        ...PICKS.map((pick) => `| pick: ${pick} | ${sum((report) => report.picks[pick] ?? 0)} |`),
        `| residue, roots (read no differing cell) | ${sum((report) => report.residueRoots)} |`,
        `| residue, downstream of a root | ${sum((report) => report.residueDownstream)} |`,
        '',
        `MATCH -1 (and descending XMATCH, XLOOKUP) is used by ${sum((report) => report.matchDescending)} formula cells. The blank pick would change ${sum((report) => report.wouldChange)} equal cells under Google's rule.`,
        '',
        '| why not built or not comparable | cells |',
        '|---|---|',
        ...merged((report) => report.why).map(
            ([reason, count]) =>
                `| ${reason.replace(/^NB /, 'not built: ').replace(/^NC /, 'not comparable: ')} | ${count} |`,
        ),
        '',
        '| residue root class (a cell counts under each function it calls) | cells | first example |',
        '|---|---|---|',
        ...merged((report) => report.classes)
            .slice(0, EXAMPLES)
            .map(([name, count]) => {
                const example = reports.find((report) => report.examples[name] !== undefined)?.examples[name] ?? '';
                return `| ${name} | ${count} | ${example.replace(/\|/g, '/').replace(/\n/g, ' ')} |`;
            }),
        '',
        '| workbook | written by | formulas | equal | differs | not built | not comparable | picks (empty text, day line, MATCH -1, approximate, blank) | residue roots | blank would change | s |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
        ...reports.map(
            (report) =>
                `| ${path.basename(report.file).slice(-60)} | ${report.application} | ${report.formulas} | ${report.equal} | ${report.differs} | ${report.notBuilt} | ${report.notComparable} | ${PICKS.map((pick) => report.picks[pick] ?? 0).join(', ')} | ${report.residueRoots} | ${report.wouldChange} | ${report.seconds.toFixed(1)} |`,
        ),
        '',
        ...failed.map((line) => `- could not be run: ${line}`),
    ];
    return lines.join('\n');
}

const [mode, ...rest] = positionals;
if (options.help || (options.book === undefined && (mode === undefined || rest.length === 0))) {
    console.log(USAGE);
} else if (options.book !== undefined) {
    console.log(JSON.stringify(bookMode(options.book)));
} else {
    const report = mode === 'rows' ? rowsMode(rest[0]) : corpusMode(rest);
    if (mode !== 'rows' && options.out !== undefined) fs.writeFileSync(options.out, `${report}\n`);
    console.log(report);
}
