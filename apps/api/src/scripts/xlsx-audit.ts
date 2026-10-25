// Audits an xlsx importer on a corpus: per file, the outcome, the import's wall time and peak RSS, what the imported
// sheets hold per feature beside what the package's XML holds, and a fingerprint per cell, so two runs compare file by
// file, feature by feature and cell by cell.
//
// Usage:
//   bun apps/api/src/scripts/xlsx-audit.ts run <corpus dir...> --out <dir> [--importer <module>] [--name <label>] [--timeout <s>] [--max-rss <MB>]
//   bun apps/api/src/scripts/xlsx-audit.ts compare <runA> <runB> [--heldout <list> --set tuned|heldout]
//   bun apps/api/src/scripts/xlsx-audit.ts roundtrip <corpus dir...> --out <dir> [--writer <module>] [--dump <dir>] [--timeout <s>] [--max-rss <MB>]
//   bun apps/api/src/scripts/xlsx-audit.ts split <corpus dir...> --out <list> [--real <key prefix>...] [--count <n>] [--seed <s>]
//
// The importer module exports `xlsxToSheets` with from-xlsx.ts's signature. Each file is imported in a child process of
// its own, handed the path as an argument, so the peak RSS is that import's alone and a hang or a blow-up is cut at the
// time or memory cap and recorded; nothing in a corpus is ever run. A file is keyed by its corpus dir's name and its
// path inside it. The fingerprints go to a gzipped file per file, and the text of each sheet's top-left corner to its
// result, so compare can show what differs; a run of a private corpus stays out of the repo.
//
// roundtrip is the xlsx writer's gate: each file the reader imports is written by the writer (`--writer`, writeXlsx's
// signature) and imported again, and the two imports are compared key by key. A difference is listed when LISTED
// explains it, else unlisted; the run passes with no crash, no cut and no unlisted difference. A file the first import
// refuses is skipped, so a reader that newly refuses one passes here: `compare` of two corpus runs catches that.
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isChartSpecKey, readChartSpec } from '@workspace/lib/charts';
import type { Cell, Sheet } from '@workspace/lib/sheets';
import { cellFontName, SHEET_DEFAULT_FONT, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import { parseA1Range, toA1, unquoteSheetName, valueIsError } from '@workspace/sheet/engine';
import { peakRss } from '../lib/core/peak-rss';
import type { TransformWarning } from '../lib/document/transform/protocol';
import { TRANSFORM_LIMITS } from '../lib/document/transform/runner';
import type { OfficeMedia } from '../lib/export/office-image';
import { sheetNames } from '../lib/export/sheets/xlsx/package';
import type { writeXlsx } from '../lib/export/sheets/xlsx/to-xlsx';
import type { xlsxToSheets } from '../lib/import/sheets/from-xlsx';
import { CONTENT_TYPES_NS, PACKAGE_RELATIONSHIPS_NS, R_NS, SML_NS } from '../lib/ooxml/ooxml';
import { uriReference } from '../lib/ooxml/opc';
import { MAX_FORMULA_STRING_LENGTH, SPREADSHEETML } from '../lib/ooxml/spreadsheetml';
import type { ZipWriteEntry } from '../lib/ooxml/zip';
import { MAX_DECOMPRESSED_BYTES, openZip, writeZip } from '../lib/ooxml/zip';
import type {
    RoundtripDifference as BaseDifference,
    CorpusFile,
    DifferenceGroup,
    Listed,
    RoundtripGate,
    RoundtripMeta,
    RoundtripOptions,
} from './office-audit';
import {
    canonical,
    cellText,
    chartsNotImported,
    classify,
    DEFAULT_MAX_RSS_MB,
    listCorpus,
    MB,
    message,
    officeMedia,
    roundtripChild,
    roundtripLine,
    runRoundtrip as runGate,
    seconds,
    seriesIdsByPlace,
    spawnChild,
} from './office-audit';

const FEATURES = [
    ['sheets', 'Sheets'],
    ['hiddenSheets', 'Hidden sheets'],
    ['tabColors', 'Tab colours'],
    ['cells', 'Cells with a value'],
    ['numbers', 'Number cells'],
    ['dates', 'Date cells'],
    ['texts', 'Text cells'],
    ['booleans', 'Boolean cells'],
    ['errors', 'Error cells'],
    ['richText', 'Rich text cells'],
    ['formulas', 'Formulas'],
    ['sharedFormulas', 'Shared formula copies'],
    ['bold', 'Bold cells'],
    ['italic', 'Italic cells'],
    ['underline', 'Underlined cells'],
    ['strike', 'Struck-through cells'],
    ['font', 'Cells with a font'],
    ['size', 'Cells with a font size'],
    ['color', 'Cells with a text colour'],
    ['fill', 'Cells with a fill'],
    ['borders', 'Cells with borders'],
    ['alignment', 'Aligned cells'],
    ['wrap', 'Wrapped cells'],
    ['rotation', 'Rotated cells'],
    ['numberFormats', 'Cells with a number format'],
    ['merges', 'Merges'],
    ['columnWidths', 'Column widths'],
    ['rowHeights', 'Row heights'],
    ['hiddenRows', 'Hidden rows'],
    ['hiddenColumns', 'Hidden columns'],
    ['frozen', 'Frozen panes'],
    ['gridlinesOff', 'Sheets without gridlines'],
    ['filters', 'Filters'],
    ['conditionalFormats', 'Conditional format rules'],
    ['validations', 'Validated cells'],
    ['hyperlinks', 'Hyperlinks'],
    ['images', 'Images'],
    ['charts', 'Charts'],
    ['text', 'Text (characters)'],
] as const;

export type Feature = (typeof FEATURES)[number][0];

// What the snapshot can't tell: a shared formula's copy is a formula like any other there.
const SOURCE_ONLY = new Set<Feature>(['sharedFormulas']);

// Compared per sheet as a whole, in the snapshot's own shape.
const CONFIG_FEATURES = ['merge', 'columnlen', 'rowlen', 'rowhidden', 'colhidden', 'borderInfo'] as const;
const SHEET_FIELDS = [
    'frozen',
    'showGridLines',
    'filterRange',
    'hyperlink',
    'dataVerification',
    'conditionalFormatRules',
    'images',
    'charts',
    'hide',
    'color',
] as const;
const SHEET_FEATURES = [...CONFIG_FEATURES, ...SHEET_FIELDS];

// A cell's three faces, each fingerprinted: what it holds, how it computes it, and how it looks.
const FACETS = ['value', 'formula', 'look'] as const;
type Facet = (typeof FACETS)[number];

const LOOK_KEYS = ['bl', 'it', 'un', 'cl', 'fs', 'ff', 'fc', 'bg', 'ht', 'vt', 'tb', 'rt', 'mc'] as const;

// The corner of each sheet whose cells keep their text, so a difference found there reads as what changed.
const SAMPLE_ROWS = 10;
const SAMPLE_COLUMNS = 26;

// Wider than any sheet: a cell's row and column as one number.
const ROW_STRIDE = 1_048_576;

type Outcome = 'ok' | 'refused' | 'crash' | 'timeout' | 'memory';

type SheetSummary = { name: string; cells: number; hashes: Record<string, number> };

// What the gzipped cells file holds: per sheet, flat [r, c, value, formula, look] fingerprints, and the sampled
// corner's texts by `r_c`, one per facet.
type Cells = { prints: [string, number[]][]; sample: Record<string, Record<string, string[]>> };

type Snapshot = { counts: Map<Feature, number>; sheets: SheetSummary[]; cells: Cells };

type FileResult = {
    file: string;
    bytes: number;
    outcome: Outcome;
    status?: number;
    error?: string;
    ms: number;
    cpuMs?: number;
    rssMb: number;
    imported: Record<string, number>;
    source: Record<string, number>;
    sourceError?: string;
    auditError?: string;
    sheets: SheetSummary[];
};

type RunMeta = {
    name: string;
    importer: string;
    corpora: string[];
    files: number;
    outcomes: Partial<Record<Outcome, number>>;
    importMs: number;
    maxRssMb: number;
    totalMs: number;
    load: [number, number];
};

// What the child reports, one JSON line each, in this order; a child cut short leaves the lines it wrote.
type ChildReport =
    | {
          kind: 'import';
          outcome: 'ok' | 'refused' | 'crash';
          status?: number;
          error?: string;
          ms: number;
          cpuMs: number;
          rssMb: number;
      }
    | { kind: 'snapshot'; imported: Record<string, number>; sheets: SheetSummary[] }
    | { kind: 'source'; source: Record<string, number> }
    | { kind: 'source'; error: string };

function bump(counts: Map<Feature, number>, feature: Feature, n = 1): void {
    if (n > 0) counts.set(feature, (counts.get(feature) ?? 0) + n);
}

const size = (value: object | undefined) => (value ? Object.keys(value).length : 0);

function facetsOf(cell: Cell): [string, string, string] {
    const look = Object.fromEntries(
        [['fa', cell.ct?.fa], ...LOOK_KEYS.map((key) => [key, cell[key]])].filter(([, value]) => value !== undefined),
    );
    return [canonical({ v: cell.v, m: cell.m, t: cell.ct?.t, s: cell.ct?.s }), cell.f ?? '', canonical(look)];
}

// ── Imported: what the sheets hold ──────────────────────────────────────────────────────────────────────────────

export function tallySheets(sheets: Sheet[]): Snapshot {
    const counts = new Map<Feature, number>();
    const summaries: SheetSummary[] = [];
    const cells: Cells = { prints: [], sample: {} };
    for (const sheet of sheets) {
        // Read by name, as SHEET_FIELDS lists them.
        const fields = new Map<string, unknown>(Object.entries(sheet));
        const config = sheet.config ?? {};
        bump(counts, 'sheets');
        if (sheet.hide) bump(counts, 'hiddenSheets');
        if (sheet.color) bump(counts, 'tabColors');
        const prints: number[] = [];
        const corner: Record<string, string[]> = {};
        for (const { r, c, v: cell } of sheet.celldata ?? []) {
            if (!cell) continue;
            const facets = facetsOf(cell);
            prints.push(r, c, ...facets.map((facet) => Bun.hash.crc32(facet)));
            if (r < SAMPLE_ROWS && c < SAMPLE_COLUMNS) corner[`${r}_${c}`] = facets;
            const value = cell.v;
            const runs = cell.ct?.s ?? [];
            if ((value !== undefined && value !== null && value !== '') || runs.length > 0) bump(counts, 'cells');
            if (typeof value === 'string' && valueIsError(value)) bump(counts, 'errors');
            else if (cell.ct?.t === 'e') bump(counts, 'errors');
            else if (cell.ct?.t === 'd') bump(counts, 'dates');
            else if (typeof value === 'number') bump(counts, 'numbers');
            else if (typeof value === 'boolean') bump(counts, 'booleans');
            else if ((typeof value === 'string' && value !== '') || runs.length > 0) bump(counts, 'texts');
            if (runs.length > 1) bump(counts, 'richText');
            if (cell.f) bump(counts, 'formulas');
            if (cell.bl === 1) bump(counts, 'bold');
            if (cell.it === 1) bump(counts, 'italic');
            if (cell.un) bump(counts, 'underline');
            if (cell.cl === 1) bump(counts, 'strike');
            if (cell.ff !== undefined) bump(counts, 'font');
            if (cell.fs !== undefined) bump(counts, 'size');
            if (cell.fc !== undefined) bump(counts, 'color');
            if (cell.bg !== undefined) bump(counts, 'fill');
            if (cell.ht !== undefined || cell.vt !== undefined) bump(counts, 'alignment');
            if (cell.tb === '2') bump(counts, 'wrap');
            if (cell.rt) bump(counts, 'rotation');
            if (cell.ct?.fa && cell.ct.fa !== 'General') bump(counts, 'numberFormats');
            const text = typeof value === 'string' ? value.length : 0;
            bump(counts, 'text', text || runs.reduce((sum, run) => sum + (run.v?.length ?? 0), 0));
        }
        bump(counts, 'merges', size(config.merge));
        bump(counts, 'columnWidths', size(config.columnlen));
        bump(counts, 'rowHeights', size(config.rowlen));
        bump(counts, 'hiddenRows', size(config.rowhidden));
        bump(counts, 'hiddenColumns', size(config.colhidden));
        bump(counts, 'borders', size(config.borderInfo));
        if (sheet.frozen) bump(counts, 'frozen');
        if (sheet.showGridLines === false || sheet.showGridLines === 0) bump(counts, 'gridlinesOff');
        if (sheet.filterRange) bump(counts, 'filters');
        bump(counts, 'conditionalFormats', sheet.conditionalFormatRules?.length ?? 0);
        bump(counts, 'validations', size(sheet.dataVerification));
        bump(counts, 'hyperlinks', size(sheet.hyperlink));
        bump(counts, 'images', size(sheet.images));
        bump(counts, 'charts', size(sheet.charts));
        const hashes = Object.fromEntries([
            ...CONFIG_FEATURES.map((key) => [key, Bun.hash.crc32(canonical(config[key] ?? null))]),
            ...SHEET_FIELDS.map((key) => [key, Bun.hash.crc32(canonical(fields.get(key) ?? null))]),
        ]);
        summaries.push({ name: sheet.name, cells: prints.length / 5, hashes });
        cells.prints.push([sheet.name, prints]);
        cells.sample[sheet.name] = corner;
    }
    return { counts, sheets: summaries, cells };
}

// ── Source: what the package's XML holds ────────────────────────────────────────────────────────────────────────

// Any namespace prefix, as a Strict or prefixed package writes them.
const P = '(?:[\\w.-]+:)?';
const tag = (pattern: string) => new RegExp(pattern.replaceAll('§', P), 'g');

// Counted in the snapshot's units: cells, merges, columns, rows, rules and links one by one.
const SHEET_RULES: [Feature, RegExp][] = [
    ['tabColors', tag('<§tabColor\\s')],
    ['cells', tag('<§(?:v|is)>')],
    ['errors', tag('<§c\\s[^>]*\\bt="e"')],
    ['formulas', tag('<§f[\\s>/]')],
    // A copy names its group and no range: the range is its anchor's.
    ['sharedFormulas', tag('<§f\\s(?![^>]*\\bref=)[^>]*\\bt="shared"')],
    ['merges', tag('<§mergeCell\\s')],
    ['rowHeights', tag('<§row\\s[^>]*\\bcustomHeight="(?:1|true)"')],
    ['hiddenRows', tag('<§row\\s[^>]*\\bhidden="(?:1|true)"')],
    ['frozen', tag('<§pane\\s[^>]*\\bstate="frozen')],
    ['gridlinesOff', tag('<§sheetView\\s[^>]*\\bshowGridLines="(?:0|false)"')],
    ['filters', tag('<§autoFilter[\\s>/]')],
    ['conditionalFormats', tag('<§cfRule\\s')],
    ['hyperlinks', tag('<§hyperlink\\s')],
];
const COLUMN = tag('<§col\\s([^>]*)>');
const HIDDEN_SHEET = tag('<§sheet\\s[^>]*\\bstate="(?:hidden|veryHidden)"');
const SHEET_ENTRY = tag('<§sheet\\s');
const PICTURE = tag('<§pic>');
const OFFICE_DOCUMENT = /<Relationship\s[^>]*Type="[^"]*\/officeDocument"[^>]*>/;
const PART = /^[^/]+\.xml$/;
const MAX_COLUMN = 16_384;

