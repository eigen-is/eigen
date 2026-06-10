export type ColumnItem = {
    id: string;
    title: string;
    taskIds: string[];
    creator: string;
    createdAt: number;
};

export type BoardData = {
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
};
