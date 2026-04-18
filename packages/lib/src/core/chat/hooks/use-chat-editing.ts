import { useCallback, useState } from 'react';
import type { ChatMessage } from '../../../types/chat';
import type { useChatRoom } from './use-chat-room';

type ChatRoom = ReturnType<typeof useChatRoom>;

export function useChatEditing(chat: ChatRoom) {
    const [deleteTarget, setDeleteTarget] = useState<ChatMessage | null>(null);
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [focusTrigger, setFocusTrigger] = useState(0);

    const endEditing = useCallback(() => {
        setEditingMessageId(null);
        setFocusTrigger((n) => n + 1);
    }, []);

    const handleSaveEdit = useCallback(
        async (messageId: string, content: string) => {
            await chat.handleEditMessage(messageId, content);
            endEditing();
        },
        [chat.handleEditMessage, endEditing],
    );

    const handleDeleteConfirm = useCallback(async () => {
        if (!deleteTarget) return;
        await chat.handleDeleteMessage(deleteTarget.id);
        setDeleteTarget(null);
    }, [deleteTarget, chat.handleDeleteMessage]);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLTextAreaElement>, content: string) => {
            if (e.key === 'ArrowUp' && !content.trim()) {
                const lastOwn = [...chat.messages]
                    .reverse()
                    .find((m) => m.authorId === chat.currentUserId && !m.deletedAt && m.type === 'message');
                if (lastOwn) {
                    e.preventDefault();
                    setEditingMessageId(lastOwn.id);
                    return true;
                }
            }
            return undefined;
        },
        [chat.messages, chat.currentUserId],
    );

    return {
        deleteTarget,
        setDeleteTarget,
        editingMessageId,
        setEditingMessageId,
        focusTrigger,
        endEditing,
        handleSaveEdit,
        handleDeleteConfirm,
        onKeyDown,
    };
}
