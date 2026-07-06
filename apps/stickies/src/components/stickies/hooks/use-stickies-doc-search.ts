import { buildSearchRegex } from '@workspace/lib/doc-search';
import type { CommentCard } from '@workspace/lib/types/comments';
import type { DocSearchController } from '@workspace/lib/types/doc-search';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { searchBoard } from '../search-board';
import type { BoardData } from '../types';

type StickiesDocSearchArgs = {
    board: BoardData;
    cards: Record<string, CommentCard>;
    // The board's color filter hides cards; scan only the visible ones so n/m matches what reveal can
    // scroll to (a filtered-out card has no DOM anchor). Column titles always match — columns are never hidden.
    colorFilter: Set<string>;
    boardScrollRef: RefObject<HTMLDivElement | null>;
};

export function useStickiesDocSearch({ board, cards, colorFilter, boardScrollRef }: StickiesDocSearchArgs): {
    controller: DocSearchController;
    highlightedCardIds: ReadonlySet<string>;
    highlightedColumnIds: ReadonlySet<string>;
} {
    const [highlightedCardIds, setHighlightedCardIds] = useState<ReadonlySet<string>>(new Set());
    const [highlightedColumnIds, setHighlightedColumnIds] = useState<ReadonlySet<string>>(new Set());

    // reveal() only records its target; the scroll + flash run in the effect below, AFTER commit. The
    // same-tick highlightAll re-render rewrites the card className, which would strip a flash class added
    // synchronously here before paint. The nonce restarts the one-shot flash on a repeat reveal of the
    // same card (a single-match Enter re-reveals the same node).
    const revealNonce = useRef(0);
    const [revealTarget, setRevealTarget] = useState<{ id: string; nonce: number } | null>(null);

    // useMemo keys on board/cards/colorFilter, so every local/remote change (or filter change)
    // republishes a new controller identity and the provider re-runs the search (contract rule 4).
    const controller = useMemo<DocSearchController>(() => {
        const visibleCards =
            colorFilter.size === 0
                ? cards
                : Object.fromEntries(Object.entries(cards).filter(([, c]) => colorFilter.has(c.color || '')));
        return {
            search: (query, opts) => {
                const regex = buildSearchRegex(query, opts);
                return regex ? searchBoard(board, visibleCards, regex) : [];
            },
            highlightAll: (matches) => {
                const cardIds = new Set<string>();
                const columnIds = new Set<string>();
                for (const m of matches) {
                    if (m.id.startsWith('card:')) cardIds.add(m.id.slice(5));
                    else if (m.id.startsWith('column:')) columnIds.add(m.id.slice(7));
                }
                setHighlightedCardIds(cardIds);
                setHighlightedColumnIds(columnIds);
            },
            reveal: (matchId) => setRevealTarget({ id: matchId, nonce: ++revealNonce.current }),
        };
    }, [board, cards, colorFilter]);

    useEffect(() => {
        if (!revealTarget) return;
        const el = boardScrollRef.current?.querySelector<HTMLElement>(`[data-search-anchor="${revealTarget.id}"]`);
        if (!el) return; // contract rule 2: filtered-out / stale id → no-op
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        // Restart the one-shot flash even when re-revealing the same node.
        el.classList.remove('eigen-search-flash');
        void el.offsetWidth;
        el.classList.add('eigen-search-flash');
        el.addEventListener('animationend', () => el.classList.remove('eigen-search-flash'), { once: true });
    }, [revealTarget, boardScrollRef]);

    return { controller, highlightedCardIds, highlightedColumnIds };
}
