import { useMemo } from 'react';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';

export function useOpenCommentCard(
    cards: Record<string, CommentCard>,
    entries: CommentEntry[],
    openCardId: string | null,
): { card: CommentCard | null; entry: CommentEntry | undefined } {
    return useMemo(() => {
        const card = openCardId ? (cards[openCardId] ?? null) : null;
        const entry = card?.chatName ? entries.find((e) => e.chatName === card.chatName) : undefined;
        return { card, entry };
    }, [cards, entries, openCardId]);
}
