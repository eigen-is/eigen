import type { CountedWarningCode, ImportTransformJob, TransformWarning } from '../document/transform/protocol';

// What an import answers when the file outgrows a cap or the memory of the transform process, in the format's words.
// Light on purpose: run-transform.ts maps an out-of-memory with these, and must not load a reader to do it.
export const DOCUMENT_TOO_LARGE = 'Document too large';
export const SPREADSHEET_TOO_LARGE = 'Spreadsheet too large';
export const PRESENTATION_TOO_LARGE = 'This presentation is too large to import';

export const IMPORT_TOO_LARGE: Record<ImportTransformJob['sourceFormat'], string> = {
    docx: DOCUMENT_TOO_LARGE,
    xlsx: SPREADSHEET_TOO_LARGE,
    pptx: PRESENTATION_TOO_LARGE,
};

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
