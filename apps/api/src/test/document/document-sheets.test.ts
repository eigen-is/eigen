import { beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { defaultChartSpec, newChartSpecParts, readChartSpec } from '@workspace/lib/charts';
import type { Op, Sheet } from '@workspace/lib/sheets';
import {
    decodeSheetsSnapshot,
    decodeSheetsWorkbook,
    encodeSheetsSnapshot,
    readSheetsSnapshotJson,
    sheetsOpLog,
    sheetsStateMap,
    writeSheetsSnapshot,
} from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as engine from '@workspace/sheet/engine';
import { normalizeSheetConfig } from '@workspace/sheet/engine';
import * as Y from 'yjs';
import { addSheetsBatch, compactSheetsSnapshot, readSheetsFromDoc } from '../../lib/document/sheets';
import { TRANSFORM_LIMITS } from '../../lib/document/transform/runner';
import { sheetsHtmlDocument } from '../../lib/export/sheets/render';
import { getHome } from '../../lib/home/get-home';
import { importIntoDocument } from '../../lib/import/import-document';
import type { Mount } from '../../lib/mount';
import { cellLinks } from '../fixtures/cell-links';
import { writeSheetsToYjs } from '../fixtures/heavy-sheets';
import { readPersistedDoc } from '../fixtures/transform-results';
import { formatList, formatsOf } from '../fixtures/validations';
import { rowsXml, xlsxFixture } from '../fixtures/xlsx';
import { driveGet, drivePost, getTestContext, NO_MEDIA } from '../setup';

// Persisted workbook → Sheet[] plus whether recalc fell back, the way every reader
// gets one now.
async function readSheets(mount: Mount, path: DrivePath): Promise<{ sheets: Sheet[]; recalcError: string | null }> {
    const doc = await readPersistedDoc(mount, path);
    const result = readSheetsFromDoc(doc);
    doc.destroy();
    return result;
}

// readSheetsFromDoc materializes a dense `data` matrix on every sheet (the
// renderers read it); equality pins here compare the persisted shape, so strip it.
function withoutData(sheets: Sheet[]): Sheet[] {
    return sheets.map(({ data: _data, ...sheet }) => sheet);
}

// The replay materializes every config collection and the `images` and `charts` maps, so the
// editor's granular ops (`['config','rowlen','2']`, `['images', id, 'x']`)
// resolve against a stored sheet that predates them. Every sheet it returns carries that shape — the snapshot's and an addSheet op's
// alike — so expectations built from raw fixtures have to carry it too.
function normalized(sheets: Sheet[]): Sheet[] {
    return sheets.map((sheet) => {
        const next = { ...sheet, config: { ...sheet.config } };
        normalizeSheetConfig(next);
        return next;
    });
}

describe('document/sheets', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    test('throws when data.db is missing', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName: 'no-data-db.eigensheets' },
        );

        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, folder.id);

        await expect(readSheets(mount, path)).rejects.toThrow('data.db missing');
    });

    test('a doc with neither snapshot nor ops reads as the sheet a tab opening it shows', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'empty-doc' },
        );

        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result.map((sheet) => sheet.id)).toEqual(['sheet-1']);
    });

    test('reads snapshot-only doc → returns parsed Sheet[]', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'snapshot-only' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(withoutData(result)).toEqual(normalized(sheets));
    });

    test('every read sheet carries a materialized dense data matrix', async () => {
        // v2 snapshots are celldata-only; the renderers' CF pass and the cross-sheet
        // formula resolver read `data`, so the read seam must materialize it.
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'materialized-data' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
        const sheets: Sheet[] = [
            { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [{ r: 1, c: 2, v: { v: 7, m: '7' } }], config: {} },
        ];
        writeSheetsToYjs(collab.doc, sheets, { computed: false });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].data).toBeDefined();
        expect(result[0].data![1][2]?.v).toBe(7);
        expect(result[0].data!.length).toBeGreaterThanOrEqual(2);
    });

    test('write round-trip: writeSheetsToYjs then a persisted read returns same sheets', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'round-trip' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                celldata: [{ r: 0, c: 0, v: { v: 'hello' } }],
                config: {},
            },
            { id: 'sheet-2', name: 'Sheet2', order: 1, celldata: [], config: {} },
        ];

        writeSheetsToYjs(collab.doc, sheets, { computed: false });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(withoutData(result)).toEqual(normalized(sheets));
    });

    test('writeSheetsSnapshot commits pre-serialized JSON and clears the ops array', async () => {
        // The import path commits the Worker's snapshot bytes without parsing them,
        // so this writer must leave the doc in the same state as the Sheet[] one.
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'snapshot-writer' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
        collab.doc.transact(() => {
            collab.doc.getArray('ops').push([[{ op: 'replace', path: ['x'], value: 1 }]]);
        });

        const sheets: Sheet[] = [
            { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [{ r: 0, c: 0, v: { v: 'hi' } }], config: {} },
        ];
        writeSheetsSnapshot(collab.doc, encodeSheetsSnapshot(sheets, { computed: false }), null);

        expect(collab.doc.getArray('ops').length).toBe(0);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        expect(withoutData((await readSheets(mount, path)).sheets)).toEqual(normalized(sheets));

        const viaSheets = new Y.Doc();
        writeSheetsToYjs(viaSheets, sheets, { computed: false });
        expect(collab.doc.getMap('state').get('snapshot')).toBe(viaSheets.getMap('state').get('snapshot'));
        viaSheets.destroy();
    });

    test('writeSheetsToYjs clears the ops array', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'clears-ops' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        collab.doc.transact(() => {
            collab.doc.getArray('ops').push([[{ op: 'replace', path: ['x'], value: 1 }]]);
        });
        expect(collab.doc.getArray('ops').length).toBe(1);

        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        writeSheetsToYjs(collab.doc, sheets, { computed: false });

        expect(collab.doc.getArray('ops').length).toBe(0);
    });
});

