import type { Editor } from '@tiptap/react';
import type { MenuSectionsProps } from '@workspace/ui/components/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
} from '@workspace/ui/components/dropdown-menu';
import { Pencil, Trash2 } from 'lucide-react';

// The rows of the equation `editor` has selected, in MenuSections' groups: its panel, the panel's Style switch and
// Delete. onEdit opens the panel, none on a phone, which has no panel.
export function equationMenuSections(
    editor: Editor,
    display: boolean,
    onEdit: (() => void) | undefined,
): MenuSectionsProps {
    return {
        create: onEdit && (
            <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4" /> Edit equation
            </DropdownMenuItem>
        ),
        organize: (
            <DropdownMenuRadioGroup value={String(display)}>
                <DropdownMenuRadioItem
                    value="false"
                    onSelect={() => editor.chain().focus().updateEquation({ display: false }).run()}
                >
                    In line with text
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                    value="true"
                    onSelect={() => editor.chain().focus().updateEquation({ display: true }).run()}
                >
                    On its own line
                </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
        ),
        destructive: (
            <DropdownMenuItem variant="destructive" onClick={() => editor.chain().focus().deleteSelection().run()}>
                <Trash2 className="h-4 w-4" /> Delete equation
            </DropdownMenuItem>
        ),
    };
}
