// The rows of Format › Table, which the table's right-click menu shows too: inserting, merging and deleting rows and
// columns, the selected cells' fill and borders. Each runs a command of the editor that holds the table, as the table
// panel's controls do, so a phone, which has no panel, reaches them here.

import type { Editor } from '@tiptap/react';
import { readHexColor } from '@workspace/lib/constants/colors';
import type { MenuSectionsProps } from '@workspace/ui/components/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { ColorPickerMenuItem } from '@workspace/ui/components/media';
import { PaintBucket } from 'lucide-react';
import type { ToolbarState } from './hooks/use-toolbar-state';
import type { TableAction, TableCommand } from './table-actions';
import { BORDER_SET_LOOKS, TABLE_ACTIONS } from './table-actions';

// The table rows of Format › Table, in MenuSections' groups, for any menu about the table the caret is in.
export function tableMenuSections(
    editor: Editor,
    active: Pick<ToolbarState, 'canMergeCells' | 'canSplitCell' | 'cellBackground'>,
): MenuSectionsProps {
    const item = (command: TableCommand, variant?: 'destructive') => {
        const { icon: Icon, label, enabledBy }: TableAction = TABLE_ACTIONS[command];
        return (
            <DropdownMenuItem
                variant={variant}
                disabled={enabledBy !== undefined && !active[enabledBy]}
                onClick={() => editor.chain().focus()[command]().run()}
            >
                <Icon className="h-4 w-4" /> {label}
            </DropdownMenuItem>
        );
    };
    return {
        create: (
            <>
                {item('addRowBefore')}
                {item('addRowAfter')}
                {item('addColumnBefore')}
                {item('addColumnAfter')}
            </>
        ),
        organize: (
            <>
                {item('distributeColumns')}
                <DropdownMenuSeparator />
                {item('mergeCells')}
                {item('splitCell')}
                <DropdownMenuSeparator />
                {item('toggleHeaderRow')}
                <ColorPickerMenuItem
                    icon={PaintBucket}
                    label="Cell background color"
                    value={active.cellBackground}
                    resetLabel="None"
                    onChange={(color) =>
                        editor.chain().focus().setCellAttribute('backgroundColor', readHexColor(color)).run()
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
                {item('deleteRow', 'destructive')}
                {item('deleteColumn', 'destructive')}
                {item('deleteTable', 'destructive')}
            </>
        ),
    };
}
