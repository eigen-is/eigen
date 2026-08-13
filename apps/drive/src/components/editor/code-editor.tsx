import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown as markdownLang } from '@codemirror/lang-markdown';
import { php } from '@codemirror/lang-php';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import {
    drawSelection,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    keymap,
    lineNumbers,
} from '@codemirror/view';
import { Column, ConfirmDialog, TooltipButton } from '@workspace/ui';
import { DocSearchProvider } from '@workspace/ui/components/search/doc-search-provider';
import { Redo, Undo } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ConflictDialog } from './conflict-dialog';
import { EditToolbar } from './editor-toolbar';
import { useCodeMirrorSearchController } from './use-codemirror-search-controller';
import { useEditorSave } from './use-editor-save';

function getLanguageExtension(language: string | null) {
    switch (language) {
        case 'json':
            return json();
        case 'yaml':
            return yaml();
        case 'xml':
            return xml();
        case 'html':
            return html();
        case 'css':
            return css();
        case 'markdown':
            return markdownLang();
        case 'javascript':
            return javascript();
        case 'typescript':
            return javascript({ typescript: true });
        case 'jsx':
            return javascript({ jsx: true });
        case 'tsx':
            return javascript({ jsx: true, typescript: true });
        case 'python':
            return python();
        case 'rust':
            return rust();
        case 'sql':
            return sql();
        case 'php':
            return php();
        default:
            return [];
    }
}

export function getLanguageFromName(name: string): string | null {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    switch (ext) {
        case '.json':
            return 'json';
        case '.yaml':
        case '.yml':
            return 'yaml';
        case '.xml':
            return 'xml';
        case '.html':
        case '.htm':
        case '.svelte':
        case '.vue':
        case '.astro':
            return 'html';
        case '.css':
            return 'css';
        case '.md':
        case '.markdown':
            return 'markdown';
        case '.js':
        case '.mjs':
        case '.cjs':
            return 'javascript';
        case '.jsx':
            return 'jsx';
        case '.ts':
        case '.mts':
        case '.cts':
            return 'typescript';
        case '.tsx':
            return 'tsx';
        case '.py':
            return 'python';
        case '.rs':
            return 'rust';
        case '.sql':
        case '.graphql':
        case '.gql':
            return 'sql';
        case '.php':
            return 'php';
        default:
            return null;
    }
}

function useDarkMode(): boolean {
    const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setDark(document.documentElement.classList.contains('dark'));
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    return dark;
}

function cmThemeExtensions(isDark: boolean) {
    return [
        EditorView.lineWrapping,
        EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-content': { padding: '16px 0', fontFamily: 'var(--font-mono)' },
            '.cm-gutters': { paddingRight: '8px', fontFamily: 'var(--font-mono)' },
        }),
        ...(isDark ? [oneDark] : []),
    ];
}

function cmBaseExtensions(language: string | null, isDark: boolean) {
    return [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        bracketMatching(),
        history(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        getLanguageExtension(language),
        ...cmThemeExtensions(isDark),
    ];
}

export type CodeEditorViewHandle = {
    undo: () => void;
    redo: () => void;
};

// Shared editable CodeMirror view
export const CodeEditorView = forwardRef<
    CodeEditorViewHandle,
    {
        content: string;
        language: string | null;
        onChange?: (value: string) => void;
        // Publishes the live view (null on teardown) so a parent can drive the find bar over it.
        onViewReady?: (view: EditorView | null) => void;
    }
>(function CodeEditorView({ content, language, onChange, onViewReady }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const isDark = useDarkMode();

    useImperativeHandle(ref, () => ({
        undo: () => viewRef.current && undo(viewRef.current),
        redo: () => viewRef.current && redo(viewRef.current),
    }));

    useEffect(() => {
        if (!containerRef.current) return;
        const extensions = [...cmBaseExtensions(language, isDark)];
        if (onChange) {
            extensions.push(
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) onChange(update.state.doc.toString());
                }),
            );
        }
        const state = EditorState.create({ doc: content, extensions });
        const view = new EditorView({ state, parent: containerRef.current });
        viewRef.current = view;
        onViewReady?.(view);
        return () => {
            view.destroy();
            onViewReady?.(null);
        };
    }, [isDark]);

    return <div ref={containerRef} className="h-full overflow-hidden" />;
});

// Full standalone code editor
type CodeEditorProps = {
    content: string;
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

export function CodeEditor({
    content,
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
}: CodeEditorProps) {
    const contentRef = useRef(content);
    const editorViewRef = useRef<CodeEditorViewHandle>(null);
    const [view, setView] = useState<EditorView | null>(null);
    const searchController = useCodeMirrorSearchController(view, canWrite);
    const language = getLanguageFromName(fileName);

    const getContent = useCallback(() => contentRef.current, []);

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
    });

    const handleChange = useCallback(
        (value: string) => {
            contentRef.current = value;
            markDirty();
        },
        [markDirty],
    );

    const handleDownload = () => {
        const blob = new Blob([contentRef.current], { type: 'text/plain' });
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
            <TooltipButton icon={Undo} tooltipText="Undo" onClick={() => editorViewRef.current?.undo()} />
            <TooltipButton icon={Redo} tooltipText="Redo" onClick={() => editorViewRef.current?.redo()} />
        </EditToolbar>
    );

    return (
        <DocSearchProvider
            controller={searchController}
            barClassName="top-14"
            onUndo={() => editorViewRef.current?.undo()}
            onRedo={() => editorViewRef.current?.redo()}
        >
            <Column id="list" width="flex" toolbar={toolbar}>
                <div className="h-full overflow-hidden">
                    <CodeEditorView
                        ref={editorViewRef}
                        content={content}
                        language={language}
                        onChange={handleChange}
                        onViewReady={setView}
                    />
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
