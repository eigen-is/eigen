import { beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as engine from '@workspace/sheet/engine';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../lib/collab/db-config';
import * as collabSchema from '../lib/collab/schema';
import { materializeYjsState } from '../lib/collab/yjs-loader';
import { ApiError } from '../lib/core/errors';
import { readSheetsFromDoc } from '../lib/document/sheets';
import { captureCollabSource } from '../lib/document/transform/collab-source';
import { documentTransformRunner } from '../lib/document/transform/runner';
import { getHome } from '../lib/home/get-home';
import { renderEigensheetsPreviewBody } from '../lib/preview/eigensheets-preview';
import { buildGoldenOps, buildGoldenSheets, seedSheetsDoc } from './fixtures/heavy-sheets';
import { authedRequest, driveGet, drivePost, getTestContext } from './setup';

// End-to-end validation of the off-thread eigensheets preview: Worker output must
// equal the same pipeline executed on the main thread, corruption and recalc
// failures surface as warnings (never as a failed preview), and the preview cache
// keeps its dedupe/stale-while-revalidate contract on top of the runner.

const GARBAGE = Buffer.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8]);

describe('document transform (eigensheets preview)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

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
        expect(response.ok).toBe(true);
        if (response.ok) {
            expect(response.result.body).toBe(direct.body);
            expect(response.warnings).toEqual(direct.warnings);
        }
    }, 60_000);

    test('a corrupt update blob surfaces as a warning, not a failed preview', async () => {
        const sheetsPath = await seedDoc('worker-corrupt-update');
        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);

        const dataDbPath = await mount.getChildByName(path.id, 'data.db');
        const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath!.id);
        const last = managedDb.db.select({ id: collabSchema.docUpdates.id }).from(collabSchema.docUpdates).all().at(-1);
        expect(last).toBeDefined();
        // Corrupt only the newest update — the base write must survive so the
        // preview still has content to render.
        managedDb.db
            .update(collabSchema.docUpdates)
            .set({ updateData: GARBAGE })
            .where(eq(collabSchema.docUpdates.id, last!.id))
            .run();

        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await documentTransformRunner.run(
                { kind: 'preview', documentType: 'eigensheets', source: await captureCollabSource(mount, path) },
                { priority: 'foreground', deadlineMs: 30_000 },
            );
            expect(response.ok).toBe(true);
            if (response.ok) {
                expect(response.warnings).toContainEqual({ code: 'corrupt-blobs-skipped', count: 1 });
                expect(response.result.body.length).toBeGreaterThan(0);
            }
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
