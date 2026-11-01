// The right-click rows of a table of contents, which the Docs editor's menu shows in MenuSections' groups, as Google's
// menu holds its Table of contents options. Each acts on the editor that holds the table of contents, the body's or
// an open note's, which the right-click has selected it in.

import type { Editor } from '@tiptap/react';
import type { MenuSectionsProps } from '@workspace/ui/components/context-menu';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { TableOfContents, Trash2 } from 'lucide-react';

// onOptions shows its panel, none on a phone, which has no panel.
export function tableOfContentsMenuSections(editor: Editor, onOptions: (() => void) | undefined): MenuSectionsProps {
    return {
        create: onOptions && (
            <DropdownMenuItem onClick={onOptions}>
                <TableOfContents className="h-4 w-4" /> Table of contents options
            </DropdownMenuItem>
        ),
        destructive: (
            <DropdownMenuItem variant="destructive" onClick={() => editor.chain().focus().deleteSelection().run()}>
                <Trash2 className="h-4 w-4" /> Delete table of contents
            </DropdownMenuItem>
        ),
    };
}
