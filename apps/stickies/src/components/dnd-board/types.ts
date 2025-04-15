export interface CommentItem {
    id: string;
    taskId: string; // The task this comment belongs to
    text: string;
    author: string; // email address
    createdAt: number; // timestamp
}

export interface TaskItem {
    id: string;
    title: string;
    description: string;
    creator: string; // email address
    createdAt: number; // timestamp
}

export interface ColumnItem {
    id: string;
    title: string;
    taskIds: string[];
    creator: string; // email address
    createdAt: number; // timestamp
}

export interface BoardData {
    tasks: Record<string, TaskItem>;
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
    comments: Record<string, CommentItem>;
}

export type BoardProps = {
    ownerId: string;
    pathId: string;
};
