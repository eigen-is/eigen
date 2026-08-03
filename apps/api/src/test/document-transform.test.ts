import { beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import type { Sheet } from '@workspace/lib/sheets';
import type { ImageObject, TextObject } from '@workspace/lib/slides';
import { type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import * as engine from '@workspace/sheet/engine';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../lib/collab/db-config';
import * as collabSchema from '../lib/collab/schema';
import { materializeYjsState } from '../lib/collab/yjs-loader';
import { ApiError } from '../lib/core/errors';
import { readEigendocFromDoc, writeEigendocToYjs, writeEigendocUpdateToYjs } from '../lib/document/doc';
import { buildPreviewUrlMap } from '../lib/document/media';
import { readSheetsFromDoc } from '../lib/document/sheets';
import { captureCollabSource } from '../lib/document/transform/collab-source';
import {
    type DocImportWorkerResult,
    type DocumentTransformResponse,
    toTransferableBuffer,
} from '../lib/document/transform/protocol';
import { runTransformToBytes } from '../lib/document/transform/run-transform';
import { documentTransformRunner, EXPORT_IMPORT_TRANSFORM_DEADLINE_MS } from '../lib/document/transform/runner';
import { exportEigendocToHtml, runEigendocExport } from '../lib/export/doc/html';
import { collectExportMedia } from '../lib/export/media';
import { exportSheetsToHtml } from '../lib/export/sheets/html';
import { exportSheetsToXlsx } from '../lib/export/sheets/xlsx';
import { exportSlidesToHtml, runEigenslidesExport } from '../lib/export/slides/html';
import { getHome } from '../lib/home/get-home';
import { docSchema, docxToPmJson } from '../lib/import/doc/from-docx';
import { importXlsxToSheetsSnapshot } from '../lib/import/sheets/transform';
import type { Mount } from '../lib/mount';
import { generateEigendocPreview, renderEigendocPreviewBody } from '../lib/preview/eigendoc-preview';
import { renderEigensheetsPreviewBody } from '../lib/preview/eigensheets-preview';
import { generateEigenslidesPreview, renderEigenslidesPreviewBody } from '../lib/preview/eigenslides-preview';
import {
    appendGoldenDocParagraph,
    buildGoldenDeck,
    buildGoldenDocJson,
    editGoldenDeckTitle,
    GOLDEN_BEYOND_CAP,
    GOLDEN_MEDIA_NAME,
    seedDocumentMedia,
    seedEigendoc,
    seedSlidesDoc,
} from './fixtures/golden-documents';
import { buildGoldenDocx, GOLDEN_DOCX_IMAGE_NAME } from './fixtures/golden-docx';
import { buildGoldenOps, buildGoldenSheets, GOLDEN_ROW1_TOTAL, seedSheetsDoc } from './fixtures/heavy-sheets';
import { authedRequest, driveGet, driveGetList, drivePost, driveUpload, getTestContext, TEST_PNG_BYTES } from './setup';

// End-to-end validation of the off-thread eigensheets preview and exports: Worker
// output must equal the same pipeline executed on the main thread, corruption and
// recalc failures surface as warnings (never as a failed preview/export), and the
// preview cache keeps its dedupe/stale-while-revalidate contract on top of the runner.

const GARBAGE = Buffer.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8]);

function sha256(data: ArrayBuffer | Buffer | string): string {
    return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let rootId: string;
const mountId = 'default';

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    rootId = root.id;
});

// The request kind decides which result member the Worker returns; these keep the
// assertions honest about which one they expect.
function previewBody(response: DocumentTransformResponse): string {
    if (!response.ok || !('body' in response.result)) {
        throw new Error(`expected a preview body, got ${JSON.stringify(response)}`);
    }
    return response.result.body;
}

function exportBytes(response: DocumentTransformResponse): ArrayBuffer {
    if (!response.ok || !('data' in response.result)) {
        throw new Error(`expected export bytes, got ${JSON.stringify(response)}`);
    }
    return response.result.data;
}

function importSnapshot(response: DocumentTransformResponse): string {
    if (!response.ok || !('snapshotJson' in response.result)) {
        throw new Error(`expected an import snapshot, got ${JSON.stringify(response)}`);
    }
    return new TextDecoder().decode(response.result.snapshotJson);
}

function importDocUpdate(response: DocumentTransformResponse): DocImportWorkerResult {
    if (!response.ok || !('update' in response.result)) {
        throw new Error(`expected a document update, got ${JSON.stringify(response)}`);
    }
    return response.result;
}

// Corrupt only the newest update — the base write must survive so the transform
// still has content to render.
async function corruptNewestUpdate(mount: Mount, drivePath: DrivePath): Promise<void> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath!.id);
    const last = managedDb.db.select({ id: collabSchema.docUpdates.id }).from(collabSchema.docUpdates).all().at(-1);
    if (!last) throw new Error(`${drivePath.name}: no update to corrupt`);
    managedDb.db
        .update(collabSchema.docUpdates)
        .set({ updateData: GARBAGE })
        .where(eq(collabSchema.docUpdates.id, last.id))
        .run();
}

