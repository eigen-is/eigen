// Reads an xlsx workbook from disk into what the engine loads, for the bench and the oracle scripts beside it: each
// sheet's cells with the values Excel cached, and every formula through the xlsx dialect, defined names put in
// place first, table references resolved, the @ of a plain formula added, a shared formula's followers given their
// master's stored text. The file is untrusted data that is only read: the zip is opened with node:zlib and the
// XML read with regular expressions, which is all a script needs and no package to install.

import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { FUNCTIONS } from '../src/functions/library';
import type { Literal, SheetSource } from '../src/index';
import { errorOf } from '../src/index';
import type { FormulaNode, Table } from '../src/text';
import {
    intersect,
    parseA1Range,
    parseXlsx,
    printStored,
    resolveTables,
    sheetFinder,
    Token,
    tokens,
} from '../src/text';

export type BookFormula = {
    // The tree the engine loads and its stored text, or null with the reason the file's text could not be loaded.
    readonly tree: FormulaNode | null;
    readonly stored: string | null;
    readonly refused: string;
    // Whether a defined name was put in place of a word of the text.
    readonly named: boolean;
};

export type BookCell = {
    readonly row: number;
    readonly column: number;
    // For a formula, the value Excel last computed; null when the file has none.
    readonly value: Literal | null;
    readonly formula: BookFormula | null;
};

export type BookSheet = { readonly id: string; readonly name: string; readonly cells: readonly BookCell[] };

export type Book = {
    readonly sheets: readonly BookSheet[];
    // The defined names, in lower case.
    readonly names: ReadonlySet<string>;
    // The program that wrote the file and its cached values, such as Microsoft Excel; empty when it does not say.
    readonly application: string;
    // The file's calculation settings: iterative calculation, and dates counted from 1904.
    readonly iterate: boolean;
    readonly date1904: boolean;
};

type Names = Map<string, { global: string | undefined; local: Map<number, string> }>;

const REFERENCE_TOKENS = new Set<number>([Token.Name, Token.Word, Token.Quote]);
const DEEPEST_NAME = 8;
const ENTITIES = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
]);

