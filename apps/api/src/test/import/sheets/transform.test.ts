import { describe, expect, spyOn, test } from 'bun:test';
import { ApiError } from '../../../lib/core/errors';
import { ZipReader } from '../../../lib/core/zip';
import { toTransferableBuffer } from '../../../lib/document/transform/protocol';
import { importXlsxToSheetsSnapshot } from '../../../lib/import/sheets/transform';
import { build, stored } from '../../fixtures/raw-zip';

// What reading the workbook throws: a slip is a file the reader can't read, an out-of-memory the transform process's.
describe('a throw reading the xlsx', () => {
    const xlsx = toTransferableBuffer(build([stored('[Content_Types].xml', '<Types/>')]));

    test.each([
        ['a slip', new TypeError('slip')],
        ['a RangeError of its own', new RangeError('Invalid array length')],
    ])('%s is a 400', async (_name, thrown) => {
        const read = spyOn(ZipReader.prototype, 'files').mockImplementationOnce(() => {
            throw thrown;
        });
        try {
            const error = await importXlsxToSheetsSnapshot(xlsx).catch((reason: unknown) => reason);
            expect(error).toBeInstanceOf(ApiError);
            expect(error).toMatchObject({ status: 400, message: 'Not a valid xlsx file' });
        } finally {
            read.mockRestore();
        }
    });

    test('an out-of-memory passes through as it is', async () => {
        const outOfMemory = new RangeError('Out of memory');
        const read = spyOn(ZipReader.prototype, 'files').mockImplementationOnce(() => {
            throw outOfMemory;
        });
        try {
            expect(await importXlsxToSheetsSnapshot(xlsx).catch((reason: unknown) => reason)).toBe(outOfMemory);
        } finally {
            read.mockRestore();
        }
    });
});