async function seedDoc(fileName: string): Promise<DrivePath> {
    const sheetsPath = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}/create/sheets`,
        { fileName },
    );
    const home = await getHome(ctx.alice.user.id);
    const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
    seedSheetsDoc(collab.doc, buildGoldenSheets(), buildGoldenOps());
    return sheetsPath;
}

describe('document transform (eigensheets preview)', () => {
    async function previewRequest(pathId: string) {
        return authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/text-preview`,
        );
    }

    // updatedAt has second granularity — a same-second touch keeps the same cache
    // stamp and the "new version" would be served as current. Touch until the
    // stamp actually moves.
    async function bumpUpdatedAt(pathId: string): Promise<void> {
        const home = await getHome(ctx.alice.user.id);
        const before = (await home.drive.resolveFile(mountId, pathId)).path.updatedAt.getTime();
        for (let i = 0; i < 30; i++) {
            await home.drive.touchUpdatedAt(mountId, pathId);
            const now = (await home.drive.resolveFile(mountId, pathId)).path.updatedAt.getTime();
            if (now !== before) return;
            await Bun.sleep(100);
        }
        throw new Error('updatedAt never advanced');
    }

    test('Worker preview equals the same pipeline run on the main thread', async () => {
        const sheetsPath = await seedDoc('worker-equivalence');
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);

        // Main-thread execution of the exact Worker pipeline (capture → materialize
        // → render/sanitize), against the Worker execution via the real runner.
        const direct = renderEigensheetsPreviewBody(materializeYjsState(await captureCollabSource(mount, path)).doc);

        const response = await documentTransformRunner.run(
            { kind: 'preview', documentType: 'eigensheets', source: await captureCollabSource(mount, path) },
            { priority: 'foreground', deadlineMs: 30_000 },
        );
        expect(previewBody(response)).toBe(direct.body);
        expect(response.ok && response.warnings).toEqual(direct.warnings);
    }, 60_000);

    test('a corrupt update blob surfaces as a warning, not a failed preview', async () => {
        const sheetsPath = await seedDoc('worker-corrupt-update');
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);

        await corruptNewestUpdate(mount, path);

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await documentTransformRunner.run(
                { kind: 'preview', documentType: 'eigensheets', source: await captureCollabSource(mount, path) },
                { priority: 'foreground', deadlineMs: 30_000 },
            );
            expect(response.ok && response.warnings).toContainEqual({ code: 'corrupt-blobs-skipped', count: 1 });
            expect(previewBody(response).length).toBeGreaterThan(0);
        } finally {
            errorSpy.mockRestore();
        }
    }, 60_000);

    test('recalc failure serves replayed values with a warning, never a failed preview', async () => {
        const original = { ...engine };
        mock.module('@workspace/sheet/engine', () => ({
            ...original,
            recalcSheets: () => {
                throw new Error('forced recalc failure');
            },
        }));
        try {
            const doc = new Y.Doc();
            const sheets: Sheet[] = [
                {
                    id: 'sheet-1',
                    name: 'Sheet1',
                    order: 0,
                    config: {},
                    celldata: [
                        { r: 0, c: 0, v: { v: 'replayed-value', m: 'replayed-value', ct: { fa: 'General', t: 'g' } } },
                        { r: 0, c: 1, v: { f: '=A1' } },
                    ],
                },
            ];
            doc.getMap('state').set('snapshot', JSON.stringify(sheets));

            const fromDoc = readSheetsFromDoc(doc);
            expect(fromDoc.recalcError).toBe('forced recalc failure');
            expect(fromDoc.sheets[0].celldata?.[0]?.v?.v).toBe('replayed-value');

            const { body, warnings } = renderEigensheetsPreviewBody(doc);
            expect(warnings).toContainEqual({ code: 'recalc-failed', message: 'forced recalc failure' });
            expect(body).toContain('replayed-value');
        } finally {
            mock.module('@workspace/sheet/engine', () => original);
        }
    });

    test('byte guard replaces an oversized body with the truncated notice, never a sliced string', async () => {
        // The budget counts cells, not bytes — one enormous cell sails through
        // 200×50/10k and only the byte guard stands between it and the cache.
        const doc = new Y.Doc();
        const huge = 'x'.repeat(9_000_000);
        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                config: {},
                celldata: [{ r: 0, c: 0, v: { v: huge, m: huge, ct: { fa: 'General', t: 'g' } } }],
            },
        ];
        doc.getMap('state').set('snapshot', JSON.stringify(sheets));

        const { body, warnings } = renderEigensheetsPreviewBody(doc);
        expect(warnings.some((warning) => warning.code === 'byte-guard-truncated')).toBe(true);
        expect(body).toContain('Preview truncated');
        expect(body.length).toBeLessThan(1000);
    }, 60_000);

    test('concurrent first-miss previews share one transform job', async () => {
        const sheetsPath = await seedDoc('cache-shared-generation');
        const runSpy = spyOn(documentTransformRunner, 'run');
        try {
            const [a, b] = await Promise.all([previewRequest(sheetsPath.id), previewRequest(sheetsPath.id)]);
            expect(a.status).toBe(200);
            expect(b.status).toBe(200);
            const [bodyA, bodyB] = [await a.json(), await b.json()];
            expect(bodyA.body).toBe(bodyB.body);
            expect(runSpy).toHaveBeenCalledTimes(1);
        } finally {
            runSpy.mockRestore();
        }
    }, 60_000);

    test('stale preview serves immediately and queues one background regeneration', async () => {
        const sheetsPath = await seedDoc('cache-stale-regen');
        const first = await previewRequest(sheetsPath.id);
        expect(first.status).toBe(200);
        await bumpUpdatedAt(sheetsPath.id);

        const runSpy = spyOn(documentTransformRunner, 'run');
        try {
            const stale = await previewRequest(sheetsPath.id);
            expect(stale.status).toBe(200);
            expect(stale.headers.get('cache-control')).toBe('no-store');

            // The regeneration was enqueued as background work.
            expect(runSpy).toHaveBeenCalledTimes(1);
            expect(runSpy.mock.calls[0][1].priority).toBe('background');

            // It converges: a later request serves the fresh current version.
            let fresh = await previewRequest(sheetsPath.id);
            for (let i = 0; i < 80 && fresh.headers.get('cache-control') === 'no-store'; i++) {
                await Bun.sleep(50);
                fresh = await previewRequest(sheetsPath.id);
            }
            expect(fresh.status).toBe(200);
            expect(fresh.headers.get('cache-control')).not.toBe('no-store');
        } finally {
            runSpy.mockRestore();
        }
    }, 60_000);

    test('a failed background regeneration leaves the stale version served', async () => {
        const sheetsPath = await seedDoc('cache-failed-regen');
        const first = await previewRequest(sheetsPath.id);
        expect(first.status).toBe(200);
        const firstBody = (await first.json()).body;
        await bumpUpdatedAt(sheetsPath.id);

        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementationOnce(async () => ({
            ok: false as const,
            error: { code: 'crashed' as const, message: 'forced failure' },
        }));
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const stale = await previewRequest(sheetsPath.id);
            expect(stale.status).toBe(200);
            expect(stale.headers.get('cache-control')).toBe('no-store');
            await Bun.sleep(50); // let the failed regeneration settle

            // Still served (from the prior version), no corrupt current entry.
            const again = await previewRequest(sheetsPath.id);
            expect(again.status).toBe(200);
            expect((await again.json()).body).toBe(firstBody);
        } finally {
            errorSpy.mockRestore();
            runSpy.mockRestore();
        }
    }, 60_000);

    test('runner overload surfaces as 503 on a first-miss preview, not a 404', async () => {
        const sheetsPath = await seedDoc('cache-overload-503');
        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementationOnce(() => {
            throw new ApiError(503, 'The server is busy, please try again in a moment');
        });
        try {
            const res = await previewRequest(sheetsPath.id);
            expect(res.status).toBe(503);
            expect(await res.text()).toContain('busy');
        } finally {
            runSpy.mockRestore();
        }
    }, 60_000);
});

