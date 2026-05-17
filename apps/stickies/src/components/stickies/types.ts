import type { CommentCard } from '@workspace/lib/types/comments';

export type ColumnItem = {
    id: string;
    title: string;
    taskIds: string[];
    creator: string;
    createdAt: number;
};

export type BoardData = {
    tasks: Record<string, CommentCard>;
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
};
