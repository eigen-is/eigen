import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { cn } from '../../../lib/utils';
import { LightEditorToolbar } from './light-editor-toolbar';

type LightEditorProps = {
    content: string;
    onChange: (html: string) => void;
    onChangeText?: (text: string) => void;
    // Fires once after TipTap parses the initial content. Receives the editor
    // instance plus the canonical (trimmed) html/text — same shape onChange
    // will emit, so callers that fingerprint state don't see spurious diffs on
    // first interaction.
    onReady?: (arg: { editor: Editor; html: string; text: string }) => void;
    placeholder?: string;
    toolbar?: 'floating' | 'fixed' | 'none';
    className?: string;
    editable?: boolean;
    // false: skip eigen-prose so caller's font/size/color inherit
    proseStyle?: boolean;
    // Drop `h-full` from the default when the parent should size to content (e.g. for vertical alignment).
    containerClassName?: string;
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

// TipTap leaves an empty paragraph at the end after Enter and sometimes at the
// start. Strip those from the emitted HTML so consumers (mail body, doc save)
// don't carry trailing whitespace that renders as blank lines. Mid-content
// empties are preserved — they're intentional spacing the user added.
const EMPTY_PARA_LEADING = /^\s*(?:<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+/i;
const EMPTY_PARA_TRAILING = /(?:\s*<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>)+\s*$/i;
function trimEmptyEdges(html: string): string {
    return html.replace(EMPTY_PARA_LEADING, '').replace(EMPTY_PARA_TRAILING, '');
}

export function LightEditor({
    content,
    onChange,
    onChangeText,
    onReady,
    placeholder,
    toolbar = 'floating',
    className,
    editable = true,
    proseStyle = true,
    containerClassName = 'relative flex flex-col h-full',
}: LightEditorProps) {
    const editor = useEditor({
        extensions: LIGHT_EXTENSIONS,
        content,
        editable,
        editorProps: {
            attributes: {
                class: cn(proseStyle && 'eigen-prose', 'outline-none min-h-[100px]', className),
                ...(placeholder ? { 'data-placeholder': placeholder } : {}),
            },
        },
        onUpdate: ({ editor: e }) => {
            onChange(trimEmptyEdges(e.getHTML()));
            onChangeText?.(e.getText().trim());
        },
    });

    const readyFiredRef = useRef(false);
    useEffect(() => {
        if (!editor || readyFiredRef.current) return;
        readyFiredRef.current = true;
        onReady?.({ editor, html: trimEmptyEdges(editor.getHTML()), text: editor.getText().trim() });
    }, [editor, onReady]);

    if (!editor) return null;

    return (
        <div className={containerClassName}>
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
