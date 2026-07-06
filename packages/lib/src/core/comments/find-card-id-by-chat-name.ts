import type { CommentCard } from '../../types/comments';

// The chatName → cardId resolution shared by the ?chat= URL hook and the comment-search reveals.
export function findCardIdByChatName(cards: Record<string, CommentCard>, chatName: string): string | undefined {
    for (const cardId in cards) {
        if (cards[cardId].chatName === chatName) return cardId;
    }
    return undefined;
}
