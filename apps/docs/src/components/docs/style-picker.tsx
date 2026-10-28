// The paragraph-style dropdown at the start of Docs' formatting row: Normal text and the headings, each drawn as it
// looks; Title and Subtitle are in the Format menu. It opens without blocking the page, as the bar's menus
// do, and hands the focus back to the editor as it closes.

import type { Editor } from '@tiptap/react';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Separator } from '@workspace/ui/components/separator';
import { ChevronDown, Pilcrow } from 'lucide-react';
import type { ToolbarState } from './hooks/use-toolbar-state';
import { paragraphStylesIn } from './paragraph-styles';

type StylePickerProps = {
    editor: Editor;
    active: ToolbarState;
    keepEditorFocus: (e: Event) => void;
};

export const StylePicker = ({ editor, active, keepEditorFocus }: StylePickerProps) => (
    <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 px-2 gap-1" onMouseDown={(e) => e.preventDefault()}>
                <span className="text-xs whitespace-nowrap">
                    {active.mixedStyles ? '' : (active.paragraphStyle ?? 'Normal text')}
                </span>
                <ChevronDown className="h-3 w-3" />
            </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent onCloseAutoFocus={keepEditorFocus}>
            <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                <Pilcrow className="h-4 w-4" /> Normal text
            </DropdownMenuItem>
            <Separator className="my-1" />
            {paragraphStylesIn(editor.schema, 'headings').map(({ name, type, attrs, icon: Icon, preview }) => (
                <DropdownMenuItem
                    key={name}
                    onClick={() => editor.chain().focus().toggleNode(type, 'paragraph', attrs).run()}
                >
                    <Icon className="h-4 w-4" /> <span className={preview}>{name}</span>
                </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
    </DropdownMenu>
);
