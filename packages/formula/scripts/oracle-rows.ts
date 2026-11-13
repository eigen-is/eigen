// The rows mode of the oracle script: every row Excel answered in the recorded oracle files, each formula in a
// fresh Engine on the fixture its file's plan gives it, compared with Excel's recorded answer, and a row that differs
// only where a blank result stays blank counted under that pick. The fixtures are the cells the recorder typed into
// each sheet, written out here because the files describe them in prose.

import * as fs from 'node:fs';
import path from 'node:path';
import type { CellSink, Literal } from '../src/index';
import { Engine } from '../src/index';
import { parseA1Range, sheetFinder, storedText } from '../src/text';

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
    // Differs only by the decided pick that a blank result stays blank where Excel shows 0.
    readonly blank: boolean;
};

const HOST = 'U21';
// The recorder's machine date, 12 Nov 2026, for the rows that read the clock and were not skipped.
const NOW = 46338.5;
export const VOLATILE = ['RAND', 'RANDBETWEEN', 'RANDARRAY', 'NOW', 'TODAY'];
const CALLS_VOLATILE = new RegExp(`\\b(${VOLATILE.join('|')})\\(`);

// The cells down a column from row 1, an empty text for a cell that stays blank.
function down(label: string, values: readonly Literal[]): Record<string, Literal> {
    const cells: Record<string, Literal> = {};
    for (const [i, value] of values.entries()) if (value !== '') cells[`${label}${i + 1}`] = value;
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
    ...down('D', ['k1', 'k2', 'k3', 'k4']),
    ...down('E', [10, 20, 30, 40]),
};
const STATISTICAL: Cells = {
    ...COMMON,
    ...down('D', [3, 1, 4, 1, 5, 9, 2, 6]),
    ...down('E', [3, 'x', '', true, 5, '=1/0', 2, '7']),
    ...down('F', ['x', 'y', 'z']),
    ...down('G', [10, 20, '=1/0', '=SUBTOTAL(9,D1:D3)', 40, 50]),
    ...down('H', [2, 7, 1, 8, 2, 8, 1, 8]),
    ...down('I', [1, 2, 3, 4, 5, 6, 7, 8]),
    ...down('J', [5, 5, 5, 5, 5]),
    ...down('K', [1, 2, '=NA()', 4, 5, 6, 7, 8]),
    ...down('N', [1, 1, 2, 2, 3, 4]),
};
const TEXT: Cells = {
    ...COMMON,
    ...down('D', [
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
    ...down('D', [
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
    ...down('F', [45002, 'x', '', '=1/0', 45002, 45003]),
    ...down('G', [45002, 45003, 45003]),
};
const TENS = down('A', [10, 20, 30, 40, 50]);
const F1: Cells = {
    ...down('A', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
    ...down('B', [40, 50, 60]),
    ...down('C', [0.1, 0.2, -0.3]),
    D1: '=TRUE',
    D2: '="TRUE"',
    ...down('E', [1, '=1/0', 3]),
};
const B10: Cells = {
    ...TENS,
    ...down('B', [40, 50, 60]),
    ...down('C', [0.1, 0.2, -0.3]),
    D1: '=TRUE',
    E1: 1,
    E2: '=1/0',
    E3: 3,
    G1: 'abc',
    H1: '=""',
};
const X12: Cells = { A1: 1, B1: 2, A2: 3, B2: 4 };
const B12: Cells = {
    ...down('A', [10, 20, 30]),
    ...down('B', [40, 50, 60]),
    ...down('D', ['k1', 'k2', 'k3', 'k4']),
    ...down('E', [10, 20, 30, 40]),
    G5: 'abc',
};
const PAIR: Cells = { ...TENS, ...down('B', [12, 19, 33, 38, 55]) };
const { A3: _, ...PAIR_WITHOUT_A3 } = PAIR;
const HUGE: Cells = { A1: 1e200, A2: 1e200, B1: 1e200, B2: 1e200, C1: 1e200, C2: -1e200, F1: 0 };

// Per file, the fixture of each row: the first pattern that matches its section's heading and its first cell, as
// `heading / cell`, wins.
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
                            ...down('A', [10, 20, '', 40, 50]),
                            ...down('B', ['a', 'b', 'c', 'd', 'e']),
                            ...down('D', [1, '="3"', 5, '', 3]),
                            ...down('E', [0, 1, 2, 'x']),
                            ...down('G', [-100, 30, 40, 50, 60]),
                            ...down('I', [10, 20, 30, '=1/0', 50]),
                            ...down('J', ['a', 'b', 'c', 'd', 'e']),
                        },
                        hostName: 'b6_f2',
                    },
                ],
                [/^Group 5:/, { host: { ...HUGE, G1: 'x', H1: true, J1: 5 }, hostName: 'b6_ovf' }],
                [
                    /^Group 6:/,
                    {
                        host: {
                            ...down('A', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
                            ...down('B', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
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
                            ...down('A', [1, 2, 4, 3, 5, 7]),
                            ...down('B', [2, 1, 5, 4, 6, 9]),
                            ...down('H', [1, '=1/0', 3]),
                            ...down('I', ['=TRUE', 2, 3]),
                            ...down('J', [1, 2, 3]),
                            ...down('K', ['x', 2, 3]),
                            ...down('L', [1, '=""', 3]),
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
                [/^Group 5.* \/ 5\.1[3-6]$/, { host: { A2: '=""', A3: 0, A4: 'x' }, hostName: 'b10_cnt' }],
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
                            ...down('A', [1.1, 2.3, 2.9, 4.2, 5.7, 6.1]),
                            ...down('B', [2.2, 3.9, 6.1, 8.3, 9.8, 12.4]),
                            ...down('C', [1000000.1, 1000000.3, 1000000.2, 1000000.7, 1000000.5, 1000000.9]),
                            ...down('D', [0.1, 0.7, 0.2, 0.9]),
                            ...down('E', [3, 1, 4, 1]),
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
    const range = parseA1Range(label);
    if (!range) throw new Error(`${label} is no cell`);
    return [range.start.row, range.start.column];
}

// The host cell's value for each formula, each in a fresh engine on the fixture, with every sheet the formula names.
function evaluateAll(formulas: readonly string[], fixture: Fixture, named: readonly string[]): (Literal | null)[] {
    const hostName = fixture.hostName ?? named[0] ?? 'Sheet1';
    const others: Record<string, Cells> = { ...fixture.others };
    for (const name of named) if (name !== hostName && !(name in others)) others[name] = fixture.host;
    if (Object.keys(others).length === 0) others.Sheet2 = fixture.host;
    const sheets = [{ id: 's1', name: hostName }, ...Object.keys(others).map((name, i) => ({ id: `o${i}`, name }))];
    const find = sheetFinder(sheets);
    const fill = (sink: CellSink, cells: Cells) => {
        for (const [label, input] of Object.entries(cells)) {
            const [row, at] = cellAt(label);
            const text = typeof input === 'string' && input.startsWith('=') ? storedText(input, row, at, find) : null;
            sink(row, at, text === null ? input : null, text);
        }
    };
    const [hostRow, hostColumn] = cellAt(HOST);
    return formulas.map((formula) => {
        const text = storedText(formula, hostRow, hostColumn, find);
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
                cells: (sink: CellSink) => fill(sink, cells),
            })),
        ]);
        engine.recalc(Number.POSITIVE_INFINITY, NOW, 7);
        return engine.valueOf('s1', hostRow, hostColumn);
    });
}

export function shown(value: Literal | null): string {
    if (value === null) return '';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return typeof value === 'object' ? value.text : String(value);
}

function equalsRecorded(ours: Literal | null, expected: Expected): boolean {
    const { type, text } = expected;
    if (expected.quoted || type === '2') return ours === text;
    if (type === '4') return typeof ours === 'boolean' && shown(ours) === text;
    if (type === '16') return ours !== null && typeof ours === 'object' && ours.text === text;
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
    if (type === '1') return false;
    if (ours === null) return text === '';
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
        if (CALLS_VOLATILE.test(formula)) return skip('volatile (RAND, NOW, TODAY)');
        const sheets = [...new Set(formula.match(/b\d+_[a-z]+\d*/g) ?? [])].sort();
        const done = (ours: string, equal: boolean, asZero = equal) =>
            outcomes.push({ file: tag, section, formula, excel, ours, equal, blank: !equal && asZero });
        if (!('rows' in expected)) {
            const [value] = evaluateAll([formula], fixture, sheets);
            const quote = typeof value === 'string' && expected.type !== '2' && !expected.quoted;
            const equal = equalsRecorded(value, expected);
            return done(quote ? `"${value}"` : shown(value), equal, value === null && equalsRecorded(0, expected));
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
        const [, ours, ...values] = evaluateAll([formula, size, ...indexes], fixture, sheets);
        const sized = shown(ours);
        const equal = sized === wanted && elements.every((element, i) => equalsRecorded(values[i], element));
        const asZero = sized === wanted && elements.every((element, i) => equalsRecorded(values[i] ?? 0, element));
        return done(`{${values.map(shown).join(',')}} ${sized}`, equal, asZero);
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
        const row = `${section} / ${cells[0]}`;
        const fixture = (plan.find(([pattern]) => pattern.test(row)) ?? plan[plan.length - 1])[1];
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
                    // ARRAYTOTEXT errs on some answers TYPE calls no error, such as a blank one; then what the
                    // formula's own cell shows, in the notes, is its answer.
                    const shows = /\bcell shows `([^`]*)`/.exec(notes)?.[1];
                    const text = type !== '16' && excel.startsWith('#') && shows !== undefined ? shows : excel;
                    record(
                        section,
                        formula,
                        fixture,
                        { text, type: type && ['1', '2', '4', '16'].includes(type) ? type : undefined },
                        text,
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

// The table of counts per file, and the differing rows, one per line.
export function rowsMode(dir: string): { readonly report: string; readonly differing: string } {
    const outcomes: Outcome[] = [];
    const skipped = new Map<string, number>();
    const lines = ['| file | run | equal | differs | of them, the blank pick | skipped |', '|---|---|---|---|---|---|'];
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
        const blank = run.filter((outcome) => outcome.blank).length;
        const skips = [...skipped].filter(([why]) => why.startsWith(`${tag}: `));
        const skipText = skips.map(([why, count]) => `${why.slice(tag.length + 2)} ${count}`).join('; ');
        lines.push(`| ${name} | ${run.length} | ${equal} | ${run.length - equal} | ${blank} | ${skipText} |`);
    }
    const equal = outcomes.filter((outcome) => outcome.equal).length;
    const blank = outcomes.filter((outcome) => outcome.blank).length;
    lines.push(
        `| total | ${outcomes.length} | ${equal} | ${outcomes.length - equal} | ${blank} | ${[...skipped.values()].reduce((a, b) => a + b, 0)} |`,
    );
    if (unplanned.length > 0)
        lines.push(
            '',
            `Not run, no fixture plan here (their fixtures are prose in each file): ${unplanned.join(', ')}.`,
        );
    const differing = outcomes
        .filter((outcome) => !outcome.equal)
        .map(
            (o) =>
                `[${o.file} / ${o.section.slice(0, 60)}] ${o.formula} | Excel ${o.excel} | ours ${o.ours}${o.blank ? ' | pick: blank' : ''}`,
        );
    return { report: lines.join('\n'), differing: differing.join('\n') };
}