function attribute(attributes: string, name: string): string | undefined {
    return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];
}

export function tallySource(bytes: Uint8Array): Map<Feature, number> {
    const zip = openZip(bytes);
    const latin1 = new TextDecoder('latin1');
    const read = (part: string) => {
        const data = zip.read(part);
        return data ? latin1.decode(data) : '';
    };
    const relationship = OFFICE_DOCUMENT.exec(read('_rels/.rels'))?.[0] ?? '';
    const workbook = (attribute(relationship, 'Target') ?? 'xl/workbook.xml').replace(/^\//, '');
    const base = path.posix.dirname(workbook);
    // The part's name in the folder beside the workbook, if it is there.
    const inFolder = (name: string, folder: string) => {
        const prefix = base === '.' ? `${folder}/` : `${base}/${folder}/`;
        return name.startsWith(prefix) ? name.slice(prefix.length) : '';
    };
    const counts = new Map<Feature, number>();
    const book = read(workbook);
    bump(counts, 'sheets', book.match(SHEET_ENTRY)?.length ?? 0);
    bump(counts, 'hiddenSheets', book.match(HIDDEN_SHEET)?.length ?? 0);
    for (const name of zip.names()) {
        // Not Excel 2016's chartEx parts, which the reader leaves out.
        if (/^chart(?!Ex)[^/]*\.xml$/.test(inFolder(name, 'charts'))) bump(counts, 'charts');
        if (PART.test(inFolder(name, 'drawings'))) bump(counts, 'images', read(name).match(PICTURE)?.length ?? 0);
        if (!PART.test(inFolder(name, 'worksheets'))) continue;
        const xml = read(name);
        for (const [feature, rule] of SHEET_RULES) bump(counts, feature, xml.match(rule)?.length ?? 0);
        for (const [, attributes] of xml.matchAll(COLUMN)) {
            const min = Number(attribute(attributes, 'min'));
            const max = Math.min(Number(attribute(attributes, 'max')), MAX_COLUMN);
            const columns = min >= 1 && max >= min ? max - min + 1 : 0;
            if (attribute(attributes, 'width')) bump(counts, 'columnWidths', columns);
            if (/^(?:1|true)$/.test(attribute(attributes, 'hidden') ?? '')) bump(counts, 'hiddenColumns', columns);
        }
    }
    return counts;
}

// ── Running an importer ─────────────────────────────────────────────────────────────────────────────────────────

// A package of the given sheets, each body what its <worksheet> holds, a stylesheet of one bold differential format, and
// any more parts.
export function xlsxPackage(
    sheets: { name: string; body: string; state?: 'hidden' | 'veryHidden' }[],
    parts: ZipWriteEntry[] = [],
): Uint8Array {
    const relationships = (list: string) =>
        `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}">${list}</Relationships>`;
    const numbered = sheets.map((sheet, index) => ({ ...sheet, n: index + 1 }));
    return writeZip([
        {
            name: '[Content_Types].xml',
            data: `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${SPREADSHEETML}.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${SPREADSHEETML}.styles+xml"/>${numbered.map(({ n }) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="${SPREADSHEETML}.worksheet+xml"/>`).join('')}</Types>`,
        },
        {
            name: '_rels/.rels',
            data: relationships(`<Relationship Id="rId1" Type="${R_NS}/officeDocument" Target="xl/workbook.xml"/>`),
        },
        {
            name: 'xl/workbook.xml',
            data: `<workbook xmlns="${SML_NS}" xmlns:r="${R_NS}"><sheets>${numbered.map(({ name, state, n }) => `<sheet name="${name}" sheetId="${n}"${state ? ` state="${state}"` : ''} r:id="rId${n}"/>`).join('')}</sheets></workbook>`,
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            data: relationships(
                `<Relationship Id="rIdStyles" Type="${R_NS}/styles" Target="styles.xml"/>${numbered
                    .map(
                        ({ n }) =>
                            `<Relationship Id="rId${n}" Type="${R_NS}/worksheet" Target="worksheets/sheet${n}.xml"/>`,
                    )
                    .join('')}`,
            ),
        },
        {
            name: 'xl/styles.xml',
            data: `<styleSheet xmlns="${SML_NS}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellXfs count="1"><xf/></cellXfs><dxfs count="1"><dxf><font><b/></font></dxf></dxfs></styleSheet>`,
        },
        ...numbered.map(({ body, n }) => ({
            name: `xl/worksheets/sheet${n}.xml`,
            data: `<worksheet xmlns="${SML_NS}" xmlns:r="${R_NS}">${body}</worksheet>`,
        })),
        ...parts,
    ]);
}

