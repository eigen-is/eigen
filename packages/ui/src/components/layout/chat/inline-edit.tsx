import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TooltipButton } from '../toolbar/tooltip-button';

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
        const ta = textareaRef.current;
        if (ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            ta.style.height = 'auto';
            ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
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
                value={content}
                onChange={(e) => {
                    setContent(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
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
