import type { Editor } from '@tiptap/react';
import { useIsCompactToolbar } from '@workspace/lib/media';
import { TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Separator } from '@workspace/ui/components/separator';
import {
    Bold,
    CheckSquare,
    Code,
    Code2,
    Heading1,
    Heading2,
    Heading3,
    Italic,
    Link,
    List,
    ListOrdered,
    Minus,
    Pilcrow,
    Quote,
    Redo,
    Strikethrough,
    Table,
    Type,
    Undo,
} from 'lucide-react';

type MarkdownToolbarButtonsProps = {
    editor: Editor | null;
    sourceMode: boolean;
    onToggleSource: () => void;
};

export function MarkdownToolbarButtons({ editor, sourceMode, onToggleSource }: MarkdownToolbarButtonsProps) {
    const isCompact = useIsCompactToolbar();

    return (
        <>
            {!sourceMode &&
                editor &&
                (isCompact ? (
                    <>
                        <TooltipButton
                            icon={Undo}
                            tooltipText="Undo"
                            onClick={() => editor.chain().focus().undo().run()}
                            preventFocusLoss
                            disabled={!editor.can().undo()}
                        />
                        <TooltipButton
                            icon={Redo}
                            tooltipText="Redo"
                            onClick={() => editor.chain().focus().redo().run()}
                            preventFocusLoss
                            disabled={!editor.can().redo()}
                        />
                        <Separator orientation="vertical" className="h-6 mx-1" />

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Format</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger>
                                        <Type className="h-4 w-4 mr-2" /> Text
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleBold().run()}>
                                            <Bold className="h-4 w-4 mr-2" /> Bold
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleItalic().run()}>
                                            <Italic className="h-4 w-4 mr-2" /> Italic
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleStrike().run()}>
                                            <Strikethrough className="h-4 w-4 mr-2" /> Strikethrough
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleCode().run()}>
                                            <Code className="h-4 w-4 mr-2" /> Code
                                        </DropdownMenuItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuSeparator />
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger>
                                        <Heading2 className="h-4 w-4 mr-2" /> Heading
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().setParagraph().run()}>
                                            <Pilcrow className="mr-2 h-4 w-4" /> Normal text
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                                        >
                                            <Heading1 className="mr-2 h-4 w-4" /> Heading 1
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                                        >
                                            <Heading2 className="mr-2 h-4 w-4" /> Heading 2
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                                        >
                                            <Heading3 className="mr-2 h-4 w-4" /> Heading 3
                                        </DropdownMenuItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuSeparator />
                                <DropdownMenuSub>
                                    <DropdownMenuSubTrigger>
                                        <List className="h-4 w-4 mr-2" /> Lists
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent>
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().toggleBulletList().run()}
                                        >
                                            <List className="h-4 w-4 mr-2" /> Bulleted
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onClick={() => editor.chain().focus().toggleOrderedList().run()}
                                        >
                                            <ListOrdered className="h-4 w-4 mr-2" /> Numbered
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => editor.chain().focus().toggleTaskList().run()}>
                                            <CheckSquare className="h-4 w-4 mr-2" /> Checklist
                                        </DropdownMenuItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => editor.chain().focus().toggleBlockquote().run()}>
                                    <Quote className="h-4 w-4 mr-2" /> Blockquote
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Insert</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem
                                    onClick={() => {
                                        const url = window.prompt('URL');
                                        if (url) editor.chain().focus().setLink({ href: url }).run();
                                    }}
                                >
                                    <Link className="h-4 w-4 mr-2" /> Link
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => editor.chain().focus().setHorizontalRule().run()}>
                                    <Minus className="h-4 w-4 mr-2" /> Horizontal rule
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() =>
                                        editor
                                            .chain()
                                            .focus()
                                            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                                            .run()
                                    }
                                >
                                    <Table className="h-4 w-4 mr-2" /> Table
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Separator orientation="vertical" className="h-6 mx-1" />
                    </>
                ) : (
                    <>
                        <TooltipButton
                            icon={Undo}
                            tooltipText="Undo"
                            onClick={() => editor.chain().focus().undo().run()}
                            preventFocusLoss
                            disabled={!editor.can().undo()}
                        />
                        <TooltipButton
                            icon={Redo}
                            tooltipText="Redo"
                            onClick={() => editor.chain().focus().redo().run()}
                            preventFocusLoss
                            disabled={!editor.can().redo()}
                        />
                        <Separator orientation="vertical" className="h-6 mx-1" />

                        <TooltipButton
                            icon={Bold}
                            tooltipText="Bold"
                            onClick={() => editor.chain().focus().toggleBold().run()}
                            preventFocusLoss
                            active={editor.isActive('bold')}
                        />
                        <TooltipButton
                            icon={Italic}
                            tooltipText="Italic"
                            onClick={() => editor.chain().focus().toggleItalic().run()}
                            preventFocusLoss
                            active={editor.isActive('italic')}
                        />
                        <TooltipButton
                            icon={Strikethrough}
                            tooltipText="Strikethrough"
                            onClick={() => editor.chain().focus().toggleStrike().run()}
                            preventFocusLoss
                            active={editor.isActive('strike')}
                        />
                        <TooltipButton
                            icon={Code}
                            tooltipText="Code"
                            onClick={() => editor.chain().focus().toggleCode().run()}
                            preventFocusLoss
                            active={editor.isActive('code')}
                        />
                        <Separator orientation="vertical" className="h-6 mx-1" />

                        <TooltipButton
                            icon={Heading1}
                            tooltipText="Heading 1"
                            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                            preventFocusLoss
                            active={editor.isActive('heading', { level: 1 })}
                        />
                        <TooltipButton
                            icon={Heading2}
                            tooltipText="Heading 2"
                            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                            preventFocusLoss
                            active={editor.isActive('heading', { level: 2 })}
                        />
                        <TooltipButton
                            icon={Heading3}
                            tooltipText="Heading 3"
                            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
                            preventFocusLoss
                            active={editor.isActive('heading', { level: 3 })}
                        />
                        <Separator orientation="vertical" className="h-6 mx-1" />

                        <TooltipButton
                            icon={List}
                            tooltipText="Bullet list"
                            onClick={() => editor.chain().focus().toggleBulletList().run()}
                            preventFocusLoss
                            active={editor.isActive('bulletList')}
                        />
                        <TooltipButton
                            icon={ListOrdered}
                            tooltipText="Ordered list"
                            onClick={() => editor.chain().focus().toggleOrderedList().run()}
                            preventFocusLoss
                            active={editor.isActive('orderedList')}
                        />
                        <TooltipButton
                            icon={CheckSquare}
                            tooltipText="Task list"
                            onClick={() => editor.chain().focus().toggleTaskList().run()}
                            preventFocusLoss
                            active={editor.isActive('taskList')}
                        />
                        <Separator orientation="vertical" className="h-6 mx-1" />

                        <TooltipButton
                            icon={Quote}
                            tooltipText="Blockquote"
                            onClick={() => editor.chain().focus().toggleBlockquote().run()}
                            preventFocusLoss
                            active={editor.isActive('blockquote')}
                        />
                        <TooltipButton
                            icon={Minus}
                            tooltipText="Horizontal rule"
                            onClick={() => editor.chain().focus().setHorizontalRule().run()}
                            preventFocusLoss
                        />
                        <TooltipButton
                            icon={Link}
                            tooltipText="Link"
                            onClick={() => {
                                const url = window.prompt('URL');
                                if (url) editor.chain().focus().setLink({ href: url }).run();
                            }}
                            preventFocusLoss
                            active={editor.isActive('link')}
                        />
                        <TooltipButton
                            icon={Table}
                            tooltipText="Insert table"
                            onClick={() =>
                                editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
                            }
                            preventFocusLoss
                        />
                        <Separator orientation="vertical" className="h-6 mx-1" />
                    </>
                ))}
            <TooltipButton
                icon={Code2}
                tooltipText={sourceMode ? 'WYSIWYG mode' : 'Source mode'}
                onClick={onToggleSource}
                active={sourceMode}
            />
        </>
    );
}
