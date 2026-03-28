export type ChatMessageType = 'message' | 'emote' | 'whisper' | 'system';

export type ChatMessage = {
    id: string;
    authorId: string;
    authorEmail: string;
    type: ChatMessageType;
    content: string;
    attachments: string[] | null;
    whisperTo: string | null;
    replyTo: string | null;
    editedAt: Date | null;
    deletedAt: Date | null;
    createdAt: Date;
};

export type RoomMember = {
    email: string;
    displayName: string;
};

export type ChatReadState = {
    userId: string;
    lastReadMessageId: string | null;
    lastReadAt: Date | null;
};

export type CommentEntry = {
    chatName: string;
    status: 'open' | 'resolved';
    resolvedBy: string | null;
    resolvedAt: string | null;
    lastAuthorEmail: string | null;
    lastMessageSnippet: string | null;
    lastActivityAt: string | null;
    messageCount: number;
    createdAt: string;
    mentions: string[];
};
