// The one rule for a deleted card, which every place that shows a card reads, such as the pane, the card dialog and the
// comment menus. A card is deleted when its host no longer uses it, such as a mark nobody anchors any more, or when its
// thread is gone from the chat folder, which a sweep after the last tab closed can do. Neither half decides early: the
// host's active set counts once the host says it is ready, and a thread counts as gone once the listing's refetch
// settled, so a new comment never flashes deleted.

import type { CommentCard } from '../../../types/comments';
import { useMediaResolver } from '../../drive';

export function useIsCardDeleted(activeCardIds: ReadonlySet<string>, ready: boolean): (card: CommentCard) => boolean {
    const { resolveChatId, isChatMissing } = useMediaResolver();
    // resolveChatId runs first: a name the listing lacks asks for the refetch that isChatMissing waits on.
    return (card) =>
        ready &&
        (!activeCardIds.has(card.id) ||
            (!!card.chatName && !resolveChatId(card.chatName) && isChatMissing(card.chatName)));
}