describe('document/sheets — patch op replay', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    test('reads doc with snapshot + cell-edit op → returns sheets with edit applied', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-cell-edit' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        const batch: Op[] = [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 0], value: { v: 7 } }];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].celldata).toEqual([{ r: 0, c: 0, v: { v: 7 } }]);
    });

    test('reads doc with pending ops but no snapshot → replays over the default sheets', async () => {
        // A fresh doc closed before its first compaction has
        // ops in Yjs but no snapshot. The replay base must be the same default
        // sheets the editor started from — over an empty base the ops
        // referencing 'sheet-1' are silently dropped and the doc reads empty.
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-no-snapshot' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const batch: Op[] = [{ op: 'replace', id: 'sheet-1', path: ['data', 1, 1], value: { v: 'b2', m: 'b2' } }];
        collab.doc.transact(() => {
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('sheet-1');
        expect(result[0].data![1][1]?.v).toBe('b2');
        expect(result[0].celldata).toEqual([{ r: 1, c: 1, v: { v: 'b2', m: 'b2' } }]);
    });

    test("an old batch's write to the recalc list fails nothing — the computed value survives", async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-first-formula' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        // A1 = "asdf", B1 = "=1+1", C1 = "test".
        const batches: Op[][] = [
            [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 0], value: { v: 'asdf', m: 'asdf' } }],
            [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 1], value: { v: 2, f: '=1+1', m: '2' } }],
            [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 2], value: { v: 'test', m: 'test' } }],
        ];
        collab.doc.transact(() => {
            collab.doc.getArray<Op[]>('ops').push(batches);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].data![0][1]).toEqual({ v: 2, f: '=1+1', m: '2' });
        expect(
            sheetsHtmlDocument({
                title: 'first-formula',
                sheets: result,
                mediaUrls: NO_MEDIA,
                mode: 'screen',
                lost: () => {},
            }),
        ).toContain('>2<');
    });

    test('reads doc with snapshot + multiple op batches → applies in order', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-multi-batch' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        const batch1: Op[] = [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 0], value: { v: 1 } }];
        const batch2: Op[] = [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 0], value: { v: 2 } }];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch1, batch2]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].celldata?.[0].v?.v).toBe(2);
    });

    test('reads doc with snapshot + addSheet op → returns sheets with new sheet appended', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-add-sheet' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        const newSheet: Sheet = { id: 'sheet-2', name: 'Sheet2', order: 1, celldata: [], config: {} };
        const batch: Op[] = [{ op: 'addSheet', id: 'sheet-2', path: [], value: newSheet }];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result, recalcError } = await readSheets(mount, path);

        expect(result).toHaveLength(2);
        expect(withoutData(result)[1]).toEqual(normalized([newSheet])[0]);
        expect(recalcError).toBeNull();
    });

    test('reads doc with snapshot + deleteSheet op → returns sheets without the deleted sheet', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-delete-sheet' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [
            { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} },
            { id: 'sheet-2', name: 'Sheet2', order: 1, celldata: [], config: {} },
        ];
        const batch: Op[] = [{ op: 'deleteSheet', id: 'sheet-1', path: [], value: sheets[0] }];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result, recalcError } = await readSheets(mount, path);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('sheet-2');
        expect(recalcError).toBeNull();
    });

    test('reads doc with snapshot + insertRowCol op → row shifted in result', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-row-col' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                // v2 never persists the dense matrix; row/column size the materialized one.
                row: 2,
                column: 1,
                celldata: [],
                data: [
                    [{ v: 'first', m: 'first', ct: { fa: 'General', t: 'g' } }],
                    [{ v: 'second', m: 'second', ct: { fa: 'General', t: 'g' } }],
                ],
                config: {},
            },
        ];
        const batch: Op[] = [
            {
                op: 'insertRowCol',
                id: 'sheet-1',
                path: [],
                value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
            },
        ];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result).toHaveLength(1);
        expect(result[0].data!.length).toBe(3);
        expect(result[0].data![0]).toEqual([null]);
        expect(result[0].data![1][0]?.v).toBe('first');
        expect(result[0].data![2][0]?.v).toBe('second');
    });

    test('celldata-only snapshot + cell-edit op → data materialized, celldata refreshed', async () => {
        // Reproduces the user-reported export crash: xlsxToSheets / early
        // FE snapshots store celldata only, but ops emitted by the reducer
        // reference data[r][c]. replaySheetsOps must materialize data before
        // applying patches, then sync celldata back so xlsx export sees the
        // edit.
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-celldata-only' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                celldata: [{ r: 0, c: 0, v: { v: 'before', m: 'before', ct: { fa: 'General', t: 'g' } } }],
                config: {},
            },
        ];
        const batch: Op[] = [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 0, 'v'], value: 'after' }];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].data![0][0]?.v).toBe('after');
        expect(result[0].celldata?.[0]?.v?.v).toBe('after');
    });

    test('reads doc with snapshot + wholesale sheets replace + insertRowCol → no crash, row inserted', async () => {
        // Real op shape from the Annual Calendar regression: when
        // the sheet reducer reassigns ctx.sheets during a row/col
        // mutation, immer emits a synthetic replace patch with no sheet id and
        // path ['sheets']. Applying that patch on Sheet[] root throws
        // immer error 14. opToPatchOnSheets drops it; the paired insertRowCol
        // special op carries the semantics.
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-wholesale-replace' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                row: 1,
                column: 1,
                data: [[{ v: 'a', m: 'a', ct: { fa: 'General', t: 'g' } }]],
                config: {},
            },
        ];
        const batch: Op[] = [
            { op: 'replace', path: ['sheets'], value: sheets },
            {
                op: 'insertRowCol',
                id: 'sheet-1',
                path: [],
                value: { type: 'row', index: 0, count: 1, direction: 'lefttop' },
            },
        ];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![1][0]?.v).toBe('a');
    });

    test('a snapshot stored as not computed gets engine-computed v/m on read', async () => {
        // An import whose recalc failed: celldata carries formula text with no cached value. The read must run
        // server recalc and return computed v + m.
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'recalc-gate-on' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                config: {},
                celldata: [
                    { r: 0, c: 0, v: { v: 5, m: '5', ct: { fa: 'General', t: 'n' } } },
                    { r: 0, c: 1, v: { f: '=A1+1' } },
                    { r: 0, c: 2, v: { f: '=A1/4', ct: { fa: '0.00', t: 'n' } } },
                ],
            },
        ];
        writeSheetsToYjs(collab.doc, sheets, { computed: false });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].data![0][1]?.v).toBe(6);
        expect(result[0].data![0][1]?.m).toBe('6');
        // fa-masked formula cell derives m via the cell's format mask
        expect(result[0].data![0][2]?.v).toBe(1.25);
        expect(result[0].data![0][2]?.m).toBe('1.25');
    });

    test('a snapshot stored as computed keeps its stored values (no recompute)', async () => {
        // Even a deliberately-wrong cached value must survive untouched.
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'recalc-gate-off' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                config: {},
                celldata: [
                    { r: 0, c: 0, v: { v: 5, m: '5', ct: { fa: 'General', t: 'n' } } },
                    { r: 0, c: 1, v: { f: '=A1+1', v: 999, m: '999', ct: { fa: 'General', t: 'n' } } },
                ],
            },
        ] as unknown as Sheet[];
        writeSheetsToYjs(collab.doc, sheets, { computed: true });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        const b1 = result[0].celldata?.find((e) => e.r === 0 && e.c === 1);
        expect(b1?.v?.v).toBe(999);
    });

    test('recalc:false — formula cells keep their stored values and the gate never runs', () => {
        // Preview and search extraction read with { recalc: false }: a legacy
        // never-computed workbook recalced ~39s on prod and the 30s Worker deadline
        // killed every preview forever. Stored values are served as-is; only the
        // export read still recalcs (under its 120s deadline).
        const doc = new Y.Doc();
        const sheets = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                config: {},
                celldata: [
                    { r: 0, c: 0, v: { v: 5, m: '5', ct: { fa: 'General', t: 'n' } } },
                    { r: 0, c: 1, v: { f: '=A1+1' } },
                    { r: 0, c: 2, v: { f: '=A1+2', v: 999, m: '999', ct: { fa: 'General', t: 'n' } } },
                ],
            },
        ] as unknown as Sheet[];
        writeSheetsToYjs(doc, sheets, { computed: false });

        const { sheets: result, recalcError } = readSheetsFromDoc(doc, { recalc: false });

        const cellAt = (c: number) => result[0].celldata?.find((e) => e.r === 0 && e.c === c)?.v;
        expect(cellAt(1)?.v).toBeUndefined();
        expect(cellAt(1)?.m).toBeUndefined();
        expect(cellAt(2)?.v).toBe(999);
        expect(recalcError).toBeNull();
        doc.destroy();
    });

    test('xlsx import e2e: formula-only cells get engine-computed v/m persisted; volatile stays empty', async () => {
        // Generator-blank case: a generator writes formula-only cells (no cached
        // result). Driven through the real import seam
        // (importIntoDocument — the same call routes/drive-content.ts's /import makes),
        // so this covers xlsxToSheets → recalcSheets → writeSheetsToYjs end to end.
        const buffer = Buffer.from(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Sheet1',
                        data: rowsXml([
                            ['A1', 10],
                            ['A2', 32],
                            ['B1', { formula: 'A1+A2' }],
                            ['B2', { formula: 'SUM(A1:A2)*2' }],
                            ['C1', { formula: 'NOW()' }],
                        ]),
                    },
                ],
            }),
        );

        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'recalc-import-e2e' },
        );

        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        await importIntoDocument(home.drive, path, buffer, { mode: 'replace' }, home.user);

        const { sheets: result } = await readSheets(mount, path);

        const cellAt = (r: number, c: number) => result[0].celldata?.find((e) => e.r === r && e.c === c)?.v;
        expect(cellAt(0, 1)?.f).toBe('=A1+A2');
        expect(cellAt(0, 1)?.v).toBe(42);
        expect(cellAt(0, 1)?.m).toBe('42');
        expect(cellAt(1, 1)?.f).toBe('=SUM(A1:A2)*2');
        expect(cellAt(1, 1)?.v).toBe(84);
        expect(cellAt(1, 1)?.m).toBe('84');

        // Volatile freeze, pinned: the xlsx carried no cached NOW() result, so
        // there is nothing to freeze — the cell keeps its formula but stays
        // without v/m until a client editor computes it.
        expect(cellAt(0, 2)?.f).toBe('=NOW()');
        expect(cellAt(0, 2)?.v).toBeUndefined();
        expect(cellAt(0, 2)?.m).toBeUndefined();
    });

    test('reads doc with snapshot + orphan patch op (sheet id not in array) → op dropped', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-orphan' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        const batch: Op[] = [{ op: 'replace', id: 'sheet-missing', path: ['celldata'], value: [] }];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', encodeSheetsSnapshot(sheets, { computed: false }));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(withoutData(result)).toEqual(normalized(sheets));
    });
});