// Imported before the file, so the modules an importer loads on first use don't count as the file's time.
const WARM_UP = xlsxPackage([{ name: 'S', body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }]);

const DEFAULT_IMPORTER = path.join(import.meta.dir, '../lib/import/sheets/from-xlsx.ts');
const DEFAULT_TIMEOUT_MS = TRANSFORM_LIMITS.import.deadlineMs;
const OUTCOMES: Outcome[] = ['ok', 'refused', 'crash', 'timeout', 'memory'];

const DEFAULT_WRITER = path.join(import.meta.dir, '../lib/export/sheets/xlsx/to-xlsx.ts');

// Another importer may answer synchronously.
type Importer = (...args: Parameters<typeof xlsxToSheets>) => Sheet[] | Promise<Sheet[]>;

function isImporter(value: unknown): value is Importer {
    return typeof value === 'function';
}

function isWriter(value: unknown): value is typeof writeXlsx {
    return typeof value === 'function';
}

function isSheets(value: unknown): value is Sheet[] {
    return (
        Array.isArray(value) &&
        value.every((sheet) => typeof sheet === 'object' && sheet !== null && typeof sheet.name === 'string')
    );
}

// A workbook or template, or one a download suffixed (Zenodo's name.xlsx__content).
const WORKBOOK = /\.xl[st][xm](?![a-z0-9])/i;

async function importOne(
    file: CorpusFile,
    options: { importer: string; timeoutMs: number; maxRssMb: number; cells: string; reports: string },
): Promise<FileResult> {
    fs.mkdirSync(path.dirname(options.cells), { recursive: true });
    const { reports, cut, observedMb, wallMs, why } = await spawnChild<ChildReport>(
        import.meta.path,
        ['child', file.absolute, '--importer', options.importer, '--cells', options.cells],
        options,
    );
    const imported = reports.find((report) => report.kind === 'import');
    const snapshot = reports.find((report) => report.kind === 'snapshot');
    const source = reports.find((report) => report.kind === 'source');
    return {
        file: file.key,
        bytes: fs.statSync(file.absolute).size,
        outcome: imported?.outcome ?? cut ?? 'crash',
        status: imported?.status,
        error: imported ? imported.error : why,
        ms: Math.round(imported?.ms ?? (cut === 'timeout' ? options.timeoutMs : wallMs)),
        cpuMs: imported && Math.round(imported.cpuMs),
        rssMb: Math.round(imported?.rssMb ?? observedMb),
        imported: snapshot?.imported ?? {},
        source: source && 'source' in source ? source.source : {},
        sourceError: source ? ('error' in source ? source.error : undefined) : why,
        auditError: imported?.outcome === 'ok' && !snapshot ? why : undefined,
        sheets: snapshot?.sheets ?? [],
    };
}

