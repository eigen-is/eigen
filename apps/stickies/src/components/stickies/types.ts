// What a board reads out of its Yjs doc, shared by the hooks and components of Stickies.

export type ColumnItem = {
    id: string;
    title: string;
    taskIds: string[];
};

export type BoardData = {
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
};
