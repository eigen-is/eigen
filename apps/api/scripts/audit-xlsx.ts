// Audit tooling for the sheets xlsx-fidelity program:
// reports, per feature dimension, what an xlsx contains (raw XML), what exceljs
// exposes, and what survives xlsxToSheets — the 4-stage gap report.
// Usage: bun apps/api/scripts/audit-xlsx.ts "<path-to-xlsx>"
// Read-only on the input; prints a markdown report to stdout.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sheet } from '@workspace/lib/sheets';
import { update } from '@workspace/sheet/engine';
import { $ } from 'bun';
import ExcelJS from 'exceljs';
import { xlsxToSheets } from '../src/lib/import/sheets/from-xlsx';

const inputPath = process.argv[2];
if (!inputPath) {
    console.error('Usage: bun apps/api/scripts/audit-xlsx.ts "<path-to-xlsx>"');
    process.exit(1);
}

function count(haystack: string, re: RegExp): number {
    return (haystack.match(re) ?? []).length;
}

async function listFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
    }
    return out;
}

// ---------- Stage 1: raw XML scan ----------
type RawFindings = {
    autoFilter: number;
    conditionalFormatting: number;
    x14ConditionalFormatting: number;
    dataValidation: number;
    x14DataValidation: number;
    hiddenCols: number;
    hiddenRows: number;
    frozenPanes: number;
    hyperlinks: number;
    definedNames: number;
    numFmts: string[];
    richTextRuns: number;
    mediaParts: string[];
    commentParts: string[];
    checkboxParts: string[];
    extLst: number;
};

async function rawScan(path: string): Promise<RawFindings> {
    const dir = await mkdtemp(join(tmpdir(), 'xlsx-audit-'));
    await $`unzip -o -q ${path} -d ${dir}`.quiet();
    const files = await listFiles(dir);
    const rel = (f: string) => f.slice(dir.length + 1);

    const findings: RawFindings = {
        autoFilter: 0,
        conditionalFormatting: 0,
        x14ConditionalFormatting: 0,
        dataValidation: 0,
        x14DataValidation: 0,
        hiddenCols: 0,
        hiddenRows: 0,
        frozenPanes: 0,
        hyperlinks: 0,
        definedNames: 0,
        numFmts: [],
        richTextRuns: 0,
        mediaParts: files.filter((f) => rel(f).startsWith('xl/media/')).map(rel),
        commentParts: files.filter((f) => /comments|threadedComments/i.test(rel(f))).map(rel),
        checkboxParts: [],
        extLst: 0,
    };

    for (const file of files) {
        const name = rel(file);
        const isText = /\.(xml|rels|json|vml)$/i.test(name);
        if (!isText) continue;
        const text = await readFile(file, 'utf8');

        if (/checkbox/i.test(text)) findings.checkboxParts.push(name);

        if (name.startsWith('xl/worksheets/') && name.endsWith('.xml')) {
            findings.autoFilter += count(text, /<autoFilter\b/g);
            findings.conditionalFormatting += count(text, /<conditionalFormatting\b/g);
            findings.x14ConditionalFormatting += count(text, /<x14:conditionalFormatting\b/g);
            findings.dataValidation += count(text, /<dataValidation\b/g);
            findings.x14DataValidation += count(text, /<x14:dataValidation\b/g);
            findings.hiddenCols += count(text, /<col\b[^>]*hidden="(?:1|true)"/g);
            findings.hiddenRows += count(text, /<row\b[^>]*hidden="(?:1|true)"/g);
            findings.frozenPanes += count(text, /<pane\b[^>]*state="frozen"/g);
            findings.hyperlinks += count(text, /<hyperlink\b/g);
            findings.extLst += count(text, /<extLst\b/g);
        }
        if (name === 'xl/workbook.xml') {
            findings.definedNames += count(text, /<definedName\b/g);
        }
        if (name === 'xl/styles.xml') {
            for (const m of text.matchAll(/<numFmt\b[^>]*formatCode="([^"]*)"/g)) {
                findings.numFmts.push(m[1]);
            }
        }
        if (name === 'xl/sharedStrings.xml') {
            findings.richTextRuns = count(text, /<r>/g);
        }
    }

    await rm(dir, { recursive: true, force: true });
    return findings;
}

// ---------- Stage 2: exceljs object-model probe ----------
type ExceljsSheetFindings = {
    name: string;
    view: { state?: string; xSplit?: number; ySplit?: number; showGridLines?: boolean };
    hiddenCols: number;
    hiddenRows: number;
    autoFilter: unknown;
    conditionalFormattings: number;
    dataValidations: number;
    images: number;
    notes: number;
    hyperlinkCells: number;
    richTextCells: number;
    numFmtSamples: Map<string, { address: string; value: unknown }>;
};

