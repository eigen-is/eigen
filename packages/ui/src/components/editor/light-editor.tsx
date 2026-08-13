import { TaskItem, TaskList } from '@tiptap/extension-list';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { isFilesOnlyClipboard } from '../../hooks/use-file-paste-target';
import { cn } from '../../lib/utils';
import { LightEditorToolbar } from './light-editor-toolbar';

type LightEditorProps = {
    content: string;
    onChange?: (html: string) => void;
    onChangeText?: (text: string) => void;
    // Canonical (trimmed) html/text on first parse — so callers that fingerprint
    // state don't see spurious diffs on first interaction.
    onReady?: (arg: { editor: Editor; html: string; text: string }) => void;
    placeholder?: string;
    toolbar?: 'floating' | 'fixed' | 'none';
    className?: string;
    editable?: boolean;
    proseStyle?: boolean;
    containerClassName?: string;
    // Read once at mount — useEditor doesn't re-initialise on prop change.
    taskList?: boolean;
    // Inside a form: swallow Mod+Enter so StarterKit's HardBreak doesn't insert a
    // line break before the host's submit hotkey fires. Read once at mount.
    submitOnModEnter?: boolean;
};

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
    taskList = false,
    submitOnModEnter = false,
}: LightEditorProps) {
    const editor = useEditor({
        extensions: [
            StarterKit.configure({
                heading: false,
                codeBlock: false,
                code: false,
                horizontalRule: false,
                link: {
                    autolink: true,
                    openOnClick: true,
                    HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
                },
            }),
            ...(taskList ? [TaskList, TaskItem.configure({ nested: true })] : []),
        ],
        content,
        editable,
        editorProps: {
            attributes: {
                class: cn(proseStyle && 'eigen-prose', 'outline-none min-h-[100px]', className),
                ...(placeholder ? { 'data-placeholder': placeholder } : {}),
            },
            // No file node in the schema: decline files-only pastes so the event bubbles to the host's attach flow.
            handlePaste: (_view, event) => event.clipboardData != null && isFilesOnlyClipboard(event.clipboardData),
            // Swallow Mod+Enter (runs before the HardBreak keymap) so the host's submit hotkey gets a clean event.
            handleKeyDown: (_view, event) =>
                submitOnModEnter && (event.metaKey || event.ctrlKey) && event.key === 'Enter',
        },
        onUpdate: ({ editor: e }) => {
            onChange?.(trimEmptyEdges(e.getHTML()));
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
