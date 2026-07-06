import { EditorSelection, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { applyPreserveCase, buildSearchRegex } from '@workspace/lib/doc-search';
import type { DocSearchController, DocSearchMatch } from '@workspace/lib/types/doc-search';
import { useEffect, useMemo, useState } from 'react';

// Same throttle cadence as the ProseMirror controller: republish n of m while the doc changes under
// an open bar, without rebuilding per keystroke.
const REPUBLISH_INTERVAL_MS = 300;
const SNIPPET = 24;

type Range = { from: number; to: number };

// Ranges painted by highlightAll. The single source of truth all four editors share
// (.eigen-search-match / -active in globals.css); the active one is the range equal to the selection,
// which reveal() sets — so stepping needs only a selection change, no separate active effect.
const setMatchesEffect = StateEffect.define<Range[]>();

const matchField = StateField.define<Range[]>({
    create: () => [],
    update(value, tr) {
        for (const effect of tr.effects) if (effect.is(setMatchesEffect)) return effect.value;
        if (!tr.docChanged || value.length === 0) return value;
        // Map ranges through the edit so highlights follow until the next republish repaints.
        const mapped: Range[] = [];
        for (const range of value) {
            const from = tr.changes.mapPos(range.from, 1);
            const to = tr.changes.mapPos(range.to, -1);
            if (to > from) mapped.push({ from, to });
        }
        return mapped;
    },
});

const matchDecorations = EditorView.decorations.compute([matchField, 'selection'], (state) => {
    const ranges = state.field(matchField);
    if (ranges.length === 0) return Decoration.none;
    const sel = state.selection.main;
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of ranges) {
        const active = range.from === sel.from && range.to === sel.to;
        builder.add(
            range.from,
            range.to,
            Decoration.mark({ class: active ? 'eigen-search-match-active' : 'eigen-search-match' }),
        );
    }
    return builder.finish();
});

function findMatches(view: EditorView, regex: RegExp): DocSearchMatch[] {
    const text = view.state.doc.toString();
    const out: DocSearchMatch[] = [];
    regex.lastIndex = 0;
    for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
        if (m[0] === '') {
            regex.lastIndex += 1;
            continue;
        }
        const from = m.index;
        const to = from + m[0].length;
        const line = view.state.doc.lineAt(from);
        const start = from - line.from;
        const end = Math.min(to - line.from, line.length);
        const context =
            (start > SNIPPET ? '…' : '') +
            line.text.slice(Math.max(0, start - SNIPPET), Math.min(line.length, end + SNIPPET)) +
            (end + SNIPPET < line.length ? '…' : '');
        out.push({ id: `${from}:${to}`, label: m[0], context: context.trim() });
    }
    return out;
}

// DocSearchController over a CodeMirror 6 view. Uses the shared buildSearchRegex over the plain doc
// string so txt/code and markdown-source match the same way as every other editor; a small
// StateField paints highlightAll and reveal marks the active match via the selection.
export function useCodeMirrorSearchController(view: EditorView | null, canWrite: boolean): DocSearchController {
    const [docVersion, setDocVersion] = useState(0);

    // Install the decoration field + a throttled republish listener once the view exists (appended,
    // since the view is created by CodeEditorView before this controller mounts). The view is
    // destroyed on unmount / dark-mode swap, so the appended config never leaks across instances.
    useEffect(() => {
        if (!view) return;
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
        const listener = EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            dirty = true;
            timer ??= setTimeout(tick, REPUBLISH_INTERVAL_MS);
        });
        view.dispatch({ effects: StateEffect.appendConfig.of([matchField, matchDecorations, listener]) });
        return () => clearTimeout(timer);
    }, [view]);

    return useMemo<DocSearchController>(() => {
        void docVersion; // new identity per (throttled) doc change — keeps n of m live

        return {
            search(query, opts) {
                if (!view || query === '') return [];
                const regex = buildSearchRegex(query, opts);
                if (!regex) return [];
                return findMatches(view, regex);
            },

            highlightAll(matches) {
                if (!view) return;
                const len = view.state.doc.length;
                const ranges: Range[] = [];
                for (const match of matches) {
                    const [from, to] = match.id.split(':').map(Number);
                    if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from && to <= len) {
                        ranges.push({ from, to });
                    }
                }
                view.dispatch({ effects: setMatchesEffect.of(ranges) });
            },

            reveal(matchId) {
                if (!view) return;
                const [from, to] = matchId.split(':').map(Number);
                // Contract rule 2: ids go stale under edits — validate/clamp, never throw or focus.
                if (!Number.isInteger(from) || !Number.isInteger(to)) return;
                if (from < 0 || to <= from || to > view.state.doc.length) return;
                view.dispatch({
                    selection: EditorSelection.single(from, to),
                    effects: EditorView.scrollIntoView(from, { y: 'center' }),
                });
            },

            canReplace: canWrite,

            // The query is EXPLICIT (never a cached term); stale-verify the id against a fresh scan,
            // then rewrite the one range. view.state updates synchronously after dispatch, so the
            // returned list is the post-edit truth the provider adopts.
            replace(matchId, query, replacement, opts, preserveCase) {
                if (!view || query === '') return [];
                const regex = buildSearchRegex(query, opts);
                if (!regex) return [];
                const before = findMatches(view, regex);
                if (!canWrite || !before.some((m) => m.id === matchId)) return before;
                const [from, to] = matchId.split(':').map(Number);
                const matched = view.state.doc.sliceString(from, to);
                view.dispatch({
                    changes: { from, to, insert: preserveCase ? applyPreserveCase(matched, replacement) : replacement },
                });
                return findMatches(view, regex);
            },

            // One transaction (one undo). CodeMirror maps the non-overlapping change set itself.
            replaceAll(query, replacement, opts, preserveCase) {
                if (!view || query === '') return { replaced: 0, matches: [] };
                const regex = buildSearchRegex(query, opts);
                if (!regex) return { replaced: 0, matches: [] };
                const before = findMatches(view, regex);
                if (!canWrite || before.length === 0) return { replaced: 0, matches: before };
                const changes = before.map((m) => {
                    const [from, to] = m.id.split(':').map(Number);
                    const matched = view.state.doc.sliceString(from, to);
                    return { from, to, insert: preserveCase ? applyPreserveCase(matched, replacement) : replacement };
                });
                view.dispatch({ changes });
                return { replaced: before.length, matches: findMatches(view, regex) };
            },
        };
    }, [view, canWrite, docVersion]);
}