// Recorded from the pre-Worker pipeline on the golden fixture (exportSheetsToHtml
// and pdf.ts's wrapped document before htmlToPdf), so the move off-thread is proven
// byte-identical. Regenerate only for an intentional renderer change.
const GOLDEN_EXPORT_HTML_SHA256 = '7ca7f67cbdcdfb160fb34f4f22d81b9df74c06fba9b37be368e57e4c861bbc98';
const GOLDEN_EXPORT_PDF_HTML_SHA256 = '8189376ecb1b541ebfd86bcffc937c3daae711e8f76558cddf8e9dbec047422c';

describe('document transform (eigensheets export)', () => {
    let golden: { mount: Mount; path: DrivePath };

    beforeAll(async () => {
        const sheetsPath = await seedDoc('golden-export');
        const home = await getHome(ctx.alice.user.id);
        golden = await home.drive.resolveFile(mountId, sheetsPath.id);
    });

    test('html export through the Worker is byte-identical to the pre-move pipeline', async () => {
        const result = await exportSheetsToHtml(golden.mount, golden.path);
        expect(sha256(result.data)).toBe(GOLDEN_EXPORT_HTML_SHA256);
    }, 120_000);

    test('pdf-html export through the Worker is byte-identical to the pre-move pipeline', async () => {
        // The stage before htmlToPdf: the wrapped document WeasyPrint renders, with
        // the @page size derived from the widest/tallest sheet.
        const job = {
            kind: 'export',
            documentType: 'eigensheets',
            format: 'pdf-html',
            title: 'golden-export',
        } as const;
        const html = await runTransformToBytes(golden.mount, golden.path, job, {
            deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS,
        });
        expect(sha256(html)).toBe(GOLDEN_EXPORT_PDF_HTML_SHA256);
    }, 120_000);

    test('xlsx export through the Worker returns a parseable workbook', async () => {
        const result = await exportSheetsToXlsx(golden.mount, golden.path);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(result.data);
        expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Dashboard', 'Data', 'Empty']);
        const dashboard = workbook.getWorksheet('Dashboard');
        expect(dashboard?.getCell('B2').value).toBe(48);
        // Recalc ran in the Worker before ExcelJS built the workbook.
        expect(dashboard?.getCell('F2').value).toMatchObject({ formula: 'SUM(B2:E2)', result: GOLDEN_ROW1_TOTAL });
    }, 120_000);

    test('a corrupt update blob surfaces as a warning, never a failed export', async () => {
        const sheetsPath = await seedDoc('worker-export-corrupt');
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);

        await corruptNewestUpdate(mount, path);

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await documentTransformRunner.run(
                {
                    kind: 'export',
                    documentType: 'eigensheets',
                    format: 'html',
                    title: stripEigenExtension(path.name),
                    source: await captureCollabSource(mount, path),
                },
                { priority: 'foreground', deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS },
            );
            expect(response.ok && response.warnings).toContainEqual({ code: 'corrupt-blobs-skipped', count: 1 });
            expect(exportBytes(response).byteLength).toBeGreaterThan(0);
        } finally {
            errorSpy.mockRestore();
        }
    }, 120_000);
});

