import type { ImportTransformJob } from '../document/transform/protocol';

// What an import answers in the format's words: past a cap or the memory of the transform process, for a file it can't
// read, and for an encrypted one, naming the application that removes the password. Light on purpose: run-transform.ts
// maps an out-of-memory with these, and must not load a reader to do it.
export const DOCUMENT_TOO_LARGE = 'Document too large';
export const SPREADSHEET_TOO_LARGE = 'Spreadsheet too large';
export const TOO_MANY_CELLS = 'Spreadsheet has too many cells';
export const NOT_A_DOCX = 'Not a valid docx file';
export const NOT_AN_XLSX = 'Not a valid xlsx file';

type ImportMessages = { tooLarge: string; invalid: string; passwordProtected: string };

export const IMPORT_MESSAGES: Record<ImportTransformJob['sourceFormat'], ImportMessages> = {
    docx: {
        tooLarge: DOCUMENT_TOO_LARGE,
        invalid: NOT_A_DOCX,
        passwordProtected: 'This document is password-protected. Remove the password in Word and import it again.',
    },
    xlsx: {
        tooLarge: SPREADSHEET_TOO_LARGE,
        invalid: NOT_AN_XLSX,
        passwordProtected: 'This spreadsheet is password-protected. Remove the password in Excel and import it again.',
    },
};
