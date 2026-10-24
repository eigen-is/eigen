import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sheet } from '@workspace/lib/sheets';
import { xlsxToSheets } from '../../lib/import/sheets/from-xlsx';
import {
    classifyDifferences,
    compareRuns,
    drawHeldout,
    type Feature,
    runAudit,
    runRoundtrip,
    tallySheets,
    tallySource,
    xlsxPackage,
} from '../../scripts/xlsx-audit';

// What the audit counts on either side, and that a
// run survives what an importer does to it and compare reports what changed.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-audit-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const READER = fileURLToPath(new URL('../../lib/import/sheets/from-xlsx.ts', import.meta.url));
const WRITER = fileURLToPath(new URL('../../lib/export/sheets/xlsx/to-xlsx.ts', import.meta.url));

// Every feature the source side counts, once or a known number of times.
const DATA = [
    '<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<cols><col min="2" max="4" width="20" customWidth="1"/><col min="5" max="5" width="9" hidden="1"/></cols>',
    '<sheetData>',
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1"><v>42</v></c><c r="C1"><f>B1*2</f><v>84</v></c><c r="D1" t="e"><v>#N/A</v></c></row>',
    '<row r="2" hidden="1"><c r="A2"><f t="shared" ref="A2:A3" si="0">B1+1</f><v>43</v></c></row>',
    '<row r="3"><c r="A3"><f t="shared" si="0"/><v>1</v></c></row>',
    '<row r="4" ht="30" customHeight="1"><c r="B4" t="inlineStr"><is><t>Merged</t></is></c></row>',
    '</sheetData>',
    '<mergeCells count="1"><mergeCell ref="B4:C4"/></mergeCells>',
    '<conditionalFormatting sqref="B1"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>10</formula></cfRule></conditionalFormatting>',
    '<hyperlinks><hyperlink ref="A1" location="\'Data\'!B1"/></hyperlinks>',
].join('');

const workbook = (marker = '') =>
    xlsxPackage(
        [
            { name: 'Data', body: DATA },
            { name: 'Notes', body: '<sheetData/>', state: 'hidden' },
        ],
        // Stored, so a stub importer finds it in the bytes it is handed.
        marker ? [{ name: 'marker.txt', data: marker, store: true }] : [],
    );

const counts = (tally: Map<Feature, number>, features: Feature[]) =>
    Object.fromEntries(features.map((feature) => [feature, tally.get(feature) ?? 0]));

describe('tallies', () => {
    test("the source side counts what the package's XML holds, columns and rows one by one", () => {
        expect(
            counts(tallySource(workbook()), [
                'sheets',
                'hiddenSheets',
                'tabColors',
                'cells',
                'errors',
                'formulas',
                'sharedFormulas',
                'merges',
                'columnWidths',
                'hiddenColumns',
                'hiddenRows',
                'rowHeights',
                'frozen',
                'conditionalFormats',
                'hyperlinks',
            ]),
        ).toEqual({
            sheets: 2,
            hiddenSheets: 1,
            tabColors: 1,
            cells: 7,
            errors: 1,
            formulas: 3,
            sharedFormulas: 1,
            merges: 1,
            columnWidths: 4,
            hiddenColumns: 1,
            hiddenRows: 1,
            rowHeights: 1,
            frozen: 1,
            conditionalFormats: 1,
            hyperlinks: 1,
        });
    });

    test('the imported side counts the same features in the sheets the reader makes', async () => {
        const { counts: tally } = tallySheets(xlsxToSheets(Buffer.from(workbook())));
        expect(
            counts(tally, [
                'sheets',
                'formulas',
                'errors',
                'merges',
                'hiddenColumns',
                'hiddenRows',
                'frozen',
                'conditionalFormats',
                'hyperlinks',
            ]),
        ).toEqual({
            sheets: 2,
            formulas: 3,
            errors: 1,
            merges: 1,
            hiddenColumns: 1,
            hiddenRows: 1,
            frozen: 1,
            conditionalFormats: 1,
            hyperlinks: 1,
        });
    });

    test('a map fingerprints alike whatever order an importer builds it in, and a cell by its value, formula and look', () => {
        const sheet = (merge: [string, number][], bold: number): Sheet => ({
            name: 'S',
            config: { merge: Object.fromEntries(merge.map(([key, r]) => [key, { r, c: 0, rs: 1, cs: 2 }])) },
            celldata: [{ r: 0, c: 0, v: { v: 1, m: '1', f: '=1', bl: bold } }],
        });
        const one = tallySheets([
            sheet(
                [
                    ['0_0', 0],
                    ['1_0', 1],
                ],
                1,
            ),
        ]);
        const other = tallySheets([
            sheet(
                [
                    ['1_0', 1],
                    ['0_0', 0],
                ],
                0,
            ),
        ]);
        expect(one.sheets[0]?.hashes['merge']).toBe(other.sheets[0]?.hashes['merge']);
        const [a, b] = [one.cells.prints[0]?.[1] ?? [], other.cells.prints[0]?.[1] ?? []];
        expect([a[2] === b[2], a[3] === b[3], a[4] === b[4]]).toEqual([true, true, false]);
        expect(one.cells.sample['S']?.['0_0']).toEqual(['{"m":"1","v":1}', '=1', '{"bl":1}']);
    });
});