// As an insert builds the batch from the workbook it read and pushes it.
function append(doc: Y.Doc, snapshotJson: string): void {
    const workbook = {
        snapshot: readSheetsSnapshotJson(doc) ?? null,
        batches: JSON.stringify(sheetsOpLog(doc).toArray()),
    };
    sheetsOpLog(doc).push([addSheetsBatch(workbook, snapshotJson, { cells: 0, text: 0 })]);
}

describe('document/sheets — addSheetsBatch', () => {
    const range = (sheetId: string) => ({
        sheetId,
        row: [0, 2] as [number, number],
        column: [0, 0] as [number, number],
    });
    const spec = {
        ...defaultChartSpec('bar', {
            source: 'range',
            categories: range('sheet-0'),
            series: [{ id: 's-1', name: 'Sum', values: range('sheet-1') }],
        }),
        title: { text: 'Totals' },
    };

    // What a file brings: "Data", whose name the workbook holds, and "Summary", which names it in a formula, a
    // conditional format, a list source, two links and a chart.
    const file: Sheet[] = [
        { id: 'sheet-0', name: 'Data', order: 0, celldata: [{ r: 0, c: 0, v: { v: 5, m: '5' } }], config: {} },
        {
            id: 'sheet-1',
            name: 'Summary',
            order: 1,
            celldata: [
                { r: 0, c: 0, v: { f: '=Data!A1*2', v: 10, m: '10' } },
                { r: 1, c: 0, v: { v: 'Go', m: 'Go', link: { type: 'sheet', address: 'Data' } } },
                { r: 1, c: 1, v: { link: { type: 'cellrange', address: 'Data!B2' } } },
            ],
            config: {},
            conditionalFormats: formatsOf([
                {
                    type: 'default',
                    ranges: [{ row: [0, 0], column: [0, 0] }],
                    format: { textColor: '#ff0000', cellColor: null },
                    conditionName: 'formula',
                    conditionRange: [],
                    conditionValue: ['=A1>Data!A1'],
                },
            ]),
            dataValidations: {
                v1: {
                    ranges: [{ row: [2, 2], column: [0, 0] }],
                    order: 'a0',
                    rule: { type: 'dropdown', type2: '', value1: 'Data!A1:A3', value2: '' },
                },
            },
            charts: {
                c1: { id: 'c1', index: 'a0', x: 0, y: 0, width: 300, height: 200, ...newChartSpecParts(spec) },
            },
        },
    ];

    function workbook(): Y.Doc {
        const doc = new Y.Doc();
        const own: Sheet[] = [
            { id: 'own', name: 'Data', order: 0, celldata: [{ r: 0, c: 0, v: { v: 1 } }], config: {} },
        ];
        doc.getMap('state').set('snapshot', encodeSheetsSnapshot(own, { computed: true }));
        return doc;
    }

    test('a taken name with a ! in it is renamed, and the formula naming it follows', () => {
        const doc = new Y.Doc();
        const own: Sheet[] = [{ id: 'own', name: 'Q1!', order: 0, celldata: [], config: {} }];
        doc.getMap('state').set('snapshot', encodeSheetsSnapshot(own, { computed: true }));
        const imported: Sheet[] = [
            { id: 'a', name: 'Q1!', order: 0, celldata: [{ r: 0, c: 0, v: { v: 5, m: '5' } }], config: {} },
            { id: 'b', name: 'Uses', order: 1, celldata: [{ r: 0, c: 0, v: { f: "='Q1!'!A1", v: 5 } }], config: {} },
        ];
        append(doc, encodeSheetsSnapshot(imported, { computed: true }));
        const { sheets } = readSheetsFromDoc(doc, { recalc: false });
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Q1!', 'Q1!(Copy)', 'Uses']);
        expect(sheets[2].celldata?.[0].v?.f).toBe("='Q1!(Copy)'!A1");
    });

    test("the sheets arrive as one batch of addSheet ops under fresh ids, after the workbook's own", () => {
        const doc = workbook();
        const pending: Op[] = [{ op: 'renameSheet', id: 'own', path: [], value: { name: 'Data' } }];
        doc.getArray('ops').push([pending]);
        const snapshot = doc.getMap('state').get('snapshot');

        append(doc, encodeSheetsSnapshot(file, { computed: true }));

        expect(doc.getMap('state').get('snapshot')).toBe(snapshot);
        const batches = doc.getArray<Op[]>('ops').toArray();
        expect(batches).toHaveLength(2);
        expect(batches[0]).toEqual(pending);
        expect(batches[1].map((op) => op.op)).toEqual(['addSheet', 'addSheet']);
        const ids = batches[1].map((op) => op.id);
        expect(new Set([...ids, 'own', 'sheet-0', 'sheet-1']).size).toBe(5);
        expect(batches[1].map((op) => op.value.id)).toEqual(ids);
        expect(batches[1].map((op) => op.value.order)).toEqual([1, 2]);

        const { sheets } = readSheetsFromDoc(doc, { recalc: false });
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Data', 'Data(Copy)', 'Summary']);
        expect(sheets[0].celldata).toEqual([{ r: 0, c: 0, v: { v: 1 } }]);
    });

    test('every ref the file makes to a renamed sheet follows its new name, and every id ref its new id', () => {
        const doc = workbook();
        append(doc, encodeSheetsSnapshot(file, { computed: true }));
        const { sheets } = readSheetsFromDoc(doc, { recalc: false });
        const [, data, summary] = sheets;
        const cell = (r: number, c: number) => summary.celldata?.find((e) => e.r === r && e.c === c)?.v;

        expect(cell(0, 0)?.f).toBe("='Data(Copy)'!A1*2");
        const rule = formatList(summary.conditionalFormats)[0];
        expect(rule?.type === 'default' && rule.conditionValue).toEqual(["=A1>'Data(Copy)'!A1"]);
        expect(summary.dataValidations?.['v1']?.rule.value1).toBe("'Data(Copy)'!A1:A3");
        expect(cellLinks(summary)).toEqual({
            '1_0': { type: 'sheet', address: 'Data(Copy)' },
            '1_1': { type: 'cellrange', address: "'Data(Copy)'!B2" },
        });
        const stored = summary.charts?.['c1'];
        const chart = stored ? readChartSpec(stored).spec : null;
        expect(chart?.data.source === 'range' && chart.data.categories?.sheetId).toBe(data.id);
        expect(chart?.data.source === 'range' && chart.data.series[0]?.values?.sheetId).toBe(summary.id);
    });

    test('a name the workbook holds in another case is taken, as Excel compares names', () => {
        const doc = workbook();
        append(doc, encodeSheetsSnapshot([{ ...file[0], name: 'DATA' }], { computed: true }));
        const { sheets } = readSheetsFromDoc(doc, { recalc: false });
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Data', 'DATA(Copy)']);
    });

    test('a link to a renamed sheet that spells its name in another case follows the new name', () => {
        const doc = workbook();
        const celldata = [
            ...(file[0].celldata ?? []),
            { r: 0, c: 1, v: { link: { type: 'sheet' as const, address: 'DATA' } } },
        ];
        append(doc, encodeSheetsSnapshot([{ ...file[0], celldata }], { computed: true }));
        const { sheets } = readSheetsFromDoc(doc, { recalc: false });
        expect(cellLinks(sheets[1])).toEqual({ '0_1': { type: 'sheet', address: 'Data(Copy)' } });
    });

    test('a workbook never compacted takes the file beside the default sheet the editor opens on', () => {
        const doc = new Y.Doc();
        append(doc, encodeSheetsSnapshot([{ ...file[0], name: 'Sheet1' }], { computed: true }));
        const { sheets } = readSheetsFromDoc(doc, { recalc: false });
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Sheet1', 'Sheet1(Copy)']);
    });

    test("a name nobody holds is kept, and a ref to a sheet the file doesn't bring stays as written", () => {
        const doc = workbook();
        const json = encodeSheetsSnapshot([{ ...file[1], name: 'Summary' }], { computed: true });
        append(doc, json);
        const [summary] = decodeSheetsSnapshot(json);
        const added = doc.getArray<Op[]>('ops').toArray()[0][0].value;
        expect(added.name).toBe('Summary');
        expect(added.celldata[0].v.f).toBe(summary.celldata?.[0]?.v?.f);
    });
});

