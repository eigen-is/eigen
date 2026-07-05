import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import { escapeRegExp } from 'es-toolkit';

// Shared matcher for what the bar's options MEAN (every surface except the docs PRIMARY path,
// which uses prosemirror-search's SearchQuery). Returns null for an empty query or an invalid
// user regex so call sites treat "no usable query" uniformly.
export function buildSearchRegex(query: string, opts: DocSearchOptions): RegExp | null {
    if (query === '') return null;

    let source = opts.regex ? query : escapeRegExp(query);
    if (opts.wholeWord) source = `\\b(?:${source})\\b`;

    try {
        return new RegExp(source, opts.matchCase ? 'g' : 'gi');
    } catch {
        return null;
    }
}
