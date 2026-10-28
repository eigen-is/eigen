// The sentence-case check of `check-standards.ts` (CODE-STANDARDS § UI labels are sentence case). Finds a word after the
// first that starts with a capital and is not a proper noun, in a string literal given to a label prop and in the text of
// a label element. Zero tolerance: PROPER_NOUNS is the one list, grown only from a real hit.

import { stripNoise } from './strip-noise';

// Names that keep their capital: Eigen and its apps, other products, protocols and formats. An all-caps word of two letters
// or more (PDF, URL, 2FA, IMAP) is an acronym and passes without being listed.
export const PROPER_NOUNS = new Set([
    'Eigen',
    'Drive',
    'Docs',
    'Sheets',
    'Slides',
    'Mail',
    'Calendar',
    'Contacts',
    'Chat',
    'Stickies',
    'Vector',
    'Space',
    'Google',
    'Microsoft',
    'Word',
    'Excel',
    'PowerPoint',
    'Thunderbird',
    'CalDAV',
    'CardDAV',
    'WebDAV',
    'GitHub',
    'Markdown',
    'Enter',
    'Tab',
    'Shift',
    'Ctrl',
    'Cmd',
    'Alt',
    'Esc',
    'Escape',
    'Backspace',
    'Delete',
    'Viewer',
    'Support',
    'Monday',
    'Friday',
    'A',
    'Z',
]);

const LABEL_PROPS = 'label|title|placeholder|tooltipText|submitLabel|dialogTitle|confirmTitle|confirmText|cancelText';
const LABEL_ELEMENTS = /<(?:DialogTitle|Label|FormLabel|FieldLabel)\b/g;
// A literal in `code` (a `const title = …` is a variable, not a prop): stripNoise left the quotes and blanked what sat between them.
const PROP_LITERAL = new RegExp(
    `(?<!\\b(?:const|let|var)\\s)\\b(?:${LABEL_PROPS})\\s*[=:]\\s*\\{?\\s*(['"\`])[ \\n]*\\1`,
    'g',
);

function isCapitalized(word: string): boolean {
    const bare = word.replaceAll(/^[^\p{L}\d]+|[^\p{L}\d]+$/gu, '');
    if (!/^\p{Lu}/u.test(bare) || /^[\p{Lu}\d]{2,}$/u.test(bare)) return false;
    return !PROPER_NOUNS.has(bare.replace(/['’]s$/, ''));
}

// The capitalized words of one label after its first. A label with a `{`, `${` or `\` is dynamic and skipped.
function offendingWords(label: string): string[] {
    if (/[{}\\]/.test(label)) return [];
    return label.trim().split(/\s+/).slice(1).filter(isCapitalized);
}

// Where the opening tag that starts at `start` ends: the first `>` outside braces and quotes.
function openingTagEnd(code: string, start: number): number {
    let depth = 0;
    let quote = '';
    for (let i = start; i < code.length; i++) {
        const char = code[i];
        if (quote) {
            if (char === quote) quote = '';
        } else if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '{') depth++;
        else if (char === '}') depth--;
        else if (char === '>' && depth === 0) return i;
    }
    return code.length;
}

// The demo seed's documents and events are sample user content, not UI.
const SAMPLE_CONTENT = 'apps/api/src/scripts/demo/';

// Every label the source gives as a literal prop or as element text, as written.
function labelsIn(text: string, code: string): string[] {
    const labels: string[] = [];
    for (const match of code.matchAll(PROP_LITERAL)) {
        const open = match.index + match[0].search(/['"`]/);
        labels.push(text.slice(open + 1, match.index + match[0].length - 1));
    }
    for (const match of code.matchAll(LABEL_ELEMENTS)) {
        const tagEnd = openingTagEnd(code, match.index);
        if (code[tagEnd - 1] === '/') continue;
        let end = tagEnd + 1;
        while (end < code.length && /\s/.test(code[end])) end++;
        labels.push(text.slice(tagEnd + 1, end));
    }
    return labels;
}

// One entry per offending label, `"Keep Aspect Ratio" (Aspect, Ratio)`.
export function sentenceCaseHits(path: string, text: string): string[] {
    if (path.startsWith(SAMPLE_CONTENT)) return [];
    const hits: string[] = [];
    for (const label of labelsIn(text, stripNoise(text, path.endsWith('.tsx')))) {
        const words = offendingWords(label);
        if (words.length > 0) hits.push(`"${label.trim()}" (${words.join(', ')})`);
    }
    return hits;
}
