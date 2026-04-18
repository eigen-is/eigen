import { beforeAll, describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import ExcelJS from 'exceljs';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../lib/collab/db-config';
import { loadYjsState } from '../lib/collab/yjs-loader';
import { getHome } from '../lib/home/get-home';
import { assertJson, authedRequest, driveGet, driveUpload, getTestContext } from './setup';

async function buildXlsxBuffer(
    cells: { a1: string; value: string | number | { formula: string; result?: string | number } }[],
    sheetName = 'Sheet1',
    merges: string[] = [],
): Promise<ArrayBuffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);
    for (const { a1, value } of cells) {
        worksheet.getCell(a1).value = value;
    }
    for (const range of merges) {
        worksheet.mergeCells(range);
    }
    const buffer = await workbook.xlsx.writeBuffer();
    const view = new Uint8Array(buffer);
    const out = new ArrayBuffer(view.byteLength);
    new Uint8Array(out).set(view);
    return out;
}

async function readSnapshot(ownerId: string, mountId: string, pathId: string): Promise<Sheet[]> {
    const home = await getHome(ownerId);
    const dataDbPath = await home.drive.getChildByName(mountId, pathId, 'data.db');
    if (!dataDbPath) throw new Error('data.db not found');
    const managedDb = await home.drive.openDatabase(mountId, COLLAB_DB_CONFIG, dataDbPath.id);
    const doc = new Y.Doc();
    loadYjsState(managedDb, doc);
    const snapshot = doc.getMap('state').get('snapshot');
    doc.destroy();
    if (typeof snapshot !== 'string') throw new Error('Snapshot missing');
    return JSON.parse(snapshot);
}

describe('Sheets xlsx import/convert', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    test('convert .xlsx to eigensheets replicates the workbook content', async () => {
        const buffer = await buildXlsxBuffer([
            { a1: 'A1', value: 'Name' },
            { a1: 'B1', value: 'Count' },
            { a1: 'A2', value: 'Apples' },
            { a1: 'B2', value: 42 },
        ]);
        const xlsxFile = new File([buffer], 'inventory.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            xlsxFile,
        );

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST' },
        );
        const converted = await assertJson<DrivePath>(res);
        expect(converted.type).toBe('sheets');
        expect(converted.name).toBe('inventory.eigensheets');
        expect(converted.parentId).toBe(rootId);

        const sheets = await readSnapshot(ctx.alice.user.id, mountId, converted.id);
        expect(sheets).toHaveLength(1);
        expect(sheets[0].name).toBe('Sheet1');
        const cellMap = Object.fromEntries((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v?.v]));
        expect(cellMap['0:0']).toBe('Name');
        expect(cellMap['0:1']).toBe('Count');
        expect(cellMap['1:0']).toBe('Apples');
        expect(cellMap['1:1']).toBe(42);
    });

    test('import .xlsx replaces an existing eigensheets document content', async () => {
        const initial = await buildXlsxBuffer([
            { a1: 'A1', value: 'Old' },
            { a1: 'B1', value: 1 },
        ]);
        const initialFile = new File([initial], 'initial.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            initialFile,
        );
        const convertRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST' },
        );
        const sheetsDoc = await assertJson<DrivePath>(convertRes);

        const replacement = await buildXlsxBuffer(
            [
                { a1: 'A1', value: 'New' },
                { a1: 'B1', value: 99 },
                { a1: 'A2', value: 'Row2' },
            ],
            'Replaced',
        );
        const importRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import`,
            { method: 'POST', body: replacement },
        );
        const importBody = await assertJson<{ success: boolean }>(importRes);
        expect(importBody.success).toBe(true);

        const sheets = await readSnapshot(ctx.alice.user.id, mountId, sheetsDoc.id);
        expect(sheets).toHaveLength(1);
        expect(sheets[0].name).toBe('Replaced');
        const cellMap = Object.fromEntries((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v?.v]));
        expect(cellMap['0:0']).toBe('New');
        expect(cellMap['0:1']).toBe(99);
        expect(cellMap['1:0']).toBe('Row2');
    });

    test('convert rejects non-.xlsx files', async () => {
        const textFile = new File(['not a spreadsheet'], 'notes.txt', { type: 'text/plain' });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            textFile,
        );
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST' },
        );
        expect(res.status).toBe(400);
    });

    test('convert rejects unsupported target types', async () => {
        const buffer = await buildXlsxBuffer([{ a1: 'A1', value: 'x' }]);
        const xlsxFile = new File([buffer], 'any.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            xlsxFile,
        );
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigendoc`,
            { method: 'POST' },
        );
        expect(res.status).toBe(400);
    });

    test('import rejects upload into non-sheets documents', async () => {
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            new File(['hello'], 'note.txt', { type: 'text/plain' }),
        );
        const buffer = await buildXlsxBuffer([{ a1: 'A1', value: 'x' }]);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/import`,
            { method: 'POST', body: buffer },
        );
        expect(res.status).toBe(400);
    });

    test('convert preserves merged cells with correct anchor/non-anchor shape', async () => {
        const buffer = await buildXlsxBuffer(
            [
                { a1: 'A1', value: 'Merged' },
                { a1: 'C1', value: 'Solo' },
            ],
            'Sheet1',
            ['A1:B2'],
        );
        const xlsxFile = new File([buffer], 'merged.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            xlsxFile,
        );
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST' },
        );
        const converted = await assertJson<DrivePath>(res);

        const sheets = await readSnapshot(ctx.alice.user.id, mountId, converted.id);
        expect(sheets[0].config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });

        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.mc).toEqual({ r: 0, c: 0, rs: 2, cs: 2 });
        expect(byCoord.get('0:1')?.mc).toEqual({ r: 0, c: 0 });
        expect(byCoord.get('1:0')?.mc).toEqual({ r: 0, c: 0 });
        expect(byCoord.get('1:1')?.mc).toEqual({ r: 0, c: 0 });
    });

    test('convert preserves formulas in celldata', async () => {
        const buffer = await buildXlsxBuffer([
            { a1: 'A1', value: 1 },
            { a1: 'A2', value: 2 },
            { a1: 'A3', value: 3 },
            { a1: 'A4', value: { formula: 'SUM(A1:A3)', result: 6 } },
        ]);
        const xlsxFile = new File([buffer], 'formula.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            xlsxFile,
        );
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST' },
        );
        const converted = await assertJson<DrivePath>(res);

        const sheets = await readSnapshot(ctx.alice.user.id, mountId, converted.id);
        const formulaCell = (sheets[0].celldata ?? []).find((c) => c.r === 3 && c.c === 0);
        expect(formulaCell?.v?.f).toBe('=SUM(A1:A3)');
    });

    test('import into another user document without write permission returns 403', async () => {
        const initial = await buildXlsxBuffer([{ a1: 'A1', value: 'Alice' }]);
        const initialFile = new File([initial], 'alice.xlsx', {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            initialFile,
        );
        const convertRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST' },
        );
        const sheetsDoc = await assertJson<DrivePath>(convertRes);

        const replacement = await buildXlsxBuffer([{ a1: 'A1', value: 'Bob was here' }]);
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import`,
            { method: 'POST', body: replacement },
        );
        expect(res.status).toBe(403);
    });
});
