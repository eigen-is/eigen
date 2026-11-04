// The comment the card dialog shows, named by its card id or by its chat name, with its index row. A chat name no card
// holds, such as that of a sticky deleted from its board, still names a comment while its row stays. Such a comment is
// gone: it has no card, only the row, and the dialog shows it deleted.

import { useMemo } from 'react';
import type { CommentEntry } from '../../../types/chat';
import type { CommentCard } from '../../../types/comments';
import { findCardIdByChatName } from '../find-card-id-by-chat-name';

export type OpenComment = { cardId: string } | { chatName: string };

export function useOpenCommentCard(
    cards: Record<string, CommentCard>,
    entries: readonly CommentEntry[],
    open: OpenComment | null,
): { card: CommentCard | null; entry: CommentEntry | undefined; gone: boolean } {
    return useMemo(() => {
        // A chat name is looked up on every render, so a card that comes back, such as through an undo, opens live.
        const cardId = !open ? undefined : 'cardId' in open ? open.cardId : findCardIdByChatName(cards, open.chatName);
        const card = cardId ? cards[cardId] : undefined;
        if (card) {
            const entry = card.chatName ? entries.find((e) => e.chatName === card.chatName) : undefined;
            return { card, entry, gone: false };
        }
        const entry = open && 'chatName' in open ? entries.find((e) => e.chatName === open.chatName) : undefined;
        return { card: null, entry, gone: !!entry };
    }, [cards, entries, open]);
}
