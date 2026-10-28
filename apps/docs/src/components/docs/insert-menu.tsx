// The Docs Insert menu: links, images, charts, text boxes, equations, rules, page breaks, tables, code blocks, the page
// elements (a header, a footer, page numbers and a footnote) and a comment. It inserts into the editor the toolbar
// follows, and greys out what that editor can't hold. A page-less doc has no page break, header, footer or page number.

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
    Sigma,
    SquareDashed,
    Superscript,
    Table,
    TableOfContents,
} from 'lucide-react';
import { useRef } from 'react';
import { pageWidths } from './extensions/text-column';
import type { ToolbarState } from './hooks/use-toolbar-state';
import type { PageNumberPreset } from './page-numbers';
import { PageNumberItems } from './page-numbers';

type InsertMenuProps = {
    editor: Editor;
    active: ToolbarState;
    keepEditorFocus: (e: Event) => void;
    onLink: () => void;
    onInsertImage?: () => void;
    onAddComment?: () => void;
    onEnterBand?: (edge: BandEdge) => void;
    onPageNumbers?: (preset: PageNumberPreset) => void;
    onInsertEquation?: () => void;
    onInsertFootnote?: () => void;
    onInsertTextBox?: () => void;
    // A note or a text box holds paragraphs only, and no chart, whose panel follows the body.
    inStory: boolean;
    // A band or a note is the active editor, not the body.
    held: boolean;
    pageless: boolean;
};

// What a band can't hold is missing from its editor's schema, and a command for a node the schema lacks throws. A
// story's schema is the body's, so what a note or a text box can't hold is disabled by hand. Those items stay in the
// menu greyed out, as in Google.
export function InsertMenu({
    editor,
    active,
    keepEditorFocus,
    onLink,
    onInsertImage,
    onAddComment,
    onInsertEquation,
    onInsertFootnote,
    onInsertTextBox,
    inStory,
    held,
    pageless,
    onEnterBand,
    onPageNumbers,
}: InsertMenuProps) {
    // An equation, a footnote and a text box go in once the menu has closed, or Radix would hand the focus back to the
    // trigger, away from the new equation's field or note.
    const afterCloseRef = useRef<(() => void) | null>(null);
    return (
        <ToolbarMenu
            label="Insert"
            onCloseAutoFocus={(e) => {
                const insert = afterCloseRef.current;
                if (!insert) return keepEditorFocus(e);
                afterCloseRef.current = null;
                // A document that closed with the menu has destroyed its editors by now, as keepEditorFocus knows.
                if (editor.isDestroyed) return;
                e.preventDefault();
                insert();
            }}
        >
            <DropdownMenuItem onClick={onLink}>
                <Link className="h-4 w-4" /> Link
            </DropdownMenuItem>
            {onInsertImage && (
                <DropdownMenuItem onClick={onInsertImage}>
                    <ImagePlus className="h-4 w-4" /> Image
                </DropdownMenuItem>
            )}
            <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={inStory || !('chart' in editor.schema.nodes)}>
                    <ChartColumn className="h-4 w-4" /> Chart
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    {CHART_TYPE_OPTIONS.map((option) => (
                        <DropdownMenuItem
                            key={option.value}
                            onClick={() =>
                                editor.chain().focus().insertChart(option.value, pageWidths(editor).column).run()
                            }
                        >
                            <option.icon className="h-4 w-4" /> {option.label}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* Word's Insert › Text box, a box in the flow open for typing: none in a band, a code block or a story. */}
            {onInsertTextBox && (
                <DropdownMenuItem
                    disabled={inStory || !active.canInsertTextBox}
                    onClick={() => {
                        afterCloseRef.current = onInsertTextBox;
                    }}
                >
                    <SquareDashed className="h-4 w-4" /> Text box
                </DropdownMenuItem>
            )}
            {/* Where Google's Insert › Symbols › Equation sits: after the chart, before the horizontal line. */}
            {onInsertEquation && (
                <DropdownMenuItem
                    disabled={held}
                    onClick={() => {
                        afterCloseRef.current = onInsertEquation;
                    }}
                >
                    <Sigma className="h-4 w-4" /> Equation
                </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={inStory} onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                <Minus className="h-4 w-4" /> Horizontal rule
            </DropdownMenuItem>
            {!pageless && (
                <DropdownMenuItem
                    disabled={inStory || !('pageBreak' in editor.schema.nodes)}
                    onClick={() => editor.chain().focus().setPageBreak().run()}
                >
                    <SeparatorHorizontal className="h-4 w-4" /> Page break
                    <DropdownMenuShortcut>{formatForDisplay('Mod+Enter')}</DropdownMenuShortcut>
                </DropdownMenuItem>
            )}
            <DropdownMenuItem
                disabled={inStory}
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
                <Table className="h-4 w-4" /> Table
            </DropdownMenuItem>
            <DropdownMenuItem
                disabled={inStory || !('codeBlock' in editor.schema.nodes)}
                onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            >
                <CodeXml className="h-4 w-4" /> Code block
            </DropdownMenuItem>
            {((onEnterBand && onPageNumbers) || onInsertFootnote) && (
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <PanelsTopLeft className="h-4 w-4" /> Page elements
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        {onEnterBand && onPageNumbers && (
                            <>
                                <DropdownMenuItem onClick={() => onEnterBand('header')}>
                                    <PanelTop className="h-4 w-4" /> Header
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onEnterBand('footer')}>
                                    <PanelBottom className="h-4 w-4" /> Footer
                                </DropdownMenuItem>
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger>
                                        <Hash className="h-4 w-4" /> Page numbers
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                        <PageNumberItems editor={editor} onPreset={onPageNumbers} />
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            </>
                        )}
                        {/* Google's Insert › Page elements › Footnote: none in a band, a code block or a note. */}
                        {onInsertFootnote && (
                            <DropdownMenuItem
                                disabled={inStory || !active.canInsertFootnote}
                                onClick={() => {
                                    afterCloseRef.current = onInsertFootnote;
                                }}
                            >
                                <Superscript className="h-4 w-4" /> Footnote
                                <DropdownMenuShortcut>{formatForDisplay('Mod+Alt+F')}</DropdownMenuShortcut>
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            )}
            {/* Last before the comment, as Google's Insert lists its table of contents. Only between the body's blocks. */}
            <DropdownMenuItem
                disabled={inStory || !active.canInsertTableOfContents}
                onClick={() => editor.chain().focus().insertTableOfContents().run()}
            >
                <TableOfContents className="h-4 w-4" /> Table of contents
            </DropdownMenuItem>
            {onAddComment && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={held || !active.canComment} onClick={onAddComment}>
                        <MessageSquarePlus className="h-4 w-4" /> Comment
                    </DropdownMenuItem>
                </>
            )}
        </ToolbarMenu>
    );
}
