// What an import answers in the format's words: past a cap or the memory of the transform process, for a file it
// can't read, and for an encrypted one, naming the application that removes the password. Light on purpose: the
// transform runner maps an out-of-memory with these, and must not load a reader.

import { ApiError, isOutOfMemory } from '../core/errors';
import { XmlError } from '../core/xml';
import type { ImportTransformJob } from '../document/transform/protocol';
import { ZipError } from '../ooxml/zip';

type ImportFormat = ImportTransformJob['sourceFormat'];

export const IMPORT_MESSAGES: Record<ImportFormat, { tooLarge: string; invalid: string; passwordProtected: string }> = {
    docx: {
        tooLarge: 'This document is too large to import',
        invalid: 'Not a valid docx file',
        passwordProtected: 'This document is password-protected. Remove the password in Word and import it again.',
    },
    xlsx: {
        tooLarge: 'This spreadsheet is too large to import',
        invalid: 'Not a valid xlsx file',
        passwordProtected: 'This spreadsheet is password-protected. Remove the password in Excel and import it again.',
    },
    pptx: {
        tooLarge: 'This presentation is too large to import',
        invalid: 'Not a valid pptx file',
        passwordProtected:
            'This presentation is password-protected. Remove the password in PowerPoint and import it again.',
    },
};

// The refusal only a spreadsheet has: a row or column past the grid, or more cells than the cap.
export const TOO_MANY_CELLS = 'Spreadsheet has too many cells';

// The zip's and the XML's messages speak of archives and markup; the user uploaded a document, a spreadsheet or a
// presentation, so a refusal is told in the format's words. An out-of-memory passes as it is: the transform process
// answers it for every format.
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

export const PRESENTATION_EMPTY = 'This presentation has no slides';
// A macro deck, template or slideshow saved under .pptx.
export const SAVE_AS_PPTX =
    'Only .pptx presentations can be imported. Save the file as a .pptx in PowerPoint and import it again.';
