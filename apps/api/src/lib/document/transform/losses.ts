// The one sentence a user reads about what a transform left out or drew simpler, built from the counted warnings a
// reader or a writer returns. An Import… answers with it for its toast, and the export route sends it in a header for
// the toast after a download or a print. Each kind of loss has one noun and one outcome here, so it reads alike in
// every format and both ways. The sentence holds counts and fixed words only, never a name from the document.

import type { CountedWarningCode, TransformWarning } from './protocol';

type OneAndMany = readonly [one: string, many: string];

// What happened to a kind, one clause each, in this order: what is missing first.
const OUTCOMES = ['unread', 'dropped', 'cut', 'simplified', 'renamed', 'flattened', 'unshown'] as const;
type Outcome = (typeof OUTCOMES)[number];

// Each outcome said of one and of more. Only a kind left out depends on the way the document went.
const SAID_EITHER_WAY: Record<Exclude<Outcome, 'dropped'>, OneAndMany> = {
    unread: ["couldn't be read and is missing", "couldn't be read and are missing"],
    cut: ['was cut to fit', 'were cut to fit'],
    simplified: ['was simplified', 'were simplified'],
    renamed: ['was renamed', 'were renamed'],
    flattened: ['lost its layout', 'lost their layout'],
    unshown: ["can't be shown", "can't be shown"],
};
const PREDICATES: Record<'import' | 'export', Record<Outcome, OneAndMany>> = {
    import: { ...SAID_EITHER_WAY, dropped: ['was not imported', 'were not imported'] },
    export: { ...SAID_EITHER_WAY, dropped: ['was left out of the file', 'were left out of the file'] },
};

// Every kind's noun and outcome, whichever reader or writer counted it. Kinds list in this order within their clause.
// A pptx's import counts source shapes, so a master's background is one fill however many slides show it.
const LOSSES: Record<CountedWarningCode, { noun: OneAndMany; what: Outcome }> = {
    'corrupt-blobs-skipped': { noun: ['part of the document', 'parts of the document'], what: 'unread' },
    'tables-dropped': { noun: ['table', 'tables'], what: 'dropped' },
    'tables-simplified': { noun: ['table', 'tables'], what: 'simplified' },
    'charts-dropped': { noun: ['chart', 'charts'], what: 'dropped' },
    'charts-simplified': { noun: ['chart', 'charts'], what: 'simplified' },
    'diagrams-dropped': { noun: ['SmartArt graphic', 'SmartArt graphics'], what: 'dropped' },
    'objects-dropped': { noun: ['embedded object', 'embedded objects'], what: 'dropped' },
    'images-dropped': { noun: ['picture', 'pictures'], what: 'dropped' },
    'mirrors-dropped': { noun: ["picture's flip", "pictures' flips"], what: 'dropped' },
    'bands-cut': { noun: ['header or footer', 'headers or footers'], what: 'cut' },
    'sheets-left-out': { noun: ['sheet', 'sheets'], what: 'dropped' },
    'sheets-cut': { noun: ['sheet', 'sheets'], what: 'cut' },
    'sheet-names-changed': { noun: ['sheet', 'sheets'], what: 'renamed' },
    'cells-dropped': { noun: ['cell', 'cells'], what: 'dropped' },
    'texts-cut': { noun: ['long text', 'long texts'], what: 'cut' },
    'formulas-dropped': { noun: ['formula', 'formulas'], what: 'dropped' },
    'number-formats-dropped': { noun: ['number format', 'number formats'], what: 'dropped' },
    'cell-formats-dropped': { noun: ['cell format', 'cell formats'], what: 'dropped' },
    'links-dropped': { noun: ['link', 'links'], what: 'dropped' },
    'conditional-formats-dropped': { noun: ['conditional format', 'conditional formats'], what: 'dropped' },
    'validations-dropped': { noun: ['data validation rule', 'data validation rules'], what: 'dropped' },
    'validation-prompts-cut': { noun: ['data validation message', 'data validation messages'], what: 'cut' },
    'section-pages-dropped': { noun: ["section's page setup", "sections' page setups"], what: 'dropped' },
    'even-bands-dropped': { noun: ['even-page header or footer', 'even-page headers or footers'], what: 'dropped' },
    'band-content-dropped': { noun: ['header or footer item', 'header or footer items'], what: 'dropped' },
    'shapes-simplified': { noun: ['shape', 'shapes'], what: 'simplified' },
    'fills-simplified': { noun: ['fill', 'fills'], what: 'simplified' },
    'text-simplified': { noun: ['text box', 'text boxes'], what: 'simplified' },
    'band-images-unanchored': { noun: ['header or footer picture', 'header or footer pictures'], what: 'simplified' },
    'blocks-flattened': { noun: ['part of the document', 'parts of the document'], what: 'flattened' },
    'images-unshown': { noun: ['picture', 'pictures'], what: 'unshown' },
};

// "2 tables and 1 SmartArt graphic were not imported; 5 shapes were simplified.", or null when nothing was lost. A
// warning without a count, such as a failed recalc, says nothing.
export function lossSummary(warnings: TransformWarning[], direction: 'import' | 'export'): string | null {
    const counts = new Map<string, number>();
    for (const warning of warnings) {
        if ('count' in warning) counts.set(warning.code, (counts.get(warning.code) ?? 0) + warning.count);
    }
    const clauses: string[] = [];
    for (const outcome of OUTCOMES) {
        const items: string[] = [];
        let total = 0;
        for (const [code, { noun, what }] of Object.entries(LOSSES)) {
            const count = counts.get(code) ?? 0;
            if (what !== outcome || count === 0) continue;
            items.push(`${count} ${count === 1 ? noun[0] : noun[1]}`);
            total += count;
        }
        if (items.length === 0) continue;
        const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
        clauses.push(`${list} ${PREDICATES[direction][outcome][total === 1 ? 0 : 1]}`);
    }
    return clauses.length > 0 ? `${clauses.join('; ')}.` : null;
}
