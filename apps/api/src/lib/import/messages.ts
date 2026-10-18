import { ApiError, isOutOfMemory } from '../core/errors';
import { XmlError } from '../core/xml';
import { ZipError } from '../core/zip';
import type { ImportTransformJob } from '../document/transform/protocol';

// What an import answers in the format's words: past a cap or the memory of the transform process, for a file it can't
// read, and for an encrypted one, naming the application that removes the password. Light on purpose: run-transform.ts
// maps an out-of-memory with these, and must not load a reader to do it.

type ImportFormat = ImportTransformJob['sourceFormat'];

export const IMPORT_MESSAGES: Record<ImportFormat, { tooLarge: string; invalid: string; passwordProtected: string }> = {
    docx: {
        tooLarge: 'Document too large',
        invalid: 'Not a valid docx file',
        passwordProtected: 'This document is password-protected. Remove the password in Word and import it again.',
    },
    xlsx: {
        tooLarge: 'Spreadsheet too large',
        invalid: 'Not a valid xlsx file',
        passwordProtected: 'This spreadsheet is password-protected. Remove the password in Excel and import it again.',
    },
};

// The refusals only a spreadsheet has: a row or column past the grid, or more cells than the cap; a workbook whose
// sheets are all charts.
export const TOO_MANY_CELLS = 'Spreadsheet has too many cells';
export const ONLY_CHART_SHEETS = "This workbook only has chart sheets, which Eigen can't open yet";

// The zip's and the XML's messages speak of archives and markup; the user uploaded a document or a spreadsheet, so a
// refusal is told in the format's words. An out-of-memory passes as it is: the transform process answers it for every
// format.
export function importError(error: unknown, format: ImportFormat): Error {
    const messages = IMPORT_MESSAGES[format];
    if (isOutOfMemory(error)) return error;
    if (error instanceof ZipError)
        return new ApiError(error.status, error.status === 413 ? messages.tooLarge : messages.invalid, {
            cause: error,
        });
    if (error instanceof XmlError) return new ApiError(400, messages.invalid, { cause: error });
    if (error instanceof ApiError) return error;
    // A stack the file outgrew; any other RangeError is the reader's slip.
    if (error instanceof RangeError && /call stack/i.test(error.message))
        return new ApiError(413, messages.tooLarge, { cause: error });
    // A file the reader slips on is refused as one it can't read; the slip is a bug, and its cause stays in the transform's log.
    console.warn(
        `[import] the ${format} reader failed:`,
        error instanceof Error ? (error.stack ?? error.message) : error,
    );
    return new ApiError(400, messages.invalid, { cause: error });
}
