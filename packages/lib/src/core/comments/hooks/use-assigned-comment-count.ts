// The number on a document's comments button: the open comments assigned to this user that the document still uses.
// It is personal, not document-wide, because a count of every open comment would turn every viewer's badge red for
// threads that belong to someone else. The server stores the assignee in lowercase.

import { useMemo } from 'react';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';

export function useAssignedCommentCount(
    cards: Record<string, CommentCard>,
    entries: readonly CommentEntry[],
    activeCardIds: ReadonlySet<string>,
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
