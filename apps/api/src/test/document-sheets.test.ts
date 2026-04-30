import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Op, Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { readSheetsContent, writeSheetsToYjs } from '../lib/document/sheets';
import { getHome } from '../lib/home/get-home';
import { driveGet, drivePost, getTestContext } from './setup';

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

        await expect(readSheetsContent(mount, path)).rejects.toThrow('eigensheets data.db missing');
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
        const result = await readSheetsContent(mount, path);

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
        const result = await readSheetsContent(mount, path);

        expect(result).toEqual(sheets);
    });

    test('write round-trip: writeSheetsToYjs then readSheetsContent returns same sheets', async () => {
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
        const result = await readSheetsContent(mount, path);

        expect(result).toEqual(sheets);
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
        const result = await readSheetsContent(mount, path);

        expect(result[0].celldata).toEqual([{ r: 0, c: 0, v: { v: 7 } }]);
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
        const result = await readSheetsContent(mount, path);

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

        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
            const result = await readSheetsContent(mount, path);

            expect(result).toHaveLength(2);
            expect(result[1]).toEqual(newSheet);
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
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

        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
            const result = await readSheetsContent(mount, path);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('sheet-2');
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('reads doc with snapshot + insertRowCol op → snapshot returned, console.warn emitted', async () => {
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'replay-row-col' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);

        const sheets: Sheet[] = [{ id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} }];
        const batch: Op[] = [
            { op: 'insertRowCol', id: 'sheet-1', path: [], value: { type: 'row', index: 0, count: 1 } },
        ];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
            collab.doc.getArray<Op[]>('ops').push([batch]);
        });

        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { mount, path } = await home.drive.resolveFile(mountId, sheetsPath.id);
            const result = await readSheetsContent(mount, path);

            expect(result).toEqual(sheets);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/insertRowCol replay deferred/));
        } finally {
            warnSpy.mockRestore();
        }
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
        const result = await readSheetsContent(mount, path);

        expect(result).toEqual(sheets);
    });
});
