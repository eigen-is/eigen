import type { CommentCard } from '@workspace/lib/types/comments';

export type CardItem = CommentCard & {
    // Runtime-enriched from useComments(); not stored in Y.Doc.
    messageCount?: number;
};

export type ColumnItem = {
    id: string;
    title: string;
    taskIds: string[];
    creator: string;
    createdAt: number;
};

export type BoardData = {
    tasks: Record<string, CardItem>;
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
};
