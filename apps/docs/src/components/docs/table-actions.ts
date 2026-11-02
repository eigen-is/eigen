// The Docs table commands, which surfaces such as Format › Table and the table panel run, and the border presets they
// draw. Each command has one icon, a label for the menu, a shorter one for the panel where it needs one, and the
// selection it needs, so the surfaces can't drift apart. Each surface keeps its own order and grouping.

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
import type { selectCellCommands } from './hooks/use-toolbar-state';

export type TableAction = {
    icon: LucideIcon;
    label: string;
    // The panel's label, which its section's title completes, as Before does under Rows. Without one the panel shows
    // the label.
    short?: string;
    // The flag the selection must raise before the command can run. A command without one always can.
    enabledBy?: keyof ReturnType<typeof selectCellCommands>;
};

// Keyed by the command's name.
export const TABLE_ACTIONS = {
    addRowBefore: { icon: BetweenHorizontalStart, label: 'Insert row above', short: 'Before' },
    addRowAfter: { icon: BetweenHorizontalEnd, label: 'Insert row below', short: 'After' },
    addColumnBefore: { icon: BetweenVerticalStart, label: 'Insert column left', short: 'Before' },
    addColumnAfter: { icon: BetweenVerticalEnd, label: 'Insert column right', short: 'After' },
    deleteRow: { icon: GripHorizontal, label: 'Delete row' },
    deleteColumn: { icon: GripVertical, label: 'Delete column' },
    distributeColumns: { icon: Columns3, label: 'Distribute columns' },
    deleteTable: { icon: Trash2, label: 'Delete table' },
    mergeCells: { icon: TableCellsMerge, label: 'Merge cells', short: 'Merge', enabledBy: 'canMergeCells' },
    splitCell: { icon: TableCellsSplit, label: 'Unmerge cells', short: 'Unmerge', enabledBy: 'canSplitCell' },
    toggleHeaderRow: { icon: ToggleLeft, label: 'Toggle header row' },
} satisfies Record<string, TableAction>;

export type TableCommand = keyof typeof TABLE_ACTIONS;

// The presets setCellBorders draws. The menu shows the label, and the panel's Borders row the short one.
export const BORDER_SET_LOOKS: { set: BorderSet; label: string; short: string; icon: LucideIcon }[] = [
    { set: 'all', label: 'All borders', short: 'All', icon: Grid3x3 },
    { set: 'outer', label: 'Outer borders', short: 'Outer', icon: Square },
    { set: 'none', label: 'No borders', short: 'None', icon: SquareDashed },
];