export async function runAudit(options: {
    corpora: string[];
    out: string;
    importer?: string;
    name: string;
    timeoutMs?: number;
    maxRssMb?: number;
}): Promise<RunMeta> {
    const started = performance.now();
    const load = os.loadavg()[0];
    const importer = path.resolve(options.importer ?? DEFAULT_IMPORTER);
    const files = listCorpus(options.corpora, WORKBOOK, 'workbooks');
    fs.mkdirSync(options.out, { recursive: true });
    for (const folder of ['files', 'cells'])
        fs.rmSync(path.join(options.out, folder), { recursive: true, force: true });
    const results: FileResult[] = [];
    for (const [index, file] of files.entries()) {
        const result = await importOne(file, {
            importer,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxRssMb: options.maxRssMb ?? DEFAULT_MAX_RSS_MB,
            cells: path.join(options.out, 'cells', `${file.key}.json.gz`),
            reports: path.join(options.out, 'child.jsonl'),
        });
        results.push(result);
        const target = path.join(options.out, 'files', `${file.key}.json`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(result)}\n`);
        console.log(
            `[${index + 1}/${files.length}] ${file.key}: ${result.outcome}${result.status ? ` ${result.status}` : ''}, ${result.ms} ms, ${result.rssMb} MB`,
        );
    }
    const meta: RunMeta = {
        name: options.name,
        importer,
        corpora: options.corpora.map((corpus) => path.resolve(corpus)),
        files: results.length,
        outcomes: Object.fromEntries(
            OUTCOMES.map((outcome) => [outcome, results.filter((result) => result.outcome === outcome).length]),
        ),
        importMs: results.reduce((sum, result) => sum + result.ms, 0),
        maxRssMb: Math.max(...results.map((result) => result.rssMb)),
        totalMs: Math.round(performance.now() - started),
        load: [load, os.loadavg()[0]],
    };
    fs.writeFileSync(path.join(options.out, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
    fs.writeFileSync(path.join(options.out, 'summary.md'), summaryMarkdown(meta, results));
    return meta;
}

// The child: imports one file, then tallies what it made and what the package holds, reporting after each step.
async function child(file: string, options: { importer: string; cells: string; reports: string }): Promise<void> {
    const report = (line: ChildReport) => fs.appendFileSync(options.reports, `${JSON.stringify(line)}\n`);
    const module: unknown = await import(options.importer);
    const importer = typeof module === 'object' && module !== null && 'xlsxToSheets' in module && module.xlsxToSheets;
    if (!isImporter(importer)) throw new Error(`${options.importer} exports no xlsxToSheets`);
    // A failed warm-up is the file's to show.
    await Promise.resolve()
        .then(() => importer(Buffer.from(WARM_UP)))
        .catch(() => undefined);
    const data = Buffer.from(await Bun.file(file).arrayBuffer());
    const cpu = process.cpuUsage();
    const started = performance.now();
    const outcome = await Promise.resolve()
        .then(() => importer(data))
        .then(
            (sheets) => ({ sheets }),
            (error: unknown) => ({ error }),
        );
    const used = process.cpuUsage(cpu);
    const measured = {
        ms: performance.now() - started,
        cpuMs: (used.user + used.system) / 1000,
        rssMb: peakRss() / MB,
    };
    if ('error' in outcome) {
        const { error } = outcome;
        const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
        report(
            typeof status === 'number'
                ? { kind: 'import', outcome: 'refused', status, error: message(error), ...measured }
                : { kind: 'import', outcome: 'crash', error: message(error), ...measured },
        );
    } else if (!isSheets(outcome.sheets)) {
        report({ kind: 'import', outcome: 'crash', error: 'malformed result', ...measured });
    } else {
        report({ kind: 'import', outcome: 'ok', ...measured });
        const snapshot = tallySheets(outcome.sheets);
        fs.writeFileSync(options.cells, Bun.gzipSync(JSON.stringify(snapshot.cells)));
        report({ kind: 'snapshot', imported: Object.fromEntries(snapshot.counts), sheets: snapshot.sheets });
    }
    try {
        report({ kind: 'source', source: Object.fromEntries(tallySource(data)) });
    } catch (error) {
        report({ kind: 'source', error: message(error) });
    }
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Row = { files: number; source: number; imported: number; matched: number };

// A feature the source counts keeps each file's min(imported, source); a crash keeps nothing.
function aggregate(results: FileResult[]): Map<Feature, Row> {
    const rows = new Map<Feature, Row>(
        FEATURES.map(([feature]) => [feature, { files: 0, source: 0, imported: 0, matched: 0 }]),
    );
    for (const result of results) {
        for (const [feature, row] of rows) {
            const source = result.source[feature] ?? 0;
            const imported = result.imported[feature] ?? 0;
            if (source > 0 || imported > 0) row.files++;
            row.source += source;
            row.imported += imported;
            row.matched += Math.min(source, imported);
        }
    }
    return rows;
}

const counted = (feature: Feature, row: Row | undefined) => !SOURCE_ONLY.has(feature) && !!row && row.source > 0;

function kept(feature: Feature, row: Row | undefined): string {
    return row && counted(feature, row) ? `${((row.matched / row.source) * 100).toFixed(1)}%` : '–';
}

function median(values: number[]): number {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const outcomeOf = (result: FileResult | undefined) =>
    result ? `${result.outcome}${result.status ? ` ${result.status}` : ''}` : '–';

const TOP_FILES = 15;

function summaryMarkdown(meta: RunMeta, results: FileResult[]): string {
    const rows = aggregate(results);
    const refusals = new Map<string, number>();
    for (const result of results) {
        if (result.outcome === 'ok') continue;
        const key = `| ${outcomeOf(result)} | ${cellText(result.error ?? '')} |`;
        refusals.set(key, (refusals.get(key) ?? 0) + 1);
    }
    const top = (by: (result: FileResult) => number) =>
        results
            .toSorted((a, b) => by(b) - by(a))
            .slice(0, TOP_FILES)
            .map(
                (result) =>
                    `| ${result.file} | ${outcomeOf(result)} | ${result.ms} | ${result.cpuMs ?? '–'} | ${result.rssMb} | ${(result.bytes / MB).toFixed(1)} |`,
            );
    const header = ['| File | Outcome | Import ms | CPU ms | Peak RSS MB | File MB |', '|---|---|---:|---:|---:|---:|'];
    return [
        `# xlsx audit: ${meta.name}`,
        '',
        `Importer \`${meta.importer}\` on ${meta.corpora.map((corpus) => `\`${corpus}\``).join(', ')}.`,
        '',
        '| Total | |',
        '|---|---|',
        `| Files | ${meta.files} |`,
        ...OUTCOMES.map((outcome) => `| ${outcome} | ${meta.outcomes[outcome] ?? 0} |`),
        `| Unreadable sources | ${results.filter((result) => result.sourceError).length} |`,
        `| Import time | ${seconds(meta.importMs)} |`,
        `| Peak RSS, largest | ${meta.maxRssMb} MB |`,
        `| Peak RSS, median | ${median(results.map((result) => result.rssMb))} MB |`,
        `| Total time | ${seconds(meta.totalMs)} |`,
        `| Load average | ${meta.load.map((load) => load.toFixed(1)).join(' → ')} |`,
        '',
        '## Not imported',
        '',
        '| Outcome | Message | Files |',
        '|---|---|---:|',
        ...[...refusals].sort(([, a], [, b]) => b - a).map(([key, n]) => `${key} ${n} |`),
        '',
        '## Slowest',
        '',
        ...header,
        ...top((result) => result.ms),
        '',
        '## Largest peak RSS',
        '',
        ...header,
        ...top((result) => result.rssMb),
        '',
        '## Features',
        '',
        `Imported is what the sheets hold; source what the package's XML holds, counted in the same units where it can be (cells, merges, columns, rows, rules and links one by one) and left out where it can't (styles, validated cells). Kept is the sum of each file's min(imported, source) over the source; a file not imported keeps nothing. Peak RSS is the child's whole process, the importer's modules included.`,
        '',
        '| Feature | Files | Source | Imported | Kept |',
        '|---|---:|---:|---:|---:|',
        ...FEATURES.map(([feature, label]) => {
            const row = rows.get(feature);
            const imported = SOURCE_ONLY.has(feature) ? '–' : (row?.imported ?? 0);
            return `| ${label} | ${row?.files ?? 0} | ${row?.source || '–'} | ${imported} | ${kept(feature, row)} |`;
        }),
        '',
    ].join('\n');
}

function readRun(out: string): { meta: RunMeta; results: Map<string, FileResult> } {
    const meta: RunMeta = JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8'));
    const results = new Map<string, FileResult>();
    for (const file of [...new Bun.Glob('**/*.json').scanSync(path.join(out, 'files'))].sort()) {
        const result: FileResult = JSON.parse(fs.readFileSync(path.join(out, 'files', file), 'utf8'));
        results.set(result.file, result);
    }
    return { meta, results };
}

