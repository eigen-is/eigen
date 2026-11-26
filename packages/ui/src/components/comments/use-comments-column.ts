// A document's comments column, such as a canvas app's: the comment lifecycle, and the column's open state in the
// page's URL, the list level as ?panel=comments or ?panel=activity and the thread it drilled into as ?chat=. It follows
// the detail history rule: opening from closed pushes, a move between the list and a thread replaces, and close goes
// back over that push or replaces on a link. A card with no chat opens in the lifecycle alone, without a URL. The host
// draws the toolbar's toggles from it and the shell renders CommentsColumn while it is open.

import { useNavigate } from '@tanstack/react-router';
import { useCommentLifecycle } from '@workspace/lib/comments';
import type { DocumentPanel } from '@workspace/lib/types/comments';
import { useState } from 'react';
import { useDetailHistory } from '../../hooks/use-detail-history';
import { columnWidthPx } from '../layout/app/column-widths';
import { useLayout } from '../layout/app/layout-context';

type CommentsColumnUrl = { panel?: DocumentPanel; chat?: string };

type CommentsColumnArgs = Omit<
    Parameters<typeof useCommentLifecycle>[0],
    'chat' | 'onOpenChat' | 'onCloseChat' | 'onClearChat'
> & {
    // The route's ?panel= and ?chat=.
    panel: DocumentPanel | undefined;
    chat: string | undefined;
    // Brings a card's anchor into view as a list or activity row opens its thread. It hears how far the column grows
    // over what is beside it as the thread opens.
    reveal?: (cardId: string, growPx: number) => void;
};

export type CommentsColumnState = {
    open: boolean;
    // The list behind the column, which a thread goes back to.
    listPanel: DocumentPanel;
    threadOpen: boolean;
    width: 'small' | 'medium';
    // How much wider a thread is than the list.
    growPx: number;
    commentPanelOpen: boolean;
    activityPanelOpen: boolean;
    toggleComments: () => void;
    toggleActivity: () => void;
    // A list row's and an activity row's open, which reveal the anchor first.
    openThread: (cardId: string) => void;
    openChat: (chatName: string) => void;
    back: () => void;
    close: () => void;
    // Whether the open thread's reply box takes the focus: only when a click opened it, never on a landing.
    focusComposer: boolean;
    onSearchOpenChange: (open: boolean) => void;
};

export function useCommentsColumn({ panel, chat, reveal, ...lifecycleArgs }: CommentsColumnArgs): {
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    column: CommentsColumnState;
} {
    const { isMobile } = useLayout();
    const navigate = useNavigate();
    const url = panel || chat ? { panel, chat } : undefined;
    const history = useDetailHistory<CommentsColumnUrl>(url, (next, { replace, state }) =>
        navigate({
            to: '.',
            search: (prev: CommentsColumnUrl) => ({ ...prev, panel: next?.panel, chat: next?.chat }),
            replace,
            state,
        }),
    );
    const listPanel = panel ?? 'comments';
    const showList = () => history.open({ panel: listPanel });
    const [clickedChat, setClickedChat] = useState<string | null>(null);

    // Every open in the app goes through here, so a thread the URL names without one was a landing or a reload.
    const lifecycle = useCommentLifecycle({
        ...lifecycleArgs,
        chat,
        onOpenChat: (chatName) => {
            setClickedChat(chatName);
            history.open({ panel, chat: chatName });
        },
        onCloseChat: showList,
        onClearChat: showList,
    });
    const { openCard, setOpenCardId } = lifecycle;

    const unlinked = !chat && !!openCard;
    const open = !!url || unlinked;
    const threadOpen = !!chat || unlinked;
    const width = threadOpen ? 'medium' : 'small';
    const growPx = isMobile ? 0 : columnWidthPx('medium') - columnWidthPx('small');

    const closeUnlinked = () => {
        if (unlinked) setOpenCardId(null);
    };
    const close = () => {
        closeUnlinked();
        if (url) history.close();
    };
    const toggle = (next: DocumentPanel) => {
        if (open && listPanel === next) return close();
        closeUnlinked();
        history.open({ panel: next });
    };
    // A phone's column covers the document, where a reveal would move a view nobody sees.
    const openThread = (cardId: string) => {
        if (!isMobile) reveal?.(cardId, growPx);
        setOpenCardId(cardId);
    };

    return {
        lifecycle,
        column: {
            open,
            listPanel,
            threadOpen,
            width,
            growPx,
            commentPanelOpen: open && listPanel === 'comments',
            activityPanelOpen: open && listPanel === 'activity',
            toggleComments: () => toggle('comments'),
            toggleActivity: () => toggle('activity'),
            openThread,
            // A comment whose card is gone opens as deleted, still named by its chat.
            openChat: (chatName) => lifecycle.openChat(chatName, openThread),
            back: () => {
                closeUnlinked();
                showList();
            },
            close,
            focusComposer: !!chat && chat === clickedChat,
            // The find bar sits in the document, which the column covers on a phone.
            onSearchOpenChange: (searchOpen) => {
                if (searchOpen && isMobile && open) close();
            },
        },
    };
}
