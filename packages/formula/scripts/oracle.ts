// The engine against Excel, in two modes. `rows` runs every row Excel answered in the recorded oracle files through
// a fresh Engine on that file's fixture and counts per file what is equal and what differs. `corpus` loads every
// workbook of a corpus with the values Excel cached, recalculates it, and sorts each formula cell into four columns:
// equal, differs, not built, not comparable; it attributes differences to the engine's decided picks and lists the
// rest. Both run on Bun, or on Node from a bundle. A run with --help prints its usage and the rules it counts by.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Literal, SheetSource } from '../src/index';
import { Engine, FUNCTIONS } from '../src/index';
import { isExcelFunction } from '../src/names';
import type { FormulaNode } from '../src/text';
import { GRID_COLUMNS, GRID_ROWS, NodeKind, printA1, RefFlag, RefKind, SheetKind, Token, toA1 } from '../src/text';
import { rowsMode, shown, VOLATILE } from './oracle-rows';
import type { Book, BookCell } from './xlsx';
import { readBook, sourcesOf } from './xlsx';

const USAGE = `bun packages/formula/scripts/oracle.ts rows <oracle dir> [--out <file>]
bun packages/formula/scripts/oracle.ts corpus <dir or file>... [--out <file>] [--timeout <s>]
node: bun build --target node packages/formula/scripts/oracle.ts --outfile /tmp/oracle.mjs, then node /tmp/oracle.mjs ...

rows: every row with Excel's answer in the oracle's family and batch files that have a fixture plan here, each in a
fresh engine; numbers equal at 15 significant digits. Skipped: rows Excel refused at entry and volatile ones.
A differing row is on the blank pick when ours is blank where Excel shows 0. --out gets the differing rows.

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
  blank        ours is blank where the file cached 0, as Excel stores a blank result, or ours is 0 where the file
               cached an empty text, and ISBLANK of its formula over the computed values is TRUE
The rest is the residue, by function: a cell counts under every function it calls.
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

const PICKS = ['empty text', 'day line', 'MATCH -1', 'approximate', 'blank'] as const;
type Pick = (typeof PICKS)[number];
const RESIDUE = 'residue';
// The writers whose cached values are Excel's own; openpyxl, for one, calls itself "Microsoft Excel Compatible".
const EXCEL = /^Microsoft (Macintosh )?Excel( Online)?$/;
const VOLATILE_CALLS = new Set([...VOLATILE, 'CELL', 'INFO']);
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
function sameValue(ours: Literal | null, cached: Literal, digits: number): boolean {
    if (typeof cached === 'number') {
        if (typeof ours !== 'number') return false;
        const unit = 10 ** (Math.floor(Math.log10(Math.max(Math.abs(ours), Math.abs(cached)))) - digits + 1);
        const rounded = Number(ours.toPrecision(digits)) === Number(cached.toPrecision(digits));
        return ours === cached || rounded || Math.abs(ours - cached) <= 0.5000001 * unit;
    }
    if (typeof cached === 'object') return ours !== null && typeof ours === 'object' && ours.text === cached.text;
    if (ours === null) return cached === '';
    return ours === cached;
}

function kindOf(value: Literal | null): string {
    if (value !== null && typeof value === 'object') return value.text;
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
    // The differing cells with no pick of their own whose value is a blank on one side and a 0 on the other.
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
            continue;
        }
        const pick = pickOf(formula, ours, cached, value);
        if (pick === undefined && ((ours === null && cached === 0) || (ours === 0 && cached === ''))) {
            candidates.push(formula);
        } else differing.set(sheet, cell.row, cell.column, pick ?? '');
    }
    // A candidate that only copies a differing cell is no blank of its own, and takes its root's label below.
    const blanks = blankResults(book, engine, candidates);
    for (const { sheet, cell } of candidates) {
        differing.set(sheet, cell.row, cell.column, blanks.has(keyOf(sheet, cell.row, cell.column)) ? 'blank' : '');
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
    ours: Literal | null,
    cached: Literal,
    value: (sheet: number, row: number, column: number) => Literal | null,
): Pick | undefined {
    const { facts: own, rects } = formula;
    const refused = typeof cached === 'object' && cached.text === '#VALUE!';
    const reads = rects.some((rect) => anyCell(rect, (row, column) => value(rect.sheet, row, column) === ''));
    const typed = own.emptyText && own.arithmetic && (refused || cached === '');
    if ((reads && (own.arithmetic || refused)) || typed) return 'empty text';
    if ([...own.calls].some((name) => DATE_CALLS.has(name))) {
        const early = (v: Literal | null) => v === null || (typeof v === 'number' && v >= 0 && v < 61);
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
        let last: Literal | null = null;
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
    return undefined;
}

// The candidates whose own formula gives a blank, by their keys: each asks ISBLANK of its formula, in an engine
// where every other formula is the value it computed.
function blankResults(book: Book, engine: Engine, candidates: readonly Formula[]): Set<number> {
    if (candidates.length === 0) return new Set();
    const probes = new Set(candidates.map(({ sheet, cell }) => keyOf(sheet, cell.row, cell.column)));
    const sources: SheetSource[] = book.sheets.map((sheet, place) => ({
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
    const probe = new Engine(sources);
    probe.recalc(Number.POSITIVE_INFINITY);
    const blank = candidates.filter(
        ({ sheet, cell }) => probe.valueOf(book.sheets[sheet].id, cell.row, cell.column) === true,
    );
    return new Set(blank.map(({ sheet, cell }) => keyOf(sheet, cell.row, cell.column)));
}

function corpusMode(paths: readonly string[]): string {
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
    const reports: BookReport[] = [];
    const failed: string[] = [];
    for (const file of files.sort()) {
        const child = spawnSync(process.execPath, [process.argv[1], '--book', file], {
            encoding: 'utf8',
            maxBuffer: 1 << 28,
            timeout: Number(options.timeout) * 1000,
        });
        const last = child.stdout.trim().split('\n').pop() ?? '';
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
        ...PICKS.map((pick) => `| pick: ${pick} | ${sum((report) => report.picks[pick])} |`),
        `| residue, roots (read no differing cell) | ${sum((report) => report.residueRoots)} |`,
        `| residue, downstream of a root | ${sum((report) => report.residueDownstream)} |`,
        '',
        `MATCH -1 (and descending XMATCH, XLOOKUP) is used by ${sum((report) => report.matchDescending)} formula cells.`,
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
        '| workbook | written by | formulas | equal | differs | not built | not comparable | picks (empty text, day line, MATCH -1, approximate, blank) | residue roots | s |',
        '|---|---|---|---|---|---|---|---|---|---|',
        ...reports.map(
            (report) =>
                `| ${path.basename(report.file).slice(-60)} | ${report.application} | ${report.formulas} | ${report.equal} | ${report.differs} | ${report.notBuilt} | ${report.notComparable} | ${PICKS.map((pick) => report.picks[pick]).join(', ')} | ${report.residueRoots} | ${report.seconds.toFixed(1)} |`,
        ),
        '',
        ...failed.map((line) => `- could not be run: ${line}`),
    ];
    return lines.join('\n');
}

const [mode, ...rest] = positionals;
if (options.book !== undefined) {
    console.log(JSON.stringify(bookMode(options.book)));
} else if (options.help || (mode !== 'rows' && mode !== 'corpus') || rest.length === 0) {
    console.log(USAGE);
} else {
    const rows = mode === 'rows' ? rowsMode(rest[0]) : null;
    const report = rows?.report ?? corpusMode(rest);
    if (options.out !== undefined) fs.writeFileSync(options.out, `${rows?.differing ?? report}\n`);
    console.log(report);
}
