// Responsiveness benchmark for document transforms (proposal Phase 0 baseline and
// the Phase 1 gate). Seeds a heavy document of each collab type — eigensheets,
// eigendoc, eigenslides — then measures a cold preview, a cache-hit preview and a
// download export while probing the event loop, the /health route, and RSS.
//
// Run from apps/api:
//   bun src/test/transform-benchmark.ts [--rows 1500] [--cols 40]
//                                       [--sections 300] [--slides 60] [--objects 6]
//   EIGEN_BENCH_XLSX=/path/to/big.xlsx adds a real-workbook scenario (file is
//   imported through the normal import seam; nothing is written to the repo).
//
// Not a .test.ts on purpose — it takes tens of seconds and its numbers are
// machine-relative. Targets (reference dev machine, proposal § Responsiveness
// benchmark): health p95 < 150 ms, event-loop p99 < 100 ms, no delay > 250 ms.

import type { DrivePath } from '@workspace/lib/types/drive';
import type * as Y from 'yjs';

// './setup' must evaluate before any lib module so EIGEN_DATA_ROOT points at the
// test dir — the same job --preload does for the test suite. Dynamic imports keep
// the import organizer from hoisting lib modules above it.
const { authedRequest, driveGet, drivePost, getTestContext } = await import('./setup');
const { getHome } = await import('../lib/home/get-home');
const { importIntoDocument } = await import('../lib/import/import-document');
const { buildHeavyOps, buildHeavySheets, seedSheetsDoc } = await import('./fixtures/heavy-sheets');
const { buildHeavyDeck, buildHeavyDocJson, seedEigendoc, seedSlidesDoc } = await import('./fixtures/golden-documents');
const fs = await import('node:fs');

const args = process.argv.slice(2);
function argNum(name: string, fallback: number): number {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : fallback;
}
const ROWS = argNum('rows', 1500);
const COLS = argNum('cols', 40);
const SECTIONS = argNum('sections', 300);
const SLIDES = argNum('slides', 60);
const OBJECTS = argNum('objects', 6);

const ctx = await getTestContext();
const token = ctx.alice.user.sessionToken;
const ownerId = ctx.alice.user.id;
const mountId = 'default';
const home = await getHome(ownerId);

type Stats = { n: number; p50: number; p95: number; p99: number; max: number };

function stats(samples: number[]): Stats {
    if (samples.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const s = [...samples].sort((a, b) => a - b);
    const pick = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
    return { n: s.length, p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: s[s.length - 1] };
}

function fmt(s: Stats): string {
    return `n=${s.n} p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms`;
}

// Runs `work` while sampling event-loop tick lag (5 ms setTimeout chain), /health
// round-trip latency (in-process app.handle), and RSS. Both probes ride the same
// event loop as the API server, so a blocked loop shows up as lag/latency spikes.
async function measure(label: string, work: () => Promise<unknown>) {
    const loopLags: number[] = [];
    const healthMs: number[] = [];
    let rssPeak = process.memoryUsage.rss();
    let running = true;

    const loopProbe = (async () => {
        while (running) {
            const before = performance.now();
            await new Promise((resolve) => setTimeout(resolve, 5));
            loopLags.push(Math.max(0, performance.now() - before - 5));
            rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
        }
    })();

    const healthProbe = (async () => {
        while (running) {
            const before = performance.now();
            await ctx.app.handle(new Request('http://localhost/health'));
            healthMs.push(performance.now() - before);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    })();

    const start = performance.now();
    const result = await work();
    const e2eMs = performance.now() - start;
    running = false;
    await Promise.all([loopProbe, healthProbe]);
    rssPeak = Math.max(rssPeak, process.memoryUsage.rss());

    console.log(`\n=== ${label} ===`);
    console.log(`e2e        ${e2eMs.toFixed(0)}ms`);
    console.log(`health     ${fmt(stats(healthMs))}`);
    console.log(`loop lag   ${fmt(stats(loopLags))}`);
    console.log(`rss peak   ${(rssPeak / 1024 / 1024).toFixed(0)}MB`);
    return { e2eMs, result };
}

async function createDocument(fileName: string, type: 'sheets' | 'doc' | 'slides'): Promise<DrivePath> {
    const root = await driveGet<DrivePath>(token, ownerId, mountId, 'root');
    return drivePost<DrivePath>(token, ownerId, mountId, `folder/${root.id}/create/${type}`, { fileName });
}

async function coldPreview(pathId: string): Promise<{ bytes: number; cacheBytes: number }> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${pathId}/text-preview`);
    if (res.status !== 200) throw new Error(`text-preview failed: ${res.status}`);
    const { body } = (await res.json()) as { body: string };
    const { mount } = await home.drive.resolveFile(mountId, pathId);
    const cacheFile = fs
        .readdirSync(mount.previewsDir)
        .filter((name) => name.startsWith(`${pathId}-`))
        .map((name) => `${mount.previewsDir}/${name}`)[0];
    return { bytes: Buffer.byteLength(body), cacheBytes: cacheFile ? fs.statSync(cacheFile).size : 0 };
}

async function exportDownload(pathId: string, format: 'xlsx' | 'html'): Promise<{ data: ArrayBuffer }> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${pathId}/export/${format}`);
    if (res.status !== 200) throw new Error(`export failed: ${res.status}`);
    return { data: await res.arrayBuffer() };
}

