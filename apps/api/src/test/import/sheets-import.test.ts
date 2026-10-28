import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Cell, CellWithRowAndCol, Op, Sheet } from '@workspace/lib/sheets';
import { decodeSheetsSnapshot, encodeSheetsSnapshot } from '@workspace/lib/sheets';
import type { DrivePath, ImportResult } from '@workspace/lib/types/drive';
import { DRIVE_MIME_SHEETS } from '@workspace/lib/types/drive';
import { escapeXml } from '@workspace/lib/xml';
import { update } from '@workspace/sheet/engine';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../../lib/collab/db-config';
import * as collabSchema from '../../lib/collab/schema';
import { loadYjsState } from '../../lib/collab/yjs-loader';
import { ApiError } from '../../lib/core';
import { readLiveSheets, readSheetsFromDoc } from '../../lib/document/sheets';
import { toTransferableBuffer } from '../../lib/document/transform/protocol';
import { getSharedDrive } from '../../lib/drive/get-drive';
import { getHome } from '../../lib/home/get-home';
import { importIntoDocument } from '../../lib/import/import-document';
import { IMPORT_MESSAGES } from '../../lib/import/messages';
import { xlsxToSheets } from '../../lib/import/sheets/from-xlsx';
import { assertInsertFits, MAX_CELLS, MAX_TEXT, sheetsWeight } from '../../lib/import/sheets/limits';
import { readLooks } from '../../lib/import/sheets/styles';
import { importXlsxToSheetsSnapshot } from '../../lib/import/sheets/transform';
import { parseOoxml } from '../../lib/ooxml/ooxml';
import { MAX_DECOMPRESSED_BYTES, openZip, writeZip } from '../../lib/ooxml/zip';
import { getUserById } from '../../lib/user';
import { PIXEL_PNG } from '../fixtures/pptx';
import { build, deflated } from '../fixtures/raw-zip';
import { exportXlsx, linkRels, rowsXml, SML, sheetXml, styleSheet, xlsxFixture } from '../fixtures/xlsx';
import { buildDeclaredSizeBombZip } from '../fixtures/zip-bomb';
import {
    assertJson,
    authedRequest,
    driveGet,
    drivePut,
    driveUpload,
    getTestContext,
    listVersions,
    restoreVersion,
    setMaxUploadSizeMB,
} from '../setup';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Transitional OOXML, then Strict, which uses the same package relationships namespace.
const TRANSITIONAL = {
    spreadsheetml: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    relationships: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    drawingml: 'http://schemas.openxmlformats.org/drawingml/2006/main',
};
const STRICT = {
    spreadsheetml: 'http://purl.oclc.org/ooxml/spreadsheetml/main',
    relationships: 'http://purl.oclc.org/ooxml/officeDocument/relationships',
    drawingml: 'http://purl.oclc.org/ooxml/drawingml/main',
};
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';

// A one-sheet workbook of plain cells, for the tests that only need their values.
function buildXlsxBuffer(
    cells: { a1: string; value: string | number | { formula: string; result?: string | number } }[],
    sheetName = 'Sheet1',
): ArrayBuffer {
    return toTransferableBuffer(
        xlsxFixture({ sheets: [{ name: sheetName, data: rowsXml(cells.map(({ a1, value }) => [a1, value])) }] }),
    );
}

// dk1 and lt1 as system colours, the way Excel writes them; the slots left out read as black.
function themeXml(prefix: string, ns: string): string {
    const p = prefix ? `${prefix}:` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${p}theme ${prefix ? `xmlns:${prefix}` : 'xmlns'}="${ns}" name="Custom"><${p}themeElements><${p}clrScheme name="Custom"><${p}dk1><${p}sysClr val="windowText" lastClr="101010"/></${p}dk1><${p}lt1><${p}sysClr val="window" lastClr="fafafa"/></${p}lt1><${p}accent1><${p}srgbClr val="123456"/></${p}accent1></${p}clrScheme></${p}themeElements></${p}theme>`;
}

// A cellXfs entry from the ids it names.
function xf(ids: { numFmt?: number; font?: number; fill?: number; border?: number }, alignment = ''): string {
    const { numFmt = 0, font = 0, fill = 0, border = 0 } = ids;
    return `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}">${alignment}</xf>`;
}

const fillDxf = (rgb: string) =>
    `<dxf><fill><patternFill patternType="solid"><bgColor rgb="${rgb}"/></patternFill></fill></dxf>`;
const fontDxf = (rgb: string) => `<dxf><font><color rgb="${rgb}"/></font></dxf>`;

// A <dataValidations> block of [sqref, attributes, ...formulas] rules.
function validations(...rules: [sqref: string, attrs: string, ...formulas: string[]][]): string {
    const items = rules.map(([sqref, attrs, ...formulas]) => {
        const inner = formulas.map(
            (formula, index) => `<formula${index + 1}>${escapeXml(formula)}</formula${index + 1}>`,
        );
        return `<dataValidation ${attrs} sqref="${sqref}">${inner.join('')}</dataValidation>`;
    });
    return `<dataValidations count="${rules.length}">${items.join('')}</dataValidations>`;
}

const BLACK = '<color rgb="FF000000"/>';
const WRAP = xf({}, '<alignment wrapText="1"/>');
const NARROW_COLUMN = '<cols><col min="1" max="1" width="4" customWidth="1"/></cols>';

// A sheet of one cell per font name, each in its own font.
function fontSheet(names: string[]): Uint8Array {
    return xlsxFixture({
        styles: styleSheet({
            fonts: names.map((name) => `<font><sz val="11"/><name val="${escapeXml(name)}"/></font>`),
            xfs: names.map((_, index) => xf({ font: index + 1 })),
        }),
        sheets: [{ name: 'Fonts', data: rowsXml(names.map((name, index) => [`A${index + 1}`, name, index + 1])) }],
    });
}

// A workbook in Calibri whose first column is that many characters wide.
function widthOf(width: number): Uint8Array {
    return xlsxFixture({
        styles: styleSheet({}),
        sheets: [
            {
                before: `<cols><col min="1" max="1" width="${width}" customWidth="1"/></cols>`,
                data: rowsXml([['A1', 'x']]),
            },
        ],
    });
}

// Two cells as far apart as the Excel grid allows (1,048,576 × 16,384 ≈ 1.7e10 cells) in a ~2 KB file.
function hugeGrid(): Uint8Array {
    return xlsxFixture({
        sheets: [
            {
                name: 'Huge',
                before: '<dimension ref="A1:XFD1048576"/>',
                data: rowsXml([
                    ['A1048576', 'x'],
                    ['XFD1', 'y'],
                ]),
            },
        ],
    });
}

// A <hyperlinks> block of rel-backed cells, rId1 onwards, then the sheet's relationships.
function externalLinks(refs: string[]): string {
    return `<hyperlinks>${refs.map((ref, index) => `<hyperlink ref="${ref}" r:id="rId${index + 1}"/>`).join('')}</hyperlinks>`;
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
    return decodeSheetsSnapshot(snapshot);
}

