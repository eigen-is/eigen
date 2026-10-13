import type { ImportTransformJob } from '../document/transform/protocol';

// What an import answers when the file outgrows a cap or the memory of the transform process, in the format's words.
// Light on purpose: run-transform.ts maps an out-of-memory with these, and must not load a reader to do it.
export const DOCUMENT_TOO_LARGE = 'Document too large';
export const SPREADSHEET_TOO_LARGE = 'Spreadsheet too large';

export const IMPORT_TOO_LARGE: Record<ImportTransformJob['sourceFormat'], string> = {
    docx: DOCUMENT_TOO_LARGE,
    xlsx: SPREADSHEET_TOO_LARGE,
};
