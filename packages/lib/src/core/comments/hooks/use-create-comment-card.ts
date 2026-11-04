// Raises a comment card: its thread in the document's chat folder first, then the card in the Y.Doc. The host's anchor
// lands in the same transaction, so one undo takes both back. The comment lifecycle hands it to every host, and a
// board's duplicate drag calls it too. writeCardToDoc is the plain write, which a new board's first card also uses.

import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@workspace/lib/auth';
import { invalidateComments } from '@workspace/lib/chat';
import { useCreateDriveItem } from '@workspace/lib/drive';
import { nanoid } from 'nanoid';
import { useCallback, useRef } from 'react';
import * as Y from 'yjs';
import type { CardAttachmentDraft, CommentCard, CommentMapName } from '../../../types/comments';
import { getItemMapRoot } from '../../collab/yjs-utils';
import { useResolveCardAttachments } from './use-resolve-card-attachments';

export type CreateCommentCardInput = {
    title?: string;
    description?: string;
    color?: string;
    attachments?: CardAttachmentDraft[];
};

// The caller opens the transaction, so the card and its anchor land in one undo step.
export function writeCardToDoc(doc: Y.Doc, mapName: CommentMapName, card: CommentCard): void {
    const map = getItemMapRoot(doc, mapName);
    const y = new Y.Map<unknown>();
    y.set('id', card.id);
    y.set('title', card.title);
    y.set('description', card.description);
    if (card.color) y.set('color', card.color);
    if (card.chatName) y.set('chatName', card.chatName);
    if (card.creator) y.set('creator', card.creator);
    if (card.createdAt !== undefined) y.set('createdAt', card.createdAt);
    if (card.attachments?.length) y.set('attachments', card.attachments);
    map.set(card.id, y);
}

export function useCreateCommentCard(
    ownerId: string,
    mountId: string,
    pathId: string,
    chatFolderId: string | null,
    mediaFolderId: string | null,
    doc: Y.Doc | null,
    mapName: CommentMapName = 'comments',
) {
    const queryClient = useQueryClient();
    const createChat = useCreateDriveItem('chat');
    const createChatRef = useRef(createChat);
    createChatRef.current = createChat;
    const resolveAttachments = useResolveCardAttachments(ownerId, mountId, mediaFolderId);
    const { user } = useAuth();
    const userEmailRef = useRef(user?.email);
    userEmailRef.current = user?.email;

    // anchorInTransact runs inside the card's transaction, so the card and the host's anchor are one undo step. It must
    // be synchronous: whatever it awaits or defers runs outside the transaction.
    return useCallback(
        async (
            input: CreateCommentCardInput = {},
            anchorInTransact?: (card: CommentCard) => void,
        ): Promise<CommentCard | undefined> => {
            if (!doc || !chatFolderId) return undefined;

            // The attachments resolve first, so a failed upload stops the create before any card exists.
            const attachments = input.attachments?.length ? await resolveAttachments(input.attachments) : undefined;

            const fileName = `comment-${Date.now()}-${nanoid(6)}`;
            const chatPath = await createChatRef.current.mutateAsync({
                ownerId,
                mountId,
                parentId: chatFolderId,
                fileName,
            });

            const card: CommentCard = {
                id: nanoid(10),
                title: input.title ?? '',
                description: input.description ?? '',
                color: input.color,
                chatName: chatPath.name,
                creator: userEmailRef.current,
                createdAt: Date.now(),
                attachments,
            };
            doc.transact(() => {
                writeCardToDoc(doc, mapName, card);
                anchorInTransact?.(card);
            });
            // Creating the chat wrote its index row on the server but sent no event. Without this refetch the new card
            // would have no row until the list goes stale.
            invalidateComments(queryClient, ownerId, mountId, pathId);
            return card;
        },
        [queryClient, ownerId, mountId, pathId, doc, chatFolderId, mapName, resolveAttachments],
    );
}
