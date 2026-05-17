import { useMemo } from 'react';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';

export function useUnresolvedCommentCount(
    cards: Record<string, CommentCard>,
    entries: CommentEntry[],
    activeCardIds: Set<string>,
): number {
    return useMemo(() => {
        const activeChatNames = new Set<string>();
        for (const id of activeCardIds) {
            const chatName = cards[id]?.chatName;
            if (chatName) activeChatNames.add(chatName);
        }
        return entries.filter((e) => e.status === 'open' && activeChatNames.has(e.chatName)).length;
    }, [cards, entries, activeCardIds]);
}