export function readBook(path: string): Book {
    const zip = openZip(fs.readFileSync(path));
    const workbook = zip('xl/workbook.xml') ?? '';
    const targets = relationships(zip, 'xl/workbook.xml');
    const strings = sharedStrings(zip('xl/sharedStrings.xml') ?? '');
    const listed = [...workbook.matchAll(/<(?:\w+:)?sheet\b([^>]*)\/?>/g)].map((match, place) => ({
        id: `s${place}`,
        name: decodeXml(attribute(match[1], 'name') ?? ''),
        part: targets.get(attribute(match[1], 'r:id') ?? '') ?? '',
    }));
    const names: Names = new Map();
    for (const match of workbook.matchAll(/<(?:\w+:)?definedName\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?definedName>/g)) {
        const key = (attribute(match[1], 'name') ?? '').toLowerCase();
        const entry = names.get(key) ?? { global: undefined, local: new Map<number, string>() };
        const scope = attribute(match[1], 'localSheetId');
        if (scope === undefined) entry.global = decodeXml(match[2]);
        else entry.local.set(Number(scope), decodeXml(match[2]));
        names.set(key, entry);
    }
    const parts = listed.map((sheet) => (sheet.part.includes('/worksheets/') ? (zip(sheet.part) ?? '') : ''));
    const tables: Table[] = [];
    const tableNames = new Map<string, Table>();
    for (const [place, sheet] of listed.entries()) {
        if (parts[place] === '') continue;
        for (const [, target] of relationships(zip, sheet.part)) {
            const xml = target.includes('/tables/') ? zip(target) : undefined;
            const head = xml && /<(?:\w+:)?table\b([^>]*)>/.exec(xml);
            const range = head ? parseA1Range(attribute(head[1], 'ref') ?? '') : null;
            if (!xml || !head || !range) continue;
            const table: Table = {
                sheet: sheet.id,
                top: range.start.row,
                left: range.start.column,
                bottom: range.end.row,
                right: range.end.column,
                headerRows: Number(attribute(head[1], 'headerRowCount') ?? 1),
                totalsRows: Number(attribute(head[1], 'totalsRowCount') ?? 0),
                columns: [...xml.matchAll(/<(?:\w+:)?tableColumn\b([^>]*?)\/?>/g)].map((column) =>
                    unescapeText(decodeXml(attribute(column[1], 'name') ?? '')),
                ),
            };
            tables.push(table);
            for (const key of ['name', 'displayName']) {
                const name = attribute(head[1], key);
                if (name !== undefined) tableNames.set(decodeXml(name).toLowerCase(), table);
            }
        }
    }
    const findSheet = sheetFinder(listed);
    const findTable = (name: string, sheet: string, row: number, column: number) =>
        name === ''
            ? tables.find(
                  (table) =>
                      table.sheet === sheet &&
                      row >= table.top &&
                      row <= table.bottom &&
                      column >= table.left &&
                      column <= table.right,
              )
            : tableNames.get(name.toLowerCase());
    const sheets = listed.map((sheet, place) => {
        const cells: BookCell[] = [];
        const masters = new Map<string, BookFormula>();
        let row = -1;
        for (const line of parts[place].matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
            const written = attribute(line[1], 'r');
            row = written === undefined ? row + 1 : Number(written) - 1;
            let column = -1;
            for (const cell of (line[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
                const at = attribute(cell[1], 'r');
                column = at === undefined ? column + 1 : (parseA1Range(at)?.start.column ?? column + 1);
                const inner = cell[2] ?? '';
                const value = literalOf(attribute(cell[1], 't'), inner, strings);
                const f = /<(?:\w+:)?f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?f>)/.exec(inner);
                if (!f) {
                    if (value !== null) cells.push({ row, column, value, formula: null });
                    continue;
                }
                const kind = attribute(f[1], 't') ?? 'normal';
                const shared = kind === 'shared' ? (attribute(f[1], 'si') ?? '') : '';
                let formula: BookFormula;
                if (kind === 'dataTable') formula = refused('a data table');
                else if (f[2] === undefined || f[2] === '') formula = masters.get(shared) ?? refused('no text');
                else {
                    const plain = kind !== 'array' && attribute(cell[1], 'cm') === undefined;
                    const text = decodeXml(f[2]);
                    const named = withNames(text, place, names, listed, 0);
                    const parsed = parseXlsx(named, row, column, findSheet);
                    if ('reason' in parsed) formula = refused(`the parser refuses it (${parsed.reason})`);
                    else {
                        const resolved = resolveTables(parsed, sheet.id, row, column, findTable);
                        const tree = plain ? intersect(resolved, FUNCTIONS) : resolved;
                        formula = { tree, stored: printStored(tree), refused: '', named: named !== text };
                    }
                    if (shared !== '') masters.set(shared, formula);
                }
                cells.push({ row, column, value, formula });
            }
        }
        return { id: sheet.id, name: sheet.name, cells };
    });
    return {
        sheets,
        names: new Set(names.keys()),
        application: decodeXml(/<(?:\w+:)?Application>([^<]*)</.exec(zip('docProps/app.xml') ?? '')?.[1] ?? ''),
        iterate: /<(?:\w+:)?calcPr\b[^>]*\biterate="(?:1|true)"/.test(workbook),
        date1904: /<(?:\w+:)?workbookPr\b[^>]*\bdate1904="(?:1|true)"/.test(workbook),
    };
}

// The book as the engine loads it. With `stale`, every formula comes without its value, so a recalc computes all of
// them; a formula the dialect could not load comes as the value Excel cached.
export function sourcesOf(book: Book, stale: boolean): SheetSource[] {
    return book.sheets.map((sheet) => ({
        id: sheet.id,
        name: sheet.name,
        cells: (sink) => {
            for (const { row, column, value, formula } of sheet.cells) {
                const stored = formula?.stored ?? null;
                sink(row, column, stored !== null && stale ? null : value, stored);
            }
        },
    }));
}

function refused(reason: string): BookFormula {
    return { tree: null, stored: null, refused: reason, named: false };
}

// The text with each defined name it uses replaced by the name's own text in brackets, as an importer resolves names
// before the engine sees a formula. A name of the host's sheet wins over a workbook's name.
function withNames(
    text: string,
    place: number,
    names: Names,
    sheets: readonly { readonly name: string }[],
    depth: number,
): string {
    if (names.size === 0 || depth > DEEPEST_NAME) return text;
    const list = tokens(text);
    let out = '';
    let from = 0;
    for (let i = 0; i < list.length; i += 1) {
        const token = list[i];
        if (token.kind !== Token.Name) continue;
        const entry = names.get(text.slice(token.start, token.end).toLowerCase());
        if (entry === undefined) continue;
        let start = token.start;
        let scope = place;
        const sheet = list[i - 2];
        if (list[i - 1]?.kind === Token.Bang && sheet !== undefined && REFERENCE_TOKENS.has(sheet.kind)) {
            const qualifier = text.slice(sheet.start, sheet.end).replace(/^'|'$/g, '').replace(/''/g, "'");
            scope = sheets.findIndex((candidate) => candidate.name.toLowerCase() === qualifier.toLowerCase());
            start = sheet.start;
        }
        const own = entry.local.get(scope);
        const definition = own ?? (start === token.start ? entry.global : undefined);
        if (definition === undefined) continue;
        const inner = withNames(definition, own === undefined ? -1 : scope, names, sheets, depth + 1);
        out += `${text.slice(from, start)}(${inner})`;
        from = token.end;
    }
    return from === 0 ? text : out + text.slice(from);
}

function literalOf(type: string | undefined, inner: string, strings: readonly string[]): Literal | null {
    if (type === 'inlineStr') return unescapeText(textOf(inner));
    const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
    if (v === undefined) return type === 'str' && /<(?:\w+:)?v\s*\/>/.test(inner) ? '' : null;
    switch (type) {
        case 's':
            return strings[Number(v)] ?? null;
        case 'str':
            return unescapeText(decodeXml(v));
        case 'b':
            return v === '1' || v === 'true';
        case 'e':
            return errorOf(decodeXml(v));
        case 'd':
            return Date.parse(`${v.slice(0, 19)}Z`) / 86_400_000 + 25_569;
        default:
            return Number(v);
    }
}

function sharedStrings(xml: string): string[] {
    return [...xml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((item) => unescapeText(textOf(item[1])));
}

// The text of a string item, its runs joined, without the phonetic guide some East Asian files carry.
function textOf(item: string): string {
    const runs = item.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
    let text = '';
    for (const run of runs.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) text += decodeXml(run[1]);
    return text;
}

// The targets of a part's relationships by id, as paths inside the zip.
function relationships(zip: (name: string) => string | undefined, part: string): Map<string, string> {
    const slash = part.lastIndexOf('/');
    const folder = part.slice(0, slash);
    const xml = zip(`${folder}/_rels/${part.slice(slash + 1)}.rels`) ?? '';
    const targets = new Map<string, string>();
    for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
        const target = attribute(match[1], 'Target') ?? '';
        if (attribute(match[1], 'TargetMode') === 'External') continue;
        const path: string[] = target.startsWith('/') ? [] : folder.split('/');
        for (const step of target.split('/')) {
            if (step === '..') path.pop();
            else if (step !== '' && step !== '.') path.push(step);
        }
        targets.set(attribute(match[1], 'Id') ?? '', decodeURIComponent(path.join('/')));
    }
    return targets;
}

function attribute(attributes: string, name: string): string | undefined {
    return new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1];
}