describe('document/sheets — compactSheetsSnapshot', () => {
    // The time a compaction's job is killed at, as the runner gives it to the child.
    const jobDeadline = () => Date.now() + TRANSFORM_LIMITS.compact.deadlineMs;
    const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
    const edit = (c: number, v: string): Op[] => [
        { op: 'replace', id: 'sheet-1', path: ['data', 0, c], value: { v, m: v } },
    ];
    const values = (snapshot: string) =>
        decodeSheetsWorkbook(snapshot).sheets[0].celldata?.map(({ r, c, v }) => [r, c, v?.v]);
    const formulaSheet = (id: string, order: number): Sheet => ({
        id,
        name: id,
        order,
        celldata: [{ r: 0, c: 0, v: { f: '=1+1', v: 99, m: '99' } }],
        config: {},
    });

    test('folds the batches, which cross as JSON text, into the snapshot', () => {
        const { snapshot: compacted } = compactSheetsSnapshot(
            encodeSheetsSnapshot(sheets, { computed: true }),
            JSON.stringify([edit(0, 'a'), edit(1, 'b')]),
            jobDeadline(),
        );
        expect(decodeSheetsWorkbook(compacted).computed).toBe(true);
        expect(values(compacted)).toEqual([
            [0, 0, 'a'],
            [0, 1, 'b'],
        ]);
    });

    test('an uncomputed workbook stays uncomputed, and the compaction runs no recalc', () => {
        const typed: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['data', 0, 1], value: { v: 4, f: '=2+2', m: '4' } },
        ];
        const original = { ...engine };
        let recalcs = 0;
        mock.module('@workspace/sheet/engine', () => ({
            ...original,
            recalcSheets: (...args: Parameters<typeof original.recalcSheets>) => {
                recalcs++;
                return original.recalcSheets(...args);
            },
        }));
        try {
            const { snapshot: compacted } = compactSheetsSnapshot(
                encodeSheetsSnapshot([formulaSheet('sheet-1', 0)], { computed: false }),
                JSON.stringify([typed]),
                jobDeadline(),
            );
            const { sheets: result, computed } = decodeSheetsWorkbook(compacted);
            expect(computed).toBe(false);
            expect(result[0].celldata?.[0]?.v?.v).toBe(99);
            expect(recalcs).toBe(0);
        } finally {
            mock.module('@workspace/sheet/engine', () => original);
        }
    });

    test('a computed workbook stays computed, with the values its editor wrote', () => {
        const { snapshot: compacted } = compactSheetsSnapshot(
            encodeSheetsSnapshot([formulaSheet('sheet-1', 0)], { computed: true }),
            JSON.stringify([edit(1, 'a')]),
            jobDeadline(),
        );
        const { sheets: result, computed } = decodeSheetsWorkbook(compacted);
        expect(computed).toBe(true);
        expect(result[0].celldata?.[0]?.v?.v).toBe(99);
    });

    test('a formula typed on an uncomputed workbook leaves its neighbours as stored', () => {
        const doc = new Y.Doc();
        sheetsStateMap(doc).set('snapshot', encodeSheetsSnapshot([formulaSheet('sheet-1', 0)], { computed: false }));
        const typed: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['data', 0, 1], value: { v: 4, f: '=2+2', m: '4' } },
        ];
        doc.getArray<Op[]>('ops').push([typed]);
        expect(readSheetsFromDoc(doc).sheets[0].celldata?.[0]?.v?.v).toBe(99);
        expect(readSheetsFromDoc(doc, { recalc: false }).sheets[0].celldata?.[0]?.v?.v).toBe(99);
        doc.destroy();
    });

    test('a tab or a formula the log adds leaves the flag as the compaction read it', () => {
        const batches: Op[][] = [
            [{ op: 'addSheet', id: 'sheet-2', path: [], value: formulaSheet('sheet-2', 1) }],
            [{ op: 'replace', id: 'sheet-1', path: ['data', 0, 0], value: { f: '=1+1', v: 99 } }],
        ];
        const { snapshot } = compactSheetsSnapshot(
            encodeSheetsSnapshot(sheets, { computed: true }),
            JSON.stringify(batches),
            jobDeadline(),
        );
        expect(decodeSheetsWorkbook(snapshot).computed).toBe(true);
    });

    test('a workbook with no snapshot compacts over the default sheets, computed', () => {
        const { snapshot: compacted } = compactSheetsSnapshot(null, JSON.stringify([edit(0, 'a')]), jobDeadline());
        const { sheets: result, computed } = decodeSheetsWorkbook(compacted);
        expect(computed).toBe(true);
        expect(result.map((sheet) => sheet.id)).toEqual(['sheet-1']);
        expect(values(compacted)).toEqual([[0, 0, 'a']]);
    });

    // Each of the 6,400 formulas in column A holds #REF!, so a row op recomputes it, and each is read by the 6,400
    // COUNT(A:A) in column B: 41 million links, past the server's 40 million.
    test('a batch whose recompute passes the budget fails the fold, so the log stays', () => {
        const rows = 6_400;
        const celldata = Array.from({ length: rows }, (_, r) => [
            { r, c: 0, v: { f: '=#REF!', v: '#REF!' } },
            { r, c: 1, v: { f: '=COUNT(A:A)', v: 0 } },
        ]).flat();
        const wide: Sheet = { id: 'sheet-1', name: 'Sheet1', order: 0, row: rows + 1, column: 2, celldata, config: {} };
        const deleteLast: Op[] = [
            { op: 'deleteRowCol', id: 'sheet-1', path: [], value: { type: 'row', start: rows, end: rows } },
        ];
        expect(() =>
            compactSheetsSnapshot(
                encodeSheetsSnapshot([wide], { computed: true }),
                JSON.stringify([deleteLast]),
                jobDeadline(),
            ),
        ).toThrow(engine.SkippedRecompute);
    }, 60_000);

    test('a batch past the budget after the first ends the fold, which stores the batches before it', () => {
        const rows = 6_400;
        const celldata = Array.from({ length: rows }, (_, r) => [
            { r, c: 0, v: { f: '=#REF!', v: '#REF!' } },
            { r, c: 1, v: { f: '=COUNT(A:A)', v: 0 } },
        ]).flat();
        const wide: Sheet = { id: 'sheet-1', name: 'Sheet1', order: 0, row: rows + 1, column: 2, celldata, config: {} };
        const typed: Op[] = [{ op: 'replace', id: 'sheet-1', path: ['data', rows, 0], value: { v: 'a', m: 'a' } }];
        const deleteLast: Op[] = [
            { op: 'deleteRowCol', id: 'sheet-1', path: [], value: { type: 'row', start: rows, end: rows } },
        ];
        const { snapshot, folded } = compactSheetsSnapshot(
            encodeSheetsSnapshot([wide], { computed: true }),
            JSON.stringify([typed, deleteLast, edit(0, 'b')]),
            jobDeadline(),
        );
        expect(folded).toBe(1);
        expect(values(snapshot)).toContainEqual([rows, 0, 'a']);
        expect(values(snapshot)).not.toContainEqual([0, 0, 'b']);
    }, 60_000);

    test('a batch that ends past the deadline is folded, and the next is not started', () => {
        const { snapshot, folded } = compactSheetsSnapshot(
            encodeSheetsSnapshot(sheets, { computed: true }),
            JSON.stringify([edit(0, 'a'), edit(1, 'b')]),
            Date.now(),
        );
        expect(folded).toBe(1);
        expect(values(snapshot)).toEqual([[0, 0, 'a']]);
    });

    test("a forged write of a sheet's id or name folds into a snapshot every reader opens", () => {
        const two: Sheet[] = [...sheets, { id: 'sheet-2', name: 'Sheet2', order: 1, celldata: [], config: {} }];
        const forged: Op[] = [
            { op: 'replace', id: 'sheet-2', path: ['id'], value: 'sheet-1' },
            { op: 'replace', id: 'sheet-2', path: ['name'], value: 7 },
        ];
        const { snapshot } = compactSheetsSnapshot(
            encodeSheetsSnapshot(two, { computed: true }),
            JSON.stringify([forged, edit(0, 'a')]),
            jobDeadline(),
        );
        const folded = decodeSheetsWorkbook(snapshot).sheets;
        expect(folded.map(({ id, name }) => [id, name])).toEqual([
            ['sheet-1', 'Sheet1'],
            ['sheet-2', 'Sheet2'],
        ]);
        expect(values(snapshot)).toEqual([[0, 0, 'a']]);
    });

    test('a batch the replay rejects is dropped and counted, and the others still apply', () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const poison: Op[] = [{ op: 'insertRowCol', id: 'sheet-1', path: [], value: { type: 'row', index: -1 } }];
            const { snapshot, dropped } = compactSheetsSnapshot(
                encodeSheetsSnapshot(sheets, { computed: true }),
                JSON.stringify([edit(0, 'a'), poison, edit(1, 'b'), poison]),
                jobDeadline(),
            );
            expect(values(snapshot)).toEqual([
                [0, 0, 'a'],
                [0, 1, 'b'],
            ]);
            expect(dropped).toBe(2);
            // The caller logs the count once, with the path, so the replay itself stays quiet.
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});

describe('document/sheets — a new snapshot', () => {
    test('a replacing import writes its snapshot and empties the log in one update', () => {
        const doc = new Y.Doc();
        writeSheetsSnapshot(doc, encodeSheetsSnapshot([], { computed: true }), null);
        doc.getArray<Op[]>('ops').push([[{ op: 'replace', path: ['x'], value: 1 }]]);

        let updates = 0;
        doc.on('update', () => updates++);
        const imported = encodeSheetsSnapshot([], { computed: false });
        writeSheetsSnapshot(doc, imported, null);

        expect(updates).toBe(1);
        expect(readSheetsSnapshotJson(doc)).toBe(imported);
        expect(doc.getArray('ops').length).toBe(0);
        doc.destroy();
    });
});
