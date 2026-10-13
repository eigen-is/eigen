import { describe, expect, spyOn, test } from 'bun:test';
import { ZipReader } from '../../../lib/core/zip';
import { toTransferableBuffer } from '../../../lib/document/transform/protocol';
import { importXlsxToSheetsSnapshot } from '../../../lib/import/sheets/transform';
import { build, stored } from '../../fixtures/raw-zip';

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
