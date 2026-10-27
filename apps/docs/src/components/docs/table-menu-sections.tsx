// The rows of Format › Table, which the table's right-click menu shows too: inserting, merging and deleting rows and
// columns, the selected cells' fill and borders. Each runs a command of the editor that holds the table, as the table
// panel's controls do, so a phone, which has no panel, reaches them here.

import type { Editor } from '@tiptap/react';
import { readCellBackground } from '@workspace/lib/docs/eigendoc';
import type { MenuSectionsProps } from '@workspace/ui/components/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { ColorPickerMenuItem } from '@workspace/ui/components/media';
import { PaintBucket } from 'lucide-react';
import type { ToolbarState } from './hooks/use-toolbar-state';
import { BORDER_SET_LOOKS, TABLE_ACTION_ICONS } from './table-action-icons';

// The table rows of Format › Table, in MenuSections' groups, for any menu about the table the caret is in.
export function tableMenuSections(
    editor: Editor,
    active: Pick<ToolbarState, 'canMergeCells' | 'canSplitCell' | 'cellBackground'>,
): MenuSectionsProps {
    return {
        create: (
            <>
                <DropdownMenuItem onClick={() => editor.chain().focus().addRowBefore().run()}>
                    <TABLE_ACTION_ICONS.addRowBefore className="h-4 w-4" /> Insert row above
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().addRowAfter().run()}>
                    <TABLE_ACTION_ICONS.addRowAfter className="h-4 w-4" /> Insert row below
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().addColumnBefore().run()}>
                    <TABLE_ACTION_ICONS.addColumnBefore className="h-4 w-4" /> Insert column left
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => editor.chain().focus().addColumnAfter().run()}>
                    <TABLE_ACTION_ICONS.addColumnAfter className="h-4 w-4" /> Insert column right
                </DropdownMenuItem>
            </>
        ),
        organize: (
            <>
                <DropdownMenuItem onClick={() => editor.chain().focus().distributeColumns().run()}>
                    <TABLE_ACTION_ICONS.distributeColumns className="h-4 w-4" /> Distribute columns
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    disabled={!active.canMergeCells}
                    onClick={() => editor.chain().focus().mergeCells().run()}
                >
                    <TABLE_ACTION_ICONS.mergeCells className="h-4 w-4" /> Merge cells
                </DropdownMenuItem>
                <DropdownMenuItem
                    disabled={!active.canSplitCell}
                    onClick={() => editor.chain().focus().splitCell().run()}
                >
                    <TABLE_ACTION_ICONS.splitCell className="h-4 w-4" /> Unmerge cells
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => editor.chain().focus().toggleHeaderRow().run()}>
                    <TABLE_ACTION_ICONS.toggleHeaderRow className="h-4 w-4" /> Toggle header row
                </DropdownMenuItem>
                <ColorPickerMenuItem
                    icon={PaintBucket}
                    label="Cell background color"
                    value={active.cellBackground}
                    resetLabel="None"
                    onChange={(color) =>
                        editor.chain().focus().setCellAttribute('backgroundColor', readCellBackground(color)).run()
                    }
                />
                {BORDER_SET_LOOKS.map(({ set, label, icon: Icon }) => (
                    <DropdownMenuItem key={set} onClick={() => editor.chain().focus().setCellBorders(set).run()}>
                        <Icon className="h-4 w-4" /> {label}
                    </DropdownMenuItem>
                ))}
            </>
        ),
        destructive: (
            <>
                <DropdownMenuItem variant="destructive" onClick={() => editor.chain().focus().deleteRow().run()}>
                    <TABLE_ACTION_ICONS.deleteRow className="h-4 w-4" /> Delete row
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => editor.chain().focus().deleteColumn().run()}>
                    <TABLE_ACTION_ICONS.deleteColumn className="h-4 w-4" /> Delete column
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => editor.chain().focus().deleteTable().run()}>
                    <TABLE_ACTION_ICONS.deleteTable className="h-4 w-4" /> Delete table
                </DropdownMenuItem>
            </>
        ),
    };
}
