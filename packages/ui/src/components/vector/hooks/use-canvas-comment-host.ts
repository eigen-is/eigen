// The comments and activity host a canvas app mounts, such as Vector or Slides: the card read, the comments column with
// its lifecycle, which the route keeps in the URL, the hover card's state, and the bookkeeping that ties a card to the
// element it was raised on, and the command palette's search in comments, whose hit opens like a list row. Apps differ
// in how a reveal moves the view, for example by going to the element's slide first, so that step comes in as
// `onReveal`. A shell such as CanvasDocumentShell renders what this returns.

import { useAuth } from '@workspace/lib/auth';
import type { useCommentLifecycle } from '@workspace/lib/comments';
import { useCommentCards, useCommentFilter, useCommentHover } from '@workspace/lib/comments';
import { useDocCommentSearchHalf } from '@workspace/lib/search';
import type { CardAttachmentDraft, CardFormPatch, CommentHover, DocumentPanel } from '@workspace/lib/types/comments';
import type { DocCommentSearch } from '@workspace/lib/types/doc-search';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import type { VectorElement } from '@workspace/lib/vector';
import { elementForCommentCard, parseIdList, serializeIdList } from '@workspace/lib/vector';
import type { ComponentProps } from 'react';
import { useCallback, useState } from 'react';
import type { CommentContextMenuItem, CommentHoverCard, CommentsColumn, CommentsColumnState } from '../../comments';
import { useCommentsColumn } from '../../comments';
import { useContextMenu } from '../../context-menu';
import { useCanvasComments } from './use-canvas-comments';
import type { CanvasDoc } from './use-canvas-doc';

type CanvasCommentHostArgs = {
    ownerId: string;
    path: DrivePath;
    canWrite: boolean;
    mediaFolderId: string | null;
    chatFolderId: string | null;
    // The route's ?panel= and ?chat=: the comments column's list and its open thread.
    panel: DocumentPanel | undefined;
    chat: string | undefined;
    doc: CanvasDoc;
    // Bring an element into view as a thread opens from a list row or a link, clear of the `growPx` the column is about
    // to grow by over the canvas.
    onReveal: (el: VectorElement, growPx: number) => void;
};

export type CanvasCommentHost = {
    column: CommentsColumnState;
    assignedCount: number;
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    members: EffectiveMember[];
    currentUserEmail: string | undefined;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    addOpen: boolean;
    closeAdd: (open: boolean) => void;
    addCommentTo: (elementId: string) => void;
    // An anchor's own open, such as its corner mark: the element is in view already, so nothing moves.
    openCard: (cardId: string) => void;
    handleSaveNew: (
        patch: CardFormPatch,
        attachments?: CardAttachmentDraft[],
        assignee?: string | null,
    ) => Promise<void>;
    deleteCard: (cardId: string) => void;
    onCommentHover: CommentHover['report'];
    columnProps: ComponentProps<typeof CommentsColumn>;
    hoverCardProps: Omit<ComponentProps<typeof CommentHoverCard>, 'side'>;
    commentSearch: DocCommentSearch;
};

export function useCanvasCommentHost({
    ownerId,
    path,
    canWrite,
    mediaFolderId,
    chatFolderId,
    panel,
    chat,
    doc,
    onReveal,
}: CanvasCommentHostArgs): CanvasCommentHost {
    const { user } = useAuth();

    // The cards are read here, so the active set doesn't depend on the lifecycle's own read of them.
    const cards = useCommentCards(doc.yjsDoc, 'comments');
    const activeComments = useCanvasComments(doc.elements, cards);

    const { lifecycle, column } = useCommentsColumn({
        ownerId,
        mountId: path.mountId,
        pathId: path.id,
        chatFolderId,
        mediaFolderId,
        doc: doc.yjsDoc,
        activeCardIds: activeComments.ids,
        ready: doc.loaded,
        panel,
        chat,
        reveal: (cardId, growPx) => {
            const el = elementForCommentCard(doc.elements, cardId);
            if (el) onReveal(el, growPx);
            return !!el;
        },
    });
    const { allComments, cards: lifecycleCards, createCard, assignComment, members, assignedCount } = lifecycle;

    const commentSearchHalf = useDocCommentSearchHalf(ownerId, path.mountId, path.id);
    const commentFilter = useCommentFilter();
    const commentContextMenu = useContextMenu<CommentContextMenuItem>();
    const hover = useCommentHover();

    const [addOpen, setAddOpen] = useState(false);
    // The element the pending new comment anchors to. The canvas menu's Comment row sets it. It is null for a card
    // raised from the column, which stays document-level.
    const [commentAnchorId, setCommentAnchorId] = useState<string | null>(null);

    const addCommentTo = useCallback((elementId: string) => {
        setCommentAnchorId(elementId);
        setAddOpen(true);
    }, []);

    const closeAdd = useCallback((open: boolean) => {
        setAddOpen(open);
        if (!open) setCommentAnchorId(null);
    }, []);

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
            if (assignee !== undefined && card) {
                assignComment.mutate({ chatName: card.chatName, assignee, title: card.title });
            }
            setCommentAnchorId(null);
            setAddOpen(false);
        },
        [commentAnchorId, createCard, assignComment, doc.elements, doc.updateElementUntracked],
    );

    return {
        column,
        assignedCount,
        lifecycle,
        members,
        currentUserEmail: user?.email,
        commentContextMenu,
        addOpen,
        closeAdd,
        addCommentTo,
        openCard: lifecycle.setOpenCardId,
        handleSaveNew,
        deleteCard: doc.deleteCommentCard,
        onCommentHover: hover.report,
        columnProps: {
            column,
            lifecycle,
            path,
            canWrite,
            currentUserEmail: user?.email ?? '',
            filter: commentFilter,
            activeComments,
            commentContextMenu,
            onAddComment: canWrite && chatFolderId ? () => setAddOpen(true) : undefined,
        },
        hoverCardProps: {
            hover,
            cards: lifecycleCards,
            entries: allComments,
            isCardDeleted: lifecycle.isCardDeleted,
            onOpenCard: lifecycle.setOpenCardId,
        },
        // A new object each render, which the palette's publisher stabilizes, so a hit sees the current cards.
        commentSearch: { ...commentSearchHalf, reveal: column.openChat },
    };
}
