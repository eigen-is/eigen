import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import { SearchQuery, search } from 'prosemirror-search';

export type FlashRange = { from: number; to: number } | null;

// One-shot flash for the palette reveal path — the bar is closed, so no query is installed and an
// unfocused editor's selection is invisible. Set via meta; cleared on a timer by the controller.
export const searchFlashKey = new PluginKey<FlashRange>('searchFlash');

// DocSearchOptions -> prosemirror-search SearchQuery. Matching is PER-TEXTBLOCK: the library cannot
// match across block boundaries, which is why the bar has no multiline toggle.
export function buildDocSearchQuery(query: string, opts: DocSearchOptions): SearchQuery {
    return new SearchQuery({
        search: query,
        caseSensitive: opts.matchCase,
        regexp: opts.regex,
        wholeWord: opts.wholeWord,
        literal: !opts.regex,
    });
}

export const SearchHighlight = Extension.create({
    name: 'searchHighlight',

    addProseMirrorPlugins() {
        return [
            // Owns the query + match state AND paints every match itself (.ProseMirror-search-match;
            // the selection-equal one gets .ProseMirror-active-search-match, rebuilt on selectionSet).
            // Never re-paint those from a second plugin — a copy double-darkens every match.
            search(),
            new Plugin<FlashRange>({
                key: searchFlashKey,
                state: {
                    init: () => null,
                    apply: (tr, value) => {
                        const meta = tr.getMeta(searchFlashKey) as FlashRange | undefined;
                        if (meta !== undefined) return meta;
                        if (!value) return value;
                        return { from: tr.mapping.map(value.from), to: tr.mapping.map(value.to) };
                    },
                },
                props: {
                    decorations: (state) => {
                        const flash = searchFlashKey.getState(state);
                        if (!flash || flash.from === flash.to) return DecorationSet.empty;
                        return DecorationSet.create(state.doc, [
                            Decoration.inline(flash.from, flash.to, { class: 'search-flash-match' }),
                        ]);
                    },
                },
            }),
        ];
    },
});