function probeWorksheet(ws: ExcelJS.Worksheet): ExceljsSheetFindings {
    const view = ws.views?.[0] ?? {};
    const f: ExceljsSheetFindings = {
        name: ws.name,
        view: {
            state: view.state,
            xSplit: 'xSplit' in view ? view.xSplit : undefined,
            ySplit: 'ySplit' in view ? view.ySplit : undefined,
            showGridLines: view.showGridLines,
        },
        hiddenCols: (ws.columns ?? []).filter((c) => c?.hidden).length,
        hiddenRows: 0,
        // exceljs typings omit these two on Worksheet; they exist at runtime (v4).
        autoFilter: (ws as unknown as { autoFilter?: unknown }).autoFilter,
        conditionalFormattings:
            (ws as unknown as { conditionalFormattings?: unknown[] }).conditionalFormattings?.length ?? 0,
        dataValidations: Object.keys(
            (ws as unknown as { dataValidations?: { model?: Record<string, unknown> } }).dataValidations?.model ?? {},
        ).length,
        images: ws.getImages().length,
        notes: 0,
        hyperlinkCells: 0,
        richTextCells: 0,
        numFmtSamples: new Map(),
    };

    ws.eachRow({ includeEmpty: false }, (row) => {
        if (row.hidden) f.hiddenRows++;
        row.eachCell({ includeEmpty: false }, (cell) => {
            if (cell.note) f.notes++;
            const v = cell.value;
            if (v && typeof v === 'object' && 'hyperlink' in v) f.hyperlinkCells++;
            if (v && typeof v === 'object' && 'richText' in v) f.richTextCells++;
            if (cell.numFmt && cell.numFmt !== 'General' && !f.numFmtSamples.has(cell.numFmt)) {
                f.numFmtSamples.set(cell.numFmt, { address: cell.address, value: cell.value });
            }
        });
    });
    return f;
}

// ---------- Stage 3: xlsxToSheets output inspection ----------
function inspectSheet(sheet: Sheet): string {
    const lines: string[] = [];
    const config = sheet.config ?? {};
    lines.push(`top-level keys: ${Object.keys(sheet).sort().join(', ')}`);
    lines.push(`config keys: ${Object.keys(config).sort().join(', ') || '(none)'}`);
    lines.push(`celldata: ${sheet.celldata?.length ?? 0} cells`);
    const counts: Record<string, number> = {};
    for (const key of ['rowhidden', 'colhidden', 'merge', 'columnlen', 'rowlen', 'borderInfo'] as const) {
        const value = (config as Record<string, unknown>)[key];
        counts[key] = value && typeof value === 'object' ? Object.keys(value).length : 0;
    }
    lines.push(
        `config counts: ${Object.entries(counts)
            .map(([k, n]) => `${k}=${n}`)
            .join(', ')}`,
    );
    for (const key of [
        'frozen',
        'filter',
        'filter_select',
        'conditionalFormatRules',
        'dataVerification',
        'hyperlink',
    ]) {
        const value = (sheet as unknown as Record<string, unknown>)[key];
        lines.push(`${key}: ${value === undefined ? 'ABSENT' : JSON.stringify(value).slice(0, 200)}`);
    }
    return lines.map((l) => `  - ${l}`).join('\n');
}

function renderCheck(sheets: Sheet[]): string[] {
    // For every distinct ct.fa: compare the imported display string (m) against what the
    // engine's numfmt-backed update() would render for the same raw value. A mismatch is
    // direct evidence of the euro/percent display bug.
    const rows: string[] = ['| fa (format) | sample v | imported m | update(fa, v) | match |', '|---|---|---|---|---|'];
    const seen = new Set<string>();
    for (const sheet of sheets) {
        for (const item of sheet.celldata ?? []) {
            const cell = item.v;
            const fa = cell?.ct?.fa;
            if (!fa || fa === 'General' || seen.has(fa)) continue;
            if (cell.v === undefined) continue;
            seen.add(fa);
            let rendered: string;
            try {
                rendered = String(update(fa, cell.v));
            } catch (error) {
                rendered = `THROWS: ${error}`;
            }
            const match = rendered === String(cell.m) ? 'OK' : 'MISMATCH';
            const esc = (s: unknown) => String(s).replaceAll('|', '\\|');
            rows.push(`| \`${esc(fa)}\` | ${esc(cell.v)} | ${esc(cell.m)} | ${esc(rendered)} | ${match} |`);
        }
    }
    return rows;
}

// ---------- main ----------
const buffer = Buffer.from(await Bun.file(inputPath).arrayBuffer());

console.log(`# xlsx audit: ${inputPath.split('/').pop()}\n`);

console.log('## Stage 1 — raw XML\n');
const raw = await rawScan(inputPath);
console.log('```json');
console.log(JSON.stringify(raw, null, 2));
console.log('```\n');

console.log('## Stage 2 — exceljs object model\n');
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(buffer);
const definedNames = (workbook.definedNames as unknown as { model?: unknown[] }).model?.length ?? 0;
console.log(`workbook definedNames: ${definedNames}\n`);
for (const ws of workbook.worksheets) {
    const f = probeWorksheet(ws);
    console.log(`### ${f.name}\n`);
    console.log('```json');
    console.log(JSON.stringify({ ...f, numFmtSamples: Object.fromEntries(f.numFmtSamples) }, null, 2));
    console.log('```\n');
}

console.log('## Stage 3 — xlsxToSheets output\n');
const sheets = await xlsxToSheets(buffer);
for (const sheet of sheets) {
    console.log(`### ${sheet.name}\n`);
    console.log(inspectSheet(sheet));
    console.log('');
}

console.log('## Stage 3b — number-format render check\n');
console.log(renderCheck(sheets).join('\n'));
console.log('');
