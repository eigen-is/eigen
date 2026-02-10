export type CommentItem = {
    id: string;
    taskId: string;
    text: string;
    author: string;
    createdAt: number;
}

export type TaskItem = {
    id: string;
    title: string;
    description: string;
    creator: string;
    createdAt: number;
}

export type ColumnItem = {
    id: string;
    title: string;
    taskIds: string[];
    creator: string;
    createdAt: number;
}

export type BoardData = {
    tasks: Record<string, TaskItem>;
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
    comments: Record<string, CommentItem>;
}

export type BoardProps = {
    ownerId: string;
    pathId: string;
};