// Recorded from the pre-Worker import pipeline (xlsxToSheets + import-document's
// recalcImportedSheets + JSON.stringify) over buildImportFixture(), so the move
// off-thread is proven byte-identical. Regenerate only for an intentional
// converter change.
const GOLDEN_IMPORT_SNAPSHOT_SHA256 = '0d9772e1958e05d72706cdb6980ecd3859fd44ea4c2b74c70a4652e557038811';

// Small but representative workbook: values, a stale cached formula result the
// import recalc must correct, styles, a date format, a merge, a column width, a
// second sheet and a hyperlink.
async function buildImportFixture(): Promise<ArrayBuffer> {
    const workbook = new ExcelJS.Workbook();
    const data = workbook.addWorksheet('Data');
    data.getCell('A1').value = 'Region';
    data.getCell('B1').value = 'Count';
    data.getCell('A2').value = 'North';
    data.getCell('B2').value = 42;
    data.getCell('A3').value = 'South';
    data.getCell('B3').value = 7;
    data.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 999 };
    data.getCell('A1').font = { bold: true, color: { argb: 'FF0000FF' } };
    data.getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
    const dated = data.getCell('C2');
    dated.value = new Date(Date.UTC(2024, 2, 15));
    dated.numFmt = 'dd/mm/yyyy';
    data.getColumn(1).width = 18;
    data.mergeCells('A6:B6');
    data.getCell('A6').value = 'Merged footer';

    const notes = workbook.addWorksheet('Notes');
    notes.getCell('A1').value = 'Second sheet';
    notes.getCell('A2').value = { text: 'link', hyperlink: 'https://example.com/report' };

    const buffer = await workbook.xlsx.writeBuffer();
    const view = new Uint8Array(buffer);
    const out = new ArrayBuffer(view.byteLength);
    new Uint8Array(out).set(view);
    return out;
}

