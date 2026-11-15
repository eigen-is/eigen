// Builders for the workbook's tests: a seeded random source, random snapshots that say things the long way round
// (equal neighbouring runs and bands, looks listed twice or never worn, sheets out of tab order), and the canonical
// form of a snapshot worked out here from plain data, without the workbook's own parts.

import { GRID_COLUMNS, GRID_ROWS } from '@workspace/formula/text';
import type { BookContent } from '@workspace/lib/sheets/book-codec';
import type {
    CellAttrs,
    CellRecord,
    LineAttrs,
    LinesOp,
    MoveOp,
    Placed,
    Rect,
    Run,
    SheetContent,
    Span,
} from '@workspace/lib/sheets/ops';
import { LOOK_KEYS } from '@workspace/lib/sheets/ops';
import type { CellLink } from '@workspace/lib/sheets/types';
import { chartOf, formulaRule, ref } from './records-fixtures';

export type Random = () => number;
export type Book = BookContent;

export function randomOf(seed: number): Random {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The op of a line insert or delete on sheet S, its new lines plain when `like` is below 0.
export function linesOp(rows: boolean, insert: boolean, index: number, count: number, like = -1): LinesOp {
    return { kind: 'lines', sheet: 'S', rows, insert, index, count, ...(like >= 0 && { like }) };
}

// The op of a block of sheet S moved to (toRow, toColumn), on S or on `toSheet`.
export function moveOp(from: Rect, toRow: number, toColumn: number, toSheet = 'S'): MoveOp {
    return { kind: 'move', sheet: 'S', from, toSheet, toRow, toColumn };
}

export function below(random: Random, n: number): number {
    return Math.floor(random() * n);
}

function pick<T>(random: Random, list: readonly T[]): T {
    return list[below(random, list.length)];
}

// A random ascending choice of the lines offered.
function someOf(random: Random, lines: readonly number[], most: number): number[] {
    const count = below(random, most + 1);
    return lines.filter(() => random() < count / lines.length);
}

const SIDE = { style: 1, color: '#000000' };
// The plain look listed as a look, one look said with its keys in two orders, and every key somewhere.
const LOOKS: readonly CellAttrs[] = [
    {},
    { bl: 1 },
    { it: 1, fc: '#ff0000' },
    { fc: '#ff0000', it: 1 },
    { bg: '#00ff00', bdt: SIDE },
    { fa: '0.00', ht: 1, vt: 2 },
    { fs: 12, ff: 'Inter', un: 1, cl: 1 },
    { rt: 'vertical', tb: '2', bdb: { style: 2, color: '#111111' }, bdl: SIDE, bdr: SIDE, bdd: SIDE },
];
const LINE_KEYS: readonly LineAttrs[] = [
    {},
    { size: 30 },
    { size: 30, custom: 1 },
    { hidden: 1 },
    { size: 12.5, custom: 1, hidden: 1 },
];
// Stored texts the engine keeps as they are: its own spelling, a text that does not parse, and a formula it cannot
// evaluate, which keeps the value it came with.
export const FORMULAS: readonly string[] = [
    '=R[1]C+1',
    '=SUM(R1C1:R5C1)',
    '=[s0]!R1C1*2',
    '=NOW()',
    '=RC[1]&"x"',
    '=1+',
    "='[b.xlsx]S'!R1C1",
];
const LINKS: readonly CellLink[] = [
    { type: 'webpage', address: 'https://eigen.is' },
    { type: 'cellrange', address: 'A1:B2' },
];
const RUNS: readonly Run[][] = [
    [{ v: 'plain' }],
    [
        { v: 'bold ', bl: 1 },
        { v: 'and red', fc: '#ff0000', fs: 14 },
    ],
    [{ v: '' }, { v: 'x', it: 1, un: 1, cl: 1, ff: 'Inter' }, { v: 'y' }],
];

function randomCell(random: Random): CellRecord {
    const f = pick(random, FORMULAS);
    const cell: CellRecord = pick<() => CellRecord>(random, [
        () => ({ v: below(random, 2000) / 8 - 100 }),
        () => ({ v: pick(random, ['text', '', '#N/A', '=not a formula']) }),
        () => ({ v: random() < 0.5 }),
        () => ({ v: pick(random, ['#DIV/0!', '#REF!', '#ERROR!', '#BUSY!', '#GETTING_DATA']), e: 1 }),
        () => ({ v: below(random, 100), f }),
        () => ({ v: pick(random, ['a', '']), f }),
        () => ({ v: false, f }),
        () => ({ v: pick(random, ['#N/A', '#REF!', '#FIELD!']), e: 1, f }),
        () => ({ f }),
        () => ({ s: pick(random, RUNS) }),
        () => ({ v: 'typed with a quote', qp: 1 }),
        () => (random() < 0.5 ? { link: pick(random, LINKS) } : { qp: 1 }),
    ])();
    if (random() < 0.15) cell.link = pick(random, LINKS);
    return cell;
}

function randomLines(random: Random): [Span, LineAttrs][] {
    const runs: [Span, LineAttrs][] = [];
    let line = below(random, 3);
    for (let i = below(random, 6); i > 0; i -= 1) {
        const last = line + below(random, 3);
        runs.push([[line, last], pick(random, LINE_KEYS)]);
        line = last + 1 + (random() < 0.5 ? 0 : below(random, 3));
    }
    return runs;
}

function randomSheet(random: Random, at: number): SheetContent {
    const id = `s${at}`;
    const cells: Placed<CellRecord>[] = [];
    for (const column of someOf(random, [0, 1, 2, 3, 7, 40, GRID_COLUMNS - 1], 5)) {
        const far = random() < 0.05 ? [100_000] : [];
        for (const row of [...someOf(random, [0, 1, 2, 3, 4, 5, 8, 13, 60], 6), ...far]) {
            cells.push([row, column, randomCell(random)]);
        }
    }
    const looks = Array.from({ length: below(random, 6) }, () => pick(random, LOOKS));
    const bands: number[] = [];
    for (const first of someOf(random, [0, 1, 2, 5, 9, GRID_COLUMNS - 1], 5)) {
        const starts = someOf(random, [0, 1, 2, 3, 7, 20, GRID_ROWS - 1], 5);
        bands.push(first, starts.length, ...starts.flatMap((start) => [start, below(random, looks.length + 1)]));
    }
    const records: SheetContent['records'] = random() < 0.3 ? { merge: {}, chart: {} } : {};
    if (random() < 0.5) records.merge = { [`${id}m2`]: { rect: [0, 0, 1, 1] }, [`${id}m1`]: { rect: [5, 5, 5, 9] } };
    if (random() < 0.5) {
        records.filter = { f: { rect: [2, 0, 20, 4] } };
        records.filterColumn = { k1: { filter: 'f', column: 1, rows: [[3, 4]] } };
        if (random() < 0.5) {
            records.filterColumn.k0 = {
                filter: 'f',
                column: 0,
                condition: { name: 'values', values: ['a'] },
                rows: [],
            };
        }
    }
    if (random() < 0.5) records.comment = { [`${id}c9`]: { row: 3, column: 1 }, [`${id}c10`]: { row: 3, column: 1 } };
    if (random() < 0.5) {
        records.conditionalFormat = { r1: formulaRule([[0, 0, 9, 0]], '=RC>1') };
    }
    if (random() < 0.5) {
        const rule = { type: 'dropdown', type2: '', value1: 'a,b', value2: '' };
        records.validation = { v1: { ranges: [[0, 2, 3, 2]], order: 'a1', rule } };
    }
    if (random() < 0.5) {
        records.image = { i1: { index: 'a0', x: 1, y: 2, width: 30, height: 40, mediaName: `${id}.png` } };
    }
    if (random() < 0.5) {
        const values = ref(id, [0, 4], [0, 0]);
        records.chart = { c: chartOf({ categories: null, series: [{ id: 's', name: 'n', values }] }) };
    }
    const fields: SheetContent['fields'] = { name: `Sheet ${at}`, order: pick(random, ['a0', 'a1', 'a2']) };
    if (random() < 0.3) fields.frozenRows = 1 + below(random, 3);
    if (random() < 0.2) fields.color = '#123456';
    return { id, fields, cells, looks, bands, rows: randomLines(random), columns: randomLines(random), records };
}

export function randomBook(random: Random): Book {
    const sheets = Array.from({ length: 1 + below(random, 4) }, (_, at) => randomSheet(random, at));
    // The sheets come in any order: their fields say where their tabs stand. A shuffle draws once per sheet, where a
    // sort by a random comparison draws as often as the runtime's sort asks, so a seed gave no one book.
    for (let at = sheets.length - 1; at > 0; at -= 1) {
        const other = below(random, at + 1);
        [sheets[at], sheets[other]] = [sheets[other], sheets[at]];
    }
    const now = 40_000 + below(random, 9000) / 7;
    return { g: below(random, 9), now, seed: below(random, 2 ** 31), computed: false, sheets };
}

function lookKey(look: CellAttrs): string {
    return JSON.stringify(LOOK_KEYS.map((key) => look[key] ?? null));
}

// The bands column by column from the looks the flat form names: each band as its first column and its runs of
// (start row, look), the looks by their keys, with nothing said twice.
function canonicalBands(sheet: SheetContent): { looks: CellAttrs[]; bands: number[] } {
    const named = [{}, ...sheet.looks];
    const bands: { first: number; runs: [number, CellAttrs][] }[] = [{ first: 0, runs: [] }];
    for (let at = 0; at < sheet.bands.length; at += 2 + 2 * sheet.bands[at + 1]) {
        const runs: [number, CellAttrs][] = [[0, {}]];
        for (let i = at + 2; i < at + 2 + 2 * sheet.bands[at + 1]; i += 2) {
            const look = named[sheet.bands[i + 1]];
            const last = runs[runs.length - 1];
            if (sheet.bands[i] === 0) last[1] = look;
            else if (lookKey(last[1]) !== lookKey(look)) runs.push([sheet.bands[i], look]);
        }
        const band = {
            first: sheet.bands[at],
            runs: runs.length === 1 && lookKey(runs[0][1]) === lookKey({}) ? [] : runs,
        };
        const last = bands[bands.length - 1];
        const same = JSON.stringify(last.runs.map(([start, look]) => [start, lookKey(look)]));
        if (band.first === 0) bands[0] = band;
        else if (same !== JSON.stringify(band.runs.map(([start, look]) => [start, lookKey(look)]))) bands.push(band);
    }
    const looks: CellAttrs[] = [];
    const indexes = new Map([[lookKey({}), 0]]);
    const flat: number[] = [];
    for (const { first, runs } of bands) {
        flat.push(first, runs.length);
        for (const [start, look] of runs) {
            if (!indexes.has(lookKey(look))) indexes.set(lookKey(look), looks.push(look));
            flat.push(start, indexes.get(lookKey(look)) ?? 0);
        }
    }
    return { looks, bands: flat };
}

function canonicalLines(runs: SheetContent['rows']): [Span, LineAttrs][] {
    const joined: [[number, number], LineAttrs][] = [];
    for (const [[first, last], attrs] of runs) {
        if (Object.keys(attrs).length === 0) continue;
        const end = joined[joined.length - 1];
        const same = (key: keyof LineAttrs) => end[1][key] === attrs[key];
        if (end && end[0][1] + 1 === first && same('size') && same('custom') && same('hidden')) end[0][1] = last;
        else joined.push([[first, last], attrs]);
    }
    return joined;
}

// What a workbook loaded from the snapshot walks back to, when every formula text is the engine's own spelling. It
// is computed while no formula waits: a load that is not computed computes every formula, and one that is computes a
// formula that holds #REF!.
export function canonical(book: Book): Book {
    const sheets = book.sheets.toSorted((a, b) =>
        a.fields.order !== b.fields.order ? (a.fields.order < b.fields.order ? -1 : 1) : a.id < b.id ? -1 : 1,
    );
    const waits = ({ f, v, e }: CellRecord) => f !== undefined && (!book.computed || (e === 1 && v === '#REF!'));
    return {
        ...book,
        computed: !sheets.some(({ cells }) => cells.some(([, , cell]) => waits(cell))),
        sheets: sheets.map((sheet) => ({
            ...sheet,
            ...canonicalBands(sheet),
            rows: canonicalLines(sheet.rows),
            columns: canonicalLines(sheet.columns),
            records: Object.fromEntries(Object.entries(sheet.records).filter(([, of]) => Object.keys(of).length > 0)),
        })),
    };
}

// The same document said another way: the sheets, the records and the listed looks in reverse.
export function reversed(book: Book): Book {
    return {
        ...book,
        sheets: book.sheets.toReversed().map((sheet) => {
            const bands = [...sheet.bands];
            for (let at = 0; at < bands.length; at += 2 + 2 * bands[at + 1]) {
                for (let i = at + 3; i < at + 2 + 2 * bands[at + 1]; i += 2) {
                    if (bands[i] > 0) bands[i] = sheet.looks.length + 1 - bands[i];
                }
            }
            const records = Object.fromEntries(
                Object.entries(sheet.records)
                    .toReversed()
                    .map(([type, of]) => [type, Object.fromEntries(Object.entries(of).toReversed())]),
            );
            return { ...sheet, looks: sheet.looks.toReversed(), bands, records };
        }),
    };
}
