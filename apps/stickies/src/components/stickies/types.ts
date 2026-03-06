export type CardItem = {
    id: string;
    title: string;
    description: string;
    color?: string;
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
    tasks: Record<string, CardItem>;
    columns: Record<string, ColumnItem>;
    columnOrder: string[];
}

export type BoardProps = {
    ownerId: string;
    pathId: string;
}

export const CARD_COLORS = [
    {label: 'None', value: ''},
    {label: 'Yellow', value: '#fef9c3'},
    {label: 'Pink', value: '#fce7f3'},
    {label: 'Blue', value: '#dbeafe'},
    {label: 'Green', value: '#dcfce7'},
    {label: 'Purple', value: '#f3e8ff'},
    {label: 'Orange', value: '#ffedd5'},
] as const;
