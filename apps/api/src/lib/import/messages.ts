import { ApiError, isOutOfMemory } from '../core/errors';
import { XmlError } from '../core/xml';
import { ZipError } from '../core/zip';
import type { CountedWarningCode, ImportTransformJob, TransformWarning } from '../document/transform/protocol';

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
    pptx: {
        tooLarge: 'This presentation is too large to import',
        invalid: 'Not a valid pptx file',
        passwordProtected:
            'This presentation is password-protected. Remove the password in PowerPoint and import it again.',
    },
};

// The refusals only a spreadsheet has: a row or column past the grid, or more cells than the cap; a workbook whose
// sheets are all charts.
export const TOO_MANY_CELLS = 'Spreadsheet has too many cells';
export const ONLY_CHART_SHEETS = "This workbook only has chart sheets, which Eigen can't open yet";

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

type Noun = readonly [one: string, many: string];

// What a pptx import left out, per kind, for the toast after Import slides…: each warning counts source shapes,
// so a master's background is one fill however many slides show it.
const NOT_IMPORTED: [readonly CountedWarningCode[], Noun][] = [
    [['tables-dropped'], ['table', 'tables']],
    [['charts-dropped'], ['chart', 'charts']],
    [['diagrams-dropped'], ['SmartArt graphic', 'SmartArt graphics']],
    [['objects-dropped'], ['embedded object', 'embedded objects']],
    [
        ['images-dropped', 'images-unshown'],
        ['picture', 'pictures'],
    ],
];
const SIMPLIFIED: [readonly CountedWarningCode[], Noun][] = [
    [['shapes-simplified'], ['shape', 'shapes']],
    [['fills-simplified'], ['fill', 'fills']],
    [['text-simplified'], ['text box', 'text boxes']],
    [['mirrors-dropped'], ['flipped picture', 'flipped pictures']],
];

// "2 tables and 1 SmartArt graphic were not imported", or nothing when no kind was met.
function clause(warnings: TransformWarning[], kinds: [readonly CountedWarningCode[], Noun][], what: string): string[] {
    const items: string[] = [];
    let total = 0;
    for (const [codes, [one, many]] of kinds) {
        let count = 0;
        for (const warning of warnings) if ('count' in warning && codes.includes(warning.code)) count += warning.count;
        if (count > 0) items.push(`${count} ${count === 1 ? one : many}`);
        total += count;
    }
    if (items.length === 0) return [];
    const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
    return [`${list} ${total === 1 ? 'was' : 'were'} ${what}`];
}

export function importSummary(warnings: TransformWarning[]): string | null {
    const clauses = [...clause(warnings, NOT_IMPORTED, 'not imported'), ...clause(warnings, SIMPLIFIED, 'simplified')];
    return clauses.length > 0 ? `${clauses.join('; ')}.` : null;
}
