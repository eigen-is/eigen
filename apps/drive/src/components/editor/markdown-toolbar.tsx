import {Editor} from "@tiptap/react";
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
    Quote,
    Redo,
    Strikethrough,
    Table,
    Undo,
} from "lucide-react";
import {Separator} from "@workspace/ui/components/separator";
import {TooltipButton} from "@workspace/ui";

type MarkdownToolbarButtonsProps = {
    editor: Editor | null;
    sourceMode: boolean;
    onToggleSource: () => void;
};

export function MarkdownToolbarButtons({editor, sourceMode, onToggleSource}: MarkdownToolbarButtonsProps) {
    return (
        <>
            {!sourceMode && editor && (
                <>
                    <TooltipButton icon={Undo} tooltipText="Undo" onClick={() => editor.chain().focus().undo().run()} preventFocusLoss disabled={!editor.can().undo()}/>
                    <TooltipButton icon={Redo} tooltipText="Redo" onClick={() => editor.chain().focus().redo().run()} preventFocusLoss disabled={!editor.can().redo()}/>
                    <Separator orientation="vertical" className="h-6 mx-1"/>

                    <TooltipButton icon={Bold} tooltipText="Bold" onClick={() => editor.chain().focus().toggleBold().run()} preventFocusLoss active={editor.isActive('bold')}/>
                    <TooltipButton icon={Italic} tooltipText="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} preventFocusLoss active={editor.isActive('italic')}/>
                    <TooltipButton icon={Strikethrough} tooltipText="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} preventFocusLoss active={editor.isActive('strike')}/>
                    <TooltipButton icon={Code} tooltipText="Code" onClick={() => editor.chain().focus().toggleCode().run()} preventFocusLoss active={editor.isActive('code')}/>
                    <Separator orientation="vertical" className="h-6 mx-1"/>

                    <TooltipButton icon={Heading1} tooltipText="Heading 1" onClick={() => editor.chain().focus().toggleHeading({level: 1}).run()} preventFocusLoss active={editor.isActive('heading', {level: 1})}/>
                    <TooltipButton icon={Heading2} tooltipText="Heading 2" onClick={() => editor.chain().focus().toggleHeading({level: 2}).run()} preventFocusLoss active={editor.isActive('heading', {level: 2})}/>
                    <TooltipButton icon={Heading3} tooltipText="Heading 3" onClick={() => editor.chain().focus().toggleHeading({level: 3}).run()} preventFocusLoss active={editor.isActive('heading', {level: 3})}/>
                    <Separator orientation="vertical" className="h-6 mx-1"/>

                    <TooltipButton icon={List} tooltipText="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} preventFocusLoss active={editor.isActive('bulletList')}/>
                    <TooltipButton icon={ListOrdered} tooltipText="Ordered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} preventFocusLoss active={editor.isActive('orderedList')}/>
                    <TooltipButton icon={CheckSquare} tooltipText="Task list" onClick={() => editor.chain().focus().toggleTaskList().run()} preventFocusLoss active={editor.isActive('taskList')}/>
                    <Separator orientation="vertical" className="h-6 mx-1"/>

                    <TooltipButton icon={Quote} tooltipText="Blockquote" onClick={() => editor.chain().focus().toggleBlockquote().run()} preventFocusLoss active={editor.isActive('blockquote')}/>
                    <TooltipButton icon={Minus} tooltipText="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()} preventFocusLoss/>
                    <TooltipButton icon={Link} tooltipText="Link" onClick={() => {
                        const url = window.prompt('URL');
                        if (url) editor.chain().focus().setLink({href: url}).run();
                    }} preventFocusLoss active={editor.isActive('link')}/>
                    <TooltipButton icon={Table} tooltipText="Insert table" onClick={() => editor.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run()} preventFocusLoss/>
                    <Separator orientation="vertical" className="h-6 mx-1"/>
                </>
            )}
            <TooltipButton icon={Code2} tooltipText={sourceMode ? "WYSIWYG mode" : "Source mode"} onClick={onToggleSource} active={sourceMode}/>
        </>
    );
}