function readCells(out: string, file: string): Cells {
    const target = path.join(out, 'cells', `${file}.json.gz`);
    return fs.existsSync(target)
        ? JSON.parse(new TextDecoder().decode(Bun.gunzipSync(fs.readFileSync(target))))
        : { prints: [], sample: {} };
}

export function readList(list: string): Set<string> {
    return new Set(
        fs
            .readFileSync(list, 'utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#')),
    );
}

type Difference = Facet | 'only in A' | 'only in B';
type Example = { file: string; at: string; a: string; b: string; sampled: boolean };

const EXAMPLES_PER_FILE = 2;
const EXAMPLES = 12;
// Beyond noise: the study's machine ran at a load of 8 to 10.
const TIME_NOISE = { total: 1.1, file: 1.5, floor: 250 };
const RSS_NOISE = { total: 1.1, file: 1.25, floor: 64 };

// B worse than A beyond both the ratio and the floor.
const worse = (b: number, a: number, ratio: number, floor: number) => b > a * ratio && b - a > floor;

// Cell by cell, sheets matched by name: the cells each facet differs in, those only one run holds, and examples, the
// sampled corner's first.
function diffCells(outA: string, outB: string, file: string) {
    const counts = new Map<Difference, number>();
    const examples = new Map<Difference, Example[]>();
    const cellsA = readCells(outA, file);
    const cellsB = readCells(outB, file);
    const printsA = new Map(cellsA.prints);
    const note = (kind: Difference, sheet: string, r: number, c: number, facet: number) => {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        const list = examples.get(kind) ?? [];
        examples.set(kind, list);
        const text = (cells: Cells) => cells.sample[sheet]?.[`${r}_${c}`]?.[facet] ?? '';
        const sampled = r < SAMPLE_ROWS && c < SAMPLE_COLUMNS;
        const example = { file, at: `${sheet}!${toA1(r, c)}`, a: text(cellsA), b: text(cellsB), sampled };
        const unsampled = list.findIndex((listed) => !listed.sampled);
        if (list.length < EXAMPLES_PER_FILE) list.push(example);
        else if (sampled && unsampled >= 0) list[unsampled] = example;
    };
    for (const [sheet, b] of cellsB.prints) {
        const a = printsA.get(sheet);
        if (!a) continue;
        const left = new Map<number, number>();
        for (let i = 0; i < a.length; i += 5) left.set(a[i] * ROW_STRIDE + a[i + 1], i);
        for (let i = 0; i < b.length; i += 5) {
            const j = left.get(b[i] * ROW_STRIDE + b[i + 1]);
            if (j === undefined) {
                note('only in B', sheet, b[i], b[i + 1], 0);
                continue;
            }
            left.delete(b[i] * ROW_STRIDE + b[i + 1]);
            for (const [index, facet] of FACETS.entries()) {
                if (a[j + 2 + index] !== b[i + 2 + index]) note(facet, sheet, b[i], b[i + 1], index);
            }
        }
        for (const j of left.values()) note('only in A', sheet, a[j], a[j + 1], 0);
    }
    return { counts, examples };
}

export function compareRuns(
    outA: string,
    outB: string,
    options: { heldout?: string; set?: 'tuned' | 'heldout' } = {},
): string {
    const a = readRun(outA);
    const b = readRun(outB);
    const heldout = options.heldout ? readList(options.heldout) : undefined;
    const inSet = (file: string) => !heldout || !options.set || heldout.has(file) === (options.set === 'heldout');
    const files = [...a.results.keys()].filter((file) => b.results.has(file) && inSet(file));
    const pairs = files.flatMap((file) => {
        const fa = a.results.get(file);
        const fb = b.results.get(file);
        return fa && fb ? [{ file, fa, fb }] : [];
    });
    const [nameA, nameB] = [a.meta.name, b.meta.name];
    const resultsA = pairs.map(({ fa }) => fa);
    const resultsB = pairs.map(({ fb }) => fb);
    const rowsA = aggregate(resultsA);
    const rowsB = aggregate(resultsB);

    // 1. Outcomes.
    const changed = pairs.filter(({ fa, fb }) => outcomeOf(fa) !== outcomeOf(fb));
    const lost = changed.filter(({ fa, fb }) => fa.outcome === 'ok' && fb.outcome !== 'ok');
    const capped = lost.filter(({ fb }) => fb.outcome === 'refused' && fb.status === 413);
    const broken = lost.length - capped.length;

    // 2. Features, and cell by cell.
    const below = FEATURES.filter(([feature]) => {
        const ra = rowsA.get(feature);
        const rb = rowsB.get(feature);
        if (!ra || !rb || !counted(feature, ra)) return false;
        return Math.round((rb.matched / rb.source) * 1000) < Math.round((ra.matched / ra.source) * 1000);
    });
    const differences = new Map<Difference, { cells: number; files: number; examples: Example[] }>();
    const sheetDiffs = new Map<string, { sheets: number; examples: string[] }>();
    const noteSheet = (feature: string, file: string, sheet: string) => {
        const entry = sheetDiffs.get(feature) ?? { sheets: 0, examples: [] };
        sheetDiffs.set(feature, entry);
        entry.sheets++;
        if (entry.examples.length < 5) entry.examples.push(`${file} ${sheet}`);
    };
    let sheetsCompared = 0;
    for (const { file, fa, fb } of pairs) {
        if (fa.outcome !== 'ok' || fb.outcome !== 'ok') continue;
        if (fa.sheets.map((sheet) => sheet.name).join('\n') !== fb.sheets.map((sheet) => sheet.name).join('\n'))
            noteSheet('names and order', file, '');
        for (const sheetA of fa.sheets) {
            const sheetB = fb.sheets.find((sheet) => sheet.name === sheetA.name);
            if (!sheetB) continue;
            sheetsCompared++;
            for (const feature of SHEET_FEATURES) {
                if (sheetA.hashes[feature] !== sheetB.hashes[feature]) noteSheet(feature, file, sheetA.name);
            }
        }
        const { counts, examples } = diffCells(outA, outB, file);
        for (const [kind, n] of counts) {
            const entry = differences.get(kind) ?? { cells: 0, files: 0, examples: [] };
            differences.set(kind, entry);
            entry.cells += n;
            entry.files++;
            entry.examples.push(...(examples.get(kind) ?? []));
        }
    }
    const differingCells = [...differences.values()].reduce((sum, entry) => sum + entry.cells, 0);

    // 3. Time and memory, over the files both import.
    const both = pairs.filter(({ fa, fb }) => fa.outcome === 'ok' && fb.outcome === 'ok');
    const sum = (pick: (pair: (typeof both)[number]) => number) => both.reduce((total, pair) => total + pick(pair), 0);
    const [msA, msB] = [sum(({ fa }) => fa.ms), sum(({ fb }) => fb.ms)];
    const [rssA, rssB] = [
        Math.max(0, ...both.map(({ fa }) => fa.rssMb)),
        Math.max(0, ...both.map(({ fb }) => fb.rssMb)),
    ];
    const slower = both
        .filter(({ fa, fb }) => worse(fb.ms, fa.ms, TIME_NOISE.file, TIME_NOISE.floor))
        .sort((x, y) => y.fb.ms - y.fa.ms - (x.fb.ms - x.fa.ms));
    const heavier = both
        .filter(({ fa, fb }) => worse(fb.rssMb, fa.rssMb, RSS_NOISE.file, RSS_NOISE.floor))
        .sort((x, y) => y.fb.rssMb - y.fa.rssMb - (x.fb.rssMb - x.fa.rssMb));
    const costly =
        worse(msB, msA, TIME_NOISE.total, TIME_NOISE.floor) || worse(rssB, rssA, RSS_NOISE.total, RSS_NOISE.floor);

    const verdict = (pass: boolean) => (pass ? 'pass' : '**FAIL**');
    const pass = broken === 0 && below.length === 0 && !costly;
    const set = heldout && options.set ? ` (${options.set} set)` : '';
    return [
        `# xlsx audit: ${nameA} vs ${nameB}${set}`,
        '',
        `**Gate: ${pass ? 'pass' : 'FAIL'}** on ${pairs.length} files.`,
        '',
        '| Criterion | Verdict | Detail |',
        '|---|---|---|',
        `| ${nameB} refuses nothing ${nameA} imports, but by a cap | ${verdict(broken === 0)} | ${broken} lost; ${capped.length} refused by a cap (413), each needs its ruling in LEDGER.md |`,
        `| Each feature kept at least as ${nameA} keeps it | ${verdict(below.length === 0)} | ${below.map(([, label]) => label).join(', ') || 'none below'}; ${differingCells} cell differences, each needs a ruled class |`,
        `| Time and peak RSS no worse beyond noise (×${TIME_NOISE.total} and ${TIME_NOISE.floor} ms, ×${RSS_NOISE.total} and ${RSS_NOISE.floor} MB) | ${verdict(!costly)} | ${seconds(msA)} → ${seconds(msB)}, largest ${rssA} → ${rssB} MB; ${slower.length} files slower, ${heavier.length} heavier |`,
        '',
        '## Outcomes',
        '',
        `| | ${nameA} | ${nameB} |`,
        '|---|---:|---:|',
        ...OUTCOMES.map(
            (outcome) =>
                `| ${outcome} | ${resultsA.filter((result) => result.outcome === outcome).length} | ${resultsB.filter((result) => result.outcome === outcome).length} |`,
        ),
        '',
        `| File | ${nameA} | ${nameB} | ${nameB} message |`,
        '|---|---|---|---|',
        ...changed.map(
            ({ file, fa, fb }) => `| ${file} | ${outcomeOf(fa)} | ${outcomeOf(fb)} | ${cellText(fb.error ?? '')} |`,
        ),
        '',
        '## Features',
        '',
        `| Feature | Files | Source | ${nameA} | ${nameB} | ${nameA} kept | ${nameB} kept |`,
        '|---|---:|---:|---:|---:|---:|---:|',
        ...FEATURES.map(([feature, label]) => {
            const ra = rowsA.get(feature);
            const rb = rowsB.get(feature);
            const imported = (row: Row | undefined) => (SOURCE_ONLY.has(feature) ? '–' : (row?.imported ?? 0));
            return `| ${label} | ${Math.max(ra?.files ?? 0, rb?.files ?? 0)} | ${ra?.source || '–'} | ${imported(ra)} | ${imported(rb)} | ${kept(feature, ra)} | ${kept(feature, rb)} |`;
        }),
        '',
        '## Sheets that differ',
        '',
        `Over ${sheetsCompared} sheets both import, matched by name.`,
        '',
        '| Feature | Sheets | Examples |',
        '|---|---:|---|',
        ...[...sheetDiffs].map(
            ([feature, entry]) => `| ${feature} | ${entry.sheets} | ${entry.examples.map(cellText).join('; ')} |`,
        ),
        '',
        '## Cells that differ',
        '',
        `A cell's value is v, m, ct.t and ct.s; its formula f; its look ct.fa, ${LOOK_KEYS.join(' ')}. The text shows for the top-left ${SAMPLE_ROWS} × ${SAMPLE_COLUMNS} cells of each sheet.`,
        '',
        '| Difference | Cells | Files |',
        '|---|---:|---:|',
        ...[...differences].map(([kind, entry]) => `| ${kind} | ${entry.cells} | ${entry.files} |`),
        '',
        ...[...differences].flatMap(([kind, entry]) => [
            `### ${kind}`,
            '',
            `| File | Cell | ${nameA} | ${nameB} |`,
            '|---|---|---|---|',
            ...entry.examples
                .slice(0, EXAMPLES)
                .map(
                    (example) =>
                        `| ${example.file} | ${cellText(example.at)} | ${cellText(example.a)} | ${cellText(example.b)} |`,
                ),
            '',
        ]),
        '## Slower beyond noise',
        '',
        `| File | ${nameA} ms | ${nameB} ms |`,
        '|---|---:|---:|',
        ...slower.slice(0, TOP_FILES).map(({ file, fa, fb }) => `| ${file} | ${fa.ms} | ${fb.ms} |`),
        '',
        '## Heavier beyond noise',
        '',
        `| File | ${nameA} MB | ${nameB} MB |`,
        '|---|---:|---:|',
        ...heavier.slice(0, TOP_FILES).map(({ file, fa, fb }) => `| ${file} | ${fa.rssMb} | ${fb.rssMb} |`),
        '',
        ...[...a.results.keys()]
            .filter((file) => !b.results.has(file) && inSet(file))
            .map((file) => `Only in ${nameA}: ${file}`),
        ...[...b.results.keys()]
            .filter((file) => !a.results.has(file) && inSet(file))
            .map((file) => `Only in ${nameB}: ${file}`),
        '',
    ].join('\n');
}

