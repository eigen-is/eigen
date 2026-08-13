import type { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { applyPreserveCase } from '@workspace/lib/doc-search';
import type { DocSearchController, DocSearchMatch } from '@workspace/lib/types/doc-search';
import { getSearchState, SearchQuery, setSearchState } from 'prosemirror-search';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildDocSearchQuery, searchFlashKey } from './prosemirror-search-highlight';

// An empty query paints nothing — used to clear the highlights.
const EMPTY_QUERY = new SearchQuery({ search: '' });
const FLASH_MS = 800;
// Republish cadence (amendment 9): coarse enough not to republish per keystroke, but a THROTTLE
// not a debounce — a trailing debounce's edge never fires while edits stream in, so it must tick.
const REPUBLISH_INTERVAL_MS = 300;

// All live match ranges for a query, in document order. Zero-width matches (degenerate regexes like
// `a*`) aren't painted by the library — skip them so n of m matches what's on screen.
function findRanges(state: EditorState, sq: SearchQuery): { from: number; to: number }[] {
    const size = state.doc.content.size;
    const out: { from: number; to: number }[] = [];
    for (let pos = 0; ; ) {
        const result = sq.findNext(state, pos, size);
        if (!result) break;
        if (result.to > result.from) out.push({ from: result.from, to: result.to });
        pos = result.to > result.from ? result.to : result.from + 1;
        if (pos >= size) break;
    }
    return out;
}

