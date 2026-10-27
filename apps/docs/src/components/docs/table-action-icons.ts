// The looks of the Docs table commands, which Format › Table and the table panel both draw. Each command has one icon,
// and each border preset one name, so the menu and the panel can't drift apart.

import type { LucideIcon } from 'lucide-react';
import {
    BetweenHorizontalEnd,
    BetweenHorizontalStart,
    BetweenVerticalEnd,
    BetweenVerticalStart,
    Columns3,
    Grid3x3,
    GripHorizontal,
    GripVertical,
    Square,
    SquareDashed,
    TableCellsMerge,
    TableCellsSplit,
    ToggleLeft,
    Trash2,
} from 'lucide-react';
import type { BorderSet } from './extensions/table-look';

// Keyed by the command's name.
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

// The presets setCellBorders draws. The menu shows the label, and the panel's Borders row the short one.
export const BORDER_SET_LOOKS: { set: BorderSet; label: string; short: string; icon: LucideIcon }[] = [
    { set: 'all', label: 'All borders', short: 'All', icon: Grid3x3 },
    { set: 'outer', label: 'Outer borders', short: 'Outer', icon: Square },
    { set: 'none', label: 'No borders', short: 'None', icon: SquareDashed },
];
