// A document's comments column, such as a canvas app's: the comment host, whose URL is the column's open state, the
// list level as ?panel=comments or ?panel=activity and the thread it drilled into as ?chat=. Opening from closed
// pushes, a move between the list and a thread replaces, and close goes back over that push or replaces on a link. A
// thread that closes or goes lands on the list. The host draws the toolbar's toggles from it and the shell renders
// CommentsColumn while it is open.

import type { DocumentPanel } from '@workspace/lib/types/comments';
import { useEffect, useEffectEvent } from 'react';
import { useEigenDocEditorSearch } from '../drive/eigendoc-config';
import { columnWidthPx } from '../layout/app/column-widths';
import { useLayout } from '../layout/app/layout-context';
import type { CommentHostArgs, CommentLifecycleBundle } from './use-comment-host';
import { useCommentHost } from './use-comment-host';

type CommentsColumnArgs = Omit<CommentHostArgs, 'listPanel'> & {
    // Brings a card's anchor into view. It hears how far the column is about to grow over what is beside it: a list or
    // activity row reveals before the thread widens it, a landing after.
    reveal?: (cardId: string, growPx: number) => void;
};

export type CommentsColumnState = {
    open: boolean;
    // The list behind the column, which a thread goes back to.
    listPanel: DocumentPanel;
    threadOpen: boolean;
    width: 'small' | 'large';
    commentsOpen: boolean;
    activityOpen: boolean;
    toggleComments: () => void;
    toggleActivity: () => void;
    // A list row's and an activity row's open, which reveal the anchor first.
    openThread: (cardId: string) => void;
    openChat: (chatName: string) => void;
    back: () => void;
    close: () => void;
    // A click on the open thread's block, which reveals its anchor again. Unset where nothing reveals.
    revealOpenCard: (() => void) | undefined;
    // Whether the open thread's reply box takes the focus: only when a click opened it, never on a landing.
    focusComposer: boolean;
    onSearchOpenChange: (open: boolean) => void;
};

export function useCommentsColumn({ reveal, ...hostArgs }: CommentsColumnArgs): {
    lifecycle: CommentLifecycleBundle;
    column: CommentsColumnState;
} {
    const { panel, chat } = useEigenDocEditorSearch();
    const { isMobile, isTablet } = useLayout();
    const listPanel = panel ?? 'comments';
    const { lifecycle, clicked, showList, close } = useCommentHost({ ...hostArgs, listPanel });
    const open = !!panel || !!chat;
    // How much wider a thread is than the list.
    const growPx = isMobile ? 0 : columnWidthPx('large', isTablet) - columnWidthPx('small');

    // A phone's column covers the document, where a reveal would move a view nobody sees.
    const openThread = (cardId: string) => {
        if (!isMobile) reveal?.(cardId, growPx);
        lifecycle.setOpenCardId(cardId);
    };

    // A thread the URL opened without a click here, such as a link or a reload, reveals its anchor once, as soon as its
    // comment has loaded. The column is at its thread width by then.
    const landedCardId = chat && !clicked && !isMobile ? lifecycle.openCard?.id : undefined;
    const revealLanded = useEffectEvent((cardId: string) => reveal?.(cardId, 0));
    useEffect(() => {
        if (landedCardId) revealLanded(landedCardId);
    }, [landedCardId]);

    const openCardId = lifecycle.openCard?.id;
    const toggle = (next: DocumentPanel) => (open && listPanel === next ? close() : showList(next));
    return {
        lifecycle,
        column: {
            open,
            listPanel,
            threadOpen: !!chat,
            width: chat ? 'large' : 'small',
            commentsOpen: open && listPanel === 'comments',
            activityOpen: open && listPanel === 'activity',
            toggleComments: () => toggle('comments'),
            toggleActivity: () => toggle('activity'),
            openThread,
            // A comment whose card is gone opens as deleted, still named by its chat.
            openChat: (chatName) => lifecycle.openChat(chatName, openThread),
            back: () => showList(listPanel),
            close,
            revealOpenCard: reveal && openCardId && !isMobile ? () => reveal(openCardId, 0) : undefined,
            focusComposer: clicked,
            // The find bar sits in the document, which the column covers on a phone.
            onSearchOpenChange: (searchOpen) => {
                if (searchOpen && isMobile && open) close();
            },
        },
    };
}
