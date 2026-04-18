import { EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { cn } from '../../../lib/utils';
import { LightEditorToolbar } from './light-editor-toolbar';

type LightEditorProps = {
    content: string;
    onChange: (html: string) => void;
    onChangeText?: (text: string) => void;
    placeholder?: string;
    toolbar?: 'floating' | 'fixed' | 'none';
    className?: string;
    editable?: boolean;
};

// StarterKit configured for "light" rich text: bold, italic, lists, blockquote, hard break, link.
// Heavier structural marks (headings, code blocks, horizontal rules) are disabled.
const LIGHT_EXTENSIONS = [
    StarterKit.configure({
        heading: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: {
            HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
        },
    }),
];

export function LightEditor({
    content,
    onChange,
    onChangeText,
    placeholder,
    toolbar = 'floating',
    className,
    editable = true,
}: LightEditorProps) {
    const editor = useEditor({
        extensions: LIGHT_EXTENSIONS,
        content,
        editable,
        editorProps: {
            attributes: {
                class: cn('eigen-prose outline-none min-h-[100px]', className),
                ...(placeholder ? { 'data-placeholder': placeholder } : {}),
            },
        },
        onUpdate: ({ editor: e }) => {
            onChange(e.getHTML());
            onChangeText?.(e.getText());
        },
    });

    if (!editor) return null;

    return (
        <div className="relative flex flex-col h-full">
            {toolbar === 'fixed' && (
                <div className="mb-2">
                    <LightEditorToolbar editor={editor} />
                </div>
            )}
            {toolbar === 'floating' && (
                <BubbleMenu editor={editor}>
                    <LightEditorToolbar editor={editor} />
                </BubbleMenu>
            )}
            <EditorContent editor={editor} className="flex-1 flex flex-col [&>.tiptap]:flex-1" />
        </div>
    );
}
