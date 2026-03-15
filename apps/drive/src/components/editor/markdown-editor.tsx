import {useCallback, useRef, useState} from 'react';
import {EditorContent, useEditor} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from 'tiptap-markdown';
import Typography from '@tiptap/extension-typography';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import LinkExtension from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {Table} from '@tiptap/extension-table';
import {TableRow} from '@tiptap/extension-table-row';
import {TableCell} from '@tiptap/extension-table-cell';
import {TableHeader} from '@tiptap/extension-table-header';
import {all, createLowlight} from 'lowlight';
import {Column} from '@workspace/ui/components/layout/app/column-layout';
import {MarkdownToolbarButtons} from './markdown-toolbar';
import {ConflictDialog} from './conflict-dialog';
import {CodeEditorView} from './code-editor';
import {EditToolbar} from './editor-toolbar';
import {useEditorSave} from './use-editor-save';

const lowlight = createLowlight(all);

function detectBulletMarker(content: string): '-' | '*' | '+' {
    const markers = content.match(/^[\s]*([*+\-])\s/gm);
    if (!markers) return '-';
    const counts = {'-': 0, '*': 0, '+': 0};
    for (const m of markers) {
        const char = m.trim()[0] as '-' | '*' | '+';
        if (char in counts) counts[char]++;
    }
    return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as '-' | '*' | '+';
}

function detectLineEnding(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function useMarkdownExtensions(content: string) {
    const bulletMarker = detectBulletMarker(content);
    return [
        StarterKit.configure({codeBlock: false}),
        Markdown.configure({
            html: true, tightLists: true, bulletListMarker: bulletMarker,
            transformPastedText: true, transformCopiedText: true,
        }),
        Typography, TaskList, TaskItem.configure({nested: true}),
        LinkExtension.configure({openOnClick: false}), Image,
        CodeBlockLowlight.configure({lowlight}),
        Table.configure({resizable: false}), TableRow, TableCell, TableHeader,
    ];
}

// Read-only markdown viewer
export function MarkdownViewer({content}: {content: string}) {
    const editor = useEditor({
        extensions: useMarkdownExtensions(content),
        content,
        editable: false,
    });

    return (
        <div className="h-full overflow-auto">
            <div className="w-full px-12 py-6">
                <EditorContent editor={editor}/>
            </div>
        </div>
    );
}

// Full markdown editor with save logic
type MarkdownEditorProps = {
    content: string;
    frontmatter: string | null;
    updatedAt: string;
    ownerId: string;
    mountId: string;
    pathId: string;
    fileName: string;
    onBack: () => void;
    onCancel: () => void;
    onSaved: () => void;
    onReload: () => void;
};

export function MarkdownEditor({content, frontmatter, updatedAt, ownerId, mountId, pathId, fileName, onBack, onCancel, onSaved, onReload}: MarkdownEditorProps) {
    const [sourceMode, setSourceMode] = useState(false);
    const [sourceContent, setSourceContent] = useState('');
    const lineEndingRef = useRef(detectLineEnding(content));

    const editor = useEditor({
        extensions: useMarkdownExtensions(content),
        content,
        onUpdate: () => {
            markDirty();
            scheduleSave();
        },
    });

    const getContent = useCallback((): string => {
        if (sourceMode) return sourceContent;
        if (!editor) return content;
        const md = (editor.storage as any).markdown.getMarkdown() as string;
        if (lineEndingRef.current === '\r\n') return md.replace(/\n/g, '\r\n');
        return md;
    }, [sourceMode, sourceContent, editor, content]);

    const getFrontmatter = useCallback(() => frontmatter ?? undefined, [frontmatter]);

    const {saveState, showConflict, setShowConflict, markDirty, scheduleSave, doSave, confirmClose} =
        useEditorSave({ownerId, mountId, pathId, updatedAt, getContent, getFrontmatter});

    const handleToggleSource = useCallback(() => {
        if (sourceMode) {
            editor?.commands.setContent(sourceContent);
            setSourceMode(false);
        } else {
            const md = (editor?.storage as any)?.markdown?.getMarkdown() as string ?? '';
            setSourceContent(md);
            setSourceMode(true);
        }
    }, [sourceMode, sourceContent, editor]);

    const handleDownload = () => {
        const blob = new Blob([getContent()], {type: 'text/markdown'});
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
        <EditToolbar onBack={() => confirmClose(onBack)} onCancel={onCancel} onSave={handleSave} isSaving={saveState === 'saving'}>
            <MarkdownToolbarButtons editor={editor} sourceMode={sourceMode} onToggleSource={handleToggleSource}/>
        </EditToolbar>
    );

    return (
        <Column id="list" width="flex" toolbar={toolbar}>
            <div className="h-full overflow-auto">
                {sourceMode ? (
                    <CodeEditorView
                        content={sourceContent}
                        language="markdown"
                        onChange={(val) => {
                            setSourceContent(val);
                            markDirty();
                            scheduleSave();
                        }}
                    />
                ) : (
                    <div className="w-full px-12 py-6">
                        <EditorContent editor={editor}/>
                    </div>
                )}
            </div>
            <ConflictDialog
                open={showConflict}
                onOpenChange={setShowConflict}
                onOverwrite={() => { setShowConflict(false); doSave(true); }}
                onReload={() => { setShowConflict(false); onReload(); }}
                onDownload={handleDownload}
            />
        </Column>
    );
}
