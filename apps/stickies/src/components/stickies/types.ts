export type CardItem = {
    id: string;
    title: string;
    description: string;
    color?: string;
    creator: string;
    createdAt: number;
    chatName?: string;
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