// ── Round trip: the import, our export and its import again ─────────────────────────────────────────────────────

// One thing the two imports hold differently: a sheet's feature at a place, or a cell's key at its cell, with the cells.
export type RoundtripDifference = BaseDifference & { sheet: string; cells?: { a?: Cell; b?: Cell } };

// A picture's media as a reader draws it, by its media name: its type and its pixels.
export type MediaFacts = ReadonlyMap<string, { contentType: string; width: number; height: number }>;

// What the writer reported cutting, by warning code, the sheets both imports made, and the media the writer was given
// beside the media the second import read.
export type RoundtripContext = {
    warnings: ReadonlyMap<string, number>;
    a: Sheet[];
    b: Sheet[];
    media: { a: MediaFacts; b: MediaFacts };
};

// A cell's keys, its type and format flattened out of `ct`, so each is a difference of its own.
function cellFields(cell: Cell | null | undefined): Map<string, unknown> {
    const fields = new Map<string, unknown>();
    for (const [key, value] of Object.entries(cell ?? {})) {
        if (value === undefined) continue;
        if (key !== 'ct' || typeof value !== 'object' || value === null) fields.set(key, value);
        else for (const [inner, held] of Object.entries(value)) if (held !== undefined) fields.set(`ct.${inner}`, held);
    }
    return fields;
}

