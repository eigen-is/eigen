import { useMemo } from 'react';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';

// Personal, not document-wide: a plain unresolved count turned every viewer's badge red for threads
// that belong to someone else. Assignee is stored lowercased server-side.
export function useAssignedCommentCount(
    cards: Record<string, CommentCard>,
    entries: CommentEntry[],
    activeCardIds: Set<string>,
    currentUserEmail: string,
): number {
    return useMemo(() => {
        if (!currentUserEmail) return 0;
        const email = currentUserEmail.toLowerCase();
        const activeChatNames = new Set<string>();
        for (const id of activeCardIds) {
            const chatName = cards[id]?.chatName;
            if (chatName) activeChatNames.add(chatName);
        }
        return entries.filter((e) => e.status === 'open' && e.assignee === email && activeChatNames.has(e.chatName))
            .length;
    }, [cards, entries, activeCardIds, currentUserEmail]);
}
