import { beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { decodeSheetsSnapshot, encodeSheetsSnapshot, type Sheet } from '@workspace/lib/sheets';
import { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS, type DrivePath, stripEigenExtension } from '@workspace/lib/types/drive';
import * as engine from '@workspace/sheet/engine';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import * as collabSchema from '../../lib/collab/schema';
import { ApiError } from '../../lib/core/errors';
import { readEigendocFromDoc, writeEigendocToYjs, writeEigendocUpdateToYjs } from '../../lib/document/doc';
import { buildPreviewUrlMap } from '../../lib/document/media';
import { readSheetsFromDoc } from '../../lib/document/sheets';
import { captureCollabSource } from '../../lib/document/transform/collab-source';
import {
    type DocumentTransformRequest,
    type DocumentTransformResponse,
    toTransferableBuffer,
} from '../../lib/document/transform/protocol';
import { runTransformToBytes, runTransformToExtractedText } from '../../lib/document/transform/run-transform';
import { documentTransformRunner, TRANSFORM_LIMITS } from '../../lib/document/transform/runner';
import type { Drive } from '../../lib/drive';
import { exportDocument, runDocumentExport } from '../../lib/export/export-document';
import { collectExportMedia } from '../../lib/export/media';
import { renderEigensheetsExport } from '../../lib/export/sheets/transform';
import { getHome } from '../../lib/home/get-home';
import { docSchema, docxToPmJson } from '../../lib/import/doc/from-docx';
import { convertToDocument, importIntoDocument } from '../../lib/import/import-document';
import { importXlsxToSheetsSnapshot } from '../../lib/import/sheets/transform';
import type { Mount } from '../../lib/mount';
import { renderEigendocPreviewBody } from '../../lib/preview/eigendoc-render';
import { renderEigensheetsPreviewBody } from '../../lib/preview/eigensheets-render';
import { renderEigenslidesPreviewBody } from '../../lib/preview/eigenslides-render';
import { renderEigenvectorPreviewBody } from '../../lib/preview/eigenvector-render';
import type { User } from '../../lib/user';
import {
    buildGoldenDeckScene,
    buildGoldenDocJson,
    buildGoldenVectorScene,
    editGoldenDeckTitle,
    GOLDEN_BEYOND_CAP,
    GOLDEN_MEDIA_NAME,
    seedDeckDoc,
    seedDocumentMedia,
    seedEigendoc,
    seedVectorDoc,
} from '../fixtures/golden-documents';
import { buildGoldenDocx, GOLDEN_DOCX_IMAGE_NAME } from '../fixtures/golden-docx';
import { buildGoldenOps, buildGoldenSheets, GOLDEN_ROW1_TOTAL, seedSheetsDoc } from '../fixtures/heavy-sheets';
import {
    exportBytes,
    importDocUpdate,
    importSnapshot,
    previewBody,
    readPersistedDoc,
} from '../fixtures/transform-results';
import {
    authedRequest,
    driveGet,
    driveGetList,
    drivePost,
    driveUpload,
    getTestContext,
    TEST_PNG_BYTES,
} from '../setup';

// End-to-end validation of the off-thread eigensheets preview and exports: Worker
// output must equal the same pipeline executed on the main thread, corruption and
// recalc failures surface as warnings (never as a failed preview/export), and the
// preview cache keeps its dedupe/stale-while-revalidate contract on top of the runner.

const GARBAGE = Buffer.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8]);

// The production limits for the runner calls this suite makes directly, in place of
// the route seams.
const PREVIEW_OPTIONS = { ...TRANSFORM_LIMITS.preview, priority: 'foreground' } as const;
const EXPORT_OPTIONS = { ...TRANSFORM_LIMITS.export, priority: 'foreground' } as const;

