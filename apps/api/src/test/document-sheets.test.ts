import { beforeAll, describe, expect, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { sheetsNeedRecalc } from '@workspace/sheet/engine';
import ExcelJS from 'exceljs';
import * as Y from 'yjs';
import { readSheetsFromDoc, writeSheetsSnapshotToYjs, writeSheetsToYjs } from '../lib/document/sheets';
import { getHome } from '../lib/home/get-home';
import { importIntoDocument } from '../lib/import/import-document';
import type { Mount } from '../lib/mount';
import { readPersistedDoc } from './fixtures/transform-results';
import { driveGet, drivePost, getTestContext } from './setup';

// Persisted workbook → Sheet[] plus whether recalc fell back, the way every reader
// gets one now.
async function readSheets(mount: Mount, path: DrivePath): Promise<{ sheets: Sheet[]; recalcError: string | null }> {
    const doc = await readPersistedDoc(mount, path);
    const result = readSheetsFromDoc(doc);
    doc.destroy();
    return result;
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

    test('reads doc with neither snapshot nor ops → returns empty Sheet[]', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'empty-doc' },
        );

        const home = await getHome(ctx.alice.user.id);
        // Materialise the data.db without writing any snapshot or ops
        await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result).toEqual([]);
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
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result).toEqual(sheets);
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

        writeSheetsToYjs(collab.doc, sheets);

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result).toEqual(sheets);
    });

    test('writeSheetsSnapshotToYjs commits pre-serialized JSON and clears the ops array', async () => {
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
        writeSheetsSnapshotToYjs(collab.doc, JSON.stringify(sheets));

        expect(collab.doc.getArray('ops').length).toBe(0);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        expect((await readSheets(mount, path)).sheets).toEqual(sheets);

        const viaSheets = new Y.Doc();
        writeSheetsToYjs(viaSheets, sheets);
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
        writeSheetsToYjs(collab.doc, sheets);

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
        const batch: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['celldata'], value: [{ r: 0, c: 0, v: { v: 7 } }] },
        ];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].celldata).toEqual([{ r: 0, c: 0, v: { v: 7 } }]);
    });

    test('reads doc with pending ops but no snapshot → replays over the default sheets', async () => {
        // A fresh doc whose tab was killed before the first flushSnapshot has
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
        const batch1: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['celldata'], value: [{ r: 0, c: 0, v: { v: 1 } }] },
        ];
        const batch2: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['celldata'], value: [{ r: 0, c: 0, v: { v: 2 } }] },
        ];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
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
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result, recalcError } = await readSheets(mount, path);

        expect(result).toHaveLength(2);
        expect(result[1]).toEqual(newSheet);
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
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
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
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
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
        // Reproduces the user-reported export crash: xlsxToSheets / pre-flush
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
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
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
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].data!.length).toBe(2);
        expect(result[0].data![1][0]?.v).toBe('a');
    });

    test('gate ON: formula cells without a calcChain get engine-computed v/m on read', async () => {
        // Simulates an xlsx-imported-never-opened doc: celldata carries formula
        // text with no cached value and no calcChain. The read must run
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
        writeSheetsToYjs(collab.doc, sheets);

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result[0].data![0][1]?.v).toBe(6);
        expect(result[0].data![0][1]?.m).toBe('6');
        // fa-masked formula cell derives m via the cell's format mask
        expect(result[0].data![0][2]?.v).toBe(1.25);
        expect(result[0].data![0][2]?.m).toBe('1.25');
    });

    test('gate OFF: a doc carrying a calcChain keeps its stored values (no recompute)', async () => {
        // Editor-flushed / import-recalced docs carry calcChain. Even a
        // deliberately-wrong cached value must survive untouched — the gate must
        // not recompute.
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
                calcChain: [{ r: 0, c: 1, id: 'sheet-1' }],
            },
        ] as unknown as Sheet[];
        writeSheetsToYjs(collab.doc, sheets);

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        const b1 = result[0].celldata?.find((e) => e.r === 0 && e.c === 1);
        expect(b1?.v?.v).toBe(999);
    });

    test('xlsx import e2e: formula-only cells get engine-computed v/m persisted; volatile stays empty', async () => {
        // Generator-blank case: exceljs writes formula-only cells (no cached
        // result) when `result` is omitted. Driven through the real import seam
        // (importIntoDocument — the same call routes/drive.ts's /import makes),
        // so this covers xlsxToSheets → recalcSheets → writeSheetsToYjs end to end.
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Sheet1');
        worksheet.getCell('A1').value = 10;
        worksheet.getCell('A2').value = 32;
        worksheet.getCell('B1').value = { formula: 'A1+A2' };
        worksheet.getCell('B2').value = { formula: 'SUM(A1:A2)*2' };
        worksheet.getCell('C1').value = { formula: 'NOW()' };
        const buffer = Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer()));

        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'recalc-import-e2e' },
        );

        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        await importIntoDocument(home.drive, mount, path, buffer, home.user);

        const { sheets: result } = await readSheets(mount, path);

        const cellAt = (r: number, c: number) => result[0].celldata?.find((e) => e.r === r && e.c === c)?.v;
        expect(cellAt(0, 1)?.f).toBe('=A1+A2');
        expect(cellAt(0, 1)?.v).toBe(42);
        expect(cellAt(0, 1)?.m).toBe('42');
        expect(cellAt(1, 1)?.f).toBe('=SUM(A1:A2)*2');
        expect(cellAt(1, 1)?.v).toBe(84);
        expect(cellAt(1, 1)?.m).toBe('84');

        // The import-time recalc stamped a calcChain, so the read gate sees the
        // doc as computed and won't recompute on every read.
        expect(sheetsNeedRecalc(result)).toBe(false);
        const calcChain = (result[0] as Sheet & { calcChain?: { r: number; c: number; id: string }[] }).calcChain;
        expect(calcChain?.length).toBe(3);

        // Volatile freeze, pinned: the xlsx carried no cached NOW() result, so
        // there is nothing to freeze — the cell keeps its formula but stays
        // without v/m until a client editor computes and flushes it.
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
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const { sheets: result } = await readSheets(mount, path);

        expect(result).toEqual(sheets);
    });
});
