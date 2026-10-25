// What an import answers in the format's words: past a cap or the memory of the transform process, for a file it
// can't read, and for an encrypted one, naming the application that removes the password; and the toast's summary of
// what it left out. Light on purpose: the transform runner maps an out-of-memory with these, and must not load a reader.

import { ApiError, isOutOfMemory } from '../core/errors';
import { XmlError } from '../core/xml';
import type { CountedWarningCode, ImportTransformJob, TransformWarning } from '../document/transform/protocol';
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

type Noun = readonly [one: string, many: string];

// What happened to a kind, one clause each, in this order.
const OUTCOMES = ['dropped', 'simplified', 'flattened', 'unshown'] as const;
type Outcome = (typeof OUTCOMES)[number];

// Each outcome said of one and of more.
const PREDICATES: Record<Outcome, readonly [one: string, many: string]> = {
    dropped: ['was not imported', 'were not imported'],
    simplified: ['was simplified', 'were simplified'],
    flattened: ['lost its layout', 'lost their layout'],
    unshown: ["can't be shown", "can't be shown"],
};

// What an import left out or drew simpler, per kind, for the toast after Import…, whichever format's reader counted it.
// Each kind lists in this order within its clause. A pptx's warnings count source shapes, so a master's background is
// one fill however many slides show it.
const LOSSES: { code: CountedWarningCode; noun: Noun; what: Outcome }[] = [
    { code: 'tables-dropped', noun: ['table', 'tables'], what: 'dropped' },
    { code: 'charts-dropped', noun: ['chart', 'charts'], what: 'dropped' },
    { code: 'diagrams-dropped', noun: ['SmartArt graphic', 'SmartArt graphics'], what: 'dropped' },
    { code: 'objects-dropped', noun: ['embedded object', 'embedded objects'], what: 'dropped' },
    { code: 'images-dropped', noun: ['picture', 'pictures'], what: 'dropped' },
    { code: 'conditional-formats-dropped', noun: ['conditional format', 'conditional formats'], what: 'dropped' },
    { code: 'validations-dropped', noun: ['data validation rule', 'data validation rules'], what: 'dropped' },
    { code: 'section-pages-dropped', noun: ["section's page setup", "sections' page setups"], what: 'dropped' },
    {
        code: 'even-bands-dropped',
        noun: ['even-page header or footer', 'even-page headers or footers'],
        what: 'dropped',
    },
    { code: 'band-content-dropped', noun: ['header or footer item', 'header or footer items'], what: 'dropped' },
    { code: 'charts-simplified', noun: ['chart', 'charts'], what: 'simplified' },
    { code: 'shapes-simplified', noun: ['shape', 'shapes'], what: 'simplified' },
    { code: 'fills-simplified', noun: ['fill', 'fills'], what: 'simplified' },
    { code: 'text-simplified', noun: ['text box', 'text boxes'], what: 'simplified' },
    { code: 'mirrors-dropped', noun: ['flipped picture', 'flipped pictures'], what: 'simplified' },
    {
        code: 'band-images-unanchored',
        noun: ['header or footer picture', 'header or footer pictures'],
        what: 'simplified',
    },
    { code: 'blocks-flattened', noun: ['part of the document', 'parts of the document'], what: 'flattened' },
    { code: 'images-unshown', noun: ['picture', 'pictures'], what: 'unshown' },
];

// "2 tables and 1 SmartArt graphic were not imported", or nothing when no kind was met.
function clause(warnings: TransformWarning[], what: Outcome): string[] {
    const items: string[] = [];
    let total = 0;
    for (const { code, noun, what: outcome } of LOSSES) {
        if (outcome !== what) continue;
        let count = 0;
        for (const warning of warnings) if ('count' in warning && warning.code === code) count += warning.count;
        if (count > 0) items.push(`${count} ${count === 1 ? noun[0] : noun[1]}`);
        total += count;
    }
    if (items.length === 0) return [];
    const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
    return [`${list} ${PREDICATES[what][total === 1 ? 0 : 1]}`];
}

export function importSummary(warnings: TransformWarning[]): string | null {
    const clauses = OUTCOMES.flatMap((what) => clause(warnings, what));
    return clauses.length > 0 ? `${clauses.join('; ')}.` : null;
}
