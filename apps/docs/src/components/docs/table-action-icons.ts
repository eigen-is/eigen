import type { LucideIcon } from 'lucide-react';
import {
    BetweenHorizontalEnd,
    BetweenHorizontalStart,
    BetweenVerticalEnd,
    BetweenVerticalStart,
    Columns3,
    GripHorizontal,
    GripVertical,
    TableCellsMerge,
    TableCellsSplit,
    ToggleLeft,
    Trash2,
} from 'lucide-react';

// Format › Table and the table panel draw each table command with one icon, keyed by the command's name.
export const TABLE_ACTION_ICONS = {
    addRowBefore: BetweenHorizontalStart,
    addRowAfter: BetweenHorizontalEnd,
    addColumnBefore: BetweenVerticalStart,
    addColumnAfter: BetweenVerticalEnd,
    deleteRow: GripHorizontal,
    deleteColumn: GripVertical,
    distributeColumns: Columns3,
    deleteTable: Trash2,
    mergeCells: TableCellsMerge,
    splitCell: TableCellsSplit,
    toggleHeaderRow: ToggleLeft,
} satisfies Record<string, LucideIcon>;
