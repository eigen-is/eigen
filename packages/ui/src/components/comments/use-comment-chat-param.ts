// The open comment thread as the editor page's ?chat=, in the shape the comment lifecycle takes, so an editor such as
// a Stickies board hands it on as it is. Every write follows the detail history rule, so a phone's back closes a thread;
// dropping a chat, after a delete or for one that names nothing, replaces the entry and keeps its state, so a column
// pushed before it still closes by going back. It writes the current route's search, under an editor route.

import { useNavigate } from '@tanstack/react-router';
import type { DetailHistoryOptions } from '../../hooks/use-detail-history';
import { useDetailHistory } from '../../hooks/use-detail-history';

type CommentChatParam = {
    chat: string | undefined;
    onOpenChat: (chatName: string) => void;
    onCloseChat: () => void;
    onClearChat: () => void;
};

export function useCommentChatParam(chat: string | undefined): CommentChatParam {
    const navigate = useNavigate();
    const setChat = (next: string | undefined, { replace, state }: DetailHistoryOptions) =>
        navigate({ to: '.', search: (prev: { chat?: string }) => ({ ...prev, chat: next }), replace, state });
    const { open, close } = useDetailHistory(chat, setChat);
    return {
        chat,
        onOpenChat: open,
        onCloseChat: close,
        onClearChat: () => setChat(undefined, { replace: true, state: true }),
    };
}