// A sheet's maps compared key by key, its lists item by item; a key either holds is compared, so nothing is left out.
export function diffWorkbooks(a: Sheet[], b: Sheet[], media: RoundtripContext['media']): RoundtripDifference[] {
    const differences: RoundtripDifference[] = [];
    const note = (
        feature: string,
        sheet: string,
        at: string,
        x: unknown,
        y: unknown,
        cells?: { a?: Cell; b?: Cell },
    ) => {
        if (canonical(x) !== canonical(y))
            differences.push({ feature, sheet, at, a: x, b: y, ...(cells && { cells }) });
    };
    const keyed = (feature: string, sheet: string, x: unknown, y: unknown) => {
        // Most maps come back as they went, built in the same order.
        if (JSON.stringify(x) === JSON.stringify(y)) return;
        const left = x && typeof x === 'object' ? Object.entries(x) : [];
        const right = new Map(y && typeof y === 'object' ? Object.entries(y) : []);
        for (const [key, value] of left) {
            note(feature, sheet, key, value, right.get(key));
            right.delete(key);
        }
        for (const [key, value] of right) note(feature, sheet, key, undefined, value);
    };
    note('sheet count', '', '', a.length, b.length);
    for (const [index, sheetA] of a.entries()) {
        const sheetB = b[index];
        if (!sheetB) continue;
        const sheet = sheetA.name;
        note('sheet name', sheet, String(index), sheetA.name, sheetB.name);
        const fieldsA = new Map<string, unknown>(Object.entries(sheetA));
        const fieldsB = new Map<string, unknown>(Object.entries(sheetB));
        for (const field of new Set([...fieldsA.keys(), ...fieldsB.keys()])) {
            const [x, y] = [fieldsA.get(field), fieldsB.get(field)];
            if (field === 'name' || field === 'celldata') continue;
            if (field === 'config') {
                const configA = new Map<string, unknown>(Object.entries(sheetA.config ?? {}));
                const configB = new Map<string, unknown>(Object.entries(sheetB.config ?? {}));
                for (const key of new Set([...configA.keys(), ...configB.keys()]))
                    keyed(key, sheet, configA.get(key), configB.get(key));
            } else if (field === 'hyperlink' || field === 'dataVerification' || field === 'conditionalFormatRules')
                keyed(field, sheet, x, y);
            else if (field === 'charts') {
                // A chart's parts compared as one spec, its series ids by place.
                const spec = (value: unknown) =>
                    Object.values(isRecord(value) ? value : {}).map((chart: unknown) => {
                        if (!isRecord(chart)) return chart;
                        const { stored, spec } = readChartSpec(chart);
                        const rest = Object.entries(chart).filter(([key]) => !isChartSpecKey(key));
                        return { ...Object.fromEntries(rest), spec: spec ? seriesIdsByPlace(spec) : stored };
                    });
                keyed('charts', sheet, spec(x), spec(y));
            } else if (field === 'images')
                keyed('images', sheet, picturesOf(sheetA, media.a), picturesOf(sheetB, media.b));
            else note(field, sheet, '', x, y);
        }
        const cellsA = new Map((sheetA.celldata ?? []).map(({ r, c, v }) => [`${r}_${c}`, { r, c, v }]));
        const at = ({ r, c }: { r: number; c: number }) => toA1(r, c);
        for (const entry of sheetB.celldata ?? []) {
            const key = `${entry.r}_${entry.c}`;
            const cells = { a: cellsA.get(key)?.v ?? undefined, b: entry.v ?? undefined };
            cellsA.delete(key);
            if (JSON.stringify(cells.a) === JSON.stringify(cells.b)) continue;
            const fieldsOfA = cellFields(cells.a);
            const fieldsOfB = cellFields(cells.b);
            for (const name of new Set([...fieldsOfA.keys(), ...fieldsOfB.keys()]))
                note(`cell ${name}`, sheet, at(entry), fieldsOfA.get(name), fieldsOfB.get(name), cells);
        }
        for (const entry of cellsA.values()) {
            const cells = { a: entry.v ?? undefined };
            for (const [name, value] of cellFields(cells.a))
                note(`cell ${name}`, sheet, at(entry), value, undefined, cells);
        }
    }
    return differences;
}

// A sheet's pictures in paint order, by place, their media by order of first use, as an import names both afresh, and
// by what it draws.
function picturesOf(sheet: Sheet, facts: MediaFacts): unknown[] {
    const media = new Map<string, number>();
    return Object.values(sheet.images ?? {})
        .toSorted((x, y) => (x.index < y.index ? -1 : x.index > y.index ? 1 : 0))
        .map(({ id: _id, index: _index, mediaName, ...image }) => {
            if (!media.has(mediaName)) media.set(mediaName, media.size);
            return { ...image, media: media.get(mediaName), file: facts.get(mediaName) };
        });
}

// A run's font without the keys that name the workbook's default, which draws the same as none.
function withoutDefaultFont(runs: unknown): unknown {
    return Array.isArray(runs)
        ? runs.map((run: unknown) => {
              if (!isRecord(run)) return run;
              const { fs: size, ff: face, ...rest } = run;
              return {
                  ...rest,
                  ...(size !== SHEET_DEFAULT_FONT_SIZE && { fs: size }),
                  ...(!isDefaultFace(face) && { ff: face }),
              };
          })
        : runs;
}

const isDefaultFace = (face: unknown) =>
    (typeof face === 'string' || typeof face === 'number') && cellFontName(face) === SHEET_DEFAULT_FONT.name;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// The differences the writer explains, each kind with why it is no loss or a loss Excel's limits force. A difference
// none matches is unlisted, and fails the gate.
export const LISTED: Listed<RoundtripDifference, RoundtripContext>[] = [
    {
        kind: 'default font keys',
        why: "The import gives a cell of any but the default format its font whole, and our writer writes a cell whose font is the default with format 0, so a size or face equal to the workbook's default (Inter 10) comes and goes; both draw alike",
        matches: ({ feature, a, b }) =>
            (feature === 'cell fs' &&
                (a === undefined || a === SHEET_DEFAULT_FONT_SIZE) &&
                (b === undefined || b === SHEET_DEFAULT_FONT_SIZE)) ||
            (feature === 'cell ff' && (a === undefined || isDefaultFace(a)) && (b === undefined || isDefaultFace(b))) ||
            (feature === 'cell ct.s' && canonical(withoutDefaultFont(a)) === canonical(withoutDefaultFont(b))),
    },
    {
        kind: 'single-cell merges',
        why: 'A merge of one cell merges nothing; the writer writes no mergeCell for it, as Excel writes none',
        matches: ({ feature, a, b }) =>
            (feature === 'merge' || feature === 'cell mc') &&
            isRecord(a) &&
            a['rs'] === 1 &&
            a['cs'] === 1 &&
            b === undefined,
    },
    {
        kind: 'web links resolved',
        why: "A web link is written as resolveWebLink makes it, the address the editor opens, and as a relationship's URI, so a bare host gains its https:// and a character a URI can't hold its escape",
        matches: ({ feature, a, b }) =>
            feature === 'hyperlink' &&
            isRecord(a) &&
            isRecord(b) &&
            a['linkType'] === 'webpage' &&
            b['linkType'] === 'webpage' &&
            typeof a['linkAddress'] === 'string' &&
            b['linkAddress'] === uriReference(resolveWebLink(a['linkAddress']) ?? ''),
    },
    {
        kind: 'unwritable links dropped',
        why: "A web link resolveWebLink refuses (a script's address), which the editor never opens, or a cell link to no range (a defined name's Print_Area), which it can't follow, is left out and counted (links-dropped), its cell's backref with it",
        matches: ({ feature, sheet, at, a, b }, { warnings, a: sheets }) => {
            if (!warnings.has('links-dropped') || b !== undefined) return false;
            const links = sheets.find((candidate) => candidate.name === sheet)?.hyperlink ?? {};
            const key =
                feature === 'hyperlink' ? at : feature === 'cell hl' && isRecord(a) ? `${a['r']}_${a['c']}` : '';
            const link = links[key];
            if (link?.linkType === 'webpage') return resolveWebLink(link.linkAddress) === null;
            return (
                link?.linkType === 'cellrange' &&
                parseA1Range(link.linkAddress.slice(link.linkAddress.lastIndexOf('!') + 1)) === null
            );
        },
    },
    {
        kind: 'sheet links as cell links',
        why: "A link to a sheet is written as a location, which names a cell, so it comes back a link to the sheet's A1",
        matches: ({ feature, a, b }) =>
            feature === 'hyperlink' &&
            isRecord(a) &&
            isRecord(b) &&
            a['linkType'] === 'sheet' &&
            b['linkType'] === 'cellrange' &&
            typeof a['linkAddress'] === 'string' &&
            typeof b['linkAddress'] === 'string' &&
            b['linkAddress'].endsWith('!A1') &&
            unquoteSheetName(b['linkAddress'].slice(0, -3)) === a['linkAddress'],
    },
    {
        kind: 'list ranges absolute',
        why: "A list's range is written absolute, as the engine reads one list for every cell where Excel would shift a relative ref",
        matches: ({ feature, a, b }) =>
            feature === 'dataVerification' &&
            isRecord(a) &&
            isRecord(b) &&
            a['type'] === 'dropdown' &&
            typeof a['value1'] === 'string' &&
            typeof b['value1'] === 'string' &&
            canonical({ ...a, value1: a['value1'].replaceAll('$', '') }) ===
                canonical({ ...b, value1: b['value1'].replaceAll('$', '') }),
    },
    {
        kind: 'list validations too long',
        why: 'Excel holds a list literal of at most 255 characters; a longer one is dropped and counted (validations-dropped)',
        matches: ({ feature, a, b }, { warnings }) =>
            feature === 'dataVerification' &&
            warnings.has('validations-dropped') &&
            b === undefined &&
            isRecord(a) &&
            a['type'] === 'dropdown' &&
            typeof a['value1'] === 'string' &&
            a['value1'].length > MAX_FORMULA_STRING_LENGTH,
    },
    {
        kind: 'sheet names repaired',
        why: 'A name Excel refuses (History, a forbidden character, past 31 characters, a duplicate in any case) is repaired and counted (sheet-names-changed)',
        matches: ({ feature, at, b }, { a: sheets }) =>
            feature === 'sheet name' && b === sheetNames(sheets, () => {})[Number(at)],
    },
];

