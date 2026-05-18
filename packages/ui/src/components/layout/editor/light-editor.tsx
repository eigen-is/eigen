import { TaskItem, TaskList } from '@tiptap/extension-list';
import { type Editor, EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { cn } from '../../../lib/utils';
import { LightEditorToolbar } from './light-editor-toolbar';

type LightEditorProps = {
    content: string;
    // Required when `editable` is true (default); omit for read-only viewers.
    onChange?: (html: string) => void;
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
    // Read once at mount — useEditor doesn't re-initialise on prop change.
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

// Shared input-style wrapper for embedding LightEditor inside a form — mimics
// the shadcn Input border/focus-ring so the description field reads consistently
// alongside Input/Label rows.
export function EditorShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-within:ring-[3px] focus-within:ring-ring/50">
            {children}
        </div>
    );
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
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;

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
            ...(taskList
                ? [
                      TaskList,
                      TaskItem.configure({
                          nested: true,
                          onReadOnlyChecked: (node, checked) => {
                              // TipTap's read-only flow only flips the DOM checkbox; it doesn't
                              // touch ProseMirror state, so `getHTML()` keeps emitting the old
                              // data-checked. Mirror the editable path (setNodeMarkup) ourselves
                              // so the toggle persists and reaches Y.Doc through onCheckedChange.
                              const e = editorRef.current;
                              if (!e) return false;
                              let pos = -1;
                              e.state.doc.descendants((descendant, p) => {
                                  if (descendant === node) {
                                      pos = p;
                                      return false;
                                  }
                                  return true;
                              });
                              if (pos === -1) return false;
                              const tr = e.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
                              e.view.dispatch(tr);
                              queueMicrotask(() => {
                                  const cb = onCheckedChangeRef.current;
                                  if (cb) cb(trimEmptyEdges(e.getHTML()));
                              });
                              return true;
                          },
                      }),
                  ]
                : []),
        ],
        content: trimEmptyEdges(content),
        editable,
        editorProps: {
            attributes: {
                class: cn(proseStyle && 'eigen-prose', 'outline-none min-h-[100px]', className),
                ...(placeholder ? { 'data-placeholder': placeholder } : {}),
            },
        },
        onUpdate: ({ editor: e }) => {
            onChange?.(trimEmptyEdges(e.getHTML()));
            onChangeText?.(e.getText().trim());
        },
    });
    editorRef.current = editor;

    const readyFiredRef = useRef(false);
    useEffect(() => {
        if (!editor || readyFiredRef.current) return;
        readyFiredRef.current = true;
        onReadyRef.current?.({ editor, html: trimEmptyEdges(editor.getHTML()), text: editor.getText().trim() });
    }, [editor]);

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
