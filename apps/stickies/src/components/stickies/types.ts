export type CardItem = {
    id: string;
    title: string;
    description: string;
    color?: string;
    creator: string;
    createdAt: number;
    chatName?: string;
}

export type ColumnItem = {
    id: string;
    title: string;
    taskIds: string[];
    creator: string;
    createdAt: number;
}

export type BoardData = {
    tasks: Record<string, CardItem>;
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
}

export type BoardProps = {
    ownerId: string;
    pathId: string;
}

export const STICKY_COLORS = [
    [
        {label: 'Yellow', value: '#fef9c3'},
        {label: 'Orange', value: '#ffedd5'},
        {label: 'Pink', value: '#fce7f3'},
        {label: 'Purple', value: '#f3e8ff'},
        {label: 'Blue', value: '#dbeafe'},
        {label: 'Cyan', value: '#cffafe'},
        {label: 'Green', value: '#dcfce7'},
        {label: 'Gray', value: '#f3f4f6'},
    ],
    // [
    //     {label: 'Deep yellow', value: '#fde68a'},
    //     {label: 'Deep orange', value: '#fed7aa'},
    //     {label: 'Deep pink', value: '#fbcfe8'},
    //     {label: 'Deep purple', value: '#e9d5ff'},
    //     {label: 'Deep blue', value: '#bfdbfe'},
    //     {label: 'Deep cyan', value: '#a5f3fc'},
    //     {label: 'Deep green', value: '#bbf7d0'},
    //     {label: 'Deep gray', value: '#e5e7eb'},
    // ],
];