// XML reads a line break written as CR LF, or a lone CR, as LF; a CR the text holds is written &#13;.
function decodeXml(text: string): string {
    return text.replace(/\r\n?/g, '\n').replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
        if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
        return ENTITIES.get(entity) ?? '';
    });
}

// A character XML cannot hold, as a file writes it in a text: _x000D_ for a carriage return.
function unescapeText(text: string): string {
    return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

// The parts of a zip by name, each inflated on first read. Only what an xlsx uses: stored or deflated, no zip64.
function openZip(bytes: Buffer): (name: string) => string | undefined {
    let end = bytes.length - 22;
    while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
    if (end < 0) throw new Error('Not a zip file');
    const entries = new Map<string, { method: number; size: number; offset: number }>();
    let at = bytes.readUInt32LE(end + 16);
    for (let i = bytes.readUInt16LE(end + 10); i > 0; i -= 1) {
        if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('Damaged zip directory');
        const nameLength = bytes.readUInt16LE(at + 28);
        const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
        entries.set(name.replace(/^\//, ''), {
            method: bytes.readUInt16LE(at + 10),
            size: bytes.readUInt32LE(at + 20),
            offset: bytes.readUInt32LE(at + 42),
        });
        at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    const decoder = new TextDecoder();
    return (name) => {
        const entry = entries.get(name);
        if (entry === undefined) return undefined;
        const start = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28);
        const data = bytes.subarray(start, start + entry.size);
        return decoder.decode(entry.method === 0 ? data : zlib.inflateRawSync(data));
    };
}
