// What an import answers in the format's words: past a cap or the memory of the transform process, for a file it can't
// read, and for an encrypted one, naming the application that removes the password. Light on purpose: run-transform.ts
// maps an out-of-memory with these, and must not load a reader to do it.

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

// What an import left out or drew simpler, per kind, for the toast after Import…, whichever format's reader counted it.
// Each kind lists in this order within its clause. A pptx's warnings count source shapes, so a master's background is
// one fill however many slides show it.
const LOSSES: { codes: readonly CountedWarningCode[]; noun: Noun; what: 'not imported' | 'simplified' }[] = [
    { codes: ['tables-dropped'], noun: ['table', 'tables'], what: 'not imported' },
    { codes: ['charts-dropped'], noun: ['chart', 'charts'], what: 'not imported' },
    { codes: ['diagrams-dropped'], noun: ['SmartArt graphic', 'SmartArt graphics'], what: 'not imported' },
    { codes: ['objects-dropped'], noun: ['embedded object', 'embedded objects'], what: 'not imported' },
    { codes: ['images-dropped', 'images-unshown'], noun: ['picture', 'pictures'], what: 'not imported' },
    {
        codes: ['conditional-formats-dropped'],
        noun: ['conditional format', 'conditional formats'],
        what: 'not imported',
    },
    { codes: ['section-pages-dropped'], noun: ['section page setup', 'section page setups'], what: 'not imported' },
    {
        codes: ['even-bands-dropped'],
        noun: ['even-page header or footer', 'even-page headers or footers'],
        what: 'not imported',
    },
    {
        codes: ['band-content-dropped'],
        noun: ['header or footer item', 'header or footer items'],
        what: 'not imported',
    },
    { codes: ['shapes-simplified'], noun: ['shape', 'shapes'], what: 'simplified' },
    { codes: ['fills-simplified'], noun: ['fill', 'fills'], what: 'simplified' },
    { codes: ['text-simplified'], noun: ['text box', 'text boxes'], what: 'simplified' },
    { codes: ['mirrors-dropped'], noun: ['flipped picture', 'flipped pictures'], what: 'simplified' },
    { codes: ['blocks-flattened'], noun: ['block', 'blocks'], what: 'simplified' },
    {
        codes: ['band-images-unanchored'],
        noun: ['header or footer picture', 'header or footer pictures'],
        what: 'simplified',
    },
];

// "2 tables and 1 SmartArt graphic were not imported", or nothing when no kind was met.
function clause(warnings: TransformWarning[], what: (typeof LOSSES)[number]['what']): string[] {
    const items: string[] = [];
    let total = 0;
    for (const { codes, noun, what: kind } of LOSSES) {
        if (kind !== what) continue;
        let count = 0;
        for (const warning of warnings) if ('count' in warning && codes.includes(warning.code)) count += warning.count;
        if (count > 0) items.push(`${count} ${count === 1 ? noun[0] : noun[1]}`);
        total += count;
    }
    if (items.length === 0) return [];
    const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
    return [`${list} ${total === 1 ? 'was' : 'were'} ${what}`];
}

export function importSummary(warnings: TransformWarning[]): string | null {
    const clauses = [...clause(warnings, 'not imported'), ...clause(warnings, 'simplified')];
    return clauses.length > 0 ? `${clauses.join('; ')}.` : null;
}