describe('document transform (xlsx import)', () => {
    async function importRequest(pathId: string, body: ArrayBuffer) {
        return authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/import`,
            { method: 'POST', body },
        );
    }

    async function liveSnapshot(pathId: string): Promise<unknown> {
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, pathId);
        return collab.doc.getMap('state').get('snapshot');
    }

    test('Worker import equals the pre-move parse + recalc pipeline', async () => {
        const response = await documentTransformRunner.run(
            { kind: 'import', sourceFormat: 'xlsx', targetType: 'eigensheets', data: await buildImportFixture() },
            { priority: 'foreground', deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS },
        );
        const snapshotJson = importSnapshot(response);
        expect(new Bun.CryptoHasher('sha256').update(snapshotJson).digest('hex')).toBe(GOLDEN_IMPORT_SNAPSHOT_SHA256);
        expect(response.ok && response.warnings).toEqual([]);

        // The same pure pipeline the Worker dispatches to, run on this thread.
        const direct = await importXlsxToSheetsSnapshot(await buildImportFixture());
        expect(snapshotJson).toBe(new TextDecoder().decode(direct.snapshotJson));
        // The stale cached SUM(B2:B3)=999 was recomputed at import.
        const sheets = JSON.parse(snapshotJson) as Sheet[];
        expect(sheets[0].celldata?.find((cell) => cell.r === 3 && cell.c === 1)?.v?.v).toBe(49);
    }, 120_000);

    test('a recalc failure keeps the parsed values and returns a warning', async () => {
        const original = { ...engine };
        mock.module('@workspace/sheet/engine', () => ({
            ...original,
            recalcSheets: () => {
                throw new Error('forced recalc failure');
            },
        }));
        try {
            const { snapshotJson, warnings } = await importXlsxToSheetsSnapshot(await buildImportFixture());
            expect(warnings).toContainEqual({ code: 'recalc-failed', message: 'forced recalc failure' });
            const sheets = JSON.parse(new TextDecoder().decode(snapshotJson)) as Sheet[];
            // Parsed values survive: the xlsx's own stale cached result, not a failure.
            expect(sheets[0].celldata?.find((cell) => cell.r === 3 && cell.c === 1)?.v?.v).toBe(999);
        } finally {
            mock.module('@workspace/sheet/engine', () => original);
        }
    }, 120_000);

    test('a recalc warning from the Worker is logged by the import orchestrator', async () => {
        const target = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'import-recalc-warning' },
        );
        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Warned', order: 0, celldata: [], config: {} }];
        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementationOnce(async () => ({
            ok: true as const,
            result: { snapshotJson: new TextEncoder().encode(JSON.stringify(sheets)).buffer as ArrayBuffer },
            warnings: [{ code: 'recalc-failed' as const, message: 'forced' }],
        }));
        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const res = await importRequest(target.id, await buildImportFixture());
            expect(res.status).toBe(200);
            expect(warnSpy).toHaveBeenCalledWith(
                '[import] server recalc of imported sheets failed, persisting parsed values:',
                'forced',
            );
        } finally {
            warnSpy.mockRestore();
            runSpy.mockRestore();
        }
    }, 120_000);

    test('a failed import Worker leaves the target document untouched', async () => {
        const target = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'import-crash-target' },
        );
        expect((await importRequest(target.id, await buildImportFixture())).status).toBe(200);
        const before = await liveSnapshot(target.id);
        expect(typeof before).toBe('string');

        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementationOnce(async () => ({
            ok: false as const,
            error: { code: 'crashed' as const, message: 'forced failure' },
        }));
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await importRequest(target.id, await buildImportFixture());
            expect(res.status).toBe(500);
            expect(await liveSnapshot(target.id)).toBe(before);
        } finally {
            errorSpy.mockRestore();
            runSpy.mockRestore();
        }
    }, 120_000);

    test('a failed convert Worker creates no destination document', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName: 'convert-crash' },
        );
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            folder.id,
            new File([await buildImportFixture()], 'crash.xlsx', {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            }),
        );

        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementationOnce(async () => ({
            ok: false as const,
            error: { code: 'crashed' as const, message: 'forced failure' },
        }));
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
                { method: 'POST' },
            );
            expect(res.status).toBe(500);
            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                'folder',
                folder.id,
            );
            expect(contents.map((entry) => entry.name)).toEqual(['crash.xlsx']);
        } finally {
            errorSpy.mockRestore();
            runSpy.mockRestore();
        }
    }, 120_000);
});

// Recorded from the pre-Worker doc/slides pipeline on the golden fixtures (preview
// generators, exportEigendocToHtml/exportSlidesToHtml, and the wrapped documents fed
// to WeasyPrint), so the move off-thread is proven byte-identical. Regenerate only
// for an intentional renderer change. The embedded media data URI comes from the
// screen-preview pipeline (sharp → WebP), so a preview-encoder change moves the
// export hashes legitimately.
const GOLDEN_DOC_PREVIEW_SHA256 = 'f61e8785cd4e3b3872e5fcf6ee817abdae5e2ed4119a113dc17342fd922e6b44';
const GOLDEN_DOC_EXPORT_HTML_SHA256 = '1f6657ad5e4e05b50d582246037d55ecc9ce6b4c4de03288e14213f9a1fdf7a1';
const GOLDEN_DOC_EXPORT_PDF_HTML_SHA256 = '1f6657ad5e4e05b50d582246037d55ecc9ce6b4c4de03288e14213f9a1fdf7a1';
const GOLDEN_DECK_PREVIEW_SHA256 = '351d31560954f2490f67bd5aeba11f24d083e3646c78b25599e0fef816c65616';
const GOLDEN_DECK_EXPORT_HTML_SHA256 = '7b584e034fcf9fe42b2dc2dd6d20d9f4af4bb1c21444875c985dacfe59bd9644';
const GOLDEN_DECK_EXPORT_PDF_HTML_SHA256 = '4c70de4e940fd61e27152e00f718546b37747bc22f5f1acbc5d53d8c753f6aec';

// Preview media is embedded as an absolute API URL carrying per-run owner/path ids —
// normalize them out so the golden pins the rendering, not the fixture's uuids.
function normalizeMediaUrls(body: string): string {
    return body.replace(/http:\/\/localhost\/drive\/[^"')\s]+\/preview/g, '{media}');
}

// `edit` runs as a follow-up transaction, so data.db carries more than one update row.
async function seedGoldenDocument(
    fileName: string,
    type: 'doc' | 'slides',
    edit?: (doc: Y.Doc) => void,
): Promise<{ mount: Mount; path: DrivePath }> {
    const created = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}/create/${type}`,
        { fileName },
    );
    const home = await getHome(ctx.alice.user.id);
    const collab = await home.drive.getCollabDocument(mountId, created.id);
    if (type === 'doc') seedEigendoc(collab.doc, buildGoldenDocJson());
    else seedSlidesDoc(collab.doc, buildGoldenDeck());
    edit?.(collab.doc);

    const resolved = await home.drive.resolveFile(mountId, created.id);
    await seedDocumentMedia(resolved.mount, resolved.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
    return resolved;
}

describe('document transform (eigendoc)', () => {
    let golden: { mount: Mount; path: DrivePath };

    beforeAll(async () => {
        golden = await seedGoldenDocument('golden-doc', 'doc');
    });

    test('preview body matches the pinned golden hash', async () => {
        const body = await generateEigendocPreview(golden.mount, golden.path);
        // A glance, not the document: the first 20 blocks with the truncated marker,
        // media as an embed URL, hostile content defanged.
        expect(body).toContain('Quarterly Report');
        expect(body).not.toContain(GOLDEN_BEYOND_CAP);
        expect(body).toContain('Preview truncated');
        expect(body).toMatch(/<img src="http:\/\/localhost\/drive\/[^"]+\/preview"/);
        expect(body).not.toMatch(/<script/i);
        expect(body).not.toContain('javascript:alert');
        expect(sha256(normalizeMediaUrls(body))).toBe(GOLDEN_DOC_PREVIEW_SHA256);

        // The route serves exactly that body in the { body, mode } envelope.
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${golden.path.id}/text-preview`,
        );
        expect(res.status).toBe(200);
        const preview = await res.json();
        expect(preview.mode).toBe('eigendoc');
        expect(preview.body).toBe(body);
    }, 120_000);

    test('html export is byte-identical to the pre-move pipeline', async () => {
        const result = await exportEigendocToHtml(golden.mount, golden.path);
        expect(sha256(result.data)).toBe(GOLDEN_DOC_EXPORT_HTML_SHA256);
    }, 120_000);

    test('pdf-html export is byte-identical to the pre-move pipeline', async () => {
        // The stage before htmlToPdf: the wrapped document WeasyPrint renders.
        const html = await runEigendocExport(golden.mount, golden.path, 'pdf-html');
        expect(sha256(html)).toBe(GOLDEN_DOC_EXPORT_PDF_HTML_SHA256);
    }, 120_000);

    test('Worker preview equals the same pipeline run on the main thread', async () => {
        const { mount, path } = golden;
        const mediaUrls = await buildPreviewUrlMap(mount, path);
        const direct = renderEigendocPreviewBody(
            materializeYjsState(await captureCollabSource(mount, path)).doc,
            mediaUrls,
        );

        const response = await documentTransformRunner.run(
            {
                kind: 'preview',
                documentType: 'eigendoc',
                mediaUrls,
                source: await captureCollabSource(mount, path),
            },
            { priority: 'foreground', deadlineMs: 30_000 },
        );
        expect(previewBody(response)).toBe(direct.body);
        expect(response.ok && response.warnings).toEqual(direct.warnings);
    }, 120_000);

    test('a corrupt update blob surfaces as a warning, not a failed preview', async () => {
        const { mount, path } = await seedGoldenDocument('worker-doc-corrupt', 'doc', (doc) =>
            appendGoldenDocParagraph(doc, 'a later edit'),
        );
        await corruptNewestUpdate(mount, path);

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await documentTransformRunner.run(
                {
                    kind: 'preview',
                    documentType: 'eigendoc',
                    mediaUrls: await buildPreviewUrlMap(mount, path),
                    source: await captureCollabSource(mount, path),
                },
                { priority: 'foreground', deadlineMs: 30_000 },
            );
            expect(response.ok && response.warnings).toContainEqual({ code: 'corrupt-blobs-skipped', count: 1 });
            // The skipped edit is gone, the base write still renders.
            expect(previewBody(response)).toContain('Quarterly Report');
            expect(previewBody(response)).not.toContain('a later edit');
        } finally {
            errorSpy.mockRestore();
        }
    }, 120_000);

    test('a figure naming a prototype key renders without an image, not a crash', () => {
        // mediaName is document data — an unknown name must resolve to null, never to
        // something off Object.prototype.
        const doc = new Y.Doc();
        seedEigendoc(doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'figure', attrs: { mediaName: 'constructor' } }] }],
        });
        expect(renderEigendocPreviewBody(doc, {}).body).not.toContain('<img');
    });

    test('byte guard replaces an oversized body with the truncated notice, never a sliced string', () => {
        // The cap counts top-level blocks, not bytes — one enormous paragraph sails
        // through the 20-block limit and only the byte guard stands between it and
        // the cache.
        const doc = new Y.Doc();
        seedEigendoc(doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(9_000_000) }] }],
        });

        const { body, warnings } = renderEigendocPreviewBody(doc, {});
        expect(warnings.some((warning) => warning.code === 'byte-guard-truncated')).toBe(true);
        expect(body).toContain('Preview truncated');
        expect(body.length).toBeLessThan(1000);
    }, 60_000);

    test('export media crosses the boundary as transferred buffers', async () => {
        const { mount, path } = golden;
        const media = await collectExportMedia(mount, path);
        expect(media).toHaveLength(1);
        expect(media[0].name).toBe(GOLDEN_MEDIA_NAME);

        const response = await documentTransformRunner.run(
            {
                kind: 'export',
                documentType: 'eigendoc',
                format: 'html',
                title: path.name,
                media,
                source: await captureCollabSource(mount, path),
            },
            { priority: 'foreground', deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS },
        );
        // Ownership moved to the Worker, and the bytes came back as a data URI.
        expect(media[0].data.byteLength).toBe(0);
        expect(Buffer.from(exportBytes(response)).toString('utf-8')).toContain('src="data:image/webp;base64,');
    }, 120_000);

    test('docx export loads Turbodocx from runtime node_modules inside the Worker', async () => {
        const { mount, path } = golden;
        const response = await documentTransformRunner.run(
            {
                kind: 'export',
                documentType: 'eigendoc',
                format: 'docx',
                title: path.name,
                media: await collectExportMedia(mount, path),
                source: await captureCollabSource(mount, path),
            },
            { priority: 'foreground', deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS },
        );
        // Turbodocx is externalized from the bundle — a real zip proves the Worker
        // resolved it at runtime and produced the document off-thread.
        const docx = Buffer.from(exportBytes(response));
        expect(docx.byteLength).toBeGreaterThan(0);
        expect(docx.subarray(0, 2).toString()).toBe('PK');
        const zip = await JSZip.loadAsync(docx);
        expect(Object.keys(zip.files)).toContain('word/document.xml');
    }, 120_000);
});

describe('document transform (eigenslides)', () => {
    let golden: { mount: Mount; path: DrivePath };

    beforeAll(async () => {
        golden = await seedGoldenDocument('golden-deck', 'slides');
    });

    test('preview body matches the pinned golden hash', async () => {
        const body = await generateEigenslidesPreview(golden.mount, golden.path);
        // First 8 slides with the truncated marker, media as an embed URL.
        expect(body).toContain('Deck <strong>title</strong>');
        expect(body).not.toContain(GOLDEN_BEYOND_CAP);
        expect(body).toContain('Preview truncated');
        expect(body).toMatch(/<img src="http:\/\/localhost\/drive\/[^"]+\/preview"/);
        expect(body).not.toMatch(/<script/i);
        expect(body).not.toMatch(/"\s*onload/i);
        expect(sha256(normalizeMediaUrls(body))).toBe(GOLDEN_DECK_PREVIEW_SHA256);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${golden.path.id}/text-preview`,
        );
        expect(res.status).toBe(200);
        const preview = await res.json();
        expect(preview.mode).toBe('eigenslides');
        expect(preview.body).toBe(body);
    }, 120_000);

    test('html export is byte-identical to the pre-move pipeline', async () => {
        const result = await exportSlidesToHtml(golden.mount, golden.path);
        expect(sha256(result.data)).toBe(GOLDEN_DECK_EXPORT_HTML_SHA256);
    }, 120_000);

    test('pdf-html export is byte-identical to the pre-move pipeline', async () => {
        // Fixed-size PDF mode: px geometry instead of container queries.
        const html = await runEigenslidesExport(golden.mount, golden.path, 'pdf-html');
        expect(sha256(html)).toBe(GOLDEN_DECK_EXPORT_PDF_HTML_SHA256);
    }, 120_000);

    test('Worker preview equals the same pipeline run on the main thread', async () => {
        const { mount, path } = golden;
        const mediaUrls = await buildPreviewUrlMap(mount, path);
        const direct = renderEigenslidesPreviewBody(
            materializeYjsState(await captureCollabSource(mount, path)).doc,
            mediaUrls,
        );

        const response = await documentTransformRunner.run(
            {
                kind: 'preview',
                documentType: 'eigenslides',
                mediaUrls,
                source: await captureCollabSource(mount, path),
            },
            { priority: 'foreground', deadlineMs: 30_000 },
        );
        expect(previewBody(response)).toBe(direct.body);
        expect(response.ok && response.warnings).toEqual(direct.warnings);
    }, 120_000);

    test('an image object naming a prototype key renders empty, not a crash', () => {
        // mediaName is document data — an unknown name must resolve to null, never to
        // something off Object.prototype.
        const deck = buildGoldenDeck();
        (deck.objects['obj-2'] as ImageObject).mediaName = 'toString';
        const doc = new Y.Doc();
        seedSlidesDoc(doc, deck);
        expect(renderEigenslidesPreviewBody(doc, {}).body).not.toContain('<img');
    });

    test('byte guard replaces an oversized body with the truncated notice, never a sliced string', () => {
        // The cap counts slides, not bytes — one enormous text object sails through
        // the 8-slide limit and only the byte guard stands between it and the cache.
        const deck = buildGoldenDeck();
        (deck.objects['obj-1'] as TextObject).text = `<p>${'x'.repeat(9_000_000)}</p>`;
        const doc = new Y.Doc();
        seedSlidesDoc(doc, deck);

        const { body, warnings } = renderEigenslidesPreviewBody(doc, {});
        expect(warnings.some((warning) => warning.code === 'byte-guard-truncated')).toBe(true);
        expect(body).toContain('Preview truncated');
        expect(body.length).toBeLessThan(1000);
    }, 60_000);

    test('a corrupt update blob surfaces as a warning, never a failed export', async () => {
        const { mount, path } = await seedGoldenDocument('worker-deck-corrupt', 'slides', (doc) =>
            editGoldenDeckTitle(doc, 'a later edit'),
        );
        await corruptNewestUpdate(mount, path);

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await documentTransformRunner.run(
                {
                    kind: 'export',
                    documentType: 'eigenslides',
                    format: 'html',
                    title: stripEigenExtension(path.name),
                    media: await collectExportMedia(mount, path),
                    source: await captureCollabSource(mount, path),
                },
                { priority: 'foreground', deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS },
            );
            expect(response.ok && response.warnings).toContainEqual({ code: 'corrupt-blobs-skipped', count: 1 });
            // The skipped edit is gone, the base write still renders.
            const html = Buffer.from(exportBytes(response)).toString('utf-8');
            expect(html).toContain('Deck <strong>title</strong>');
            expect(html).not.toContain('a later edit');
        } finally {
            errorSpy.mockRestore();
        }
    }, 120_000);
});