async function corpus(name: string, files: Record<string, Uint8Array | string>): Promise<string> {
    const dir = path.join(scratch, name);
    for (const [file, bytes] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        await Bun.write(path.join(dir, file), bytes);
    }
    return dir;
}

// Its own directory: Bun's resolver keeps a listing of a directory it loaded a module from.
async function importer(name: string, source: string): Promise<string> {
    const module = path.join(fs.mkdtempSync(path.join(scratch, 'importer-')), `${name}.ts`);
    await Bun.write(module, source);
    return module;
}

describe('runs', () => {
    test('the reader against itself is a pass; a planted difference is reported cell by cell and fails the gate', async () => {
        const dir = await corpus('planted', { 'book.xlsx': workbook(), 'nested/twin.xlsm': workbook() });
        const reader = path.join(scratch, 'out-reader');
        const again = path.join(scratch, 'out-again');
        for (const out of [reader, again]) {
            const meta = await runAudit({ corpora: [dir], out, name: path.basename(out), timeoutMs: 30_000 });
            expect([meta.files, meta.outcomes.ok]).toEqual([2, 2]);
        }
        const same = compareRuns(reader, again);
        expect(same).toContain('**Gate: pass** on 2 files.');
        expect(same).not.toContain('### value');

        // A1 loses its bold-free look, B1 its value, and the merge is gone.
        const planted = await importer(
            'planted',
            `import { xlsxToSheets as read } from ${JSON.stringify(READER)};
            export async function xlsxToSheets(buffer) {
                const sheets = await read(buffer);
                const cells = sheets[0].celldata;
                cells.find((cell) => cell.r === 0 && cell.c === 0).v.bl = 1;
                cells.find((cell) => cell.r === 0 && cell.c === 1).v.v = 41;
                delete sheets[0].config.merge;
                return sheets;
            }`,
        );
        const out = path.join(scratch, 'out-planted');
        await runAudit({ corpora: [dir], out, importer: planted, name: 'planted', timeoutMs: 30_000 });
        const comparison = compareRuns(reader, out);
        expect(comparison).toContain('**Gate: FAIL** on 2 files.');
        expect(comparison).toContain('| Each feature kept at least as out-reader keeps it | **FAIL** | Merges;');
        expect(comparison).toContain('| look | 2 | 2 |');
        expect(comparison).toContain('| value | 2 | 2 |');
        expect(comparison).toContain(
            '| planted/book.xlsx | Data!B1 | {"m":"42","t":"n","v":42} | {"m":"42","t":"n","v":41} |',
        );
        expect(comparison).toContain('| merge | 2 | planted/book.xlsx Data; planted/nested/twin.xlsm Data |');
    }, 60_000);

    test('a refusal, a crash, a timeout and a blow-up are results, and the run goes on to its summary', async () => {
        const dir = await corpus('hostile', {
            'refuse.xlsx': workbook('REFUSE'),
            'crash.xlsx': workbook('CRASH'),
            'hang.xlsx': workbook('HANG'),
            'hog.xlsx': workbook('HOG'),
            'fine.xlsx': workbook(),
        });
        const stub = await importer(
            'stub',
            `import { xlsxToSheets as read } from ${JSON.stringify(READER)};
            export async function xlsxToSheets(buffer) {
                const text = buffer.toString('latin1');
                if (text.includes('REFUSE')) throw Object.assign(new Error('Spreadsheet too large'), { status: 413 });
                if (text.includes('CRASH')) throw new Error('stub crashes');
                if (text.includes('HANG')) while (true) {}
                if (text.includes('HOG')) {
                    globalThis.hog = new Uint8Array(512 * 1024 * 1024).fill(1);
                    while (true) {}
                }
                return read(buffer);
            }`,
        );
        const out = path.join(scratch, 'out-stub');
        const meta = await runAudit({
            corpora: [dir],
            out,
            importer: stub,
            name: 'stub',
            timeoutMs: 5_000,
            maxRssMb: 256,
        });
        expect(meta.outcomes).toEqual({ ok: 1, refused: 1, crash: 1, timeout: 1, memory: 1 });
        const result = (file: string) =>
            JSON.parse(fs.readFileSync(path.join(out, 'files/hostile', `${file}.json`), 'utf8'));
        expect([result('refuse.xlsx').status, result('refuse.xlsx').error, result('crash.xlsx').error]).toEqual([
            413,
            'Spreadsheet too large',
            'stub crashes',
        ]);
        expect(result('hang.xlsx').ms).toBe(5_000);
        expect(result('hog.xlsx').rssMb).toBeGreaterThan(256);
        expect(result('fine.xlsx').rssMb).toBeGreaterThan(0);
        // The source is read whatever the importer did, but where the child was cut first.
        expect([result('crash.xlsx').source.merges, result('hang.xlsx').sourceError]).toEqual([1, 'timeout']);
        expect(fs.readFileSync(path.join(out, 'summary.md'), 'utf8')).toContain(
            '| refused 413 | Spreadsheet too large | 1 |',
        );

        const reader = path.join(scratch, 'out-hostile-reader');
        await runAudit({ corpora: [dir], out: reader, name: 'reader', timeoutMs: 30_000 });
        const comparison = compareRuns(reader, out);
        expect(comparison).toContain(
            '| stub refuses nothing reader imports, but by a cap | **FAIL** | 3 lost; 1 refused by a cap (413)',
        );
        expect(comparison).toContain('| hostile/hang.xlsx | ok | timeout | timeout |');
    }, 90_000);

    test('the held-out draw is seeded and half real; compare reads one set at a time', async () => {
        const files = Object.fromEntries(
            [...Array(6).keys()].flatMap((n) => [
                [`real/${n}.xlsx`, workbook()],
                [`fixture/${n}.xlsx`, workbook()],
            ]),
        );
        const dir = await corpus('split', files);
        const draw = (seed: string) => drawHeldout({ corpora: [dir], real: ['split/real/'], count: 4, seed });
        const heldout = draw('one');
        expect(heldout).toEqual(draw('one'));
        expect(heldout.filter((key) => key.startsWith('split/real/'))).toHaveLength(2);
        expect(heldout).toHaveLength(4);

        const list = path.join(scratch, 'heldout.txt');
        fs.writeFileSync(list, `# drawn\n${heldout.join('\n')}\n`);
        const script = fileURLToPath(new URL('../../scripts/xlsx-audit.ts', import.meta.url));
        const out = path.join(scratch, 'out-split');
        const run = Bun.spawn([process.execPath, script, 'run', dir, '--out', out], { stdout: 'ignore' });
        expect(await run.exited).toBe(0);
        expect(JSON.parse(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).name).toBe('from-xlsx');
        const compared = (set: string) =>
            Bun.spawnSync([process.execPath, script, 'compare', out, out, '--heldout', list, '--set', set])
                .stdout.toString()
                .split('\n')[2];
        expect([compared('heldout'), compared('tuned')]).toEqual([
            '**Gate: pass** on 4 files.',
            '**Gate: pass** on 8 files.',
        ]);
    }, 90_000);
});

