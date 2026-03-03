export type TaskItem = {
    id: string;
    title: string;
    description: string;
    creator: string;
    createdAt: number;
    chatId?: string;
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
}

export type BoardProps = {
    ownerId: string;
    pathId: string;
};