export function classifyDifferences(context: RoundtripContext): DifferenceGroup[] {
    return classify(
        diffWorkbooks(context.a, context.b, context.media),
        LISTED,
        context,
        (difference) => `${difference.sheet}!${difference.at}`,
    );
}

const XLSX_GATE: RoundtripGate = {
    format: 'xlsx',
    script: import.meta.path,
    pattern: WORKBOOK,
    noun: 'workbooks',
    writer: DEFAULT_WRITER,
    listed: LISTED,
};

// A picture's media by name, its type and pixel size as sharp reads them.
async function mediaFacts(
    media: { name: string; contentType: string; data: ArrayBuffer | Buffer }[],
): Promise<MediaFacts> {
    const { default: sharp } = await import('sharp');
    const facts = new Map<string, { contentType: string; width: number; height: number }>();
    for (const { name, contentType, data } of media) {
        const { width = 0, height = 0 } = await sharp(data).metadata();
        facts.set(name, { contentType, width, height });
    }
    return facts;
}

// The round trip's child: the file imported, written by our writer with its pictures prepared as an export prepares
// them, imported again, and the two imports compared.
async function xlsxRoundtripChild(
    file: string,
    options: { writer: string; reports: string; dump?: string },
): Promise<void> {
    const { readXlsx } = await import('../lib/import/sheets/from-xlsx');
    const module: unknown = await import(options.writer);
    const write = typeof module === 'object' && module !== null && 'writeXlsx' in module && module.writeXlsx;
    if (!isWriter(write)) throw new Error(`${options.writer} exports no writeXlsx`);
    const limits = { maxMediaBytes: MAX_DECOMPRESSED_BYTES };
    await roundtripChild(options, async (step) => {
        const data = new Uint8Array(await Bun.file(file).arrayBuffer());
        const a = await step('import', () => readXlsx(data, limits));
        const exported: TransformWarning[] = [];
        let prepared: OfficeMedia[] = [];
        const bytes = await step('export', async () => {
            prepared = await officeMedia(a.media);
            return write(a.sheets, { title: '', media: prepared, warnings: exported });
        });
        const b = await step('reimport', () => readXlsx(bytes, limits));
        const warnings = new Map(exported.map((warning) => [warning.code, 'count' in warning ? warning.count : 1]));
        const groups = await step('compare', async () => {
            const media = { a: await mediaFacts(prepared), b: await mediaFacts(b.media) };
            return classifyDifferences({ warnings, a: a.sheets, b: b.sheets, media });
        });
        return { warnings, groups, charts: chartsNotImported(a.warnings, a.sheets) };
    });
}

// Pass: no crash, cut or unlisted difference, so every width and height came back to the pixel.
export function runRoundtrip(options: RoundtripOptions): Promise<RoundtripMeta> {
    return runGate(XLSX_GATE, options);
}

// ── The held-out set ────────────────────────────────────────────────────────────────────────────────────────────

// A seeded draw by hash, half from the real-world files, so it holds at least as many real files as fixtures.
export function drawHeldout(options: { corpora: string[]; real: string[]; count: number; seed: string }): string[] {
    const rank = (key: string) => new Bun.CryptoHasher('sha256').update(`${options.seed}\n${key}`).digest('hex');
    const keys = listCorpus(options.corpora, WORKBOOK, 'workbooks').map(({ key }) => key);
    const isReal = (key: string) => options.real.some((prefix) => key.startsWith(prefix));
    const ranked = (real: boolean) =>
        keys.filter((key) => isReal(key) === real).sort((x, y) => (rank(x) < rank(y) ? -1 : 1));
    const real = ranked(true).slice(0, Math.ceil(options.count / 2));
    return [...real, ...ranked(false).slice(0, options.count - real.length)].sort();
}

if (import.meta.main) {
    const { values, positionals } = parseArgs({
        args: Bun.argv.slice(2),
        allowPositionals: true,
        options: {
            out: { type: 'string' },
            importer: { type: 'string' },
            writer: { type: 'string' },
            name: { type: 'string' },
            timeout: { type: 'string' },
            'max-rss': { type: 'string' },
            heldout: { type: 'string' },
            set: { type: 'string' },
            real: { type: 'string', multiple: true },
            count: { type: 'string' },
            seed: { type: 'string' },
            cells: { type: 'string' },
            reports: { type: 'string' },
            dump: { type: 'string' },
        },
    });
    const [command, ...rest] = positionals;
    const set = values.set === 'tuned' || values.set === 'heldout' ? values.set : undefined;
    if (command === 'child' && rest.length === 1 && values.importer && values.cells && values.reports) {
        await child(rest[0], { importer: values.importer, cells: values.cells, reports: values.reports });
    } else if (command === 'roundtrip-child' && rest.length === 1 && values.writer && values.reports) {
        await xlsxRoundtripChild(rest[0], { writer: values.writer, reports: values.reports, dump: values.dump });
    } else if (command === 'roundtrip' && rest.length > 0 && values.out) {
        const meta = await runRoundtrip({
            corpora: rest,
            out: values.out,
            writer: values.writer,
            dump: values.dump,
            timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
            maxRssMb: values['max-rss'] ? Number(values['max-rss']) : undefined,
        });
        console.log(`${roundtripLine(meta)}: ${path.join(values.out, 'summary.md')}`);
        if (!meta.pass) process.exit(1);
    } else if (command === 'compare' && rest.length === 2 && (values.set === undefined || (set && values.heldout))) {
        console.log(compareRuns(rest[0], rest[1], { heldout: values.heldout, set }));
    } else if (command === 'run' && rest.length > 0 && values.out) {
        const meta = await runAudit({
            corpora: rest,
            out: values.out,
            importer: values.importer,
            name: values.name ?? path.basename(values.importer ?? DEFAULT_IMPORTER, '.ts'),
            timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
            maxRssMb: values['max-rss'] ? Number(values['max-rss']) : undefined,
        });
        console.log(
            `${meta.files} files, ${OUTCOMES.map((outcome) => `${meta.outcomes[outcome] ?? 0} ${outcome}`).join(', ')}: ${path.join(values.out, 'summary.md')}`,
        );
    } else if (command === 'split' && rest.length > 0 && values.out) {
        const seed = values.seed ?? 'xlsx-r0';
        const heldout = drawHeldout({
            corpora: rest,
            real: values.real ?? [],
            count: Number(values.count ?? 100),
            seed,
        });
        fs.writeFileSync(
            values.out,
            `# Held-out xlsx files: seed ${seed}, real-world ${(values.real ?? []).join(' ')}\n${heldout.join('\n')}\n`,
        );
        console.log(`${heldout.length} held-out files: ${values.out}`);
    } else {
        console.error(
            [
                'Usage: bun apps/api/src/scripts/xlsx-audit.ts run <corpus dir...> --out <dir> [--importer <module>] [--name <label>] [--timeout <s>] [--max-rss <MB>]',
                '       bun apps/api/src/scripts/xlsx-audit.ts compare <runA> <runB> [--heldout <list> --set tuned|heldout]',
                '       bun apps/api/src/scripts/xlsx-audit.ts roundtrip <corpus dir...> --out <dir> [--writer <module>] [--dump <dir>] [--timeout <s>] [--max-rss <MB>]',
                '       bun apps/api/src/scripts/xlsx-audit.ts split <corpus dir...> --out <list> [--real <key prefix>...] [--count <n>] [--seed <s>]',
            ].join('\n'),
        );
        process.exit(1);
    }
}
