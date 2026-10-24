import type { Editor } from '@tiptap/react';
import type { MenuSectionsProps } from '@workspace/ui/components/context-menu';
import { ChoiceMenuSub, DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import type { LucideIcon } from 'lucide-react';
import { Pencil, Rows3, TextCursorInput, Trash2, WrapText } from 'lucide-react';

// The panel's Style row and the menu's Style submenu name an equation's display alike.
export const EQUATION_STYLES: readonly { display: boolean; label: string; icon: LucideIcon }[] = [
    { display: false, label: 'In line with text', icon: TextCursorInput },
    { display: true, label: 'On its own line', icon: Rows3 },
];

// The rows of the equation `editor` has selected, in MenuSections' groups: its panel, the panel's Style choice and
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
            <ChoiceMenuSub
                trigger={
                    <>
                        <WrapText className="h-4 w-4" /> Style
                    </>
                }
                value={display}
                options={EQUATION_STYLES.map(({ display: value, label, icon: Icon }) => ({
                    value,
                    label: (
                        <>
                            <Icon className="h-4 w-4" /> {label}
                        </>
                    ),
                }))}
                onChange={(value) => editor.chain().focus().updateEquation({ display: value }).run()}
            />
        ),
        destructive: (
            <DropdownMenuItem variant="destructive" onClick={() => editor.chain().focus().deleteSelection().run()}>
                <Trash2 className="h-4 w-4" /> Delete equation
            </DropdownMenuItem>
        ),
    };
}
