import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import * as engine from '@workspace/sheet/engine';
import { ZipReader } from '../../../lib/core/zip';
import { SERVER_RECALC_BUDGET } from '../../../lib/document/sheets';
import { toTransferableBuffer } from '../../../lib/document/transform/protocol';
import { importXlsxToSheetsSnapshot } from '../../../lib/import/sheets/transform';
import { build, stored } from '../../fixtures/raw-zip';
import { xlsxFixture } from '../../fixtures/xlsx';

// What reading the workbook throws: a slip is a file the reader can't read, an out-of-memory the transform process's.
describe('a throw reading the xlsx', () => {
    const xlsx = toTransferableBuffer(build([stored('[Content_Types].xml', '<Types/>')]));

    function thrownBy(read: () => unknown): unknown {
        try {
            read();
        } catch (error) {
            return error;
        }
        throw new Error('expected a throw');
    }

    test.each([
        ['a slip', new TypeError('slip'), { status: 400, message: 'Not a valid xlsx file' }],
        ['a RangeError of its own', new RangeError('Invalid array length'), { status: 400 }],
        ['a stack the file outgrew', new RangeError('Maximum call stack size exceeded.'), { status: 413 }],
    ])('%s is refused', (_name, thrown, refusal) => {
        const read = spyOn(ZipReader.prototype, 'read').mockImplementationOnce(() => {
            throw thrown;
        });
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(thrownBy(() => importXlsxToSheetsSnapshot(xlsx))).toMatchObject(refusal);
        } finally {
            read.mockRestore();
            warn.mockRestore();
        }
    });

    test('an out-of-memory passes through as it is', () => {
        const outOfMemory = new RangeError('Out of memory');
        const read = spyOn(ZipReader.prototype, 'read').mockImplementationOnce(() => {
            throw outOfMemory;
        });
        try {
            expect(thrownBy(() => importXlsxToSheetsSnapshot(xlsx))).toBe(outOfMemory);
        } finally {
            read.mockRestore();
        }
    });
});

// The import's recalc is the server's, under its budget: past it the recalc fails, and the import keeps Excel's values
// uncomputed (document-transform.test.ts).
describe("the formulas' ranges", () => {
    test("the recalc runs under the server's budget", () => {
        const original = { ...engine };
        const budgets: unknown[] = [];
        mock.module('@workspace/sheet/engine', () => ({
            ...original,
            recalcSheets: (sheets: Sheet[], options?: { maxDependencyBlocks?: number; maxCellsRead?: number }) => {
                budgets.push(options);
                return original.recalcSheets(sheets, options);
            },
        }));
        try {
            importXlsxToSheetsSnapshot(
                toTransferableBuffer(xlsxFixture({ sheets: [{ data: '<row r="1"><c r="A1"><f>1+1</f></c></row>' }] })),
            );
            expect(budgets).toEqual([SERVER_RECALC_BUDGET]);
        } finally {
            mock.module('@workspace/sheet/engine', () => original);
        }
    });
});
