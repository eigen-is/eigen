import type { AnyExtension } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
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
    // Opt-in TipTap TaskList + TaskItem ([] shortcut, toolbar button, data-checked persistence).
    taskList?: boolean;
    // Only fires when `editable === false` and the user clicks a task-item checkbox.
    // `onUpdate` is not guaranteed in read-only mode, so this is the canonical signal.
    onCheckedChange?: (html: string) => void;
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

// Build extensions per-instance so the TaskItem onReadOnlyChecked closure
// captures the current onCheckedChange prop value through the editor ref.
function buildExtensions(opts: {
    taskList: boolean;
    getEditor: () => Editor | null;
    getOnCheckedChange: () => ((html: string) => void) | undefined;
}) {
    const list: AnyExtension[] = [
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
    ];
    if (opts.taskList) {
        list.push(TaskList);
        list.push(
            TaskItem.configure({
                nested: true,
                onReadOnlyChecked: () => {
                    // Return true to let ProseMirror commit the toggle, then read the
                    // post-commit HTML on the next microtask and bubble it up.
                    queueMicrotask(() => {
                        const editor = opts.getEditor();
                        const cb = opts.getOnCheckedChange();
                        if (editor && cb) cb(trimEmptyEdges(editor.getHTML()));
                    });
                    return true;
                },
            }),
        );
    }
    return list;
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
    onCheckedChange,
}: LightEditorProps) {
    const editorRef = useRef<Editor | null>(null);
    const onCheckedChangeRef = useRef(onCheckedChange);
    onCheckedChangeRef.current = onCheckedChange;

    const editor = useEditor({
        extensions: buildExtensions({
            taskList,
            getEditor: () => editorRef.current,
            getOnCheckedChange: () => onCheckedChangeRef.current,
        }),
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
    editorRef.current = editor;

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
