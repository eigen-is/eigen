// The comments and activity host a canvas app mounts, such as Vector or Slides: the card read, the panel state, the
// lifecycle, the hover card's state, and the bookkeeping that ties a card to the element it was raised on. Apps differ
// in how a reveal moves the view, for example by going to the element's slide first, so that step comes in as
// `onReveal`. A shell such as CanvasDocumentShell renders what this returns.

import { useAuth } from '@workspace/lib/auth';
import {
    useCommentCards,
    useCommentFilter,
    useCommentHover,
    useCommentLifecycle,
    useDocumentPanels,
} from '@workspace/lib/comments';
import type { CardAttachmentDraft, CardFormPatch, CommentHover } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import type { VectorElement } from '@workspace/lib/vector';
import { elementForCommentCard, parseIdList, serializeIdList } from '@workspace/lib/vector';
import type { ComponentProps } from 'react';
import { useCallback, useState } from 'react';
import type { CommentContextMenuItem, CommentHoverCard, PanelColumn } from '../../comments';
import { useContextMenu } from '../../context-menu';
import { useCanvasComments } from './use-canvas-comments';
import type { CanvasDoc } from './use-canvas-doc';

type CanvasCommentHostArgs = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    initialChatName?: string;
    doc: CanvasDoc;
    isMobile: boolean;
    // Bring an element into view before its card opens.
    onReveal: (el: VectorElement) => void;
};

export type CanvasCommentHost = ReturnType<typeof useDocumentPanels> & {
    assignedCount: number;
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    members: EffectiveMember[];
    currentUserEmail: string | undefined;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    addOpen: boolean;
    closeAdd: (open: boolean) => void;
    addCommentTo: (elementId: string) => void;
    openCard: (cardId: string) => void;
    handleSaveNew: (
        patch: CardFormPatch,
        attachments?: CardAttachmentDraft[],
        assignee?: string | null,
    ) => Promise<void>;
    deleteCard: (cardId: string) => void;
    onCommentHover: CommentHover['report'];
    panelProps: Omit<ComponentProps<typeof PanelColumn>, 'activePanel'>;
    hoverCardProps: Omit<ComponentProps<typeof CommentHoverCard>, 'side'>;
};

export function useCanvasCommentHost({
    ownerId,
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    initialChatName,
    doc,
    isMobile,
    onReveal,
}: CanvasCommentHostArgs): CanvasCommentHost {
    const { user } = useAuth();

    // The cards are read here, so the active set doesn't depend on the lifecycle's own read of them.
    const cards = useCommentCards(doc.yjsDoc, 'comments');
    const activeComments = useCanvasComments(doc.elements, cards);

    const panels = useDocumentPanels(isMobile);

    const lifecycle = useCommentLifecycle({
        ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: doc.yjsDoc,
        activeCardIds: activeComments.ids,
        initialChatName,
        ready: doc.synced,
    });
    const {
        allComments,
        cards: lifecycleCards,
        createCard,
        assignComment,
        members,
        assignedCount,
        setOpenCardId,
        openChat: openLifecycleChat,
    } = lifecycle;

    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();
    const hover = useCommentHover();

    const [addOpen, setAddOpen] = useState(false);
    // The element the pending new comment anchors to. The canvas menu's Comment row sets it. It is null for a card
    // raised from the panel, which stays document-level.
    const [commentAnchorId, setCommentAnchorId] = useState<string | null>(null);

    const addCommentTo = useCallback((elementId: string) => {
        setCommentAnchorId(elementId);
        setAddOpen(true);
    }, []);

    const closeAdd = useCallback((open: boolean) => {
        setAddOpen(open);
        if (!open) setCommentAnchorId(null);
    }, []);

    const openCard = useCallback(
        (cardId: string) => {
            const el = elementForCommentCard(doc.elements, cardId);
            if (el) onReveal(el);
            setOpenCardId(cardId);
        },
        [doc.elements, onReveal, setOpenCardId],
    );

    // A comment an activity row names opens like a tap on its card. One whose card is gone opens as deleted.
    const openChat = useCallback(
        (chatName: string) => openLifecycleChat(chatName, openCard),
        [openCard, openLifecycleChat],
    );

    const handleSaveNew = useCallback(
        async (patch: CardFormPatch, attachments?: CardAttachmentDraft[], assignee?: string | null) => {
            const anchorId = commentAnchorId;
            const card = await createCard({ ...patch, attachments });
            if (card && anchorId) {
                const el = doc.elements.find((e) => e.id === anchorId);
                const ids = el ? parseIdList(el.commentCardIds) : [];
                if (el && !ids.includes(card.id)) {
                    // Untracked, as the delete is: the card lives in the comments map, outside the UndoManager's
                    // scope, so a ⌘Z that took back the anchor alone would orphan the new card.
                    doc.updateElementUntracked(anchorId, { commentCardIds: serializeIdList([...ids, card.id]) });
                }
            }
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setCommentAnchorId(null);
            setAddOpen(false);
        },
        [commentAnchorId, createCard, assignComment, doc.elements, doc.updateElementUntracked],
    );

    return {
        ...panels,
        assignedCount,
        lifecycle,
        members,
        currentUserEmail: user?.email,
        commentContextMenu,
        addOpen,
        closeAdd,
        addCommentTo,
        openCard,
        handleSaveNew,
        deleteCard: doc.deleteCommentCard,
        onCommentHover: hover.report,
        panelProps: {
            onClose: panels.closePanels,
            path,
            cards: lifecycleCards,
            entries: allComments,
            members,
            currentUserEmail: user?.email ?? '',
            filter: commentFilter,
            activeComments,
            isCardDeleted: lifecycle.isCardDeleted,
            commentContextMenu,
            // The mobile pane hides the canvas, so its element reveal would go unseen there.
            onOpenCard: isMobile ? setOpenCardId : openCard,
            onOpenChat: isMobile ? openLifecycleChat : openChat,
            onAddComment: canWrite && chatFolderId ? () => setAddOpen(true) : undefined,
        },
        hoverCardProps: {
            hover,
            cards: lifecycleCards,
            entries: allComments,
            isCardDeleted: lifecycle.isCardDeleted,
            onOpenCard: openCard,
        },
    };
}
