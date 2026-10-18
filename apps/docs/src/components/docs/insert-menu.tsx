import { formatForDisplay } from '@tanstack/react-hotkeys';
import type { Editor } from '@tiptap/react';
import type { BandEdge } from '@workspace/lib/docs/eigendoc';
import { ToolbarMenu } from '@workspace/ui';
import { CHART_TYPE_OPTIONS } from '@workspace/ui/components/charts';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    ChartColumn,
    CodeXml,
    Hash,
    ImagePlus,
    Link,
    MessageSquarePlus,
    Minus,
    PanelBottom,
    PanelsTopLeft,
    PanelTop,
    SeparatorHorizontal,
    Table,
} from 'lucide-react';
import { textColumnWidth } from './extensions/text-column';
import type { ToolbarState } from './hooks/use-toolbar-state';
import { PageNumberItems, type PageNumberPreset } from './page-numbers';

type InsertMenuProps = {
    editor: Editor;
    active: ToolbarState;
    keepEditorFocus: (e: Event) => void;
    onLink: () => void;
    onInsertImage?: () => void;
    onAddComment?: () => void;
    onEnterBand?: (edge: BandEdge) => void;
    onPageNumbers?: (preset: PageNumberPreset) => void;
};

// What a band can't hold is missing from its editor's schema, and a command for a node the schema lacks throws.
export const InsertMenu = ({
    editor,
    active,
    keepEditorFocus,
    onLink,
    onInsertImage,
    onAddComment,
    onEnterBand,
    onPageNumbers,
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
        {'chart' in editor.schema.nodes && (
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <ChartColumn className="h-4 w-4 mr-2" /> Chart
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    {CHART_TYPE_OPTIONS.map((option) => (
                        <DropdownMenuItem
                            key={option.value}
                            onClick={() =>
                                editor
                                    .chain()
                                    .focus()
                                    .insertChart(option.value, textColumnWidth(editor.view.dom) ?? undefined)
                                    .run()
                            }
                        >
                            <option.icon className="h-4 w-4 mr-2" /> {option.label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        )}
        <DropdownMenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            <Minus className="h-4 w-4 mr-2" /> Horizontal rule
        </DropdownMenuItem>
        {'pageBreak' in editor.schema.nodes && (
            <DropdownMenuItem onClick={() => editor.chain().focus().setPageBreak().run()}>
                <SeparatorHorizontal className="h-4 w-4 mr-2" /> Page break
                <DropdownMenuShortcut>{formatForDisplay('Mod+Enter')}</DropdownMenuShortcut>
            </DropdownMenuItem>
        )}
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
        {'codeBlock' in editor.schema.nodes && (
            <DropdownMenuItem onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
                <CodeXml className="h-4 w-4 mr-2" /> Code block
            </DropdownMenuItem>
        )}
        {onEnterBand && onPageNumbers && (
            <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                    <PanelsTopLeft className="h-4 w-4 mr-2" /> Page elements
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => onEnterBand('header')}>
                        <PanelTop className="h-4 w-4 mr-2" /> Header
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEnterBand('footer')}>
                        <PanelBottom className="h-4 w-4 mr-2" /> Footer
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Hash className="h-4 w-4 mr-2" /> Page numbers
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <PageNumberItems editor={editor} onPreset={onPageNumbers} />
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
