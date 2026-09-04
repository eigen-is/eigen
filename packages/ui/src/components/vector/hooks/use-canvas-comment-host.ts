// The comment/activity host both canvas apps mount: the cards read, the panel state, the lifecycle,
// and the anchor bookkeeping that ties a card to the element it was raised on. The two apps differ in
// one step only — how a reveal moves the view (select it vs. go to its slide first) — which rides in
// as `onReveal`. CanvasDocumentShell renders what this returns.

import { useAuth } from '@workspace/lib/auth';
import { useCommentCards, useCommentFilter, useCommentLifecycle, useDocumentPanels } from '@workspace/lib/comments';
import type { CardAttachmentDraft } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { elementForCommentCard, parseIdList, serializeIdList, type VectorElement } from '@workspace/lib/vector';
import { useCallback, useState } from 'react';
import type { CommentContextMenuItem } from '../../comments';
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

export const useCanvasCommentHost = ({
    ownerId,
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    initialChatName,
    doc,
    isMobile,
    onReveal,
}: CanvasCommentHostArgs) => {
    const { user } = useAuth();

    // Read the cards here so the "active" set is derived independently of the lifecycle's own card
    // read. A card anchored to an element takes that element's text as its panel row; every card stays
    // active either way — one whose element was deleted degrades to document-level rather than vanishing.
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
    } = lifecycle;

    // Host-owned so the filter survives panel close/reopen.
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();

    const [addOpen, setAddOpen] = useState(false);
    // The element the pending "New comment" anchors to — set by the canvas menu's Comment row, null for
    // a card raised from the panel (which stays document-level).
    const [commentAnchorId, setCommentAnchorId] = useState<string | null>(null);

    const addCommentTo = useCallback((elementId: string) => {
        setCommentAnchorId(elementId);
        setAddOpen(true);
    }, []);

    const closeAdd = useCallback((open: boolean) => {
        setAddOpen(open);
        if (!open) setCommentAnchorId(null);
    }, []);

    // Opening a card reveals its anchor element; mobile hides the canvas, so there it just opens.
    const openCard = useCallback(
        (cardId: string) => {
            const el = elementForCommentCard(doc.elements, cardId);
            if (el) onReveal(el);
            setOpenCardId(cardId);
        },
        [doc.elements, onReveal, setOpenCardId],
    );

    // A comment raised from an element anchors to it; one raised from the panel stays document-level.
    const handleSaveNew = useCallback(
        async (
            patch: { title?: string; description?: string; color?: string },
            attachments?: CardAttachmentDraft[],
            assignee?: string | null,
        ) => {
            const anchorId = commentAnchorId;
            const card = await createCard({ ...patch, attachments });
            if (card && anchorId) {
                const el = doc.elements.find((e) => e.id === anchorId);
                // Idempotent: a double submit must not list the same card twice on the element.
                const ids = el ? parseIdList(el.commentCardIds) : [];
                if (el && !ids.includes(card.id)) {
                    doc.updateElement(anchorId, { commentCardIds: serializeIdList([...ids, card.id]) });
                }
            }
            if (assignee !== undefined && card?.chatName) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setCommentAnchorId(null);
            setAddOpen(false);
        },
        [commentAnchorId, createCard, assignComment, doc.elements, doc.updateElement],
    );

    // Delete drops the card from the `comments` Y.Map and strips it from its anchor element, so no
    // element keeps a flag for a card that is gone. The .eigenchat + comments.db row persist server-side.
    const deleteCard = useCallback(
        (cardId: string) => {
            const yjsDoc = doc.yjsDoc;
            if (!yjsDoc) return;
            const anchor = elementForCommentCard(doc.elements, cardId);
            yjsDoc.transact(() => {
                yjsDoc.getMap('comments').delete(cardId);
            });
            // Untracked: stripping the anchor is bookkeeping for a delete the UndoManager never saw (the
            // comments map is outside its scope), so ⌘Z must not resurrect the flag without its card.
            if (anchor) {
                const ids = parseIdList(anchor.commentCardIds).filter((id) => id !== cardId);
                doc.updateElementUntracked(anchor.id, { commentCardIds: serializeIdList(ids) });
            }
        },
        [doc.yjsDoc, doc.elements, doc.updateElementUntracked],
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
        deleteCard,
        panelProps: {
            onClose: panels.closePanels,
            path,
            cards: lifecycleCards,
            entries: allComments,
            members,
            currentUserEmail: user?.email ?? '',
            filter: commentFilter,
            activeComments,
            commentContextMenu,
            // The mobile pane hides the canvas, so its element reveal would go unseen there.
            onOpenCard: isMobile ? setOpenCardId : openCard,
            onAddComment: canWrite && chatFolderId ? () => setAddOpen(true) : undefined,
        },
    };
};

export type CanvasCommentHost = ReturnType<typeof useCanvasCommentHost>;
