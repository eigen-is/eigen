import {forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState} from 'react';
import {
    drawSelection,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    keymap,
    lineNumbers
} from '@codemirror/view';
import {EditorState} from '@codemirror/state';
import {defaultKeymap, history, historyKeymap, redo, undo} from '@codemirror/commands';
import {bracketMatching, defaultHighlightStyle, syntaxHighlighting} from '@codemirror/language';
import {oneDark} from '@codemirror/theme-one-dark';
import {json} from '@codemirror/lang-json';
import {yaml} from '@codemirror/lang-yaml';
import {xml} from '@codemirror/lang-xml';
import {html} from '@codemirror/lang-html';
import {css} from '@codemirror/lang-css';
import {markdown as markdownLang} from '@codemirror/lang-markdown';
import {javascript} from '@codemirror/lang-javascript';
import {python} from '@codemirror/lang-python';
import {rust} from '@codemirror/lang-rust';
import {sql} from '@codemirror/lang-sql';
import {php} from '@codemirror/lang-php';
import {Redo, Undo} from 'lucide-react';
import {TooltipButton} from "@workspace/ui";
import {Column} from '@workspace/ui/components/layout/app/column-layout';
import {ConflictDialog} from './conflict-dialog';
import {EditToolbar} from './editor-toolbar';
import {useEditorSave} from './use-editor-save';

function getLanguageExtension(language: string | null) {
    switch (language) {
        case 'json': return json();
        case 'yaml': return yaml();
        case 'xml': return xml();
        case 'html': return html();
        case 'css': return css();
        case 'markdown': return markdownLang();
        case 'javascript': return javascript();
        case 'typescript': return javascript({typescript: true});
        case 'jsx': return javascript({jsx: true});
        case 'tsx': return javascript({jsx: true, typescript: true});
        case 'python': return python();
        case 'rust': return rust();
        case 'sql': return sql();
        case 'php': return php();
        default: return [];
    }
}

export function getLanguageFromName(name: string): string | null {
    const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
    switch (ext) {
        case '.json': return 'json';
        case '.yaml': case '.yml': return 'yaml';
        case '.xml': return 'xml';
        case '.html': case '.htm': case '.svelte': case '.vue': case '.astro': return 'html';
        case '.css': return 'css';
        case '.md': case '.markdown': return 'markdown';
        case '.js': case '.mjs': case '.cjs': return 'javascript';
        case '.jsx': return 'jsx';
        case '.ts': case '.mts': case '.cts': return 'typescript';
        case '.tsx': return 'tsx';
        case '.py': return 'python';
        case '.rs': return 'rust';
        case '.sql': case '.graphql': case '.gql': return 'sql';
        case '.php': return 'php';
        default: return null;
    }
}

function useDarkMode(): boolean {
    const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setDark(document.documentElement.classList.contains('dark'));
        });
        observer.observe(document.documentElement, {attributes: true, attributeFilter: ['class']});
        return () => observer.disconnect();
    }, []);
    return dark;
}

function cmThemeExtensions(isDark: boolean) {
    return [
        EditorView.lineWrapping,
        EditorView.theme({
            '&': {height: '100%'},
            '.cm-scroller': {overflow: 'auto'},
            '.cm-content': {padding: '16px 0'},
            '.cm-gutters': {paddingRight: '8px'},
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
        syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
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
export const CodeEditorView = forwardRef<CodeEditorViewHandle, {
    content: string;
    language: string | null;
    onChange?: (value: string) => void;
}>(function CodeEditorView({content, language, onChange}, ref) {
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
            extensions.push(EditorView.updateListener.of(update => {
                if (update.docChanged) onChange(update.state.doc.toString());
            }));
        }
        const state = EditorState.create({doc: content, extensions});
        const view = new EditorView({state, parent: containerRef.current});
        viewRef.current = view;
        return () => view.destroy();
    }, [isDark]);

    return <div ref={containerRef} className="h-full overflow-hidden"/>;
});

// Full standalone code editor
type CodeEditorProps = {
    content: string;
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

export function CodeEditor({content, updatedAt, ownerId, mountId, pathId, fileName, onBack, onCancel, onSaved, onReload}: CodeEditorProps) {
    const contentRef = useRef(content);
    const editorViewRef = useRef<CodeEditorViewHandle>(null);
    const language = getLanguageFromName(fileName);

    const getContent = useCallback(() => contentRef.current, []);

    const {saveState, showConflict, setShowConflict, markDirty, doSave, confirmClose} =
        useEditorSave({ownerId, mountId, pathId, updatedAt, getContent});

    const handleChange = useCallback((value: string) => {
        contentRef.current = value;
        markDirty();
    }, [markDirty]);

    const handleDownload = () => {
        const blob = new Blob([contentRef.current], {type: 'text/plain'});
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
            <TooltipButton icon={Undo} tooltipText="Undo" onClick={() => editorViewRef.current?.undo()}/>
            <TooltipButton icon={Redo} tooltipText="Redo" onClick={() => editorViewRef.current?.redo()}/>
        </EditToolbar>
    );

    return (
        <Column id="list" width="flex" toolbar={toolbar}>
            <div className="h-full overflow-hidden">
                <CodeEditorView ref={editorViewRef} content={content} language={language} onChange={handleChange}/>
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
