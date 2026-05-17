import { nanoid } from 'nanoid';
import { useCallback } from 'react';
import * as Y from 'yjs';
import type { CommentCard } from '../../../types/comments';
import { useCreateChat } from '../../chat/hooks/use-chat';

export type CreateCommentCardInput = {
    title?: string;
    description?: string;
    color?: string;
};

export function writeCardToDoc(doc: Y.Doc, mapName: string, card: CommentCard): void {
    doc.transact(() => {
        const map = doc.getMap<Y.Map<unknown>>(mapName);
        const y = new Y.Map<unknown>();
        y.set('id', card.id);
        y.set('title', card.title);
        y.set('description', card.description);
        if (card.color) y.set('color', card.color);
        if (card.chatName) y.set('chatName', card.chatName);
        map.set(card.id, y);
    });
}

export function useCreateCommentCard(
    ownerId: string,
    mountId: string,
    chatFolderId: string | null,
    doc: Y.Doc | null,
    mapName: 'comments' | 'tasks' = 'comments',
) {
    const createChat = useCreateChat(ownerId, mountId);

    return useCallback(
        async (input: CreateCommentCardInput = {}): Promise<CommentCard | null> => {
            if (!doc || !chatFolderId) return null;

            const fileName = `comment-${Date.now()}-${nanoid(6)}`;
            const chatPath = await createChat.mutateAsync({ parentId: chatFolderId, fileName });

            const card: CommentCard = {
                id: nanoid(10),
                title: input.title ?? '',
                description: input.description ?? '',
                color: input.color,
                chatName: chatPath.name,
            };
            writeCardToDoc(doc, mapName, card);
            return card;
        },
        [createChat, doc, chatFolderId, mapName],
    );
}
