import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import { ToolbarMenu } from '@workspace/ui';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    CodeXml,
    Files,
    Hash,
    ImagePlus,
    Link,
    MessageSquarePlus,
    Minus,
    PanelBottom,
    PanelsTopLeft,
    PanelTop,
    SeparatorHorizontal,
    Sigma,
    Table,
} from 'lucide-react';
import { useRef } from 'react';
import { type BandRequest, PAGE_NUMBER_PRESETS } from './headers-footers-panel';
import type { ToolbarState } from './hooks/use-toolbar-state';

type InsertMenuProps = {
    editor: Editor;
    active: ToolbarState;
    keepEditorFocus: (e: Event) => void;
    onLink: () => void;
    onInsertImage?: () => void;
    onAddComment?: () => void;
    onInsertEquation?: () => void;
    onOpenBand?: (request: BandRequest) => void;
};

export function InsertMenu({
    editor,
    active,
    keepEditorFocus,
    onLink,
    onInsertImage,
    onAddComment,
    onInsertEquation,
    onOpenBand,
}: InsertMenuProps) {
    // The equation goes in once the menu has closed, or Radix would hand the focus back to the trigger, away from the
    // new equation's field.
    const insertEquationRef = useRef(false);
    return (
        <ToolbarMenu
            label="Insert"
            onCloseAutoFocus={(e) => {
                if (!insertEquationRef.current) return keepEditorFocus(e);
                insertEquationRef.current = false;
                e.preventDefault();
                onInsertEquation?.();
            }}
        >
            <DropdownMenuItem onClick={onLink}>
                <Link className="h-4 w-4 mr-2" /> Link
            </DropdownMenuItem>
            {onInsertImage && (
                <DropdownMenuItem onClick={onInsertImage}>
                    <ImagePlus className="h-4 w-4 mr-2" /> Image
                </DropdownMenuItem>
            )}
            {/* Where Google's Insert › Symbols › Equation sits: after the image, before the horizontal line. */}
            {onInsertEquation && (
                <DropdownMenuItem
                    onClick={() => {
                        insertEquationRef.current = true;
                    }}
                >
                    <Sigma className="h-4 w-4 mr-2" /> Equation
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
            {onOpenBand && (
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <PanelsTopLeft className="h-4 w-4 mr-2" /> Page elements
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onClick={() => onOpenBand({ band: 'header' })}>
                            <PanelTop className="h-4 w-4 mr-2" /> Header
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onOpenBand({ band: 'footer' })}>
                            <PanelBottom className="h-4 w-4 mr-2" /> Footer
                        </DropdownMenuItem>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Hash className="h-4 w-4 mr-2" /> Page numbers
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {PAGE_NUMBER_PRESETS.map((preset) => (
                                    <DropdownMenuItem
                                        key={preset.label}
                                        onClick={() => onOpenBand({ band: preset.band, preset })}
                                    >
                                        {preset.label}
                                    </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                                {/* Google's Page count goes in at the caret, wherever it is. */}
                                <DropdownMenuItem
                                    onClick={() =>
                                        editor
                                            .chain()
                                            .focus()
                                            .insertContent({ type: 'pageNumber', attrs: { kind: 'pages' } })
                                            .run()
                                    }
                                >
                                    <Files className="h-4 w-4 mr-2" /> Page count
                                </DropdownMenuItem>
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            )}
            {onAddComment && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={!active.canComment} onClick={onAddComment}>
                        <MessageSquarePlus className="h-4 w-4 mr-2" /> Comment
                    </DropdownMenuItem>
                </>
            )}
        </ToolbarMenu>
    );
}
