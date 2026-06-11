import { beforeAll, describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import ExcelJS from 'exceljs';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../lib/collab/db-config';
import * as collabSchema from '../lib/collab/schema';
import { loadYjsState } from '../lib/collab/yjs-loader';
import { getHome } from '../lib/home/get-home';
import { xlsxToSheets } from '../lib/import/sheets/from-xlsx';
import { assertJson, authedRequest, driveGet, driveUpload, getTestContext } from './setup';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// exceljs's writeBuffer returns a Buffer view over a larger ArrayBuffer; copy into a
// standalone ArrayBuffer so it can back a File body byte-exactly.
async function workbookToBuffer(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
    const buffer = await workbook.xlsx.writeBuffer();
    const view = new Uint8Array(buffer);
    const out = new ArrayBuffer(view.byteLength);
    new Uint8Array(out).set(view);
    return out;
}

async function buildXlsxBuffer(
    cells: {
        a1: string;
        value: string | number | { formula: string; result?: string | number };
        fontSize?: number;
        border?: Partial<ExcelJS.Borders>;
        dataValidation?: ExcelJS.DataValidation;
    }[],
    sheetName = 'Sheet1',
    merges: string[] = [],
    columnWidths?: { col: number; width: number }[],
): Promise<ArrayBuffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(sheetName);
    for (const { a1, value, fontSize, border, dataValidation } of cells) {
        const cell = worksheet.getCell(a1);
        cell.value = value;
        if (fontSize) cell.font = { size: fontSize };
        if (border) cell.border = border;
        if (dataValidation) cell.dataValidation = dataValidation;
    }
    for (const range of merges) {
        worksheet.mergeCells(range);
    }
    if (columnWidths) {
        for (const { col, width } of columnWidths) {
            worksheet.getColumn(col).width = width;
        }
    }
    return workbookToBuffer(workbook);
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

    async function uploadAndConvert(buffer: ArrayBuffer, filename: string): Promise<DrivePath> {
        const xlsxFile = new File([buffer], filename, { type: XLSX_MIME });
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
        return assertJson<DrivePath>(res);
    }

    async function convertBuffer(buffer: ArrayBuffer, filename: string): Promise<Sheet[]> {
        const converted = await uploadAndConvert(buffer, filename);
        return readSnapshot(ctx.alice.user.id, mountId, converted.id);
    }

    async function convertWorkbook(workbook: ExcelJS.Workbook, filename: string): Promise<Sheet[]> {
        return convertBuffer(await workbookToBuffer(workbook), filename);
    }

    test('convert .xlsx to eigensheets replicates the workbook content', async () => {
        const buffer = await buildXlsxBuffer([
            { a1: 'A1', value: 'Name' },
            { a1: 'B1', value: 'Count' },
            { a1: 'A2', value: 'Apples' },
            { a1: 'B2', value: 42 },
        ]);
        const converted = await uploadAndConvert(buffer, 'inventory.xlsx');
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
        const sheetsDoc = await uploadAndConvert(initial, 'initial.xlsx');

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
        const xlsxFile = new File([buffer], 'any.xlsx', { type: XLSX_MIME });
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
        const sheets = await convertBuffer(buffer, 'merged.xlsx');
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
        const sheets = await convertBuffer(buffer, 'formula.xlsx');
        const formulaCell = (sheets[0].celldata ?? []).find((c) => c.r === 3 && c.c === 0);
        expect(formulaCell?.v?.f).toBe('=SUM(A1:A3)');
    });

    test('convert renders custom date number formats via numfmt, not literal format tokens', async () => {
        // Excel date formats use lowercase month tokens (m/mm/mmm) and "…" literal-text escapes.
        // The old hand-rolled formatter leaked both — e.g. d"-"m rendered as 15"-"m, mm/dd/yyyy as
        // 00/15/2024 (lowercase mm collided with minutes). Render through numfmt instead so the
        // import display matches what the engine shows live.
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Dates');
        const date = new Date(Date.UTC(2024, 2, 15)); // 2024-03-15 → Excel serial 45366
        for (const [a1, numFmt] of [
            ['A1', 'd"-"m'],
            ['A2', 'd"-"mmm'],
            ['A3', 'mm/dd/yyyy'],
        ] as const) {
            const cell = ws.getCell(a1);
            cell.value = date;
            cell.numFmt = numFmt;
        }
        const sheets = await convertWorkbook(workbook, 'dates.xlsx');
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));

        // Serial value and raw format string are preserved; only the cached display was wrong.
        expect(byCoord.get('0:0')?.v).toBe(45366);
        expect(byCoord.get('0:0')?.ct).toEqual({ fa: 'd"-"m', t: 'd' });

        expect(byCoord.get('0:0')?.m).toBe('15-3');
        expect(byCoord.get('1:0')?.m).toBe('15-Mar');
        expect(byCoord.get('2:0')?.m).toBe('03/15/2024');
    });

    test('convert renders numeric display strings through numfmt, not raw floats', async () => {
        // extractValueAndDisplay used to cache m = String(raw) for numbers, so a cell formatted
        // as "€"#,##0.00 showed the raw float in the grid while ct.fa held the format — until
        // the cell was touched. Numbers must render through the engine's numfmt like dates do.
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Numbers');
        for (const [a1, value, numFmt] of [
            ['A1', 14207.82, '#,##0'],
            ['A2', 0.4072175408, '0.00%'],
            ['A3', 90, '[$€]#,##0'],
            ['A4', 1, '0.0'],
            ['A5', 495083.6, '"€"#,##0.00'],
            ['A6', 145.2, '_-"€" * #,##0.00_-;_-"€" * #,##0.00-;_-"€" * "-"??_-;_-@'],
        ] as const) {
            const cell = ws.getCell(a1);
            cell.value = value;
            cell.numFmt = numFmt;
        }
        ws.getCell('B1').value = 100.5; // General/missing format stays the raw string
        const text = ws.getCell('C1');
        text.value = 'hello';
        text.numFmt = '"€"#,##0.00'; // a string cell with a currency numFmt stays the string
        const formula = ws.getCell('D1');
        formula.value = { formula: 'A3*2', result: 90 };
        formula.numFmt = '[$€]#,##0';
        const sheets = await convertWorkbook(workbook, 'numbers.xlsx');
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));

        // Raw value and format are preserved; only the cached display changes.
        expect(byCoord.get('0:0')?.v).toBe(14207.82);
        expect(byCoord.get('0:0')?.ct).toEqual({ fa: '#,##0', t: 'n' });

        expect(byCoord.get('0:0')?.m).toBe('14,208');
        expect(byCoord.get('1:0')?.m).toBe('40.72%');
        expect(byCoord.get('2:0')?.m).toBe('€90');
        expect(byCoord.get('3:0')?.m).toBe('1.0');
        expect(byCoord.get('4:0')?.m).toBe('€495,083.60');
        // numfmt expands the accounting format's `*` fill char to one padding space per side.
        expect(byCoord.get('5:0')?.m).toBe(' € 145.20 ');

        expect(byCoord.get('0:1')?.m).toBe('100.5');
        expect(byCoord.get('0:2')?.m).toBe('hello');

        expect(byCoord.get('0:3')?.f).toBe('=A3*2');
        expect(byCoord.get('0:3')?.m).toBe('€90');
    });

    test('large sheet import stores a zstd-compressed blob and reads back intact', async () => {
        const cells = Array.from({ length: 300 }, (_, i) => ({ a1: `A${i + 1}`, value: `value-${i}` }));
        const buffer = await buildXlsxBuffer(cells);
        const converted = await uploadAndConvert(buffer, 'large.xlsx');

        // Write path: at least one stored blob (update or snapshot) must be a zstd frame.
        const home = await getHome(ctx.alice.user.id);
        const dataDbPath = await home.drive.getChildByName(mountId, converted.id, 'data.db');
        if (!dataDbPath) throw new Error('data.db not found');
        const managedDb = await home.drive.openDatabase(mountId, COLLAB_DB_CONFIG, dataDbPath.id);
        const updateBlobs = managedDb.db
            .select()
            .from(collabSchema.docUpdates)
            .all()
            .map((r) => r.updateData as Uint8Array);
        const snapshotBlobs = managedDb.db
            .select()
            .from(collabSchema.docSnapshots)
            .all()
            .map((r) => r.stateData as Uint8Array);
        const allBlobs = [...updateBlobs, ...snapshotBlobs];
        expect(allBlobs.length).toBeGreaterThan(0);
        const anyZstd = allBlobs.some(
            (b) => b.byteLength >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd,
        );
        expect(anyZstd).toBe(true);

        // Read path: content round-trips through decompression.
        const sheets = await readSnapshot(ctx.alice.user.id, mountId, converted.id);
        const cellMap = Object.fromEntries((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v?.v]));
        expect(cellMap['0:0']).toBe('value-0');
        expect(cellMap['299:0']).toBe('value-299');
    });

    test('import with a non-xlsx body returns 400, not 500', async () => {
        // Create a target sheet to import into
        const buffer = await buildXlsxBuffer([{ a1: 'A1', value: 'seed' }]);
        const sheetsDoc = await uploadAndConvert(buffer, 'target.xlsx');

        const notXlsx = new TextEncoder().encode('this is not a valid xlsx file');
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import`,
            { method: 'POST', body: notXlsx },
        );
        expect(res.status).toBe(400);
    });

    test('convert scales column widths from character units to pixels', async () => {
        const buffer = await buildXlsxBuffer([{ a1: 'A1', value: 'wide' }], 'Sheet1', [], [{ col: 1, width: 15 }]);
        const sheets = await convertBuffer(buffer, 'colwidth.xlsx');
        expect(sheets[0].config?.columnlen?.['0']).toBe(Math.round(15 * 8));
    });

    test('convert preserves font sizes in points', async () => {
        const buffer = await buildXlsxBuffer([
            { a1: 'A1', value: 'big', fontSize: 24 },
            { a1: 'B1', value: 'small', fontSize: 8 },
            { a1: 'C1', value: 'default' },
        ]);
        const sheets = await convertBuffer(buffer, 'fontsizes.xlsx');
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.fs).toBe(24);
        expect(byCoord.get('0:1')?.fs).toBe(8);
        expect(byCoord.get('0:2')?.fs).toBeUndefined();
    });

    test('convert imports cell borders', async () => {
        const thinBorder = { style: 'thin' as const, color: { argb: 'FF000000' } };
        const buffer = await buildXlsxBuffer([
            {
                a1: 'A1',
                value: 'bordered',
                border: { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder },
            },
            { a1: 'B1', value: 'no border' },
        ]);
        const sheets = await convertBuffer(buffer, 'borders.xlsx');
        const bi = sheets[0].config?.borderInfo;
        expect(bi).toBeDefined();
        const a1Border = bi?.find((b) => b.rangeType === 'cell' && b.value.row_index === 0 && b.value.col_index === 0);
        expect(a1Border).toBeDefined();
        if (a1Border?.rangeType !== 'cell') throw new Error('expected cell-rangeType BorderInfo');
        expect(a1Border.value.l).toEqual({ style: 1, color: '#000000' });
        expect(a1Border.value.r).toEqual({ style: 1, color: '#000000' });
        expect(a1Border.value.t).toEqual({ style: 1, color: '#000000' });
        expect(a1Border.value.b).toEqual({ style: 1, color: '#000000' });
        expect(
            bi?.find((b) => b.rangeType === 'cell' && b.value.row_index === 0 && b.value.col_index === 1),
        ).toBeUndefined();
    });

    test('convert right-aligns numbers without explicit alignment', async () => {
        const buffer = await buildXlsxBuffer([
            { a1: 'A1', value: 'text' },
            { a1: 'B1', value: 42 },
        ]);
        const sheets = await convertBuffer(buffer, 'align.xlsx');
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.ht).toBeUndefined();
        expect(byCoord.get('0:1')?.ht).toBe(2);
    });

    test('convert resolves ARGB colors for font and fill and skips pattern none', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Themed');
        const cell = ws.getCell('A1');
        cell.value = 'Hello';
        cell.font = { bold: true, color: { argb: 'FFFF0000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0000FF' } };
        const cell2 = ws.getCell('B1');
        cell2.value = 'World';
        cell2.fill = { type: 'pattern', pattern: 'none' };
        const sheets = await convertWorkbook(workbook, 'themed.xlsx');
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.fc).toBe('#FF0000');
        expect(byCoord.get('0:0')?.bg).toBe('#0000FF');
        expect(byCoord.get('0:1')?.bg).toBeUndefined();
    });

    test('convert preserves text rotation and font family', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Styled');
        ws.getCell('A1').value = '45-up';
        ws.getCell('A1').alignment = { textRotation: 45 };
        ws.getCell('A2').value = '90-up';
        ws.getCell('A2').alignment = { textRotation: 90 };
        ws.getCell('A3').value = '45-down';
        ws.getCell('A3').alignment = { textRotation: -45 };
        ws.getCell('A4').value = '90-down';
        ws.getCell('A4').alignment = { textRotation: -90 };
        ws.getCell('A5').value = 'vertical';
        ws.getCell('A5').alignment = { textRotation: 'vertical' };
        ws.getCell('B1').value = 'georgia';
        ws.getCell('B1').font = { name: 'Georgia' };
        const sheets = await convertWorkbook(workbook, 'styled.xlsx');
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.rt).toBe(45);
        expect(byCoord.get('1:0')?.rt).toBe(90);
        expect(byCoord.get('2:0')?.rt).toBe(-45);
        expect(byCoord.get('3:0')?.rt).toBe(-90);
        expect(byCoord.get('4:0')?.rt).toBe('vertical');
        // Georgia is a serif font → mapped to the bundled Source Serif 4. See FONT_MAP
        // in apps/api/src/lib/import/sheets/from-xlsx.ts; only the four supported faces
        // ship as embedded webfonts, so unsupported families collapse to the closest one.
        expect(byCoord.get('0:1')?.ff).toBe('Source Serif 4');
    });

    test('convert maps common xlsx fonts into the four supported families', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Fonts');
        ws.getCell('A1').value = 'sans';
        ws.getCell('A1').font = { name: 'Calibri' };
        ws.getCell('A2').value = 'serif';
        ws.getCell('A2').font = { name: 'Times New Roman' };
        ws.getCell('A3').value = 'mono';
        ws.getCell('A3').font = { name: 'Courier New' };
        ws.getCell('A4').value = 'unknown';
        ws.getCell('A4').font = { name: 'Wingdings' };
        ws.getCell('A5').value = 'native';
        ws.getCell('A5').font = { name: 'Inter' };
        const sheets = await convertWorkbook(workbook, 'fonts.xlsx');
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.ff).toBe('Inter');
        expect(byCoord.get('1:0')?.ff).toBe('Source Serif 4');
        expect(byCoord.get('2:0')?.ff).toBe('JetBrains Mono');
        // Unrecognized → no ff (falls back to body default, which is Inter).
        expect(byCoord.get('3:0')?.ff).toBeUndefined();
        expect(byCoord.get('4:0')?.ff).toBe('Inter');
    });

    test('convert handles multi-sheet workbooks', async () => {
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet('Sheet A').getCell('A1').value = 'Alpha';
        workbook.addWorksheet('Sheet B').getCell('A1').value = 'Beta';
        workbook.addWorksheet('Sheet C').getCell('A1').value = 'Gamma';
        const sheets = await convertWorkbook(workbook, 'multi.xlsx');
        expect(sheets).toHaveLength(3);
        expect(sheets[0].name).toBe('Sheet A');
        expect(sheets[1].name).toBe('Sheet B');
        expect(sheets[2].name).toBe('Sheet C');
        const getVal = (s: Sheet) => (s.celldata ?? []).find((c) => c.r === 0 && c.c === 0)?.v?.v;
        expect(getVal(sheets[0])).toBe('Alpha');
        expect(getVal(sheets[1])).toBe('Beta');
        expect(getVal(sheets[2])).toBe('Gamma');
    });

    test('convert handles hyperlinks whose .text is a rich-text wrapper', async () => {
        // Google Sheets-exported xlsx files emit hyperlinks where the .text is a CellRichTextValue
        // rather than a plain string — exceljs's types claim string but the runtime allows both.
        // Combined with wrapText=true, this used to crash the auto-fit-height path in
        // from-xlsx.ts (`text.split('\n')` on an object).
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Links');
        const cell = ws.getCell('A1');
        cell.value = {
            text: { richText: [{ text: 'GSV Assets\n' }, { text: 'Canva' }] },
            hyperlink: 'https://example.com',
        } as unknown as ExcelJS.CellHyperlinkValue;
        cell.alignment = { wrapText: true };
        const sheets = await convertWorkbook(workbook, 'richlinks.xlsx');
        const a1 = (sheets[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0);
        expect(a1?.v?.v).toBe('GSV Assets\nCanva');
    });

    test('convert imports hidden columns from col min/max ranges', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Hidden');
        ws.getCell('A1').value = 'visible';
        ws.getCell('E1').value = 'after';
        // Adjacent hidden columns C+D serialize as one <col min="3" max="4" hidden="1">
        // range element; exceljs expands ranges back to per-column flags on read.
        ws.getColumn(3).hidden = true;
        ws.getColumn(4).hidden = true;
        const sheets = await convertWorkbook(workbook, 'hiddencols.xlsx');
        expect(sheets[0].config?.colhidden).toEqual({ '2': 0, '3': 0 });
        expect(sheets[0].config?.rowhidden).toBeUndefined();
    });

    test('convert imports hidden rows including style-only hidden rows', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Hidden');
        ws.getCell('A1').value = 'top';
        ws.getCell('A2').value = 'hidden with data';
        ws.getRow(2).hidden = true;
        // Row 5 is hidden but carries no cell values, so eachRow({includeEmpty:false})
        // skips it. Excel writes bare <row r="5" hidden="1"/> elements for such rows;
        // exceljs's writer only keeps a valueless row when it has a height, so set one
        // to make the fixture round-trip the same shape.
        ws.getRow(5).hidden = true;
        ws.getRow(5).height = 15;
        ws.getCell('A7').value = 'bottom';
        const sheets = await convertWorkbook(workbook, 'hiddenrows.xlsx');
        expect(sheets[0].config?.rowhidden).toEqual({ '1': 0, '4': 0 });
        expect(sheets[0].config?.colhidden).toBeUndefined();
    });

    test('convert maps frozen panes onto sheet.frozen', async () => {
        const workbook = new ExcelJS.Workbook();
        const rowOnly = workbook.addWorksheet('RowOnly');
        rowOnly.getCell('A1').value = 'header';
        rowOnly.views = [{ state: 'frozen', ySplit: 1 }];
        const colOnly = workbook.addWorksheet('ColOnly');
        colOnly.getCell('A1').value = 'label';
        colOnly.views = [{ state: 'frozen', xSplit: 1 }];
        const both = workbook.addWorksheet('Both');
        both.getCell('A1').value = 'corner';
        both.views = [{ state: 'frozen', xSplit: 3, ySplit: 2 }];
        const plain = workbook.addWorksheet('Plain');
        plain.getCell('A1').value = 'free';
        const sheets = await convertWorkbook(workbook, 'frozen.xlsx');

        // Excel semantics: ySplit=N freezes the top N rows, xSplit=M the left M columns.
        // Engine range carries the 0-based index of the LAST frozen row/col.
        expect(sheets[0].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } });
        expect(sheets[1].frozen).toEqual({ type: 'rangeColumn', range: { row_focus: 0, column_focus: 0 } });
        expect(sheets[2].frozen).toEqual({ type: 'rangeBoth', range: { row_focus: 1, column_focus: 2 } });
        expect(sheets[3].frozen).toBeUndefined();
    });

    test('convert imports the autofilter range onto sheet.filterRange', async () => {
        const workbook = new ExcelJS.Workbook();
        const filtered = workbook.addWorksheet('Filtered');
        filtered.getCell('B2').value = 'Name';
        filtered.getCell('C2').value = 'Count';
        filtered.getCell('D2').value = 'Notes';
        filtered.getCell('B3').value = 'Apples';
        filtered.getCell('B4').value = 'Bananas';
        filtered.autoFilter = 'B2:D10';
        // Excel autofilter sheets routinely also carry hidden rows (a previously
        // applied criterion hides non-matching rows); both must import together.
        filtered.getRow(4).hidden = true;
        const plain = workbook.addWorksheet('Plain');
        plain.getCell('A1').value = 'free';
        const sheets = await convertWorkbook(workbook, 'autofilter.xlsx');

        expect(sheets[0].filterRange).toEqual({ row: [1, 9], column: [1, 3] });
        // No <filterColumn> criteria → no per-column entries. A fresh filter enable in
        // the editor writes only filterRange too (state/modules/filter.ts createFilter);
        // per-column `filter` entries appear only once a criterion is set.
        expect('filter' in sheets[0]).toBe(false);
        expect(sheets[0].config?.rowhidden).toEqual({ '3': 0 });
        expect(sheets[1].filterRange).toBeUndefined();
    });

    test('convert imports cellIs rules with resolved dxf colors and percent-string coercion', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('CF');
        ws.getCell('B1').value = 5;
        ws.getCell('B2').value = 12;
        ws.addConditionalFormatting({
            ref: 'B1:B5',
            rules: [
                {
                    type: 'cellIs',
                    operator: 'greaterThan',
                    formulae: [10],
                    priority: 1,
                    style: {
                        font: { color: { argb: 'FFFFFFFF' } },
                        fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFF0000' } },
                    },
                },
                // Google Sheets exports serialize numeric thresholds as quoted percent
                // strings; the importer must coerce them to the numeric form the engine
                // compares against. Also covers an operator beyond exceljs's typed four.
                {
                    type: 'cellIs',
                    operator: 'lessThanOrEqual',
                    formulae: ['"5%"'],
                    priority: 2,
                    style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF00FF00' } } },
                } as unknown as ExcelJS.ConditionalFormattingRule,
            ],
        });
        const plain = workbook.addWorksheet('Plain');
        plain.getCell('A1').value = 'free';
        const sheets = await convertWorkbook(workbook, 'cellis.xlsx');

        // Priority DESC order: priority 2 first, priority 1 last (last write wins in the engine).
        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [1, 1] }],
                format: { textColor: null, cellColor: '#00FF00' },
                conditionName: 'lessThanOrEqual',
                conditionRange: [],
                conditionValue: ['0.05'],
            },
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [1, 1] }],
                format: { textColor: '#FFFFFF', cellColor: '#FF0000' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['10'],
            },
        ]);
        expect(sheets[1].conditionalFormatRules).toBeUndefined();
    });

    test('convert imports cellIs between rules with both bounds', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Between');
        ws.getCell('A1').value = 3;
        ws.addConditionalFormatting({
            ref: 'A1:A4',
            rules: [
                {
                    type: 'cellIs',
                    operator: 'between',
                    formulae: [2, 5],
                    priority: 1,
                    style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF112233' } } },
                },
            ],
        });
        const sheets = await convertWorkbook(workbook, 'between.xlsx');

        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [0, 3], column: [0, 0] }],
                format: { textColor: null, cellColor: '#112233' },
                conditionName: 'between',
                conditionRange: [],
                conditionValue: ['2', '5'],
            },
        ]);
    });

    test('convert imports expression rules anchored at the first range and shifted per sub-range', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Expr');
        ws.getCell('B2').value = 'longtext';
        ws.getCell('D2').value = 'x';
        ws.addConditionalFormatting({
            ref: 'B2:B4 D2:D4',
            rules: [
                {
                    type: 'expression',
                    formulae: ['LEN(B2)>2'],
                    priority: 1,
                    style: { font: { color: { argb: 'FF0000FF' } } },
                },
            ],
        });
        const sheets = await convertWorkbook(workbook, 'expression.xlsx');

        // Excel anchors the formula's relative refs at the top-left of the FIRST sqref
        // range; the engine re-anchors per cellrange entry, so the importer emits one
        // rule per sub-range with the formula pre-shifted (D2 range → LEN(D2)).
        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [1, 3], column: [1, 1] }],
                format: { textColor: '#0000FF', cellColor: null },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=LEN(B2)>2'],
            },
            {
                type: 'default',
                cellrange: [{ row: [1, 3], column: [3, 3] }],
                format: { textColor: '#0000FF', cellColor: null },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=LEN(D2)>2'],
            },
        ]);
    });

    test('convert maps colorScale rules onto colorGradation with engine stop order', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Scale');
        ws.getCell('C1').value = 1;
        ws.getCell('C2').value = 5;
        ws.getCell('C3').value = 9;
        ws.addConditionalFormatting({
            ref: 'C1:C3',
            rules: [
                {
                    type: 'colorScale',
                    cfvo: [{ type: 'min' }, { type: 'max' }],
                    color: [{ argb: 'FFFFFFFF' }, { argb: 'FFFF0000' }],
                    priority: 1,
                },
            ],
        });
        const sheets = await convertWorkbook(workbook, 'colorscale.xlsx');

        // exceljs lists stops min→max; the engine's colorGradation format is max→min.
        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'colorGradation',
                cellrange: [{ row: [0, 2], column: [2, 2] }],
                format: ['#FF0000', '#FFFFFF'],
            },
        ]);
    });

    test('convert imports multi-range refs as multiple cellrange entries', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Multi');
        ws.getCell('A1').value = 1;
        ws.addConditionalFormatting({
            ref: 'A1:A2 C1:C2 E5',
            rules: [
                {
                    type: 'cellIs',
                    operator: 'lessThan',
                    formulae: [0],
                    priority: 1,
                    style: { font: { color: { argb: 'FFAA0000' } } },
                },
            ],
        });
        const sheets = await convertWorkbook(workbook, 'multirange.xlsx');

        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [
                    { row: [0, 1], column: [0, 0] },
                    { row: [0, 1], column: [2, 2] },
                    { row: [4, 4], column: [4, 4] },
                ],
                format: { textColor: '#AA0000', cellColor: null },
                conditionName: 'lessThan',
                conditionRange: [],
                conditionValue: ['0'],
            },
        ]);
    });

    test('convert orders overlapping rules so the lowest Excel priority number wins', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Prio');
        ws.getCell('A1').value = 100;
        ws.addConditionalFormatting({
            ref: 'A1:A5',
            rules: [
                {
                    type: 'cellIs',
                    operator: 'greaterThan',
                    formulae: [0],
                    priority: 2,
                    style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FF00FF00' } } },
                },
                {
                    type: 'cellIs',
                    operator: 'greaterThan',
                    formulae: [50],
                    priority: 1,
                    style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFF0000' } } },
                },
            ],
        });
        const sheets = await convertWorkbook(workbook, 'priority.xlsx');

        // Excel: lowest priority number wins conflicting properties. The engine applies
        // rules in array order with last-write-wins per property, so the importer emits
        // priority DESCENDING — the priority-1 (red) rule must come last.
        const rules = sheets[0].conditionalFormatRules ?? [];
        expect(rules).toHaveLength(2);
        expect(rules[0]).toMatchObject({ format: { cellColor: '#00FF00' }, conditionValue: ['0'] });
        expect(rules[1]).toMatchObject({ format: { cellColor: '#FF0000' }, conditionValue: ['50'] });
    });

    test('convert skips iconSet rules but keeps supported rules from the same sheet', async () => {
        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Icons');
        ws.getCell('A1').value = 1;
        ws.addConditionalFormatting({
            ref: 'A1:A3',
            rules: [
                {
                    type: 'iconSet',
                    iconSet: '3TrafficLights1',
                    cfvo: [
                        { type: 'percent', value: 0 },
                        { type: 'percent', value: 33 },
                        { type: 'percent', value: 67 },
                    ],
                    priority: 1,
                },
                {
                    type: 'cellIs',
                    operator: 'equal',
                    formulae: [1],
                    priority: 2,
                    style: { font: { color: { argb: 'FF00AA00' } } },
                },
            ],
        });
        const onlyIcons = workbook.addWorksheet('OnlyIcons');
        onlyIcons.getCell('A1').value = 2;
        onlyIcons.addConditionalFormatting({
            ref: 'A1:A3',
            rules: [
                {
                    type: 'iconSet',
                    iconSet: '3Arrows',
                    cfvo: [
                        { type: 'percent', value: 0 },
                        { type: 'percent', value: 33 },
                        { type: 'percent', value: 67 },
                    ],
                    priority: 1,
                },
            ],
        });
        const sheets = await convertWorkbook(workbook, 'iconset.xlsx');

        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [0, 2], column: [0, 0] }],
                format: { textColor: '#00AA00', cellColor: null },
                conditionName: 'equal',
                conditionRange: [],
                conditionValue: ['1'],
            },
        ]);
        expect(sheets[1].conditionalFormatRules).toBeUndefined();
    });

    test('convert imports literal-list data validations as one dropdown rule per cell', async () => {
        const listRule: ExcelJS.DataValidation = { type: 'list', allowBlank: true, formulae: ['"Red,Green,Blue"'] };
        const buffer = await buildXlsxBuffer([
            { a1: 'A1', value: 'plain' },
            { a1: 'B2', value: 'Red', dataValidation: listRule },
            { a1: 'B3', value: 'Green', dataValidation: listRule },
            { a1: 'B4', value: '', dataValidation: listRule },
        ]);
        const sheets = await convertBuffer(buffer, 'dv-list.xlsx');

        // sqref ranges arrive pre-expanded to per-cell keys; value1 holds the literal
        // with the outer quotes stripped; type2 '' is the dialog's single-select value.
        const expected = {
            type: 'dropdown',
            type2: '',
            value1: 'Red,Green,Blue',
            value2: '',
            checked: false,
            prohibitInput: false,
            hintShow: false,
            hintValue: '',
        };
        expect(sheets[0].dataVerification).toEqual({ '1_1': expected, '2_1': expected, '3_1': expected });
    });

    test('convert clones the shared exceljs validation object per cell key', async () => {
        // exceljs expands a sqref range to per-cell model entries that all alias ONE
        // rule object; the engine mutates rules in place (checkboxChange), so the
        // converter must emit a fresh object per key. JSON snapshot round-trips would
        // mask aliasing — assert on the converter output directly.
        const listRule: ExcelJS.DataValidation = { type: 'list', allowBlank: true, formulae: ['"A,B"'] };
        const buffer = await buildXlsxBuffer([
            { a1: 'B2', value: 'A', dataValidation: listRule },
            { a1: 'B3', value: 'B', dataValidation: listRule },
        ]);
        const sheets = await xlsxToSheets(Buffer.from(buffer));
        const rules = sheets[0].dataVerification;
        if (!rules) throw new Error('expected dataVerification rules');
        expect(rules['1_1']).toEqual(rules['2_1']);
        expect(rules['1_1']).not.toBe(rules['2_1']);
    });

    test('convert keeps range-ref list sources verbatim for live cross-sheet resolution', async () => {
        const workbook = new ExcelJS.Workbook();
        const main = workbook.addWorksheet('Main');
        main.getCell('C1').value = 'pick';
        main.getCell('C1').dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: ["'Other Sheet'!$B$1:$B$5"],
        };
        const other = workbook.addWorksheet('Other Sheet');
        for (let i = 1; i <= 5; i++) other.getCell(`B${i}`).value = `Option ${i}`;
        const sheets = await convertWorkbook(workbook, 'dv-ref.xlsx');

        // The engine's getDropdownList resolves range refs (incl. quoted sheet names)
        // live, so source edits propagate — don't inline the values at import.
        expect(sheets[0].dataVerification?.['0_2']).toMatchObject({
            type: 'dropdown',
            type2: '',
            value1: "'Other Sheet'!$B$1:$B$5",
        });
        expect(sheets[1].dataVerification).toBeUndefined();
    });

    test('convert maps numeric, text-length and date validations onto engine types and operators', async () => {
        const buffer = await buildXlsxBuffer([
            {
                a1: 'A1',
                value: 5,
                dataValidation: { type: 'whole', operator: 'between', allowBlank: true, formulae: [1, 10] },
            },
            {
                a1: 'A2',
                value: 3.5,
                dataValidation: { type: 'decimal', operator: 'greaterThan', allowBlank: true, formulae: [2.5] },
            },
            {
                a1: 'A3',
                value: 'abc',
                dataValidation: { type: 'textLength', operator: 'lessThanOrEqual', allowBlank: true, formulae: [5] },
            },
            {
                a1: 'A4',
                value: '',
                dataValidation: {
                    type: 'date',
                    operator: 'between',
                    allowBlank: true,
                    formulae: [new Date(Date.UTC(2024, 0, 1)), new Date(Date.UTC(2024, 11, 31))],
                },
            },
            {
                a1: 'A5',
                value: '',
                dataValidation: {
                    type: 'date',
                    operator: 'greaterThan',
                    allowBlank: true,
                    formulae: [new Date(Date.UTC(2024, 5, 15))],
                },
            },
        ]);
        const sheets = await convertBuffer(buffer, 'dv-operators.xlsx');
        const rules = sheets[0].dataVerification ?? {};

        expect(rules['0_0']).toMatchObject({ type: 'number_integer', type2: 'between', value1: '1', value2: '10' });
        // Excel "decimal" accepts any real number → engine `number`, not
        // `number_decimal` (which rejects integers).
        expect(rules['1_0']).toMatchObject({ type: 'number', type2: 'moreThanThe', value1: '2.5', value2: '' });
        expect(rules['2_0']).toMatchObject({ type: 'text_length', type2: 'lessThanOrEqualTo', value1: '5' });
        // exceljs hands date operands over as JS Dates (excelToDate, UTC); the engine's
        // validateCellData parses value1/value2 through isdatetime + dayjs → YYYY-MM-DD.
        expect(rules['3_0']).toMatchObject({
            type: 'date',
            type2: 'between',
            value1: '2024-01-01',
            value2: '2024-12-31',
        });
        expect(rules['4_0']).toMatchObject({ type: 'date', type2: 'laterThan', value1: '2024-06-15', value2: '' });
    });

    test('convert skips custom, defined-name list and non-literal operand validations', async () => {
        const buffer = await buildXlsxBuffer([
            { a1: 'A1', value: 1, dataValidation: { type: 'custom', formulae: ['A1>0'] } },
            // Defined names are dropped program-wide; a garbage one-option dropdown is
            // worse than no rule.
            { a1: 'A2', value: 'x', dataValidation: { type: 'list', allowBlank: true, formulae: ['MyNamedRange'] } },
            // Cell-ref operand: exceljs's parseInt coercion yields NaN — no literal to
            // validate against.
            { a1: 'A3', value: 7, dataValidation: { type: 'whole', operator: 'greaterThan', formulae: ['$B$1'] } },
            { a1: 'B1', value: 'Red', dataValidation: { type: 'list', allowBlank: true, formulae: ['"Red,Blue"'] } },
        ]);
        const sheets = await convertBuffer(buffer, 'dv-skips.xlsx');
        expect(Object.keys(sheets[0].dataVerification ?? {})).toEqual(['0_1']);

        const allSkipped = await buildXlsxBuffer([
            { a1: 'A1', value: 1, dataValidation: { type: 'custom', formulae: ['A1>0'] } },
        ]);
        const skippedSheets = await convertBuffer(allSkipped, 'dv-all-skipped.xlsx');
        expect(skippedSheets[0].dataVerification).toBeUndefined();
    });

    test('convert maps validation messages onto hint and prohibit-input flags', async () => {
        const list: Pick<ExcelJS.DataValidation, 'type' | 'allowBlank' | 'formulae'> = {
            type: 'list',
            allowBlank: true,
            formulae: ['"Yes,No"'],
        };
        const buffer = await buildXlsxBuffer([
            {
                a1: 'A1',
                value: '',
                dataValidation: { ...list, showInputMessage: true, promptTitle: 'Pick', prompt: 'Choose Yes or No' },
            },
            // showErrorMessage without errorStyle means Excel's default "stop" style →
            // block invalid input. warning/information styles let the value through.
            { a1: 'A2', value: '', dataValidation: { ...list, showErrorMessage: true, error: 'Invalid choice' } },
            {
                a1: 'A3',
                value: '',
                dataValidation: { ...list, showErrorMessage: true, errorStyle: 'warning', error: 'Are you sure?' },
            },
            { a1: 'A4', value: '', dataValidation: { ...list, showInputMessage: true } },
        ]);
        const sheets = await convertBuffer(buffer, 'dv-messages.xlsx');
        const rules = sheets[0].dataVerification ?? {};

        expect(rules['0_0']).toMatchObject({ hintShow: true, hintValue: 'Choose Yes or No', prohibitInput: false });
        expect(rules['1_0']).toMatchObject({ hintShow: false, hintValue: '', prohibitInput: true });
        expect(rules['2_0']).toMatchObject({ prohibitInput: false });
        // showInputMessage without prompt text has nothing to show.
        expect(rules['3_0']).toMatchObject({ hintShow: false, hintValue: '' });
    });

    test('import into another user document without write permission returns 403', async () => {
        const initial = await buildXlsxBuffer([{ a1: 'A1', value: 'Alice' }]);
        const sheetsDoc = await uploadAndConvert(initial, 'alice.xlsx');

        const replacement = await buildXlsxBuffer([{ a1: 'A1', value: 'Bob was here' }]);
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import`,
            { method: 'POST', body: replacement },
        );
        expect(res.status).toBe(403);
    });
});
