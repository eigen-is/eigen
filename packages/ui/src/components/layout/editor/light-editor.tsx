import { EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { cn } from '../../../lib/utils';
import { LightEditorToolbar } from './light-editor-toolbar';
import { getLightExtensions } from './light-extensions';

type LightEditorProps = {
    content: string;
    onChange: (html: string) => void;
    placeholder?: string;
    toolbar?: 'floating' | 'fixed' | 'none';
    className?: string;
    editable?: boolean;
};

export function LightEditor({
    content,
    onChange,
    placeholder,
    toolbar = 'floating',
    className,
    editable = true,
}: LightEditorProps) {
    const editor = useEditor({
        extensions: getLightExtensions(),
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