export function useProseMirrorSearchController(editor: Editor | null, canWrite: boolean): DocSearchController {
    // The query built by the LAST search()/replace()/replaceAll(). Read ONLY by highlightAll, which
    // is safe (contract rule 3): paint always follows the immediately-preceding search-shaped call
    // on this controller. reveal parses its id and replace receives the query explicitly, so
    // interleaved palette calls can't corrupt a bar session.
    const queryRef = useRef<SearchQuery | null>(null);

    // Republish on doc change so the provider's re-search keeps n of m live. The search plugin remaps
    // its own decorations per transaction, but the provider's match list would freeze otherwise.
    // Throttled, not debounced: during sustained editing (local typing OR a remote collaborator) the
    // `update` stream never pauses, so a trailing debounce is starved and the count sticks while the
    // paint keeps moving. Tick at a fixed cadence while dirty; settle one tick after edits stop.
    const [docVersion, setDocVersion] = useState(0);
    useEffect(() => {
        if (!editor) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let dirty = false;
        const tick = () => {
            if (!dirty) {
                timer = undefined;
                return;
            }
            dirty = false;
            setDocVersion((v) => v + 1);
            timer = setTimeout(tick, REPUBLISH_INTERVAL_MS);
        };
        const onUpdate = () => {
            dirty = true;
            timer ??= setTimeout(tick, REPUBLISH_INTERVAL_MS);
        };
        editor.on('update', onUpdate);
        return () => {
            clearTimeout(timer);
            editor.off('update', onUpdate);
        };
    }, [editor]);

    return useMemo<DocSearchController>(() => {
        void docVersion; // new identity per (throttled) doc change — keeps n of m live

        // context = the match inside its surrounding sentence fragment, so the palette's
        // IN DOCUMENT rows distinguish occurrences (six bare "launch" rows don't).
        const SNIPPET = 24;
        const toMatches = (state: EditorState, sq: SearchQuery): DocSearchMatch[] =>
            findRanges(state, sq).map((r) => {
                const $from = state.doc.resolve(r.from);
                const block = $from.parent.textContent;
                const start = r.from - $from.start();
                const end = start + (r.to - r.from);
                const context =
                    (start > SNIPPET ? '…' : '') +
                    block.slice(Math.max(0, start - SNIPPET), Math.min(block.length, end + SNIPPET)) +
                    (end + SNIPPET < block.length ? '…' : '');
                return {
                    id: `${r.from}:${r.to}`,
                    label: state.doc.textBetween(r.from, r.to, ' '),
                    context: context.trim(),
                };
            });

        return {
            search(query, opts) {
                if (!editor || query === '') {
                    queryRef.current = null;
                    return [];
                }
                const sq = buildDocSearchQuery(query, opts);
                if (!sq.valid) {
                    queryRef.current = null;
                    return [];
                }
                queryRef.current = sq;
                return toMatches(editor.view.state, sq);
            },

            highlightAll(matches) {
                if (!editor) return;
                const { view } = editor;
                const query = matches.length > 0 ? (queryRef.current ?? EMPTY_QUERY) : EMPTY_QUERY;
                view.dispatch(setSearchState(view.state.tr, query));
            },

            reveal(matchId) {
                if (!editor) return;
                const { view } = editor;
                const [from, to] = matchId.split(':').map(Number);
                // Contract rule 2: ids go stale under collab edits, and an out-of-range position
                // THROWS in TextSelection.create — validate against the current doc, never throw.
                if (!Number.isInteger(from) || !Number.isInteger(to)) return;
                if (from < 0 || to <= from || to > view.state.doc.content.size) return;
                // Bar closed (palette path): no query installed and an unfocused editor's selection is
                // invisible — flash the match instead (one-shot, self-clearing).
                const installed = getSearchState(view.state)?.query;
                const flash = !installed || installed.search === '';
                // No .focus(): keep the caret in the bar input so Enter / ⌘G keep stepping.
                const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to));
                if (flash) tr.setMeta(searchFlashKey, { from, to });
                view.dispatch(tr);
                // Centre the match (amendment 11) so the top-right bar can't cover it. The painted
                // decoration span exists synchronously after dispatch; native centring is scale-aware.
                const el = view.dom.querySelector('.ProseMirror-active-search-match, .search-flash-match');
                if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
                else view.dispatch(view.state.tr.scrollIntoView());
                if (flash) {
                    setTimeout(() => {
                        if (view.isDestroyed) return;
                        // Clear whatever flash exists — a concurrent edit remaps the stored coords
                        // away from {from,to}, so a coord-equality guard would strand the decoration.
                        if (searchFlashKey.getState(view.state)) {
                            view.dispatch(view.state.tr.setMeta(searchFlashKey, null));
                        }
                    }, FLASH_MS);
                }
            },

            canReplace: canWrite,

            // Rewrite the one range the id encodes, then re-search the post-edit doc (editor state
            // updates synchronously after dispatch). The query arrives explicitly and is NEVER read
            // from queryRef — a palette search on this shared controller may have overwritten it
            // since the bar's last search. Stale-verify first: an id whose range is no longer a live
            // match no-ops and returns the current fresh list (collab shifts positions).
            replace(matchId, query, replacement, opts, preserveCase) {
                if (!editor || query === '') return [];
                const sq = buildDocSearchQuery(query, opts);
                if (!sq.valid) return [];
                queryRef.current = sq; // resync the paint query — highlightAll follows this call
                const fresh = () => toMatches(editor.view.state, sq);
                if (!canWrite) return fresh();
                const { view } = editor;
                const [from, to] = matchId.split(':').map(Number);
                if (!Number.isInteger(from) || !Number.isInteger(to)) return fresh();
                if (!findRanges(view.state, sq).some((r) => r.from === from && r.to === to)) return fresh();
                const matched = view.state.doc.textBetween(from, to);
                // Literal insert (no $1/$& expansion); preserve-case per the matched run.
                view.dispatch(
                    view.state.tr.insertText(
                        preserveCase ? applyPreserveCase(matched, replacement) : replacement,
                        from,
                        to,
                    ),
                );
                return fresh();
            },

            // Every match in ONE transaction (one Yjs undo). Iterate high-to-low so an edit never
            // shifts a not-yet-processed lower range. Literal insert + per-run preserve-case.
            replaceAll(query, replacement, opts, preserveCase) {
                if (!editor || query === '') return { replaced: 0, matches: [] };
                const sq = buildDocSearchQuery(query, opts);
                queryRef.current = sq.valid ? sq : null;
                const { view } = editor;
                if (!canWrite || !sq.valid) return { replaced: 0, matches: sq.valid ? toMatches(view.state, sq) : [] };
                const ranges = findRanges(view.state, sq);
                if (ranges.length === 0) return { replaced: 0, matches: [] };
                const tr = view.state.tr;
                for (let i = ranges.length - 1; i >= 0; i -= 1) {
                    const { from, to } = ranges[i];
                    const matched = view.state.doc.textBetween(from, to);
                    tr.insertText(preserveCase ? applyPreserveCase(matched, replacement) : replacement, from, to);
                }
                view.dispatch(tr);
                return { replaced: ranges.length, matches: toMatches(view.state, sq) };
            },
        };
    }, [editor, canWrite, docVersion]);
}
