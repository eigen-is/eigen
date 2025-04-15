export interface Comment {
    id: string;
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
    comments: Comment[];
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
}

export type BoardProps = {
    ownerId: string;
    pathId: string;
};