function sha256(data: ArrayBuffer | Buffer | string): string {
    return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

// The runner is a process-wide singleton that background search reindexes also drive, so
// a bare mock can be consumed by an unrelated extract job. Intercept the FIRST job of the
// kind under test and let every other job run for real.
function interceptRunOnce(kind: DocumentTransformRequest['kind'], handler: () => Promise<DocumentTransformResponse>) {
    const real = documentTransformRunner.run.bind(documentTransformRunner);
    let used = false;
    return spyOn(documentTransformRunner, 'run').mockImplementation((request, opts) => {
        if (used || request.kind !== kind) return real(request, opts);
        used = true;
        return handler();
    });
}

// Same reason, one admission refusal only: a concurrent background reindex must not
// be caught in the window.
function refuseAdmissionOnce() {
    const real = documentTransformRunner.assertAdmissible.bind(documentTransformRunner);
    let used = false;
    return spyOn(documentTransformRunner, 'assertAdmissible').mockImplementation((priority) => {
        if (used) return real(priority);
        used = true;
        throw new ApiError(503, 'The server is busy, please try again in a moment');
    });
}

// Same reason, for the tests that count runner calls instead of replacing them.
function callsOfKind(
    spy: ReturnType<typeof spyOn<typeof documentTransformRunner, 'run'>>,
    kind: DocumentTransformRequest['kind'],
) {
    return spy.mock.calls.filter(([request]) => request.kind === kind);
}

let ctx: Awaited<ReturnType<typeof getTestContext>>;
let rootId: string;
const mountId = 'default';

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    rootId = root.id;
});

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
        const persisted = await readPersistedDoc(mount, path);
        const direct = renderEigensheetsPreviewBody(persisted);
        persisted.destroy();

        const response = await documentTransformRunner.run(
            { kind: 'preview', documentType: 'eigensheets', source: await captureCollabSource(mount, path) },
            PREVIEW_OPTIONS,
        );
        expect(previewBody(response)).toBe(direct.body);
        expect(response.ok && response.warnings).toEqual(direct.warnings);
    }, 60_000);

    test('a corrupt update blob surfaces as a warning, not a failed preview', async () => {
        // Every documentType skips corrupt blobs on one shared worker.ts path — this
        // covers the preview side of it, the eigenslides export test the export side.
        const sheetsPath = await seedDoc('worker-corrupt-update');
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);

        await corruptNewestUpdate(mount, path);

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await documentTransformRunner.run(
                { kind: 'preview', documentType: 'eigensheets', source: await captureCollabSource(mount, path) },
                PREVIEW_OPTIONS,
            );
            expect(response.ok && response.warnings).toContainEqual({ code: 'corrupt-blobs-skipped', count: 1 });
            expect(previewBody(response).length).toBeGreaterThan(0);
        } finally {
            errorSpy.mockRestore();
        }
    }, 60_000);

    test('recalc policy: only the export read recalcs; its failure serves replayed values with a warning', async () => {
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
            doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));

            // Default read (the export path) attempts recalc and falls back.
            const fromDoc = readSheetsFromDoc(doc);
            expect(fromDoc.recalcError).toBe('forced recalc failure');
            expect(fromDoc.sheets[0].celldata?.[0]?.v?.v).toBe('replayed-value');

            const exported = await renderEigensheetsExport(doc, 'html', 'Warned');
            expect(exported.warnings).toContainEqual({ code: 'recalc-failed', message: 'forced recalc failure' });
            expect(new TextDecoder().decode(exported.data)).toContain('replayed-value');

            // The preview read never invokes recalc, so the forced failure is unreachable.
            const { body, warnings } = renderEigensheetsPreviewBody(doc);
            expect(warnings).toEqual([]);
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
        doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));

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
            expect(callsOfKind(runSpy, 'preview')).toHaveLength(1);
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
            expect(callsOfKind(runSpy, 'preview')).toHaveLength(1);
            expect(callsOfKind(runSpy, 'preview')[0][1].priority).toBe('background');

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

        const runSpy = interceptRunOnce('preview', async () => ({
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
        const runSpy = interceptRunOnce('preview', () => {
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

// Pinned bytes of the golden fixture's export documents (the html download and the
// wrapped document fed to htmlToPdf). Regenerate only for an intentional renderer
// change — last moved by the class-based export styles (2026-08-05), which replaced
// every inline style attribute with interned classes in a body <style> element.
const GOLDEN_EXPORT_HTML_SHA256 = 'f5d528de407c003abef49b98ce37a24c8aea7f7a1f366e46118535680d6512fe';
const GOLDEN_EXPORT_PDF_HTML_SHA256 = '5cc180f8ccf3b9f2864b9226c9323810a8ba780c0ed6ad94b754ec43dc22c2bd';

describe('document transform (eigensheets export)', () => {
    let golden: { mount: Mount; path: DrivePath };

    beforeAll(async () => {
        const sheetsPath = await seedDoc('golden-export');
        const home = await getHome(ctx.alice.user.id);
        golden = await home.drive.resolveFile(mountId, sheetsPath.id);
    });

    test('html export through the Worker matches the pinned golden bytes', async () => {
        const result = await exportDocument(golden.mount, golden.path, 'html');
        expect(sha256(result.data)).toBe(GOLDEN_EXPORT_HTML_SHA256);
    }, 120_000);

    test('pdf-html export through the Worker matches the pinned golden bytes', async () => {
        // The stage before htmlToPdf: the wrapped document WeasyPrint renders, with
        // the @page size derived from the widest/tallest sheet.
        const job = {
            kind: 'export',
            documentType: 'eigensheets',
            format: 'pdf-html',
            title: 'golden-export',
        } as const;
        const html = await runTransformToBytes(golden.mount, golden.path, job, {});
        expect(sha256(html)).toBe(GOLDEN_EXPORT_PDF_HTML_SHA256);
    }, 120_000);

    test('xlsx export through the Worker returns a parseable workbook', async () => {
        const result = await exportDocument(golden.mount, golden.path, 'xlsx');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(result.data);
        expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Dashboard', 'Data', 'Empty']);
        const dashboard = workbook.getWorksheet('Dashboard');
        expect(dashboard?.getCell('B2').value).toBe(48);
        // Recalc ran in the Worker before ExcelJS built the workbook.
        expect(dashboard?.getCell('F2').value).toMatchObject({ formula: 'SUM(B2:E2)', result: GOLDEN_ROW1_TOTAL });
    }, 120_000);
});

// Recorded from the import pipeline (xlsxToSheets + recalcImportedSheets +
// encodeSheetsSnapshot) over buildImportFixture(), so the Worker and the main
// thread are proven to emit the same bytes. Regenerate only for an intentional
// converter or wire-format change (last moved by the snapshot v2 format).
const GOLDEN_IMPORT_SNAPSHOT_SHA256 = '310a4f1b918d8901737343cddd8bcad48487d706af4440b3d28670c398b2a4ae';

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

    return toTransferableBuffer(new Uint8Array(await workbook.xlsx.writeBuffer()));
}

async function importRequest(pathId: string, body: ArrayBuffer): Promise<Response> {
    return authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/import`, {
        method: 'POST',
        body,
    });
}

// The xlsx and docx import/convert failure contracts are identical — same routes, same
// statuses, the same untouched-target guarantee — so both formats run through one pair
// of helpers over their own fixture.
type ImportFormatFixture = {
    extension: 'xlsx' | 'docx';
    createType: 'sheets' | 'doc';
    targetType: 'eigensheets' | 'eigendoc';
    mimeType: string;
    build: () => Promise<ArrayBuffer>;
    readState: (pathId: string) => Promise<unknown>;
    expectSeeded: (state: unknown) => void;
};

async function liveState(pathId: string, read: (doc: Y.Doc) => unknown): Promise<unknown> {
    const home = await getHome(ctx.alice.user.id);
    const collab = await home.drive.getCollabDocument(mountId, pathId);
    return read(collab.doc);
}

const XLSX_FIXTURE: ImportFormatFixture = {
    extension: 'xlsx',
    createType: 'sheets',
    targetType: 'eigensheets',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    build: buildImportFixture,
    readState: (pathId) => liveState(pathId, (doc) => doc.getMap('state').get('snapshot')),
    expectSeeded: (state) => expect(typeof state).toBe('string'),
};

const DOCX_FIXTURE: ImportFormatFixture = {
    extension: 'docx',
    createType: 'doc',
    targetType: 'eigendoc',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    build: () => buildGoldenDocx(TEST_PNG_BYTES),
    readState: (pathId) => liveState(pathId, readEigendocFromDoc),
    expectSeeded: (state) => expect((state as JSONContent).content?.length).toBeGreaterThan(0),
};

async function expectFailedImportLeavesTargetUntouched(fixture: ImportFormatFixture): Promise<void> {
    const target = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}/create/${fixture.createType}`,
        { fileName: `${fixture.extension}-import-crash-target` },
    );
    expect((await importRequest(target.id, await fixture.build())).status).toBe(200);
    const before = await fixture.readState(target.id);
    fixture.expectSeeded(before);

    const runSpy = interceptRunOnce('import', async () => ({
        ok: false as const,
        error: { code: 'crashed' as const, message: 'forced failure' },
    }));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
        const res = await importRequest(target.id, await fixture.build());
        expect(res.status).toBe(500);
        expect(await fixture.readState(target.id)).toEqual(before);
    } finally {
        errorSpy.mockRestore();
        runSpy.mockRestore();
    }
}

async function expectFailedConvertCreatesNoDestination(fixture: ImportFormatFixture): Promise<void> {
    const folder = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}`,
        { folderName: `${fixture.extension}-convert-crash` },
    );
    const sourceName = `crash.${fixture.extension}`;
    const uploaded = await driveUpload<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        folder.id,
        new File([await fixture.build()], sourceName, { type: fixture.mimeType }),
    );

    const runSpy = interceptRunOnce('import', async () => ({
        ok: false as const,
        error: { code: 'crashed' as const, message: 'forced failure' },
    }));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/${fixture.targetType}`,
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
        expect(contents.map((entry) => entry.name)).toEqual([sourceName]);
    } finally {
        errorSpy.mockRestore();
        runSpy.mockRestore();
    }
}

