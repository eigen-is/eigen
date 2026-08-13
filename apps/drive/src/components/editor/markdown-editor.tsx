import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Typography from '@tiptap/extension-typography';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Column, ConfirmDialog } from '@workspace/ui';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { useProseMirrorSearchController } from '@workspace/ui/components/search/prosemirror-search-controller';
import { SearchHighlight } from '@workspace/ui/components/search/prosemirror-search-highlight';
import { common, createLowlight } from 'lowlight';
import { useCallback, useRef, useState } from 'react';
import { Markdown } from 'tiptap-markdown';
import { CodeEditorView } from './code-editor';
import { ConflictDialog } from './conflict-dialog';
import { EditToolbar } from './editor-toolbar';
import { MarkdownToolbarButtons } from './markdown-toolbar';
import { useCodeMirrorSearchController } from './use-codemirror-search-controller';
import { useEditorSave } from './use-editor-save';

const lowlight = createLowlight(common);

function detectBulletMarker(content: string): '-' | '*' | '+' {
    const markers = content.match(/^[\s]*([*+-])\s/gm);
    if (!markers) return '-';
    const counts = { '-': 0, '*': 0, '+': 0 };
    for (const m of markers) {
        const char = m.trim()[0] as '-' | '*' | '+';
        if (char in counts) counts[char]++;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] as '-' | '*' | '+';
}

function detectLineEnding(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function useMarkdownExtensions(content: string) {
    const bulletMarker = detectBulletMarker(content);
    return [
        StarterKit.configure({
            codeBlock: false,
            link: { openOnClick: false },
        }),
        Markdown.configure({
            html: true,
            tightLists: true,
            bulletListMarker: bulletMarker,
            transformPastedText: true,
            transformCopiedText: true,
        }),
        Typography,
        TaskList,
        TaskItem.configure({ nested: true }),
        Image,
        CodeBlockLowlight.configure({ lowlight }),
        Table.configure({ resizable: false }),
        TableRow,
        TableCell,
        TableHeader,
        SearchHighlight,
    ];
}

// Full markdown editor with save logic
type MarkdownEditorProps = {
    content: string;
    frontmatter: string | null;
    updatedAt: Date;
    ownerId: string;
    mountId: string;
    pathId: string;
    fileName: string;
    canWrite: boolean;
    onBack: () => void;
    onCancel: () => void;
    onSaved: () => void;
    onReload: () => void;
};

export function MarkdownEditor({
    content,
    frontmatter,
    updatedAt,
    ownerId,
    mountId,
    pathId,
    fileName,
    canWrite,
    onBack,
    onCancel,
    onSaved,
    onReload,
}: MarkdownEditorProps) {
    const [sourceMode, setSourceMode] = useState(false);
    const [sourceContent, setSourceContent] = useState('');
    const [sourceView, setSourceView] = useState<EditorView | null>(null);
    const lineEndingRef = useRef(detectLineEnding(content));

    const editor = useEditor({
        extensions: useMarkdownExtensions(content),
        content,
        onUpdate: () => {
            markDirty();
        },
    });

    // One find bar over whichever surface is active: the TipTap doc in WYSIWYG, the CodeMirror source
    // view in source mode. Swapping the controller identity makes the provider re-run the open search
    // against the newly-active editor.
    const pmController = useProseMirrorSearchController(editor, canWrite);
    const cmController = useCodeMirrorSearchController(sourceView, canWrite);
    const searchController = sourceMode ? cmController : pmController;

    const getContent = useCallback((): string => {
        if (sourceMode) return sourceContent;
        if (!editor) return content;
        const md = (editor.storage as unknown as Record<string, { getMarkdown: () => string }>).markdown.getMarkdown();
        if (lineEndingRef.current === '\r\n') return md.replace(/\n/g, '\r\n');
        return md;
    }, [sourceMode, sourceContent, editor, content]);

    const getFrontmatter = useCallback(() => frontmatter ?? undefined, [frontmatter]);

    const {
        saveState,
        showConflict,
        setShowConflict,
        markDirty,
        doSave,
        confirmClose,
        showDiscardConfirm,
        handleDiscardConfirm,
        handleDiscardCancel,
    } = useEditorSave({
        ownerId,
        mountId,
        pathId,
        updatedAt,
        getContent,
        getFrontmatter,
    });

    const handleToggleSource = useCallback(() => {
        if (sourceMode) {
            editor?.commands.setContent(sourceContent);
            setSourceMode(false);
        } else {
            const md =
                (
                    editor?.storage as unknown as Record<string, { getMarkdown: () => string }> | undefined
                )?.markdown?.getMarkdown() ?? '';
            setSourceContent(md);
            setSourceMode(true);
        }
    }, [sourceMode, sourceContent, editor]);

    const handleDownload = () => {
        const blob = new Blob([getContent()], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(a.href);
        setShowConflict(false);
        onReload();
    };

    const handleSave = async () => {
        const ok = await doSave();
        if (ok) onSaved();
    };

    const toolbar = (
        <EditToolbar
            onBack={() => confirmClose(onBack)}
            onCancel={() => confirmClose(onCancel)}
            onSave={handleSave}
            isSaving={saveState === 'saving'}
        >
            <MarkdownToolbarButtons editor={editor} sourceMode={sourceMode} onToggleSource={handleToggleSource} />
        </EditToolbar>
    );

    return (
        <DocSearchProvider
            controller={searchController}
            barClassName="top-14"
            onUndo={() => (sourceMode ? sourceView && undo(sourceView) : editor?.commands.undo())}
            onRedo={() => (sourceMode ? sourceView && redo(sourceView) : editor?.commands.redo())}
        >
            <Column id="list" width="flex" toolbar={toolbar}>
                <div className="h-full overflow-auto">
                    {sourceMode ? (
                        <CodeEditorView
                            content={sourceContent}
                            language="markdown"
                            onChange={(val) => {
                                setSourceContent(val);
                                markDirty();
                            }}
                            onViewReady={setSourceView}
                        />
                    ) : (
                        <div className="w-full px-12 py-6">
                            <EditorContent editor={editor} />
                        </div>
                    )}
                </div>
                <ConflictDialog
                    open={showConflict}
                    onOpenChange={setShowConflict}
                    onOverwrite={() => {
                        setShowConflict(false);
                        doSave(true);
                    }}
                    onReload={() => {
                        setShowConflict(false);
                        onReload();
                    }}
                    onDownload={handleDownload}
                />
                <ConfirmDialog
                    open={showDiscardConfirm}
                    onOpenChange={(open) => {
                        if (!open) handleDiscardCancel();
                    }}
                    title="Discard changes?"
                    description="You have unsaved changes. Discard them?"
                    confirmText="Discard"
                    onConfirm={handleDiscardConfirm}
                />
            </Column>
        </DocSearchProvider>
    );
}
