// The row of formatting buttons above or over a LightEditor: bold, italic, lists, quote and a link. The link button
// opens a small URL field. Enter there sets the link without submitting a form the editor sits in, and Escape closes
// the field without closing a dialog around it.

import type { Editor } from '@tiptap/react';
import { Bold, Italic, Link, List, ListChecks, ListOrdered, Quote } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

// The key of the bubble menu a floating toolbar sits in, so the toolbar can ask the menu to place itself again.
export const LIGHT_EDITOR_BUBBLE_MENU = 'lightEditorBubbleMenu';

type ToolbarButtonProps = {
    icon: React.ComponentType<{ className?: string }>;
    isActive?: boolean;
    onClick: () => void;
    title: string;
};

function ToolbarButton({ icon: Icon, isActive, onClick, title }: ToolbarButtonProps) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            className={cn('p-1.5 rounded hover:bg-muted transition-colors', isActive && 'bg-muted text-foreground')}
            onMouseDown={(e) => {
                e.preventDefault();
                onClick();
            }}
        >
            <Icon className="h-4 w-4" />
        </button>
    );
}

export function LightEditorToolbar({ editor }: { editor: Editor }) {
    const [linkUrl, setLinkUrl] = useState('');
    const [showLinkInput, setShowLinkInput] = useState(false);
    const linkField = useRef<HTMLInputElement>(null);

    // The field widens a floating toolbar past where its menu was placed, and in a dialog that scrolls, focusing the
    // field would scroll the dialog sideways to show it. So the menu places itself again and the focus does not scroll.
    useEffect(() => {
        if (!showLinkInput) return;
        linkField.current?.focus({ preventScroll: true });
        editor.view.dispatch(editor.state.tr.setMeta(LIGHT_EDITOR_BUBBLE_MENU, 'updatePosition'));
    }, [editor, showLinkInput]);

    const setLink = useCallback(() => {
        if (linkUrl.trim()) {
            const url =
                linkUrl.startsWith('http://') || linkUrl.startsWith('https://') ? linkUrl : `https://${linkUrl}`;
            editor.chain().focus().setLink({ href: url }).run();
        }
        setShowLinkInput(false);
        setLinkUrl('');
    }, [editor, linkUrl]);

    return (
        <div className="flex items-center gap-0.5 p-1 rounded-md border bg-popover text-popover-foreground shadow-md">
            <ToolbarButton
                icon={Bold}
                isActive={editor.isActive('bold')}
                onClick={() => editor.chain().focus().toggleBold().run()}
                title="Bold"
            />
            <ToolbarButton
                icon={Italic}
                isActive={editor.isActive('italic')}
                onClick={() => editor.chain().focus().toggleItalic().run()}
                title="Italic"
            />
            <ToolbarButton
                icon={List}
                isActive={editor.isActive('bulletList')}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
                title="Bullet list"
            />
            <ToolbarButton
                icon={ListOrdered}
                isActive={editor.isActive('orderedList')}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
                title="Numbered list"
            />
            {editor.schema.nodes.taskList && (
                <ToolbarButton
                    icon={ListChecks}
                    isActive={editor.isActive('taskList')}
                    onClick={() => editor.chain().focus().toggleTaskList().run()}
                    title="Checklist"
                />
            )}
            <ToolbarButton
                icon={Quote}
                isActive={editor.isActive('blockquote')}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
                title="Quote"
            />
            <ToolbarButton
                icon={Link}
                isActive={editor.isActive('link')}
                onClick={() => {
                    if (editor.isActive('link')) {
                        editor.chain().focus().unsetLink().run();
                    } else {
                        setShowLinkInput(true);
                    }
                }}
                title="Link"
            />
            {showLinkInput && (
                <input
                    ref={linkField}
                    type="url"
                    aria-label="Link URL"
                    // Escape closes this field only, not a dialog the editor sits in.
                    data-owns-escape
                    placeholder="https://..."
                    className="ml-1 px-2 py-1 text-xs border rounded bg-background w-40"
                    value={linkUrl}
                    onChange={(e) => setLinkUrl(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            setLink();
                        }
                        if (e.key === 'Escape') setShowLinkInput(false);
                    }}
                />
            )}
        </div>
    );
}
