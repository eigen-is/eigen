export type CommentCard = {
    id: string;
    title: string;
    description: string;
    color?: string;
    chatName?: string;
    creator?: string;
    createdAt?: number;
};

export type ActiveComments = {
    ids: Set<string>;
    anchorTexts: Map<string, string>;
};