// /convert and /import commit the Worker's snapshotJson verbatim, so parsing here
// yields the same Sheet[] a route round-trip would read back — without a Worker spawn.
function parseXlsx(xlsx: ArrayBuffer | Uint8Array): Sheet[] {
    const data = xlsx instanceof Uint8Array ? toTransferableBuffer(xlsx) : xlsx;
    const { snapshotJson } = importXlsxToSheetsSnapshot(data, { maxMediaBytes: MAX_DECOMPRESSED_BYTES });
    return decodeSheetsSnapshot(new TextDecoder().decode(snapshotJson));
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

    test('convert completes even when the client has disconnected (aborted request signal)', async () => {
        // A page reload aborts every in-flight fetch, and a large workbook needs
        // 40-70s of Worker time — the conversion must detach from the connection
        // and finish anyway (the new sheet surfaces via the drive SSE refresh).
        const buffer = buildXlsxBuffer([{ a1: 'A1', value: 'survives' }]);
        const xlsxFile = new File([buffer], 'detached.xlsx', { type: XLSX_MIME });
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            xlsxFile,
        );

        const controller = new AbortController();
        controller.abort();
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST', signal: controller.signal },
        );

        expect(res.status).toBe(200);
        const converted = await assertJson<DrivePath>(res);
        expect(converted.name).toBe('detached.eigensheets');
    });

    test('convert .xlsx to eigensheets replicates the workbook content', async () => {
        const buffer = buildXlsxBuffer([
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
        const initial = buildXlsxBuffer([
            { a1: 'A1', value: 'Old' },
            { a1: 'B1', value: 1 },
        ]);
        const sheetsDoc = await uploadAndConvert(initial, 'initial.xlsx');

        const replacement = buildXlsxBuffer(
            [
                { a1: 'A1', value: 'New' },
                { a1: 'B1', value: 99 },
                { a1: 'A2', value: 'Row2' },
            ],
            'Replaced',
        );
        const importRes = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import?mode=replace`,
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

    function importRequest(pathId: string, body: ArrayBuffer, mode: 'insert' | 'replace'): Promise<Response> {
        return authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/import?mode=${mode}`,
            { method: 'POST', body },
        );
    }

    async function readLive(pathId: string): Promise<Sheet[]> {
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, pathId);
        return readSheetsFromDoc(collab.doc, { recalc: false }).sheets;
    }

    // "Data" holds 5, and "Summary" doubles it across sheets.
    function dataAndSummary(): ArrayBuffer {
        return toTransferableBuffer(
            xlsxFixture({
                sheets: [
                    { name: 'Data', data: rowsXml([['A1', 5]]) },
                    { name: 'Summary', data: rowsXml([['A1', { formula: 'Data!A1*2', result: 10 }]]) },
                ],
            }),
        );
    }

    test("an insert adds the file's sheets after the workbook's own, renaming a taken name and the refs to it", async () => {
        const sheetsDoc = await uploadAndConvert(
            buildXlsxBuffer([{ a1: 'A1', value: 'Mine' }], 'Data'),
            'insert-target.xlsx',
        );
        await assertJson<ImportResult>(await importRequest(sheetsDoc.id, dataAndSummary(), 'insert'));

        const sheets = await readLive(sheetsDoc.id);
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Data', 'Data(Copy)', 'Summary']);
        expect(new Set(sheets.map((sheet) => sheet.id)).size).toBe(3);
        expect(sheets[0].celldata?.[0]?.v?.v).toBe('Mine');
        const formula = sheets[2].celldata?.find((cell) => cell.r === 0 && cell.c === 0)?.v;
        expect(formula).toMatchObject({ f: "='Data(Copy)'!A1*2", v: 10 });
        expect(await listVersions(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, sheetsDoc.id)).toEqual([]);
    });

    test('an import answers with what the file held that did not come over', async () => {
        const sheetsDoc = await uploadAndConvert(buildXlsxBuffer([{ a1: 'A1', value: 'Mine' }]), 'summary-target.xlsx');
        const iconSet = '<cfRule type="iconSet" priority="1"><iconSet iconSet="3Arrows"/></cfRule>';
        const bytes = xlsxFixture({
            sheets: [
                {
                    data: rowsXml([['A1', 5]]),
                    after: `<conditionalFormatting sqref="A1">${iconSet}</conditionalFormatting>`,
                },
            ],
        });
        const result = await assertJson<ImportResult>(
            await importRequest(sheetsDoc.id, toTransferableBuffer(bytes), 'replace'),
        );
        expect(result).toEqual({ success: true, summary: '1 conditional format was not imported.' });
    });

    test('a replace saves a version first, which restores the workbook as it was', async () => {
        const sheetsDoc = await uploadAndConvert(
            buildXlsxBuffer([{ a1: 'A1', value: 'Before' }], 'Old'),
            'replace-target.xlsx',
        );
        await assertJson<ImportResult>(await importRequest(sheetsDoc.id, dataAndSummary(), 'replace'));
        expect((await readLive(sheetsDoc.id)).map((sheet) => sheet.name)).toEqual(['Data', 'Summary']);

        const versions = await listVersions(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, sheetsDoc.id);
        expect(versions).toHaveLength(1);
        await restoreVersion(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, sheetsDoc.id, versions[0].name);
        const restored = await readLive(sheetsDoc.id);
        expect(restored.map((sheet) => sheet.name)).toEqual(['Old']);
        expect(restored[0].celldata?.[0]?.v?.v).toBe('Before');
    });

    // A workbook of one picture, as the export writes it: a sheet's image over B2, and the cells given.
    async function pictureWorkbook(celldata: CellWithRowAndCol[] = []): Promise<ArrayBuffer> {
        const image = { id: 'photo', index: 'a0', x: 100, y: 20, width: 40, height: 30, mediaName: 'photo.png' };
        const media = [{ name: 'photo.png', contentType: 'image/png', data: toTransferableBuffer(PIXEL_PNG) }];
        return toTransferableBuffer(exportXlsx([{ name: 'Pictures', celldata, images: { photo: image } }], { media }));
    }

    async function mediaFiles(pathId: string): Promise<Map<string, Uint8Array>> {
        const home = await getHome(ctx.alice.user.id);
        const { mount } = await home.drive.resolveFile(mountId, pathId);
        const media = await mount.getChildByName(pathId, 'media');
        if (!media) throw new Error('media folder missing');
        const files = new Map<string, Uint8Array>();
        for (const child of await mount.listFolder(media.id))
            files.set(child.name, new Uint8Array((await mount.readBytes(child.id)) ?? new ArrayBuffer(0)));
        return files;
    }

    test("convert brings a workbook's pictures in as files of the new sheet's media folder", async () => {
        const converted = await uploadAndConvert(await pictureWorkbook(), 'pictures.xlsx');
        const [sheet] = await readSnapshot(ctx.alice.user.id, mountId, converted.id);
        const [image] = Object.values(sheet.images ?? {});
        expect(image).toMatchObject({ x: 100, y: 20, width: 40, height: 30 });
        const files = await mediaFiles(converted.id);
        expect([...files.keys()]).toEqual([image.mediaName]);
        expect([...(files.get(image.mediaName) ?? [])]).toEqual([...PIXEL_PNG]);
    });

    test('each insert names its pictures apart, so a second never overwrites the first', async () => {
        const sheetsDoc = await uploadAndConvert(await pictureWorkbook(), 'pictures-twice.xlsx');
        await assertJson<ImportResult>(await importRequest(sheetsDoc.id, await pictureWorkbook(), 'insert'));
        const sheets = await readLive(sheetsDoc.id);
        const names = sheets.flatMap((sheet) => Object.values(sheet.images ?? {}).map((image) => image.mediaName));
        expect(new Set(names).size).toBe(2);
        expect(new Set((await mediaFiles(sheetsDoc.id)).keys())).toEqual(new Set(names));
    });

    // A sheet no tab has flushed, which fills a workbook to the text cap, so a file's one label passes it.
    const fullSheet: Op = {
        op: 'addSheet',
        id: 'full',
        path: [],
        value: {
            id: 'full',
            name: 'Full',
            order: 1,
            config: {},
            celldata: [{ r: 0, c: 0, v: { v: 'a'.repeat(MAX_TEXT) } }],
        },
    };
    const labelled = () => pictureWorkbook([{ r: 0, c: 0, v: { v: 'x', m: 'x' } }]);

    test('an insert refused against the workbook saves none of its pictures', async () => {
        const sheetsDoc = await uploadAndConvert(await pictureWorkbook(), 'pictures-full.xlsx');
        const before = await mediaFiles(sheetsDoc.id);
        const home = await getHome(ctx.alice.user.id);
        const ops = (await home.drive.getCollabDocument(mountId, sheetsDoc.id)).doc.getArray<Op[]>('ops');
        ops.push([[fullSheet]]);
        try {
            const res = await importRequest(sheetsDoc.id, await labelled(), 'insert');
            expect(res.status).toBe(413);
            expect(await res.text()).toContain(IMPORT_MESSAGES.xlsx.tooLarge);
            expect([...(await mediaFiles(sheetsDoc.id)).keys()]).toEqual([...before.keys()]);
            expect(ops).toHaveLength(1);
        } finally {
            ops.delete(0, ops.length);
        }
    }, 60_000);

    test('an insert is weighed again in its write, against what another insert added while its pictures were saved', async () => {
        const sheetsDoc = await uploadAndConvert(buildXlsxBuffer([{ a1: 'A1', value: 'Own' }]), 'grown-meanwhile.xlsx');
        const home = await getHome(ctx.alice.user.id);
        const { path } = await home.drive.resolveFile(mountId, sheetsDoc.id);
        const user = await getUserById(ctx.alice.user.id);
        if (!user) throw new Error('alice missing');
        const ops = (await home.drive.getCollabDocument(mountId, sheetsDoc.id)).doc.getArray<Op[]>('ops');
        // The first open weighs the file before its pictures; the workbook grows before the write opens it again.
        const realGet = home.drive.getCollabDocument.bind(home.drive);
        let opens = 0;
        const getSpy = spyOn(home.drive, 'getCollabDocument').mockImplementation(async (id, pathId) => {
            if (++opens === 2) ops.push([[fullSheet]]);
            return realGet(id, pathId);
        });
        let error: unknown;
        try {
            await importIntoDocument(home.drive, path, Buffer.from(await labelled()), { mode: 'insert' }, user);
        } catch (e) {
            error = e;
        } finally {
            getSpy.mockRestore();
        }
        try {
            expect(opens).toBe(2);
            expect(error).toMatchObject({ status: 413, message: IMPORT_MESSAGES.xlsx.tooLarge });
            expect(ops).toHaveLength(1);
        } finally {
            ops.delete(0, ops.length);
        }
    }, 60_000);

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
        const buffer = buildXlsxBuffer([{ a1: 'A1', value: 'x' }]);
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
        const buffer = buildXlsxBuffer([{ a1: 'A1', value: 'x' }]);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/import?mode=replace`,
            { method: 'POST', body: buffer },
        );
        expect(res.status).toBe(400);
    });

    test('large sheet import stores a zstd-compressed blob and reads back intact', async () => {
        const cells = Array.from({ length: 300 }, (_, i) => ({ a1: `A${i + 1}`, value: `value-${i}` }));
        const buffer = buildXlsxBuffer(cells);
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
        const buffer = buildXlsxBuffer([{ a1: 'A1', value: 'seed' }]);
        const sheetsDoc = await uploadAndConvert(buffer, 'target.xlsx');

        const notXlsx = new TextEncoder().encode('this is not a valid xlsx file');
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import?mode=replace`,
            { method: 'POST', body: notXlsx },
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Not a valid xlsx file');
    });

    test('import of a password-protected workbook says so', async () => {
        const sheetsDoc = await uploadAndConvert(buildXlsxBuffer([{ a1: 'A1', value: 'seed' }]), 'locked.xlsx');
        // An OLE compound file: its signature, then a directory entry naming the encrypted package's stream.
        const locked = new Uint8Array(4096);
        locked.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        locked.set(Buffer.from('EncryptedPackage', 'utf16le'), 1024);
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import?mode=replace`,
            { method: 'POST', body: locked },
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toBe(
            'This spreadsheet is password-protected. Remove the password in Excel and import it again.',
        );
    });

    test('convert of a garbage .xlsx returns 400 Not a valid xlsx file', async () => {
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            new File(['not a spreadsheet at all'], 'garbage.xlsx', { type: XLSX_MIME }),
        );
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
            { method: 'POST' },
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Not a valid xlsx file');
    });

    test('import route surfaces the decompression-bomb guard as 413 This spreadsheet is too large to import', async () => {
        const sheetsDoc = await uploadAndConvert(buildXlsxBuffer([{ a1: 'A1', value: 'seed' }]), 'bomb-target.xlsx');
        const bomb = buildDeclaredSizeBombZip('xl/worksheets/sheet1.xml', 201 * 1024 * 1024);

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import?mode=replace`,
            { method: 'POST', body: new Uint8Array(bomb) },
        );
        expect(res.status).toBe(413);
        expect(await res.text()).toBe('This spreadsheet is too large to import');
    });

    test('import route surfaces the cell-count guard as 413 Spreadsheet has too many cells', async () => {
        const sheetsDoc = await uploadAndConvert(buildXlsxBuffer([{ a1: 'A1', value: 'seed' }]), 'cells-target.xlsx');
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import?mode=replace`,
            { method: 'POST', body: toTransferableBuffer(hugeGrid()) },
        );
        expect(res.status).toBe(413);
        expect(await res.text()).toBe('Spreadsheet has too many cells');
    });

    test('convert rejects a stored source file over the upload limit with 413', async () => {
        // /convert buffers an already-stored file, so it needs its own bound — the
        // upload-time limit can have been raised since the file landed.
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            new File(['x'.repeat(2 * 1024 * 1024)], 'oversized.xlsx', { type: XLSX_MIME }),
        );
        await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
        try {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigensheets`,
                { method: 'POST' },
            );
            expect(res.status).toBe(413);
            expect(await res.text()).toBe('Source file too large');
        } finally {
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
        }
    });

    test('import route rejects an over-quota upload with 413 Upload too large', async () => {
        const sheetsDoc = await uploadAndConvert(buildXlsxBuffer([{ a1: 'A1', value: 'seed' }]), 'quota-target.xlsx');
        await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
        try {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import?mode=replace`,
                { method: 'POST', body: new Uint8Array(2 * 1024 * 1024) },
            );
            expect(res.status).toBe(413);
            expect(await res.text()).toBe('Upload too large');
        } finally {
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
        }
    });

    test('import into a plain file wearing an eigen mime is refused before the transform', async () => {
        // mimeType is caller-controlled on upload (the multipart part's Content-Type lands in the row
        // verbatim), so the container TYPE gates the dispatch, exactly as it does for export and
        // extraction: without it the xlsx Worker runs over the caller's bytes before the collab
        // lookup can 404 on the missing data.db.
        const spoofed = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            new File(['not a container'], 'spoof-import.txt', { type: DRIVE_MIME_SHEETS }),
        );
        expect(spoofed.type).toBe('file');

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${spoofed.id}/import?mode=replace`,
            { method: 'POST', body: buildXlsxBuffer([{ a1: 'A1', value: 'payload' }]) },
        );
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('not supported');
    });

    test('import into another user document without write permission returns 403', async () => {
        const initial = buildXlsxBuffer([{ a1: 'A1', value: 'Alice' }]);
        const sheetsDoc = await uploadAndConvert(initial, 'alice.xlsx');

        const replacement = buildXlsxBuffer([{ a1: 'A1', value: 'Bob was here' }]);
        const res = await authedRequest(
            ctx.bob.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsDoc.id}/import?mode=replace`,
            { method: 'POST', body: replacement },
        );
        expect(res.status).toBe(403);
    });

    test('write revoked while the transform ran blocks the commit', async () => {
        // The route checks write before buffering, then the job queues and transforms
        // for up to minutes. Calling the commit seam directly with a writer whose
        // permission was revoked in that window is exactly the race: read still
        // resolves the collab document, only the write recheck stands in the way.
        const sheetsDoc = await uploadAndConvert(buildXlsxBuffer([{ a1: 'A1', value: 'Alice' }]), 'acl-race.xlsx');
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${sheetsDoc.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });

        const bob = await getUserById(ctx.bob.user.id);
        const bobDrive = await getSharedDrive(ctx.alice.user.id, bob!);
        const { path } = await bobDrive.resolveFile(mountId, sheetsDoc.id);

        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${sheetsDoc.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });

        const before = await readSnapshot(ctx.alice.user.id, mountId, sheetsDoc.id);
        const replacement = Buffer.from(buildXlsxBuffer([{ a1: 'A1', value: 'Bob was here' }]));
        let error: unknown;
        try {
            await importIntoDocument(bobDrive, path, replacement, { mode: 'replace' }, bob!);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(403);
        expect((error as ApiError).message).toBe('No write permission');
        expect(await readSnapshot(ctx.alice.user.id, mountId, sheetsDoc.id)).toEqual(before);
    }, 60_000);

    test('write revoked during the collab-document lookup blocks the commit', async () => {
        // The recheck only closes the race if it is the LAST await before the write:
        // resolving the collab document is itself an await, read-checked only.
        const sheetsDoc = await uploadAndConvert(
            buildXlsxBuffer([{ a1: 'A1', value: 'Alice' }]),
            'acl-race-lookup.xlsx',
        );
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${sheetsDoc.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });

        const bob = await getUserById(ctx.bob.user.id);
        const bobDrive = await getSharedDrive(ctx.alice.user.id, bob!);
        const { path } = await bobDrive.resolveFile(mountId, sheetsDoc.id);

        const realGet = bobDrive.getCollabDocument.bind(bobDrive);
        const getSpy = spyOn(bobDrive, 'getCollabDocument').mockImplementation(async (id, pathId) => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${sheetsDoc.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: false }],
            });
            return realGet(id, pathId);
        });

        const before = await readSnapshot(ctx.alice.user.id, mountId, sheetsDoc.id);
        const replacement = Buffer.from(buildXlsxBuffer([{ a1: 'A1', value: 'Bob was here' }]));
        let error: unknown;
        try {
            await importIntoDocument(bobDrive, path, replacement, { mode: 'replace' }, bob!);
        } catch (e) {
            error = e;
        } finally {
            getSpy.mockRestore();
        }
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(403);
        expect((error as ApiError).message).toBe('No write permission');
        expect(await readSnapshot(ctx.alice.user.id, mountId, sheetsDoc.id)).toEqual(before);
    }, 60_000);
});

describe('Sheets xlsx conversion fidelity', () => {
    test('convert preserves merged cells with correct anchor/non-anchor shape', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        data: rowsXml([
                            ['A1', 'Merged'],
                            ['C1', 'Solo'],
                        ]),
                        after: '<mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>',
                    },
                ],
            }),
        );
        expect(sheets[0].config?.merge).toEqual({ '0_0': { r: 0, c: 0, rs: 2, cs: 2 } });

        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.mc).toEqual({ r: 0, c: 0, rs: 2, cs: 2 });
        expect(byCoord.get('0:1')?.mc).toEqual({ r: 0, c: 0 });
        expect(byCoord.get('1:0')?.mc).toEqual({ r: 0, c: 0 });
        expect(byCoord.get('1:1')?.mc).toEqual({ r: 0, c: 0 });
        // Only the anchor keeps the value, as Excel shows it.
        expect(byCoord.get('0:0')?.v).toBe('Merged');
        expect(byCoord.get('1:1')?.v).toBeUndefined();
    });

    test('wrapped numbers and dates in a narrow column count as one line for the row height', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    numFmts: { 164: 'yyyy-mm-dd' },
                    xfs: [WRAP, xf({ numFmt: 164 }, '<alignment wrapText="1"/>')],
                }),
                sheets: [
                    {
                        name: 'Wrap',
                        before: NARROW_COLUMN,
                        data: rowsXml([
                            ['A1', 282547512345.75, 1],
                            ['A2', { formula: '1/3', result: 0.333333333333333 }, 1],
                            ['A3', 45000, 2], // 2023-03-15
                            ['A4', 'wrapped text long enough to need lines', 1],
                        ]),
                    },
                ],
            }),
        );
        const rowlen = sheets[0].config?.rowlen ?? {};
        expect(rowlen['0']).toBeUndefined();
        expect(rowlen['1']).toBeUndefined();
        expect(rowlen['2']).toBeUndefined();
        expect(rowlen['3']).toBeGreaterThan(100);
    });

    test('wrapped text sizes its row the same whether plain, rich, hyperlinked or a formula result', async () => {
        const text = 'wrapped text long enough to need lines';
        const bytes = xlsxFixture({
            styles: styleSheet({ xfs: [WRAP] }),
            parts: [linkRels(1, ['https://example.com'])],
            sheets: [
                {
                    name: 'Wrap',
                    before: NARROW_COLUMN,
                    data: rowsXml([
                        ['A1', text, 1],
                        [
                            'A2',
                            {
                                rich: '<r><t xml:space="preserve">wrapped text </t></r><r><t>long enough to need lines</t></r>',
                            },
                            1,
                        ],
                        ['A3', text, 1],
                        ['A4', { formula: 'LOWER(B4)', result: text }, 1],
                        ['A5', 'one\ntwo\nthree', 1],
                        ['A6', true, 1],
                    ]),
                    after: externalLinks(['A3']),
                },
            ],
        });
        const rowlen = parseXlsx(bytes)[0].config?.rowlen ?? {};
        // Width 4 is 28 px at Calibri's 7 px digit: 38 characters at 6.6 px each take 9 lines.
        expect(rowlen).toEqual({ '0': 184, '1': 184, '2': 184, '3': 184, '4': 85, '5': 26 });
    });

    test('convert preserves formulas in celldata', async () => {
        const buffer = buildXlsxBuffer([
            { a1: 'A1', value: 1 },
            { a1: 'A2', value: 2 },
            { a1: 'A3', value: 3 },
            { a1: 'A4', value: { formula: 'SUM(A1:A3)', result: 6 } },
        ]);
        const sheets = parseXlsx(buffer);
        const formulaCell = (sheets[0].celldata ?? []).find((c) => c.r === 3 && c.c === 0);
        expect(formulaCell?.v?.f).toBe('=SUM(A1:A3)');
    });

    test('convert renders custom date number formats via numfmt, not literal format tokens', async () => {
        // Excel date formats use lowercase month tokens (m/mm/mmm) and "…" literal-text escapes.
        // The old hand-rolled formatter leaked both — e.g. d"-"m rendered as 15"-"m, mm/dd/yyyy as
        // 00/15/2024 (lowercase mm collided with minutes). Render through numfmt instead so the
        // import display matches what the engine shows live.
        // 2024-03-15 is Excel serial 45366.
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    numFmts: { 164: 'd"-"m', 165: 'd"-"mmm', 166: 'mm/dd/yyyy' },
                    xfs: [xf({ numFmt: 164 }), xf({ numFmt: 165 }), xf({ numFmt: 166 })],
                }),
                sheets: [
                    {
                        name: 'Dates',
                        data: rowsXml([
                            ['A1', 45366, 1],
                            ['A2', 45366, 2],
                            ['A3', 45366, 3],
                        ]),
                    },
                ],
            }),
        );
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));

        // Serial value is preserved; the stored format is canonicalised to the Google
        // month/minute convention at import — `m` after a day token is a MONTH, so it
        // uppercases to `M` (numfmt renders both identically, see import/sheets/styles.ts).
        expect(byCoord.get('0:0')?.v).toBe(45366);
        expect(byCoord.get('0:0')?.ct).toEqual({ fa: 'd"-"M', t: 'd' });

        expect(byCoord.get('0:0')?.m).toBe('15-3');
        expect(byCoord.get('1:0')?.m).toBe('15-Mar');
        expect(byCoord.get('2:0')?.m).toBe('03/15/2024');
    });

    test('convert renders numeric display strings through numfmt, not raw floats', async () => {
        // extractValueAndDisplay used to cache m = String(raw) for numbers, so a cell formatted
        // as "€"#,##0.00 showed the raw float in the grid while ct.fa held the format — until
        // the cell was touched. Numbers must render through the engine's numfmt like dates do.
        // Built-in ids 3 (#,##0) and 10 (0.00%), then four custom formats.
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    numFmts: {
                        164: '[$€]#,##0',
                        165: '0.0',
                        166: '"€"#,##0.00',
                        167: '_-"€" * #,##0.00_-;_-"€" * #,##0.00-;_-"€" * "-"??_-;_-@',
                    },
                    xfs: [3, 10, 164, 165, 166, 167].map((numFmt) => xf({ numFmt })),
                }),
                sheets: [
                    {
                        name: 'Numbers',
                        data: rowsXml([
                            ['A1', 14207.82, 1],
                            ['A2', 0.4072175408, 2],
                            ['A3', 90, 3],
                            ['A4', 1, 4],
                            ['A5', 495083.6, 5],
                            ['A6', 145.2, 6],
                            ['B1', 100.5], // General/missing format
                            ['B2', 0.1 + 0.2], // float noise General hides, as in Excel
                            ['C1', 'hello', 5], // a string cell with a currency numFmt stays the string
                            ['D1', { formula: 'A3*2', result: 90 }, 3],
                        ]),
                    },
                ],
            }),
        );
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
        expect(byCoord.get('1:1')?.v).toBe(0.30000000000000004);
        expect(byCoord.get('1:1')?.m).toBe('0.3');
        expect(byCoord.get('0:2')?.m).toBe('hello');

        // Import-time recalc recomputes formula cells through our engine, so the
        // xlsx's stale cached result (90) is corrected to A3*2 = 180, rendered
        // through the cell's mask.
        expect(byCoord.get('0:3')?.f).toBe('=A3*2');
        expect(byCoord.get('0:3')?.v).toBe(180);
        expect(byCoord.get('0:3')?.m).toBe('€180');
    });

    test('a malformed numFmt shows the number as General', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({ numFmts: { 164: '#,##0;;;;;' }, xfs: [xf({ numFmt: 164 })] }),
                sheets: [{ name: 'Numbers', data: rowsXml([['A1', 1234.5, 1]]) }],
            }),
        );
        expect(sheets[0].celldata?.[0]?.v).toMatchObject({ v: 1234.5, m: '1234.5' });
    });

    test("convert shows General numbers as Excel's default-width General", async () => {
        const values = [123456789012, 1234567.891234, 1.5e-10, 1e21, -0.1 - 0.2];
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [{ name: 'General', data: rowsXml(values.map((value, i) => [`A${i + 1}`, value])) }],
            }),
        );
        const byRow = new Map((sheets[0].celldata ?? []).map((c) => [c.r, c.v?.m] as const));

        expect(values.map((_, i) => byRow.get(i))).toEqual(['1.23457E+11', '1234567.891', '1.5E-10', '1E+21', '-0.3']);
    });

    test("convert displays literal booleans in the engine's uppercase TRUE/FALSE", async () => {
        // extractValueAndDisplay used to cache m = String(raw), so a literal Excel
        // boolean showed lowercase "false" while a formula-produced one showed
        // "TRUE" (import-time recalc rewrites m through the engine). Both must
        // agree — tick boxes read the display value to decide their state.
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Bools',
                        data: rowsXml([
                            ['A1', false],
                            ['A2', true],
                            ['B1', { formula: 'NOT(A1)', result: true }],
                        ]),
                    },
                ],
            }),
        );
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));

        expect(byCoord.get('0:0')?.m).toBe('FALSE');
        expect(byCoord.get('0:0')?.v).toBe(false);
        expect(byCoord.get('1:0')?.m).toBe('TRUE');
        expect(byCoord.get('0:1')?.m).toBe('TRUE');
    });

    test('convert scales column widths from character units to pixels', async () => {
        const sheets = parseXlsx(widthOf(15));
        // 15 of Calibri 11's 7 px digits, as Excel draws it.
        expect(sheets[0].config?.columnlen?.['0']).toBe(105);
    });

    test("a width counts the file's default font: Calibri's 7 px digit beside Calibri, Inter's digit beside Inter", async () => {
        // Excel's default column, 8.43 characters and the padding, stored as 9.140625.
        expect(parseXlsx(widthOf(9.140625))[0].config?.columnlen?.['0']).toBe(64);
        const inter = exportXlsx([{ name: 'Sheet1', celldata: [], config: { columnlen: { 0: 67 } } }]);
        expect(xlsxToSheets(inter)[0].config?.columnlen).toEqual({ 0: 67 });
    });

    test('convert preserves font sizes in points', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    fonts: ['<font><sz val="24"/></font>', '<font><sz val="8"/></font>'],
                    xfs: [xf({ font: 1 }), xf({ font: 2 })],
                }),
                sheets: [
                    {
                        data: rowsXml([
                            ['A1', 'big', 1],
                            ['B1', 'small', 2],
                            ['C1', 'default'],
                        ]),
                    },
                ],
            }),
        );
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.fs).toBe(24);
        expect(byCoord.get('0:1')?.fs).toBe(8);
        expect(byCoord.get('0:2')?.fs).toBeUndefined();
    });

    test('convert imports cell borders', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    borders: [
                        `<border>${['left', 'right', 'top', 'bottom'].map((side) => `<${side} style="thin">${BLACK}</${side}>`).join('')}<diagonal/></border>`,
                    ],
                    xfs: [xf({ border: 1 })],
                }),
                sheets: [
                    {
                        data: rowsXml([
                            ['A1', 'bordered', 1],
                            ['B1', 'no border'],
                        ]),
                    },
                ],
            }),
        );
        const thin = { style: 1, color: '#000000' };
        expect(sheets[0].config?.borderInfo).toEqual({ '0_0': { l: thin, r: thin, t: thin, b: thin } });
    });

    test('imports a diagonalDown border as the slash side, dropping diagonalUp', async () => {
        const diagonal = (direction: 'Down' | 'Up') =>
            `<border diagonal${direction}="1"><left/><right/><top/><bottom/><diagonal style="thin">${BLACK}</diagonal></border>`;
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    borders: [diagonal('Down'), diagonal('Up')],
                    xfs: [xf({ border: 1 }), xf({ border: 2 })],
                }),
                sheets: [
                    {
                        data: rowsXml([
                            ['A1', 'down', 1],
                            ['B1', 'up', 2],
                        ]),
                    },
                ],
            }),
        );
        // Our slash is top-left → bottom-right (diagonalDown); a diagonalUp-only border has no
        // single-direction equivalent in our model and is dropped.
        expect(sheets[0].config?.borderInfo).toEqual({ '0_0': { s: { style: 1, color: '#000000' } } });
    });

    test('convert imports the border of a value-less cell', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    borders: [
                        `<border><left/><right/><top/><bottom style="thin">${BLACK}</bottom><diagonal/></border>`,
                    ],
                    xfs: [xf({ border: 1 })],
                }),
                sheets: [
                    {
                        data: rowsXml([
                            ['A1', 'x'],
                            ['B1', undefined, 1],
                        ]),
                    },
                ],
            }),
        );
        expect(sheets[0].config?.borderInfo).toEqual({ '0_1': { b: { style: 1, color: '#000000' } } });
    });

    test('convert leaves a number without explicit alignment to align by its type', async () => {
        const buffer = buildXlsxBuffer([
            { a1: 'A1', value: 'text' },
            { a1: 'B1', value: 42 },
        ]);
        const sheets = parseXlsx(buffer);
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.ht).toBeUndefined();
        expect(byCoord.get('0:1')?.ht).toBeUndefined();
    });

    test('convert resolves ARGB colors for font and fill and skips pattern none', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    fonts: ['<font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font>'],
                    fills: [
                        '<fill><patternFill patternType="solid"><fgColor rgb="FF0000FF"/></patternFill></fill>',
                        '<fill><patternFill patternType="none"/></fill>',
                    ],
                    xfs: [xf({ font: 1, fill: 2 }), xf({ fill: 3 })],
                }),
                sheets: [
                    {
                        name: 'Themed',
                        data: rowsXml([
                            ['A1', 'Hello', 1],
                            ['B1', 'World', 2],
                        ]),
                    },
                ],
            }),
        );
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.fc).toBe('#FF0000');
        expect(byCoord.get('0:0')?.bg).toBe('#0000FF');
        expect(byCoord.get('0:1')?.bg).toBeUndefined();
    });

    test('convert resolves theme colors from a theme part under any prefix, Transitional or Strict', async () => {
        const themed = (theme: string) =>
            xlsxFixture({
                theme,
                styles: styleSheet({
                    fonts: ['<font><color theme="4"/></font>', '<font><color theme="1"/></font>'],
                    fills: ['<fill><patternFill patternType="solid"><fgColor theme="0"/></patternFill></fill>'],
                    xfs: [xf({ font: 1 }), xf({ font: 2 }), xf({ fill: 2 })],
                }),
                sheets: [
                    {
                        name: 'Themed',
                        data: rowsXml([
                            ['A1', 'accent1', 1],
                            ['B1', 'dk1', 2],
                            ['C1', 'lt1', 3],
                        ]),
                    },
                ],
            });

        for (const [prefix, ns] of [
            ['dml', TRANSITIONAL.drawingml],
            ['', STRICT.drawingml],
        ]) {
            const sheets = parseXlsx(themed(themeXml(prefix, ns)));
            const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
            expect(byCoord.get('0:0')?.fc).toBe('#123456');
            expect(byCoord.get('0:1')?.fc).toBe('#101010');
            expect(byCoord.get('0:2')?.bg).toBe('#FAFAFA');
        }
    });

    test('convert imports the cells of a workbook whose theme part is malformed, without theme colors', async () => {
        const valid = themeXml('a', TRANSITIONAL.drawingml);

        for (const broken of [
            valid.slice(0, valid.indexOf('</a:clrScheme>')),
            valid.replace('<a:theme', '<!DOCTYPE a:theme [<!ENTITY x "y">]><a:theme'),
            valid.replace('<a:theme', '<b:theme').replace('</a:theme>', '</b:theme>'),
        ]) {
            const sheets = parseXlsx(
                xlsxFixture({
                    theme: broken,
                    styles: styleSheet({ fonts: ['<font><color theme="4"/></font>'], xfs: [xf({ font: 1 })] }),
                    sheets: [{ name: 'Themed', data: rowsXml([['A1', 'kept', 1]]) }],
                }),
            );
            const a1 = (sheets[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0);
            expect(a1?.v?.v).toBe('kept');
            expect(a1?.v?.fc).toBeUndefined();
        }
    });

    test('convert preserves text rotation and font family', async () => {
        // textRotation 0-90 counts up, 91-180 is 90 less down, and 255 is vertical.
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    fonts: ['<font><sz val="11"/><name val="Georgia"/></font>'],
                    xfs: [
                        ...[45, 90, 135, 180, 255].map((rotation) => xf({}, `<alignment textRotation="${rotation}"/>`)),
                        xf({ font: 1 }),
                    ],
                }),
                sheets: [
                    {
                        name: 'Styled',
                        data: rowsXml([
                            ['A1', '45-up', 1],
                            ['A2', '90-up', 2],
                            ['A3', '45-down', 3],
                            ['A4', '90-down', 4],
                            ['A5', 'vertical', 5],
                            ['B1', 'georgia', 6],
                        ]),
                    },
                ],
            }),
        );
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.rt).toBe(45);
        expect(byCoord.get('1:0')?.rt).toBe(90);
        expect(byCoord.get('2:0')?.rt).toBe(-45);
        expect(byCoord.get('3:0')?.rt).toBe(-90);
        expect(byCoord.get('4:0')?.rt).toBe('vertical');
        // Georgia is a serif font → mapped to the bundled Source Serif 4. See bundledFont
        // in packages/lib/src/constants/fonts.ts; only the four supported faces
        // ship as embedded webfonts, so unsupported families collapse to the closest one.
        expect(byCoord.get('0:1')?.ff).toBe('Source Serif 4');
    });

    test('convert maps common xlsx fonts into the four supported families', async () => {
        const sheets = parseXlsx(fontSheet(['Calibri', 'Times New Roman', 'Courier New', 'Wingdings', 'Inter']));
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.ff).toBe('Inter');
        expect(byCoord.get('1:0')?.ff).toBe('Source Serif 4');
        expect(byCoord.get('2:0')?.ff).toBe('JetBrains Mono');
        // Unrecognized → no ff (falls back to body default, which is Inter).
        expect(byCoord.get('3:0')?.ff).toBeUndefined();
        expect(byCoord.get('4:0')?.ff).toBe('Inter');
    });

    test('convert maps each known font by its name, in any case and padding', async () => {
        const expected: [name: string, ff: string][] = [
            ['Inter', 'Inter'],
            ['Source Serif 4', 'Source Serif 4'],
            ['Source Serif Pro', 'Source Serif 4'],
            ['JetBrains Mono', 'JetBrains Mono'],
            ['Excalifont', 'Excalifont'],
            ...[
                'Calibri',
                'Calibri Light',
                'Arial',
                'Helvetica',
                'Helvetica Neue',
                'Verdana',
                'Tahoma',
                'Segoe UI',
                'Trebuchet MS',
            ].map((name): [string, string] => [name, 'Inter']),
            ...[
                'Times New Roman',
                'Times',
                'Georgia',
                'Cambria',
                'Garamond',
                'Book Antiqua',
                'Palatino',
                'Palatino Linotype',
            ].map((name): [string, string] => [name, 'Source Serif 4']),
            ...['Courier New', 'Courier', 'Consolas', 'Monaco', 'Lucida Console', 'Menlo'].map(
                (name): [string, string] => [name, 'JetBrains Mono'],
            ),
            ['Comic Sans MS', 'Excalifont'],
            ['Comic Sans', 'Excalifont'],
            ['  TIMES NEW ROMAN ', 'Source Serif 4'],
        ];
        const sheets = parseXlsx(fontSheet(expected.map(([name]) => name)));
        const ff = new Map((sheets[0].celldata ?? []).map((c) => [c.r, c.v?.ff] as const));
        expect(expected.map(([name], index) => [name, ff.get(index)])).toEqual(expected);
    });

    test('convert reads the shared font map', async () => {
        const sheets = parseXlsx(fontSheet(['Lora']));
        expect(sheets[0].celldata?.[0]?.v?.ff).toBe('Source Serif 4');
    });

    test('convert handles multi-sheet workbooks', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    { name: 'Sheet A', data: rowsXml([['A1', 'Alpha']]) },
                    { name: 'Sheet B', data: rowsXml([['A1', 'Beta']]) },
                    { name: 'Sheet C', data: rowsXml([['A1', 'Gamma']]) },
                ],
            }),
        );
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
        // rather than a plain string.
        // Combined with wrapText=true, this used to crash the auto-fit-height path in
        // from-xlsx.ts (`text.split('\n')` on an object).
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({ xfs: [WRAP] }),
                parts: [linkRels(1, ['https://example.com'])],
                sheets: [
                    {
                        name: 'Links',
                        data: rowsXml([
                            ['A1', { rich: '<r><t xml:space="preserve">GSV Assets\n</t></r><r><t>Canva</t></r>' }, 1],
                        ]),
                        after: externalLinks(['A1']),
                    },
                ],
            }),
        );
        const a1 = (sheets[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0);
        expect(a1?.v?.ct?.s?.map((run) => run.v).join('')).toBe('GSV Assets\nCanva');
    });

    test('convert imports hidden columns from col min/max ranges', async () => {
        // Adjacent hidden columns C+D serialize as one <col min="3" max="4" hidden="1">
        // range element, which the import expands to per-column flags.
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Hidden',
                        before: '<cols><col min="3" max="4" width="9" hidden="1" customWidth="1"/></cols>',
                        data: rowsXml([
                            ['A1', 'visible'],
                            ['E1', 'after'],
                        ]),
                    },
                ],
            }),
        );
        expect(sheets[0].config?.colhidden).toEqual({ '2': 0, '3': 0 });
        expect(sheets[0].config?.rowhidden).toBeUndefined();
    });

    test('convert imports hidden rows including style-only hidden rows', async () => {
        // Row 5 is hidden but carries no cells: Excel writes a bare <row r="5" hidden="1"/> for it.
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Hidden',
                        data: rowsXml(
                            [
                                ['A1', 'top'],
                                ['A2', 'hidden with data'],
                                ['A7', 'bottom'],
                            ],
                            { 2: 'hidden="1"', 5: 'hidden="1"' },
                        ),
                    },
                ],
            }),
        );
        expect(sheets[0].config?.rowhidden).toEqual({ '1': 0, '4': 0 });
        expect(sheets[0].config?.colhidden).toBeUndefined();
    });

    test('convert maps frozen panes onto sheet.frozen', async () => {
        const frozen = (pane: string) =>
            `<sheetViews><sheetView workbookViewId="0"><pane ${pane} state="frozen"/></sheetView></sheetViews>`;
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        name: 'RowOnly',
                        before: frozen('ySplit="1" topLeftCell="A2" activePane="bottomLeft"'),
                        data: rowsXml([['A1', 'header']]),
                    },
                    {
                        name: 'ColOnly',
                        before: frozen('xSplit="1" topLeftCell="B1" activePane="topRight"'),
                        data: rowsXml([['A1', 'label']]),
                    },
                    {
                        name: 'Both',
                        before: frozen('xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight"'),
                        data: rowsXml([['A1', 'corner']]),
                    },
                    { name: 'Plain', data: rowsXml([['A1', 'free']]) },
                ],
            }),
        );

        // Excel semantics: ySplit=N freezes the top N rows, xSplit=M the left M columns.
        // Engine range carries the 0-based index of the LAST frozen row/col.
        expect(sheets[0].frozen).toEqual({ type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } });
        expect(sheets[1].frozen).toEqual({ type: 'rangeColumn', range: { row_focus: 0, column_focus: 0 } });
        expect(sheets[2].frozen).toEqual({ type: 'rangeBoth', range: { row_focus: 1, column_focus: 2 } });
        expect(sheets[3].frozen).toBeUndefined();
    });

    test('convert imports the autofilter range onto sheet.filterRange', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Filtered',
                        data: rowsXml(
                            [
                                ['B2', 'Name'],
                                ['C2', 'Count'],
                                ['D2', 'Notes'],
                                ['B3', 'Apples'],
                                ['B4', 'Bananas'],
                            ],
                            // Excel autofilter sheets routinely also carry hidden rows (a previously
                            // applied criterion hides non-matching rows); both must import together.
                            { 4: 'hidden="1"' },
                        ),
                        after: '<autoFilter ref="B2:D10"/>',
                    },
                    { name: 'Plain', data: rowsXml([['A1', 'free']]) },
                ],
            }),
        );

        expect(sheets[0].filterRange).toEqual({ row: [1, 9], column: [1, 3] });
        // No <filterColumn> criteria → no per-column entries. A fresh filter enable in
        // the editor writes only filterRange too (state/modules/filter.ts createFilter);
        // per-column `filter` entries appear only once a criterion is set.
        expect('filter' in sheets[0]).toBe(false);
        expect(sheets[0].config?.rowhidden).toEqual({ '3': 0 });
        expect(sheets[1].filterRange).toBeUndefined();
    });

    test('convert imports cellIs rules with resolved dxf colors and percent-string coercion', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({
                    dxfs: [
                        '<dxf><font><color rgb="FFFFFFFF"/></font><fill><patternFill patternType="solid"><bgColor rgb="FFFF0000"/></patternFill></fill></dxf>',
                        fillDxf('FF00FF00'),
                    ],
                }),
                sheets: [
                    {
                        name: 'CF',
                        data: rowsXml([
                            ['B1', 5],
                            ['B2', 12],
                        ]),
                        // Google Sheets exports serialize numeric thresholds as quoted percent
                        // strings; the importer must coerce them to the numeric form the engine
                        // compares against.
                        after: '<conditionalFormatting sqref="B1:B5"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>10</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="2" operator="lessThanOrEqual"><formula>"5%"</formula></cfRule></conditionalFormatting>',
                    },
                    { name: 'Plain', data: rowsXml([['A1', 'free']]) },
                ],
            }),
        );

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
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({ dxfs: [fillDxf('FF112233')] }),
                sheets: [
                    {
                        name: 'Between',
                        data: rowsXml([['A1', 3]]),
                        after: '<conditionalFormatting sqref="A1:A4"><cfRule type="cellIs" dxfId="0" priority="1" operator="between"><formula>2</formula><formula>5</formula></cfRule></conditionalFormatting>',
                    },
                ],
            }),
        );

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

    test('convert imports an expression rule over several ranges as one rule with its formula as written', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({ dxfs: [fontDxf('FF0000FF')] }),
                sheets: [
                    {
                        name: 'Expr',
                        data: rowsXml([
                            ['B2', 'longtext'],
                            ['D2', 'x'],
                        ]),
                        after: '<conditionalFormatting sqref="B2:B4 D2:D4 A7:A8"><cfRule type="expression" dxfId="0" priority="1"><formula>SUM(B2:$C$3)&gt;2</formula></cfRule></conditionalFormatting>',
                    },
                ],
            }),
        );

        // Excel anchors the relative refs at the first range's top-left, and so does the engine.
        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [
                    { row: [1, 3], column: [1, 1] },
                    { row: [1, 3], column: [3, 3] },
                    { row: [6, 7], column: [0, 0] },
                ],
                format: { textColor: '#0000FF', cellColor: null },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=SUM(B2:$C$3)>2'],
            },
        ]);
    });

    test('convert maps colorScale rules onto colorGradation with engine stop order', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Scale',
                        data: rowsXml([
                            ['C1', 1],
                            ['C2', 5],
                            ['C3', 9],
                        ]),
                        after: '<conditionalFormatting sqref="C1:C3"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="FFFF0000"/></colorScale></cfRule></conditionalFormatting>',
                    },
                ],
            }),
        );

        // The file lists stops min→max; the engine's colorGradation format is max→min.
        expect(sheets[0].conditionalFormatRules).toEqual([
            {
                type: 'colorGradation',
                cellrange: [{ row: [0, 2], column: [2, 2] }],
                format: ['#FF0000', '#FFFFFF'],
            },
        ]);
    });

    test('convert imports multi-range refs as multiple cellrange entries', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({ dxfs: [fontDxf('FFAA0000')] }),
                sheets: [
                    {
                        name: 'Multi',
                        data: rowsXml([['A1', 1]]),
                        after: '<conditionalFormatting sqref="A1:A2 C1:C2 E5"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>0</formula></cfRule></conditionalFormatting>',
                    },
                ],
            }),
        );

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
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({ dxfs: [fillDxf('FF00FF00'), fillDxf('FFFF0000')] }),
                sheets: [
                    {
                        name: 'Prio',
                        data: rowsXml([['A1', 100]]),
                        after: '<conditionalFormatting sqref="A1:A5"><cfRule type="cellIs" dxfId="0" priority="2" operator="greaterThan"><formula>0</formula></cfRule><cfRule type="cellIs" dxfId="1" priority="1" operator="greaterThan"><formula>50</formula></cfRule></conditionalFormatting>',
                    },
                ],
            }),
        );

        // Excel: lowest priority number wins conflicting properties. The engine applies
        // rules in array order with last-write-wins per property, so the importer emits
        // priority DESCENDING — the priority-1 (red) rule must come last.
        const rules = sheets[0].conditionalFormatRules ?? [];
        expect(rules).toHaveLength(2);
        expect(rules[0]).toMatchObject({ format: { cellColor: '#00FF00' }, conditionValue: ['0'] });
        expect(rules[1]).toMatchObject({ format: { cellColor: '#FF0000' }, conditionValue: ['50'] });
    });

    test('convert skips iconSet rules but keeps supported rules from the same sheet', async () => {
        const icons = (name: string) =>
            `<cfRule type="iconSet" priority="1"><iconSet iconSet="${name}"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule>`;
        const sheets = parseXlsx(
            xlsxFixture({
                styles: styleSheet({ dxfs: [fontDxf('FF00AA00')] }),
                sheets: [
                    {
                        name: 'Icons',
                        data: rowsXml([['A1', 1]]),
                        after: `<conditionalFormatting sqref="A1:A3">${icons('3TrafficLights1')}<cfRule type="cellIs" dxfId="0" priority="2" operator="equal"><formula>1</formula></cfRule></conditionalFormatting>`,
                    },
                    {
                        name: 'OnlyIcons',
                        data: rowsXml([['A1', 2]]),
                        after: `<conditionalFormatting sqref="A1:A3">${icons('3Arrows')}</conditionalFormatting>`,
                    },
                ],
            }),
        );

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
        const buffer = xlsxFixture({
            sheets: [
                {
                    data: rowsXml([
                        ['A1', 'plain'],
                        ['B2', 'Red'],
                        ['B3', 'Green'],
                    ]),
                    after: validations(['B2:B4', 'type="list" allowBlank="1"', '"Red,Green,Blue"']),
                },
            ],
        });
        const sheets = parseXlsx(buffer);

        // sqref ranges        const sheets = parseXlsx(buffer);

        // sqref ranges arrive pre-expanded to per-cell keys; value1 holds the literal
        // with the outer quotes stripped; type2 '' is the dialog's single-select value.
        const expected = {
            type: 'dropdown',
            type2: '',
            value1: 'Red,Green,Blue',
            value2: '',
            prohibitInput: false,
            hintShow: false,
            hintValue: '',
        };
        expect(sheets[0].dataVerification).toEqual({ '1_1': expected, '2_1': expected, '3_1': expected });
    });

    test('convert keeps range-ref list sources verbatim for live cross-sheet resolution', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        name: 'Main',
                        data: rowsXml([['C1', 'pick']]),
                        after: validations(['C1', 'type="list" allowBlank="1"', "'Other Sheet'!$B$1:$B$5"]),
                    },
                    {
                        name: 'Other Sheet',
                        data: rowsXml([1, 2, 3, 4, 5].map((i) => [`B${i}`, `Option ${i}`])),
                    },
                ],
            }),
        );

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
        // Dates are Excel serials: 2024-01-01, 2024-12-31 and 2024-06-15.
        const buffer = xlsxFixture({
            sheets: [
                {
                    data: rowsXml([
                        ['A1', 5],
                        ['A2', 3.5],
                        ['A3', 'abc'],
                    ]),
                    after: validations(
                        ['A1', 'type="whole" operator="between" allowBlank="1"', '1', '10'],
                        ['A2', 'type="decimal" operator="greaterThan" allowBlank="1"', '2.5'],
                        ['A3', 'type="textLength" operator="lessThanOrEqual" allowBlank="1"', '5'],
                        ['A4', 'type="date" operator="between" allowBlank="1"', '45292', '45657'],
                        ['A5', 'type="date" operator="greaterThan" allowBlank="1"', '45458'],
                    ),
                },
            ],
        });
        const sheets = parseXlsx(buffer);
        const rules = sheets[0].dataVerification ?? {};

        expect(rules['0_0']).toMatchObject({ type: 'number_integer', type2: 'between', value1: '1', value2: '10' });
        // Excel "decimal" accepts any real number → engine `number`, not
        // `number_decimal` (which rejects integers).
        expect(rules['1_0']).toMatchObject({ type: 'number', type2: 'moreThanThe', value1: '2.5', value2: '' });
        expect(rules['2_0']).toMatchObject({ type: 'text_length', type2: 'lessThanOrEqualTo', value1: '5' });
        // Date operands are serials; the engine's validateCellData parses value1/value2
        // through isdatetime + dayjs → YYYY-MM-DD.
        expect(rules['3_0']).toMatchObject({
            type: 'date',
            type2: 'between',
            value1: '2024-01-01',
            value2: '2024-12-31',
        });
        expect(rules['4_0']).toMatchObject({ type: 'date', type2: 'laterThan', value1: '2024-06-15', value2: '' });
    });

    test('convert skips custom, defined-name list and non-literal operand validations', async () => {
        const buffer = xlsxFixture({
            sheets: [
                {
                    data: rowsXml([
                        ['A1', 1],
                        ['A2', 'x'],
                        ['A3', 7],
                        ['B1', 'Red'],
                    ]),
                    after: validations(
                        ['A1', 'type="custom"', 'A1>0'],
                        // Defined names are dropped program-wide; a garbage one-option dropdown is
                        // worse than no rule.
                        ['A2', 'type="list" allowBlank="1"', 'MyNamedRange'],
                        // Cell-ref operand: no literal to validate against.
                        ['A3', 'type="whole" operator="greaterThan"', '$B$1'],
                        ['B1', 'type="list" allowBlank="1"', '"Red,Blue"'],
                    ),
                },
            ],
        });
        const sheets = parseXlsx(buffer);
        expect(Object.keys(sheets[0].dataVerification ?? {})).toEqual(['0_1']);
    });

    test('convert maps validation messages onto hint and prohibit-input flags', async () => {
        const list = 'type="list" allowBlank="1"';
        const buffer = xlsxFixture({
            sheets: [
                {
                    after: validations(
                        ['A1', `${list} showInputMessage="1" promptTitle="Pick" prompt="Choose Yes or No"`, '"Yes,No"'],
                        // showErrorMessage without errorStyle means Excel's default "stop" style →
                        // block invalid input. warning/information styles let the value through.
                        ['A2', `${list} showErrorMessage="1" error="Invalid choice"`, '"Yes,No"'],
                        ['A3', `${list} showErrorMessage="1" errorStyle="warning" error="Are you sure?"`, '"Yes,No"'],
                        ['A4', `${list} showInputMessage="1"`, '"Yes,No"'],
                    ),
                },
            ],
        });
        const sheets = parseXlsx(buffer);
        const rules = sheets[0].dataVerification ?? {};

        expect(rules['0_0']).toMatchObject({ hintShow: true, hintValue: 'Choose Yes or No', prohibitInput: false });
        expect(rules['1_0']).toMatchObject({ hintShow: false, hintValue: '', prohibitInput: true });
        expect(rules['2_0']).toMatchObject({ prohibitInput: false });
        // showInputMessage without prompt text has nothing to show.
        expect(rules['3_0']).toMatchObject({ hintShow: false, hintValue: '' });
    });

    test('convert clamps validation emission to the used extent plus a margin', async () => {
        // A rule keys every cell of its range, so a column-wide rule ("C1:C1048576")
        // would otherwise emit ~1M rule objects into the snapshot.
        const sheets = parseXlsx(
            xlsxFixture({
                sheets: [
                    {
                        data: rowsXml([1, 2, 3, 4, 5].map((i) => [`A${i}`, `row${i}`])),
                        after: validations(['C1:C5000', 'type="list" allowBlank="1"', '"Yes,No"']),
                    },
                ],
            }),
        );

        const rules = sheets[0].dataVerification ?? {};
        // rowCount is 5 → rules survive up to 0-based row 1004 (5 + 1000-row margin).
        expect(rules['0_2']).toMatchObject({ type: 'dropdown', value1: 'Yes,No' });
        expect(rules['1004_2']).toMatchObject({ type: 'dropdown', value1: 'Yes,No' });
        expect(rules['1005_2']).toBeUndefined();
        expect(Object.keys(rules).length).toBe(1005);
    });

    test('convert imports webpage and mailto hyperlinks with verbatim targets and cell backrefs', async () => {
        const sheets = parseXlsx(
            xlsxFixture({
                parts: [linkRels(1, ['https://jira.example.com/browse/PLATFORMS-1452', 'mailto:erikjan@example.com'])],
                sheets: [
                    {
                        name: 'Links',
                        data: rowsXml([
                            ['B2', 'PLATFORMS-1452'],
                            ['B3', 'Erik-Jan ten Brinke'],
                            ['B4', 'no link'],
                        ]),
                        after: externalLinks(['B2', 'B3']),
                    },
                ],
            }),
        );

        // Targets import verbatim (incl. mailto:) — fidelity at import; scheme
        // safety is enforced at navigation time by the engine's allowlist.
        expect(sheets[0].hyperlink).toEqual({
            '1_1': { linkType: 'webpage', linkAddress: 'https://jira.example.com/browse/PLATFORMS-1452' },
            '2_1': { linkType: 'webpage', linkAddress: 'mailto:erikjan@example.com' },
        });
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        // The cell keeps its display text; hl is the saveHyperlink backref invariant
        // (patch.ts's cell-op path keys off it).
        expect(byCoord.get('1:1')?.v).toBe('PLATFORMS-1452');
        expect(byCoord.get('1:1')?.m).toBe('PLATFORMS-1452');
        expect(byCoord.get('1:1')?.hl).toEqual({ r: 1, c: 1, id: 'sheet-0' });
        expect(byCoord.get('2:1')?.hl).toEqual({ r: 2, c: 1, id: 'sheet-0' });
        expect(byCoord.get('3:1')?.hl).toBeUndefined();
    });

    test('convert maps internal #location links onto cellrange and sheet link types', async () => {
        // A {text, hyperlink: '#…'} cell as a library writes it: a location beside a rel, both to the #-prefixed target.
        const targets = ['#Sheet2!A3', '#Sheet2', "#'My Sheet'!B2", "#'My Sheet'"];
        const links = targets
            .map(
                (target, index) =>
                    `<hyperlink ref="A${index + 1}" r:id="rId${index + 1}" location="${escapeXml(target)}"/>`,
            )
            .join('');
        const sheets = parseXlsx(
            xlsxFixture({
                parts: [linkRels(1, targets)],
                sheets: [
                    {
                        name: 'Sheet1',
                        data: rowsXml(
                            ['cell link', 'sheet link', 'quoted cell link', 'quoted sheet link'].map((text, index) => [
                                `A${index + 1}`,
                                text,
                            ]),
                        ),
                        after: `<hyperlinks>${links}</hyperlinks>`,
                    },
                    { name: 'Sheet2' },
                    { name: 'My Sheet' },
                ],
            }),
        );

        // cellrange keeps the quoted form (getcellrange resolves quoted names);
        // sheet links strip quotes to match goToLink's name exact-equality.
        expect(sheets[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: 'Sheet2!A3' },
            '1_0': { linkType: 'sheet', linkAddress: 'Sheet2' },
            '2_0': { linkType: 'cellrange', linkAddress: "'My Sheet'!B2" },
            '3_0': { linkType: 'sheet', linkAddress: 'My Sheet' },
        });
    });

    test('convert imports Excel-authored location-form hyperlinks without rels', async () => {
        const location = (ref: string, target: string) => `<hyperlink ref="${ref}" location="${escapeXml(target)}"/>`;
        const buffer = xlsxFixture({
            parts: [linkRels(1, ['https://example.com'])],
            sheets: [
                {
                    name: 'Sheet1',
                    data: rowsXml([
                        ['A1', 'unquoted'],
                        ['A2', 'quoted'],
                        ['A3', 'range tail'],
                        ['A4', 'entities'],
                        ['B7', 'range ref'],
                        // A rel-based external link in the same sheet must keep importing unchanged.
                        ['A5', 'web'],
                    ]),
                    after: `<hyperlinks><hyperlink ref="A5" r:id="rId1"/>${[
                        location('A1', 'Sheet2!A1'),
                        location('A2', "'My Sheet'!B2"),
                        location('A3', "'My Sheet'!A1:B2"),
                        location('A4', "'A & B'!C3"),
                        // Range refs hang the link on the anchor cell.
                        location('B7:C8', 'Sheet2!D4'),
                    ].join('')}</hyperlinks>`,
                },
                { name: 'Sheet2' },
                { name: 'My Sheet' },
                { name: 'A & B' },
            ],
        });
        const sheets = parseXlsx(buffer);

        expect(sheets[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: 'Sheet2!A1' },
            '1_0': { linkType: 'cellrange', linkAddress: "'My Sheet'!B2" },
            '2_0': { linkType: 'cellrange', linkAddress: "'My Sheet'!A1:B2" },
            '3_0': { linkType: 'cellrange', linkAddress: "'A & B'!C3" },
            '4_0': { linkType: 'webpage', linkAddress: 'https://example.com' },
            '6_1': { linkType: 'cellrange', linkAddress: 'Sheet2!D4' },
        });
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('0:0')?.hl).toEqual({ r: 0, c: 0, id: 'sheet-0' });
        expect(byCoord.get('2:0')?.v).toBe('range tail');
        expect(byCoord.get('6:1')?.hl).toEqual({ r: 6, c: 1, id: 'sheet-0' });
    });

    test('convert reads a prefixed hyperlinks block and decodes the references in its locations', async () => {
        const buffer = xlsxFixture({
            sheets: [
                {
                    name: 'Sheet1',
                    data: rowsXml([['A1', 'link']]),
                    after: `<x:hyperlinks xmlns:x="${TRANSITIONAL.spreadsheetml}"><x:hyperlink ref="A1" location="&apos;Q1 &#x2013; &quot;A&quot; &amp; B&apos;!C3"/></x:hyperlinks>`,
                },
                { name: 'Q1 – "A" & B' },
            ],
        });
        const sheets = parseXlsx(buffer);

        expect(sheets[1].name).toBe('Q1 – "A" & B');
        expect(sheets[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: `'Q1 – "A" & B'!C3` },
        });
    });

    test('location hyperlinks follow the workbook, its rels and the sheets by namespace, not by prefix', async () => {
        for (const [prefixes, ns] of [
            [{ sml: 'x:', r: 'rel', pr: 'pr:' }, TRANSITIONAL],
            [{ sml: '', r: 'r', pr: '' }, STRICT],
        ] as const) {
            const { sml, r, pr } = prefixes;
            const smlns = sml ? `xmlns:${sml.slice(0, -1)}` : 'xmlns';
            const prns = pr ? `xmlns:${pr.slice(0, -1)}` : 'xmlns';
            const worksheet = `${ns.relationships}/worksheet`;
            // The decoy's `r:id` binds `r` to another namespace, so it names no relationship.
            const files = [
                {
                    name: 'xl/workbook.xml',
                    data: `<${sml}workbook ${smlns}="${ns.spreadsheetml}" xmlns:${r}="${ns.relationships}"><${sml}sheets><${sml}sheet name="Q1 &#x2013; &quot;A&quot; &amp; B" sheetId="1" ${r}:id="rId1"/><${sml}sheet xmlns:r="urn:decoy" name="Decoy" sheetId="2" r:id="rId2"/></${sml}sheets></${sml}workbook>`,
                },
                {
                    name: 'xl/_rels/workbook.xml.rels',
                    data: `<${pr}Relationships ${prns}="${PACKAGE_RELATIONSHIPS}"><${pr}Relationship Id="rId1" Type="${worksheet}" Target="worksheets/sheet1.xml"/><${pr}Relationship Id="rId2" Type="${worksheet}" Target="worksheets/sheet2.xml"/></${pr}Relationships>`,
                },
                ...['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].map((name) => ({
                    name,
                    data: `<${sml}worksheet ${smlns}="${ns.spreadsheetml}"><${sml}sheetData/><${sml}hyperlinks><${sml}hyperlink ref="B2:C3" location="Other!A1"/></${sml}hyperlinks></${sml}worksheet>`,
                })),
            ];

            const sheets = xlsxToSheets(writeZip(files));
            expect(sheets.map(({ name, hyperlink }) => ({ name, hyperlink }))).toEqual([
                { name: 'Q1 – "A" & B', hyperlink: { '1_1': { linkType: 'cellrange', linkAddress: 'Other!A1' } } },
            ]);
        }
    });

    test('location hyperlinks keep all of the 66,530 Excel allows a sheet', async () => {
        const entries = Array.from(
            { length: 66_530 },
            (_, i) =>
                `<hyperlink ref="A${i + 1}" location="'Sheet 2'!B${i + 1}" display="Row ${i + 1} of the second sheet, column B" tooltip="Open the second sheet"/>`,
        ).join('');
        const bytes = xlsxFixture({
            sheets: [
                { name: 'Sheet1', data: rowsXml([['A1', 'link']]), after: `<hyperlinks>${entries}</hyperlinks>` },
                { name: 'Sheet 2' },
            ],
        });

        const links = xlsxToSheets(bytes)[0].hyperlink ?? {};
        expect(Object.keys(links)).toHaveLength(66_530);
        expect(links['66529_0']).toEqual({ linkType: 'cellrange', linkAddress: "'Sheet 2'!B66530" });
    });

    test('a hyperlinks opener in a comment before the sheet data leaves the real block to be read', async () => {
        const bytes = xlsxFixture({
            sheets: [
                {
                    name: 'Sheet1',
                    before: '<!-- <hyperlinks> -->',
                    data: rowsXml([['A1', 'link']]),
                    after: '<hyperlinks><hyperlink ref="A1" location="Sheet1!B2"/></hyperlinks>',
                },
            ],
        });

        expect(xlsxToSheets(bytes)[0].hyperlink).toEqual({
            '0_0': { linkType: 'cellrange', linkAddress: 'Sheet1!B2' },
        });
    });

    // A DOCTYPE is refused in every part.
    test('convert refuses a sheet whose part holds a DOCTYPE', async () => {
        const xml = sheetXml({ data: rowsXml([['A1', 'kept']]) }).replace(
            '<worksheet',
            '<!DOCTYPE worksheet><worksheet',
        );
        expect(() => xlsxToSheets(xlsxFixture({ sheets: [{ name: 'Sheet1', xml }] }))).toThrow('Not a valid xlsx file');
    });

    test('convert imports hyperlinks on rich-text cells, the text in their runs', async () => {
        // Benchmark shape (e.g. Project Checklist E9): the link cell's .text is a
        // CellRichTextValue, not a string.
        const sheets = parseXlsx(
            xlsxFixture({
                parts: [linkRels(1, ['https://example.com/assets'])],
                sheets: [
                    {
                        name: 'Links',
                        data: rowsXml([
                            ['E9', { rich: '<r><t xml:space="preserve">GSV Assets </t></r><r><t>Canva</t></r>' }],
                        ]),
                        after: externalLinks(['E9']),
                    },
                ],
            }),
        );

        expect(sheets[0].hyperlink).toEqual({
            '8_4': { linkType: 'webpage', linkAddress: 'https://example.com/assets' },
        });
        const e9 = (sheets[0].celldata ?? []).find((c) => c.r === 8 && c.c === 4);
        expect(e9?.v?.ct?.s?.map((run) => run.v).join('')).toBe('GSV Assets Canva');
        expect(e9?.v?.hl).toEqual({ r: 8, c: 4, id: 'sheet-0' });
    });

    test('convert omits the hyperlink field for sheets without links and skips blank targets', async () => {
        // A whitespace-only target; a webpage entry pointing at ' ' would be navigation garbage.
        const sheets = parseXlsx(
            xlsxFixture({
                parts: [linkRels(1, [' '])],
                sheets: [
                    {
                        name: 'Plain',
                        data: rowsXml([
                            ['A1', 'text'],
                            ['A2', 'blank target'],
                        ]),
                        after: externalLinks(['A2']),
                    },
                ],
            }),
        );

        expect(sheets[0].hyperlink).toBeUndefined();
        const byCoord = new Map((sheets[0].celldata ?? []).map((c) => [`${c.r}:${c.c}`, c.v] as const));
        expect(byCoord.get('1:0')?.v).toBe('blank target');
        expect(byCoord.get('1:0')?.hl).toBeUndefined();
    });
});

// The reader bounds each file alone, so an insert weighs the file with the workbook it joins against the same caps.
describe('an insert weighed with the workbook it joins', () => {
    const refused = { status: 413, message: IMPORT_MESSAGES.xlsx.tooLarge };
    const sheetOf = (id: string, celldata: CellWithRowAndCol[]): Sheet => ({
        id,
        name: id,
        order: 0,
        config: {},
        celldata,
    });
    const numbers = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ r: Math.floor(i / 26), c: i % 26, v: { v: i } }));
    function thrownBy(weigh: () => void): unknown {
        try {
            weigh();
        } catch (error) {
            return error;
        }
        return null;
    }

    test("a cell's text is its value, display, formula, number format and runs, as the reader charges them", () => {
        const cell: Cell = { v: 'ab', m: 'cd', f: '=x', ct: { fa: 'General', s: [{ v: 'run' }] } };
        const sheet = sheetOf('Text', [
            { r: 0, c: 0, v: cell },
            { r: 0, c: 1, v: { v: 1 } },
            { r: 0, c: 2, v: null },
        ]);
        expect(sheetsWeight([sheet])).toEqual({ cells: 3, text: 2 + 2 + 2 + 7 + 3 });
    });

    test('a file that fits alone is refused when it and the workbook pass the cell cap', () => {
        const workbook = [sheetOf('Stored', numbers(MAX_CELLS - 1_000))];
        expect(thrownBy(() => assertInsertFits(workbook, { cells: 1_001, text: 0 }))).toMatchObject(refused);
        expect(thrownBy(() => assertInsertFits(workbook, { cells: 1_000, text: 0 }))).toBeNull();
    }, 30_000);

    test('a file that fits alone is refused when it and the workbook pass the text cap', () => {
        const workbook = [sheetOf('Stored', [{ r: 0, c: 0, v: { v: 'a'.repeat(MAX_TEXT - 10) } }])];
        expect(thrownBy(() => assertInsertFits(workbook, { cells: 1, text: 11 }))).toMatchObject(refused);
        expect(thrownBy(() => assertInsertFits(workbook, { cells: 1, text: 10 }))).toBeNull();
    });

    test('a sheet no tab has flushed weighs with the stored ones', () => {
        const doc = new Y.Doc();
        doc.getMap('state').set('snapshot', encodeSheetsSnapshot([sheetOf('Stored', numbers(10))], { computed: true }));
        const pending = sheetOf('Pending', numbers(10));
        doc.getArray<Op[]>('ops').push([[{ op: 'addSheet', id: pending.id, path: [], value: pending }]]);
        expect(sheetsWeight(readLiveSheets(doc)).cells).toBe(20);
    });

    // A file weighs no more than the reader charged it, so the largest a replace accepts sits at both caps.
    test('a file as large as a replace accepts goes into a workbook never flushed', () => {
        const file = { cells: MAX_CELLS, text: MAX_TEXT };
        expect(thrownBy(() => assertInsertFits(readLiveSheets(new Y.Doc()), file))).toBeNull();
    });
});

describe('xlsxToSheets resource guards', () => {
    // openZip refuses both before the reader parses anything: the declared total past the cap, with nothing inflated,
    // and an entry inflating past the size it declares.
    test.each([
        ['declaring more than the cap', buildDeclaredSizeBombZip('xl/worksheets/sheet1.xml', 201 * 1024 * 1024), 413],
        [
            'holding an entry that lies small',
            build([{ ...deflated('xl/worksheets/sheet1.xml', '<row/>'.repeat(100_000)), size: 64 }]),
            400,
        ],
    ])('rejects an xlsx %s', (_name, bytes, status) => {
        expect(() => xlsxToSheets(bytes)).toThrow(
            expect.objectContaining({
                status,
                message: status === 413 ? 'This spreadsheet is too large to import' : 'Not a valid xlsx file',
            }),
        );
    });

    // JSZip names an entry by its Info-ZIP Unicode Path extra (0x7075), which openZip ignores: an entry openZip reads
    // as decoy.xml is a second sheet1.xml to JSZip, and the later one wins. The reader reads only what openZip names.
    test('the reader reads the entries openZip names, not another reading of the upload', async () => {
        const zip = openZip(xlsxFixture({ sheets: [{ name: 'S', data: rowsXml([['A1', 1]]) }] }));
        const parts = zip.names().map((name) => deflated(name, zip.read(name) ?? ''));
        const sheet = new TextDecoder().decode(zip.read('xl/worksheets/sheet1.xml'));
        const decoyName = 'xl/worksheets/decoy.xml';
        const unicodePath = new TextEncoder().encode('xl/worksheets/sheet1.xml');
        const extra = new Uint8Array(9 + unicodePath.length);
        const view = new DataView(extra.buffer);
        view.setUint16(0, 0x7075, true);
        view.setUint16(2, 5 + unicodePath.length, true);
        view.setUint8(4, 1);
        view.setUint32(5, Bun.hash.crc32(decoyName), true);
        extra.set(unicodePath, 9);
        const bytes = build([...parts, { ...deflated(decoyName, sheet.replace('<v>1</v>', '<v>2</v>')), extra }]);

        const jszip = await JSZip.loadAsync(bytes);
        expect(await jszip.file('xl/worksheets/sheet1.xml')?.async('string')).toContain('<v>2</v>');

        const sheets = xlsxToSheets(bytes);
        expect((sheets[0].celldata ?? []).find((c) => c.r === 0 && c.c === 0)?.v?.v).toBe(1);
    });

    test('rejects an xlsx declaring an absurd cell count', async () => {
        // Recalc would walk the grid the two far-apart cells span.
        expect(() => xlsxToSheets(hugeGrid())).toThrow(
            expect.objectContaining({ status: 413, message: 'Spreadsheet has too many cells' }),
        );
    });
});

// A cell format's ct.fa, as the styles reader writes it.
function faOf(numFmt: string): string {
    const styles = parseOoxml(
        `<styleSheet xmlns="${SML}"><numFmts><numFmt numFmtId="164" formatCode="${escapeXml(numFmt)}"/></numFmts><cellXfs><xf/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    );
    return readLooks(styles ?? undefined, [])[1].fa ?? '';
}

