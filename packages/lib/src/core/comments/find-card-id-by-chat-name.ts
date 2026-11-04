// Finds the card that holds a chat name, the name a link, an activity row or a search hit knows a comment by. The
// comment lifecycle opens such a comment by the card id this finds, or hands the id to a host that reveals the card's
// anchor first. A chat name no card holds, such as that of a deleted sticky, finds nothing.

import type { CommentCard } from '../../types/comments';

export function findCardIdByChatName(
    cards: Readonly<Record<string, CommentCard>>,
    chatName: string,
): string | undefined {
    return Object.keys(cards).find((cardId) => cards[cardId].chatName === chatName);
}