describe('round trip', () => {
    const history = xlsxPackage([
        { name: 'History', body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' },
    ]);

    test('our writer brings every feature back; a refused file is skipped and a listed difference counted under its kind', async () => {
        const dir = await corpus('roundtrip', {
            'book.xlsx': workbook(),
            'history.xlsx': history,
            'bad.xlsx': 'no zip',
        });
        const out = path.join(scratch, 'out-roundtrip');
        const meta = await runRoundtrip({ corpora: [dir], out, timeoutMs: 30_000 });
        expect(meta.outcomes).toEqual({ ok: 2, skipped: 1, crash: 0, timeout: 0, memory: 0 });
        expect([meta.pass, meta.unlisted, meta.listed]).toEqual([
            true,
            { differences: 0, files: 0 },
            { differences: 1, files: 1 },
        ]);
        const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
        expect(summary).toContain(
            '**Round trip pass: 3 files, 2 imported and written back, 1 skipped, 0 crashes, 0 cut; 0 unlisted differences in 0 files, 1 listed in 1.**',
        );
        expect(summary).toContain(
            '| roundtrip/history.xlsx | sheet names repaired | listed | 1 | History!0: "History" → "History (2)" |',
        );
    }, 60_000);

    test('a writer that moves a column by a pixel, changes a value and drops a merge fails the gate, each by kind', async () => {
        const dir = await corpus('mutated', { 'book.xlsx': workbook() });
        const planted = await importer(
            'writer',
            `import { writeXlsx as write } from ${JSON.stringify(WRITER)};
            export function writeXlsx(sheets, options) {
                const copy = structuredClone(sheets);
                const [data] = copy;
                data.config.columnlen[1] += 1;
                data.celldata.find((cell) => cell.r === 0 && cell.c === 1).v.v = 41;
                delete data.config.merge;
                return write(copy, options);
            }`,
        );
        const out = path.join(scratch, 'out-mutated');
        const script = fileURLToPath(new URL('../../scripts/xlsx-audit.ts', import.meta.url));
        const run = Bun.spawnSync([process.execPath, script, 'roundtrip', dir, '--out', out, '--writer', planted]);
        expect(run.exitCode).toBe(1);
        expect(run.stdout.toString()).toContain(
            '\nRound trip FAIL: 1 files, 1 imported and written back, 0 skipped, 0 crashes, 0 cut; 6 unlisted differences in 1 files',
        );
        const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
        for (const row of [
            '| columnlen | **unlisted** | 1 | 1 |',
            '| cell v | **unlisted** | 1 | 1 |',
            '| cell m | **unlisted** | 1 | 1 |',
            '| merge | **unlisted** | 1 | 1 |',
            '| cell mc | **unlisted** | 2 | 1 |',
        ])
            expect(summary).toContain(row);
        expect(summary).toContain('| mutated/book.xlsx | columnlen | **unlisted** | 1 | Data!1: 140 → 141 |');
    }, 60_000);

    test('a writer that throws is a crash, at its stage', async () => {
        const dir = await corpus('throws', { 'book.xlsx': workbook() });
        const planted = await importer('throws', 'export function writeXlsx() { throw new Error("writer broke"); }');
        const out = path.join(scratch, 'out-throws');
        const meta = await runRoundtrip({ corpora: [dir], out, writer: planted, timeoutMs: 30_000 });
        expect([meta.pass, meta.outcomes.crash]).toEqual([false, 1]);
        const result = JSON.parse(fs.readFileSync(path.join(out, 'files/throws/book.xlsx.json'), 'utf8'));
        expect([result.outcome, result.stage, result.error.split('\n')[0]]).toEqual([
            'crash',
            'export',
            'Error: writer broke',
        ]);
    }, 60_000);

    test('a difference the writer explains is listed under its kind, any other under its feature', () => {
        const sheet = (cell: Sheet['celldata']): Sheet[] => [{ name: 'S', celldata: cell }];
        const groups = classifyDifferences({
            warnings: new Map(),
            media: { a: new Map(), b: new Map() },
            a: sheet([
                { r: 0, c: 0, v: { v: 'a', fs: 10 } },
                { r: 0, c: 1, v: { v: 1, m: '1' } },
            ]),
            b: sheet([
                { r: 0, c: 0, v: { v: 'a', ff: 'Inter' } },
                { r: 0, c: 1, v: { v: 1, m: '1', fs: 11 } },
            ]),
        });
        expect(groups.map(({ kind, listed, count }) => [kind, listed, count])).toEqual([
            ['default font keys', true, 2],
            ['cell fs', false, 1],
        ]);
    });

    test('a sheet name is listed as repaired only as the writer repairs it', () => {
        const names = (...names: string[]): Sheet[] => names.map((name) => ({ name }));
        const classify = (b: Sheet[]) =>
            classifyDifferences({
                warnings: new Map([['sheet-names-changed', 1]]),
                a: names('History', 'Data'),
                b,
                media: { a: new Map(), b: new Map() },
            }).map(({ kind, listed, count }) => [kind, listed, count]);
        expect(classify(names('History (2)', 'Data'))).toEqual([['sheet names repaired', true, 1]]);
        expect(classify(names('History (2)', 'Other'))).toEqual([
            ['sheet names repaired', true, 1],
            ['sheet name', false, 1],
        ]);
    });

    test("a picture over the same box whose media changed its type or its pixels differs, whatever it's named", () => {
        const image = (mediaName: string): Sheet[] => [
            { name: 'S', images: { i: { id: 'i', index: 'a0', x: 0, y: 0, width: 10, height: 10, mediaName } } },
        ];
        const classify = (b: { contentType: string; width: number; height: number }) =>
            classifyDifferences({
                warnings: new Map(),
                a: image('one.png'),
                b: image('two.png'),
                media: {
                    a: new Map([['one.png', { contentType: 'image/png', width: 4, height: 4 }]]),
                    b: new Map([['two.png', b]]),
                },
            }).map(({ kind, listed, count }) => [kind, listed, count]);
        expect(classify({ contentType: 'image/png', width: 4, height: 4 })).toEqual([]);
        expect(classify({ contentType: 'image/jpeg', width: 4, height: 4 })).toEqual([['images', false, 1]]);
        expect(classify({ contentType: 'image/png', width: 2, height: 2 })).toEqual([['images', false, 1]]);
    });
});
