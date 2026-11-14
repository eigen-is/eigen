// The edit and delete state of one chat room's composer: which message is being edited or is about to be
// deleted, and the up arrow that opens the user's own last message for editing. It runs the room's own edit
// and delete calls and hands the composer its focus back when an edit ends.

import { useCallback, useState } from 'react';
import type { ChatMessage } from '../../../types/chat';
import type { ChatRoomState } from './use-chat-room';

type ChatEditing = {
    deleteTarget: ChatMessage | null;
    setDeleteTarget: (message: ChatMessage | null) => void;
    editingMessageId: string | null;
    setEditingMessageId: (id: string | null) => void;
    focusTrigger: number;
    endEditing: () => void;
    handleSaveEdit: (messageId: string, content: string) => Promise<void>;
    handleDeleteConfirm: () => Promise<void>;
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>, content: string) => true | undefined;
};

export function useChatEditing(chat: ChatRoomState): ChatEditing {
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
                    .find((m) => m.authorEmail === chat.currentUserEmail && !m.deletedAt && m.type === 'message');
                if (lastOwn) {
                    e.preventDefault();
                    setEditingMessageId(lastOwn.id);
                    return true;
                }
            }
            return undefined;
        },
        [chat.messages, chat.currentUserEmail],
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