describe('document transform (xlsx import)', () => {
    test('Worker import equals the pre-move parse + recalc pipeline', async () => {
        const response = await documentTransformRunner.run(
            { kind: 'import', sourceFormat: 'xlsx', targetType: 'eigensheets', data: await buildImportFixture() },
            EXPORT_OPTIONS,
        );
        const snapshotJson = importSnapshot(response);
        expect(sha256(snapshotJson)).toBe(GOLDEN_IMPORT_SNAPSHOT_SHA256);
        expect(response.ok && response.warnings).toEqual([]);

        // The same pure pipeline the Worker dispatches to, run on this thread.
        const direct = await importXlsxToSheetsSnapshot(await buildImportFixture());
        expect(snapshotJson).toBe(new TextDecoder().decode(direct.snapshotJson));
        // The stale cached SUM(B2:B3)=999 was recomputed at import.
        const sheets = decodeSheetsSnapshot(snapshotJson);
        expect(sheets[0].celldata?.find((cell) => cell.r === 3 && cell.c === 1)?.v?.v).toBe(49);
    }, 120_000);

    test('the committed snapshot is stored in the v2 wire format, flagged computed', async () => {
        const target = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'import-snapshot-v2' },
        );
        expect((await importRequest(target.id, await buildImportFixture())).status).toBe(200);

        const snapshot = (await XLSX_FIXTURE.readState(target.id)) as string;
        expect(snapshot.startsWith('{"f":"eigensheets/2"')).toBe(true);
        // The import recalc succeeded, so the decoded calcChain keeps the read gate off.
        expect(snapshot).toContain('"computed":true');
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
            const sheets = decodeSheetsSnapshot(new TextDecoder().decode(snapshotJson));
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
        const runSpy = interceptRunOnce('import', async () => ({
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
        await expectFailedImportLeavesTargetUntouched(XLSX_FIXTURE);
    }, 120_000);

    test('a failed convert Worker creates no destination document', async () => {
        await expectFailedConvertCreatesNoDestination(XLSX_FIXTURE);
    }, 120_000);
});

// Recorded from the pre-Worker doc/slides pipeline on the golden fixtures (preview
// generators, the html downloads, and the wrapped documents fed to WeasyPrint), so the
// move off-thread is proven byte-identical. Regenerate only
// for an intentional renderer change. The embedded media data URI comes from the
// screen-preview pipeline (sharp → WebP), so a preview-encoder change moves the
// export hashes legitimately. The deck hashes were re-recorded when the deck moved onto the canvas
// compositor: a slide is a `canvas-page` of scene layers now, so the bytes differ by construction —
// and again when every screen-rendered page gained the shared `.page-fit` wrapper, which the preview
// body now carries too so the lightbox and the drive hero can scale a page below its own width.
const GOLDEN_DOC_PREVIEW_SHA256 = 'f61e8785cd4e3b3872e5fcf6ee817abdae5e2ed4119a113dc17342fd922e6b44';
const GOLDEN_DOC_EXPORT_HTML_SHA256 = 'f4b1308435d2d2f9d140c4ed62b81a1e9cb281dee8d68aee3a880258e87edf3b';
const GOLDEN_DOC_EXPORT_PDF_HTML_SHA256 = 'f4b1308435d2d2f9d140c4ed62b81a1e9cb281dee8d68aee3a880258e87edf3b';
const GOLDEN_DECK_PREVIEW_SHA256 = '311befb5e41d44764a652b426ce83f96293ccccb9adffe14e16412c50b0c5c50';
const GOLDEN_DECK_EXPORT_HTML_SHA256 = '90aedd5ee8392ed455dcd90d8ad069b0c4c16c5866879f8c03614a54e0e76c4c';
const GOLDEN_DECK_EXPORT_PDF_HTML_SHA256 = '1f82eecdcf9b60057fbcba2eec06355945d869676f947b80a59ca05bf4f8659e';

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
    else seedDeckDoc(collab.doc, buildGoldenDeckScene());
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

    test('Worker preview equals the main thread and matches the pinned golden hash', async () => {
        const { mount, path } = golden;
        const mediaUrls = await buildPreviewUrlMap(mount, path);
        // Main-thread execution of the exact Worker pipeline (capture → materialize
        // → render/sanitize), against the Worker execution via the real runner.
        const persisted = await readPersistedDoc(mount, path);
        const direct = renderEigendocPreviewBody(persisted, mediaUrls);
        persisted.destroy();

        const response = await documentTransformRunner.run(
            { kind: 'preview', documentType: 'eigendoc', mediaUrls, source: await captureCollabSource(mount, path) },
            PREVIEW_OPTIONS,
        );
        const body = previewBody(response);
        expect(body).toBe(direct.body);
        expect(response.ok && response.warnings).toEqual(direct.warnings);

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
        const result = await exportDocument(golden.mount, golden.path, 'html');
        expect(sha256(result.data)).toBe(GOLDEN_DOC_EXPORT_HTML_SHA256);
    }, 120_000);

    test('pdf-html export is byte-identical to the pre-move pipeline', async () => {
        // The stage before htmlToPdf: the wrapped document WeasyPrint renders.
        const html = await runDocumentExport(
            { documentType: 'eigendoc', format: 'pdf-html' },
            golden.mount,
            golden.path,
        );
        expect(sha256(html)).toBe(GOLDEN_DOC_EXPORT_PDF_HTML_SHA256);
    }, 120_000);

    test('a figure naming a prototype key renders without an image, not a crash', () => {
        // mediaName is document data — an unknown name must resolve to null, never to
        // something off Object.prototype.
        const doc = new Y.Doc();
        seedEigendoc(doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'figure', attrs: { mediaName: 'constructor' } }] }],
        });
        expect(renderEigendocPreviewBody(doc, new Map()).body).not.toContain('<img');
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

        const { body, warnings } = renderEigendocPreviewBody(doc, new Map());
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
            EXPORT_OPTIONS,
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
            EXPORT_OPTIONS,
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

    test('Worker preview equals the main thread and matches the pinned golden hash', async () => {
        const { mount, path } = golden;
        const mediaUrls = await buildPreviewUrlMap(mount, path);
        const persisted = await readPersistedDoc(mount, path);
        const direct = renderEigenslidesPreviewBody(persisted, mediaUrls);
        persisted.destroy();

        const response = await documentTransformRunner.run(
            { kind: 'preview', documentType: 'eigenslides', mediaUrls, source: await captureCollabSource(mount, path) },
            PREVIEW_OPTIONS,
        );
        const body = previewBody(response);
        expect(body).toBe(direct.body);
        expect(response.ok && response.warnings).toEqual(direct.warnings);

        // First 8 slides as compositor pages, with the truncated marker and media as an embed URL.
        expect(body.match(/class="canvas-page"/g)).toHaveLength(8);
        expect(body).toContain('Deck <strong>title</strong>');
        expect(body).not.toContain(GOLDEN_BEYOND_CAP);
        expect(body).toContain('Preview truncated');
        expect(body).toMatch(/href="http:\/\/localhost\/drive\/[^"]+\/preview"/);
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

    test('html export matches the pinned golden bytes', async () => {
        const result = await exportDocument(golden.mount, golden.path, 'html');
        expect(sha256(result.data)).toBe(GOLDEN_DECK_EXPORT_HTML_SHA256);
    }, 120_000);

    test('pdf-html export matches the pinned golden bytes', async () => {
        // The PDF arm keeps each page unscaled on its own sheet; only the screen arm wraps a page
        // in the container-query fit box.
        const html = await runDocumentExport(
            { documentType: 'eigenslides', format: 'pdf-html' },
            golden.mount,
            golden.path,
        );
        expect(sha256(html)).toBe(GOLDEN_DECK_EXPORT_PDF_HTML_SHA256);
    }, 120_000);

    test('a corrupt update blob surfaces as a warning, never a failed export', async () => {
        // The export side of the shared worker.ts blob-skip path (preview side: the
        // eigensheets preview test).
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
                EXPORT_OPTIONS,
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

// Vector's preview body is one compositor page of HTML, the same markup the PDF export prints,
// so this suite proves the page round-trip (Worker == main thread) and the /preview media URL the
// main thread resolved.
async function seedGoldenVector(fileName: string): Promise<{ mount: Mount; path: DrivePath }> {
    const created = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}/create/vector`,
        { fileName },
    );
    const home = await getHome(ctx.alice.user.id);
    const collab = await home.drive.getCollabDocument(mountId, created.id);
    seedVectorDoc(collab.doc, buildGoldenVectorScene());

    const resolved = await home.drive.resolveFile(mountId, created.id);
    await seedDocumentMedia(resolved.mount, resolved.path, GOLDEN_MEDIA_NAME, TEST_PNG_BYTES);
    return resolved;
}

describe('document transform (eigenvector)', () => {
    let golden: { mount: Mount; path: DrivePath };

    beforeAll(async () => {
        golden = await seedGoldenVector('golden-vector');
    });

    test('Worker preview equals the main thread', async () => {
        const { mount, path } = golden;
        const mediaUrls = await buildPreviewUrlMap(mount, path);
        // Main-thread execution of the exact Worker pipeline against the Worker run.
        const persisted = await readPersistedDoc(mount, path);
        const direct = renderEigenvectorPreviewBody(persisted, mediaUrls);
        persisted.destroy();

        const response = await documentTransformRunner.run(
            { kind: 'preview', documentType: 'eigenvector', mediaUrls, source: await captureCollabSource(mount, path) },
            PREVIEW_OPTIONS,
        );
        const body = previewBody(response);
        expect(body).toBe(direct.body);
        expect(response.ok && response.warnings).toEqual(direct.warnings);

        // The body is a compositor page — the same HTML the PDF export prints, not an SVG
        // document. Its image rides the /preview URL the main thread prepared, and hostile text
        // stays escaped through DOMPurify and the serializer.
        expect(body.startsWith('<div class="page-fit"')).toBe(true);
        expect(body).toContain('Vector &lt;sketch&gt;');
        expect(body).not.toContain('<sketch>');
        expect(body).toMatch(/<image[^>]+href="https?:\/\/[^"]+\/file\/[^"]+\/preview"/);
        expect(body).not.toContain('eigen-media:');
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
    async function runDocxImport(data: ArrayBuffer): Promise<DocumentTransformResponse> {
        return documentTransformRunner.run(
            { kind: 'import', sourceFormat: 'docx', targetType: 'eigendoc', data },
            EXPORT_OPTIONS,
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
        await expectFailedImportLeavesTargetUntouched(DOCX_FIXTURE);
    }, 120_000);

    test('a failed convert Worker creates no destination document', async () => {
        await expectFailedConvertCreatesNoDestination(DOCX_FIXTURE);
    }, 120_000);
});

describe('document transform (admission)', () => {
    test('a refused job never reads the source document', async () => {
        // Admission is checked before captureCollabSource, so a 503'd job pays nothing:
        // a reindex drain under load was reading every dirty row's blobs to be refused.
        const mount = {
            getChildByName: () => {
                throw new Error('a refused job captured its source');
            },
        } as unknown as Mount;
        const path = { id: 'refused', name: 'refused.eigendoc' } as DrivePath;

        const refuse = refuseAdmissionOnce();
        let error: unknown;
        try {
            await runTransformToExtractedText(
                mount,
                path,
                { kind: 'extract-text', documentType: 'eigendoc' },
                { priority: 'background' },
            );
        } catch (err) {
            error = err;
        } finally {
            refuse.mockRestore();
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(503);
    });

    test('a refused export never collects its media', async () => {
        // Doc and slides exports pay Mount I/O plus a screen preview per image before
        // the transform seam is reached — a 503'd export must pay for neither.
        const mount = {
            getChildByName: () => {
                throw new Error('a refused export collected its media');
            },
        } as unknown as Mount;
        const path = { id: 'refused', name: 'refused.eigendoc' } as DrivePath;

        const refuse = refuseAdmissionOnce();
        let error: unknown;
        try {
            await runDocumentExport({ documentType: 'eigendoc', format: 'html' }, mount, path);
        } catch (err) {
            error = err;
        } finally {
            refuse.mockRestore();
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(503);
    });

    test('a refused import never copies the upload', async () => {
        // Any read of the upload means toTransferableBuffer copied it before admission.
        const upload = new Proxy(Buffer.alloc(0), {
            get: () => {
                throw new Error('a refused import copied the upload');
            },
        });
        const drive = {} as unknown as Drive;
        const mount = {} as unknown as Mount;
        const user = {} as unknown as User;

        for (const mimeType of [DRIVE_MIME_SHEETS, DRIVE_MIME_DOC]) {
            const refuse = refuseAdmissionOnce();
            let error: unknown;
            try {
                await importIntoDocument(drive, mount, { id: 'refused', mimeType } as DrivePath, upload, user);
            } catch (err) {
                error = err;
            } finally {
                refuse.mockRestore();
            }
            expect(error).toBeInstanceOf(ApiError);
            expect((error as ApiError).status).toBe(503);
        }
    });

    test('a refused convert never reads the stored file', async () => {
        const mount = {
            readFile: () => {
                throw new Error('a refused convert read the stored file');
            },
        } as unknown as Mount;
        const path = { id: 'refused', parentId: 'parent', name: 'refused.xlsx' } as DrivePath;

        const refuse = refuseAdmissionOnce();
        let error: unknown;
        try {
            await convertToDocument({} as unknown as Drive, mount, path, 'eigensheets');
        } catch (err) {
            error = err;
        } finally {
            refuse.mockRestore();
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(503);
    });
});