// Recorded from the pre-Worker docx import pipeline (docxToPmJson, then
// writeEigendocToYjs into a fresh document) over buildGoldenDocx(), so the move
// off-thread is proven equivalent: the Worker must hand back a Yjs update whose
// applied document reads back identically, and the extracted image bytes must
// survive the transfer untouched. Regenerate only for an intentional converter change.
const GOLDEN_DOCX_PM_JSON_SHA256 = '15b5feca693ca9ee7c3cf8fe3d030a1bc79bc3a1ac56bee9f23d644e5de19eb1';
const GOLDEN_DOCX_DOCUMENT_SHA256 = '51ae42c1e14f8f5acfa31337873d126218c155746f6850860afdc90900808cfe';

describe('document transform (docx import)', () => {
    async function importRequest(pathId: string, body: ArrayBuffer): Promise<Response> {
        return authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/import`,
            { method: 'POST', body },
        );
    }

    async function runDocxImport(data: ArrayBuffer): Promise<DocumentTransformResponse> {
        return documentTransformRunner.run(
            { kind: 'import', sourceFormat: 'docx', targetType: 'eigendoc', data },
            { priority: 'foreground', deadlineMs: EXPORT_IMPORT_TRANSFORM_DEADLINE_MS },
        );
    }

    // The document the pre-move pipeline produced: parse on this thread, commit into
    // a fresh Y.Doc, read back. The Worker must reproduce it exactly.
    async function referenceDocument(): Promise<JSONContent> {
        const { json } = await docxToPmJson(Buffer.from(await buildGoldenDocx(TEST_PNG_BYTES)));
        const doc = new Y.Doc();
        writeEigendocToYjs(doc, json, docSchema);
        const read = readEigendocFromDoc(doc);
        doc.destroy();
        return read;
    }

    test('the reference parse + Yjs commit pipeline matches the pinned goldens', async () => {
        const { json, images } = await docxToPmJson(Buffer.from(await buildGoldenDocx(TEST_PNG_BYTES)));
        expect(sha256(JSON.stringify(json))).toBe(GOLDEN_DOCX_PM_JSON_SHA256);
        expect(images.map(({ name, contentType }) => ({ name, contentType }))).toEqual([
            { name: GOLDEN_DOCX_IMAGE_NAME, contentType: 'image/png' },
        ]);
        expect(images[0].data).toEqual(Buffer.from(TEST_PNG_BYTES));

        const doc = new Y.Doc();
        writeEigendocToYjs(doc, json, docSchema);
        expect(sha256(JSON.stringify(readEigendocFromDoc(doc)))).toBe(GOLDEN_DOCX_DOCUMENT_SHA256);
        doc.destroy();
    }, 120_000);

    test('Worker import returns a Yjs update that commits to the golden document', async () => {
        const response = await runDocxImport(await buildGoldenDocx(TEST_PNG_BYTES));
        const { update, images } = importDocUpdate(response);
        expect(response.ok && response.warnings).toEqual([]);

        const doc = new Y.Doc();
        writeEigendocUpdateToYjs(doc, new Uint8Array(update));
        const committed = readEigendocFromDoc(doc);
        doc.destroy();
        expect(committed).toEqual(await referenceDocument());
        expect(sha256(JSON.stringify(committed))).toBe(GOLDEN_DOCX_DOCUMENT_SHA256);

        // The extracted image crossed the boundary as a transferred buffer, byte-intact.
        expect(images.map(({ name, contentType }) => ({ name, contentType }))).toEqual([
            { name: GOLDEN_DOCX_IMAGE_NAME, contentType: 'image/png' },
        ]);
        expect(Buffer.from(images[0].data)).toEqual(Buffer.from(TEST_PNG_BYTES));
    }, 120_000);

    test('garbage bytes keep their 400 across the Worker boundary', async () => {
        const response = await runDocxImport(toTransferableBuffer(GARBAGE));
        expect(response.ok).toBe(false);
        expect(!response.ok && response.error).toMatchObject({ status: 400, message: 'Not a valid docx file' });
    }, 120_000);

    test('a failed import Worker leaves the target document untouched', async () => {
        const target = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'docx-import-crash-target' },
        );
        expect((await importRequest(target.id, await buildGoldenDocx(TEST_PNG_BYTES))).status).toBe(200);
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, target.id);
        const before = readEigendocFromDoc(collab.doc);

        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementationOnce(async () => ({
            ok: false as const,
            error: { code: 'crashed' as const, message: 'forced failure' },
        }));
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await importRequest(target.id, await buildGoldenDocx(TEST_PNG_BYTES));
            expect(res.status).toBe(500);
            expect(readEigendocFromDoc(collab.doc)).toEqual(before);
        } finally {
            errorSpy.mockRestore();
            runSpy.mockRestore();
        }
    }, 120_000);

    test('a failed convert Worker creates no destination document', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName: 'docx-convert-crash' },
        );
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            folder.id,
            new File([await buildGoldenDocx(TEST_PNG_BYTES)], 'crash.docx', {
                type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            }),
        );

        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementationOnce(async () => ({
            ok: false as const,
            error: { code: 'crashed' as const, message: 'forced failure' },
        }));
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigendoc`,
                { method: 'POST' },
            );
            expect(res.status).toBe(500);
            const contents = await driveGetList(
                ctx.alice.user.sessionToken,
                ctx.alice.user.id,
                mountId,
                'folder',
                folder.id,
            );
            expect(contents.map((entry) => entry.name)).toEqual(['crash.docx']);
        } finally {
            errorSpy.mockRestore();
            runSpy.mockRestore();
        }
    }, 120_000);
});