async function importXlsx(pathId: string, data: ArrayBuffer): Promise<void> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${pathId}/import`, {
        method: 'POST',
        body: data,
    });
    if (res.status !== 200) throw new Error(`import failed: ${res.status} ${await res.text()}`);
}

async function runScenario(label: string, pathId: string, format: 'xlsx' | 'html'): Promise<ArrayBuffer> {
    const cold = await measure(`${label}: cold preview`, () => coldPreview(pathId));
    const sizes = cold.result as { bytes: number; cacheBytes: number };
    console.log(`body bytes ${sizes.bytes}  cache bytes ${sizes.cacheBytes}`);

    const warm = await measure(`${label}: cache-hit preview`, () => coldPreview(pathId));
    console.log(`cache-hit e2e ${warm.e2eMs.toFixed(1)}ms`);

    const download = await measure(`${label}: ${format} export`, () => exportDownload(pathId, format));
    const exported = (download.result as { data: ArrayBuffer }).data;
    console.log(`${format} bytes ${exported.byteLength}`);
    return exported;
}

// The export's own bytes go back in through the /import route, into a fresh doc —
// so import runs under the same event-loop/health probes as preview and export.
async function importScenario(label: string, xlsx: ArrayBuffer) {
    const target = await createDocument(`bench-import-${Date.now()}`, 'sheets');
    await measure(`${label}: xlsx import`, () => importXlsx(target.id, xlsx));
    console.log(`import bytes ${xlsx.byteLength}`);
}

// One heavy document per collab type, under the same probes, so a doc- or deck-render
// regression shows up next to the sheets numbers. The generators are the ones the tests
// use, so the fixtures stay deterministic.
const scenarios: {
    label: string;
    fileName: string;
    type: 'sheets' | 'doc' | 'slides';
    seed: (doc: Y.Doc) => void;
    format: 'xlsx' | 'html';
}[] = [
    {
        label: `synthetic ${ROWS}x${COLS}`,
        fileName: 'bench-synthetic',
        type: 'sheets',
        seed: (doc) => seedSheetsDoc(doc, buildHeavySheets(ROWS, COLS), buildHeavyOps(60, 25, ROWS, COLS)),
        format: 'xlsx',
    },
    {
        label: `doc ${SECTIONS} sections`,
        fileName: 'bench-doc',
        type: 'doc',
        seed: (doc) => seedEigendoc(doc, buildHeavyDocJson(SECTIONS)),
        format: 'html',
    },
    {
        label: `deck ${SLIDES}x${OBJECTS}`,
        fileName: 'bench-deck',
        type: 'slides',
        seed: (doc) => seedSlidesDoc(doc, buildHeavyDeck(SLIDES, OBJECTS)),
        format: 'html',
    },
];

for (const { label, fileName, type, seed, format } of scenarios) {
    const created = await createDocument(fileName, type);
    const collab = await home.drive.getCollabDocument(mountId, created.id);
    const seedStart = performance.now();
    seed(collab.doc);
    console.log(`seeded ${label} in ${(performance.now() - seedStart).toFixed(0)}ms`);
    const exported = await runScenario(label, created.id, format);
    // Only the sheet export can go back in through /import.
    if (format === 'xlsx') await importScenario(label, exported);
}

// Memory pass (proposal § Memory benchmark): repeat the heavy preview through
// one-shot Workers and verify post-job RSS stabilizes instead of growing linearly.
if (args.includes('--memory')) {
    const { generateDocumentPreview } = await import('../lib/preview/preview-document');
    const doc = await createDocument('bench-memory', 'sheets');
    const collab = await home.drive.getCollabDocument(mountId, doc.id);
    seedSheetsDoc(collab.doc, buildHeavySheets(600, 45), buildHeavyOps(40, 25, 600, 45));
    const { mount, path } = await home.drive.resolveFile(mountId, doc.id);

    const memoryRuns = argNum('memory-runs', 8);
    console.log(`\n=== memory: ${memoryRuns} repeated Worker previews (600x45) ===`);
    for (let i = 0; i < memoryRuns; i++) {
        const start = performance.now();
        await generateDocumentPreview('eigensheets', mount, path);
        Bun.gc(true);
        console.log(
            `run ${i + 1}: ${(performance.now() - start).toFixed(0)}ms rss=${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)}MB`,
        );
    }
}

// A real workbook, if provided (kept out of the repo).
const xlsxPath = process.env['EIGEN_BENCH_XLSX'];
if (xlsxPath && fs.existsSync(xlsxPath)) {
    const doc = await createDocument('bench-real-xlsx', 'sheets');
    const { mount, path } = await home.drive.resolveFile(mountId, doc.id);
    const buffer = Buffer.from(fs.readFileSync(xlsxPath));
    await measure(`real xlsx: import (${buffer.byteLength} bytes)`, () =>
        importIntoDocument(home.drive, mount, path, buffer, home.user),
    );
    console.log(`imported ${xlsxPath}`);
    await runScenario('real xlsx', doc.id, 'xlsx');
} else {
    console.log('\n(no EIGEN_BENCH_XLSX provided — skipping real-workbook scenario)');
}

process.exit(0);
