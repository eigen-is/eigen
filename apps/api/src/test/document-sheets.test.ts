import { beforeAll, describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
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
