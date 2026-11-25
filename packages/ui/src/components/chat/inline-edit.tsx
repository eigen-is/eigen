// A chat message edited in place: a textarea that grows with its text up to a few lines, with Save and Cancel beside
// it. Enter saves, Shift+Enter breaks the line, and Esc cancels only this edit, even inside a dialog such as a card's.
// The message list renders it in place of the message being edited and does the write.

import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

export function InlineEdit({
    initialContent,
    onSave,
    onCancel,
}: {
    initialContent: string;
    onSave: (content: string) => void;
    onCancel: () => void;
}) {
    const [content, setContent] = useState(initialContent);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            fitHeight(textarea);
        }
    }, []);

    const handleSave = () => {
        const trimmed = content.trim();
        if (trimmed && trimmed !== initialContent) {
            onSave(trimmed);
        } else {
            onCancel();
        }
    };

    return (
        <div className="flex items-end gap-2">
            <textarea
                ref={textareaRef}
                data-owns-escape
                value={content}
                onChange={(e) => {
                    setContent(e.target.value);
                    fitHeight(e.target);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSave();
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        onCancel();
                    }
                }}
                onBlur={() => {
                    if (content.trim() === initialContent) onCancel();
                }}
                rows={1}
                className="flex-1 min-w-0 resize-none rounded-lg border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px] leading-[1.125]"
            />
            <TooltipButton icon={Check} tooltipText="Save" className="h-8 w-8" preventFocusLoss onClick={handleSave} />
            <TooltipButton icon={X} tooltipText="Cancel" className="h-8 w-8" preventFocusLoss onClick={onCancel} />
        </div>
    );
}

// Grows the textarea with its text up to its max-h, where it starts to scroll.
function fitHeight(textarea: HTMLTextAreaElement) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
}