describe("a number format's month and minute (Excel m/M → the Google convention)", () => {
    test('a month run adjacent to day/year uppercases (the headline bug)', () => {
        expect(faOf('dd/mm/yyyy')).toBe('dd/MM/yyyy');
        expect(faOf('m/d/yyyy')).toBe('M/d/yyyy');
        expect(faOf('mm/yyyy')).toBe('MM/yyyy');
    });

    test('a minute run adjacent to hours or seconds lowercases; hour/second case stays untouched', () => {
        expect(faOf('hh:mm:ss')).toBe('hh:mm:ss');
        // Mirror bug: uppercase MM in a time position must become lowercase minutes.
        expect(faOf('HH:MM:SS')).toBe('HH:mm:SS');
        // A following seconds token resolves the deferred month back to a minute.
        expect(faOf('mm:ss')).toBe('mm:ss');
    });

    test('month and minute in the same string are classified independently', () => {
        expect(faOf('yyyy-mm-dd hh:mm')).toBe('yyyy-MM-dd hh:mm');
        expect(faOf('yyyy-mm-dd hh:mm:ss')).toBe('yyyy-MM-dd hh:mm:ss');
    });

    test('month-name runs (mmm/mmmm/mmmmm) uppercase to the Google month tokens', () => {
        expect(faOf('d-mmm-yyyy')).toBe('d-MMM-yyyy');
        expect(faOf('d"-"mmm')).toBe('d"-"MMM');
        expect(faOf('mmmm')).toBe('MMMM');
        expect(faOf('mmmmm')).toBe('MMMMM');
    });

    test('elapsed-minute bracket form is always minute (lowercased); other brackets are untouched', () => {
        expect(faOf('[mm]:ss')).toBe('[mm]:ss');
        expect(faOf('[MM]:ss')).toBe('[mm]:ss');
        // Elapsed hours before a minute run: mm follows [h] → minute.
        expect(faOf('[h]:mm:ss')).toBe('[h]:mm:ss');
        // A color bracket carries an M but is not a token — leave it alone.
        expect(faOf('[Red]mm/yyyy')).toBe('[Red]MM/yyyy');
    });

    test('quoted literals, escapes and AM/PM markers are never treated as month/minute tokens', () => {
        expect(faOf('"mm" mm/yyyy')).toBe('"mm" MM/yyyy');
        expect(faOf('h:mm AM/PM')).toBe('h:mm AM/PM');
        expect(faOf('h:mm am/pm')).toBe('h:mm am/pm');
        // Escaped m stays a literal; the real token still uppercases.
        expect(faOf('\\m mm/yyyy')).toBe('\\m MM/yyyy');
    });

    test('each section of a multi-section format is classified on its own', () => {
        expect(faOf('dd/mm/yyyy;hh:mm:ss')).toBe('dd/MM/yyyy;hh:mm:ss');
        expect(faOf('mm/dd/yyyy;@')).toBe('MM/dd/yyyy;@');
    });

    test('non-date formats are returned unchanged', () => {
        expect(faOf('#,##0.00')).toBe('#,##0.00');
        expect(faOf('0.00E+00')).toBe('0.00E+00');
        expect(faOf('"€"#,##0.00')).toBe('"€"#,##0.00');
    });

    test('re-casing never changes what numfmt renders (the renderer is case-invariant)', () => {
        // Tue 2024-03-15 13:30:45 as an Excel serial.
        const serial = 45366.56302083333;
        for (const fmt of ['dd/mm/yyyy', 'HH:MM:SS', 'yyyy-mm-dd hh:mm', 'd"-"mmm', '[MM]:ss', 'mm:ss']) {
            expect(update(faOf(fmt), serial)).toBe(update(fmt, serial));
        }
    });
});
