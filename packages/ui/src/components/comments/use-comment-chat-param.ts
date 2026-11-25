// The open comment thread as the editor page's ?chat=, in the shape the comment lifecycle takes, so an editor such as
// docs or a board hands it on as it is. Opening and closing follow the detail history rule, so a phone's back closes a
// thread; dropping a chat, after a delete or for one that names nothing, replaces the entry. Every editor route reads
// ?chat=, so only those routes' apps compile this.

import { useNavigate } from '@tanstack/react-router';
import { useDetailHistory } from '../../hooks/use-detail-history';

type CommentChatParam = {
    chat: string | undefined;
    onOpenChat: (chatName: string) => void;
    onCloseChat: () => void;
    onClearChat: () => void;
};

export function useCommentChatParam(chat: string | undefined): CommentChatParam {
    const navigate = useNavigate();
    const { open, close } = useDetailHistory(chat, (next, { replace, state }) =>
        navigate({ to: '.', search: (prev: { chat?: string }) => ({ ...prev, chat: next }), replace, state }),
    );
    return {
        chat,
        onOpenChat: open,
        onCloseChat: close,
        onClearChat: () =>
            navigate({ to: '.', search: (prev: { chat?: string }) => ({ ...prev, chat: undefined }), replace: true }),
    };
}
