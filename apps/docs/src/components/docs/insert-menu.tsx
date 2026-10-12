import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { ToolbarMenu } from '@workspace/ui';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@workspace/ui/components/dropdown-menu';
import { CodeXml, ImagePlus, Link, MessageSquarePlus, Minus, SeparatorHorizontal, Table } from 'lucide-react';
import type { ToolbarState } from './hooks/use-toolbar-state';

type InsertMenuProps = {
    editor: Editor;
    active: ToolbarState;
    keepEditorFocus: (e: Event) => void;
    onLink: () => void;
    onInsertImage?: () => void;
    onAddComment?: () => void;
};

export const InsertMenu = ({
    editor,
    active,
    keepEditorFocus,
    onLink,
    onInsertImage,
    onAddComment,
}: InsertMenuProps) => (
    <ToolbarMenu label="Insert" onCloseAutoFocus={keepEditorFocus}>
        <DropdownMenuItem onClick={onLink}>
            <Link className="h-4 w-4 mr-2" /> Link
        </DropdownMenuItem>
        {onInsertImage && (
            <DropdownMenuItem onClick={onInsertImage}>
                <ImagePlus className="h-4 w-4 mr-2" /> Image
            </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <Minus className="h-4 w-4 mr-2" /> Horizontal rule
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor.chain().focus().setPageBreak().run()}>
            <SeparatorHorizontal className="h-4 w-4 mr-2" /> Page break
            <DropdownMenuShortcut>{formatForDisplay('Mod+Enter')}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
            onClick={() =>
                editor
                    .chain()
                    .focus()
                    .insertTable({
                        rows: 3,
                        cols: 3,
                        withHeaderRow: true,
                    })
                    .run()
            }
        >
            <Table className="h-4 w-4 mr-2" /> Table
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
            <CodeXml className="h-4 w-4 mr-2" /> Code block
        </DropdownMenuItem>
        {onAddComment && (
            <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={active.selectionEmpty} onClick={onAddComment}>
                    <MessageSquarePlus className="h-4 w-4 mr-2" /> Comment
                </DropdownMenuItem>
            </>
        )}
    </ToolbarMenu>
);
