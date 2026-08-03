// Responsiveness benchmark for document transforms (proposal Phase 0 baseline and
// the Phase 1 gate). Seeds a heavy eigensheets doc, then measures a cold preview
// and an XLSX export while probing the event loop, the /health route, and RSS.
//
// Run from apps/api:
//   bun src/test/transform-benchmark.ts [--rows 1500] [--cols 40]
//   EIGEN_BENCH_XLSX=/path/to/big.xlsx adds a real-workbook scenario (file is
//   imported through the normal import seam; nothing is written to the repo).
//
// Not a .test.ts on purpose — it takes tens of seconds and its numbers are
// machine-relative. Targets (reference dev machine, proposal § Responsiveness
// benchmark): health p95 < 150 ms, event-loop p99 < 100 ms, no delay > 250 ms.

import type { DrivePath } from '@workspace/lib/types/drive';

// './setup' must evaluate before any lib module so EIGEN_DATA_ROOT points at the
// test dir — the same job --preload does for the test suite. Dynamic imports keep
// the import organizer from hoisting lib modules above it.
const { authedRequest, driveGet, drivePost, getTestContext } = await import('./setup');
const { getHome } = await import('../lib/home/get-home');
const { importIntoDocument } = await import('../lib/import/import-document');
const { buildHeavyOps, buildHeavySheets, seedSheetsDoc } = await import('./fixtures/heavy-sheets');
const fs = await import('node:fs');

const args = process.argv.slice(2);
function argNum(name: string, fallback: number): number {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : fallback;
}
const ROWS = argNum('rows', 1500);
const COLS = argNum('cols', 40);

const ctx = await getTestContext();
const token = ctx.alice.user.sessionToken;
const ownerId = ctx.alice.user.id;
const mountId = 'default';

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

async function createSheetsDoc(fileName: string): Promise<DrivePath> {
    const root = await driveGet<DrivePath>(token, ownerId, mountId, 'root');
    return drivePost<DrivePath>(token, ownerId, mountId, `folder/${root.id}/create/sheets`, { fileName });
}

async function coldPreview(pathId: string): Promise<{ bytes: number; cacheBytes: number }> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${pathId}/text-preview`);
    if (res.status !== 200) throw new Error(`text-preview failed: ${res.status}`);
    const { body } = (await res.json()) as { body: string };
    const home = await getHome(ownerId);
    const { mount } = await home.drive.resolveFile(mountId, pathId);
    const cacheFile = fs
        .readdirSync(mount.previewsDir)
        .filter((name) => name.startsWith(`${pathId}-`))
        .map((name) => `${mount.previewsDir}/${name}`)[0];
    return { bytes: Buffer.byteLength(body), cacheBytes: cacheFile ? fs.statSync(cacheFile).size : 0 };
}

async function exportXlsx(pathId: string): Promise<{ bytes: number }> {
    const res = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${pathId}/export/xlsx`);
    if (res.status !== 200) throw new Error(`export failed: ${res.status}`);
    return { bytes: (await res.arrayBuffer()).byteLength };
}

async function runScenario(label: string, pathId: string) {
    const cold = await measure(`${label}: cold preview`, () => coldPreview(pathId));
    const sizes = cold.result as { bytes: number; cacheBytes: number };
    console.log(`body bytes ${sizes.bytes}  cache bytes ${sizes.cacheBytes}`);

    const warm = await measure(`${label}: cache-hit preview`, () => coldPreview(pathId));
    console.log(`cache-hit e2e ${warm.e2eMs.toFixed(1)}ms`);

    const xlsx = await measure(`${label}: xlsx export`, () => exportXlsx(pathId));
    console.log(`xlsx bytes ${(xlsx.result as { bytes: number }).bytes}`);
}

// Scenario 1: deterministic synthetic heavy sheet (same generator the tests use).
{
    const doc = await createSheetsDoc('bench-synthetic');
    const home = await getHome(ownerId);
    const collab = await home.drive.getCollabDocument(mountId, doc.id);
    const seedStart = performance.now();
    seedSheetsDoc(collab.doc, buildHeavySheets(ROWS, COLS), buildHeavyOps(60, 25, ROWS, COLS));
    console.log(`seeded synthetic ${ROWS}x${COLS} in ${(performance.now() - seedStart).toFixed(0)}ms`);
    await runScenario(`synthetic ${ROWS}x${COLS}`, doc.id);
}

// Memory pass (proposal § Memory benchmark): repeat the heavy preview through
// one-shot Workers and verify post-job RSS stabilizes instead of growing linearly.
if (args.includes('--memory')) {
    const { generateEigensheetsPreview } = await import('../lib/preview/eigensheets-preview');
    const doc = await createSheetsDoc('bench-memory');
    const home = await getHome(ownerId);
    const collab = await home.drive.getCollabDocument(mountId, doc.id);
    seedSheetsDoc(collab.doc, buildHeavySheets(600, 45), buildHeavyOps(40, 25, 600, 45));
    const { mount, path } = await home.drive.resolveFile(mountId, doc.id);

    const memoryRuns = argNum('memory-runs', 8);
    console.log(`\n=== memory: ${memoryRuns} repeated Worker previews (600x45) ===`);
    for (let i = 0; i < memoryRuns; i++) {
        const start = performance.now();
        await generateEigensheetsPreview(mount, path);
        Bun.gc(true);
        console.log(
            `run ${i + 1}: ${(performance.now() - start).toFixed(0)}ms rss=${(process.memoryUsage.rss() / 1024 / 1024).toFixed(0)}MB`,
        );
    }
}

// Scenario 2: a real workbook, if provided (kept out of the repo).
const xlsxPath = process.env['EIGEN_BENCH_XLSX'];
if (xlsxPath && fs.existsSync(xlsxPath)) {
    const doc = await createSheetsDoc('bench-real-xlsx');
    const home = await getHome(ownerId);
    const { mount, path } = await home.drive.resolveFile(mountId, doc.id);
    const buffer = Buffer.from(fs.readFileSync(xlsxPath));
    const importStart = performance.now();
    await importIntoDocument(home.drive, mount, path, buffer);
    console.log(
        `\nimported ${xlsxPath} (${buffer.byteLength} bytes) in ${(performance.now() - importStart).toFixed(0)}ms`,
    );
    await runScenario('real xlsx', doc.id);
} else {
    console.log('\n(no EIGEN_BENCH_XLSX provided — skipping real-workbook scenario)');
}

process.exit(0);
