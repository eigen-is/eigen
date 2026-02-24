import {useState} from 'react';
import {Button} from "@workspace/ui/components/button";
import {Send} from "lucide-react";

type MessageInputProps = {
    onSend: (content: string) => void;
    disabled?: boolean;
}

export function MessageInput({onSend, disabled = false}: MessageInputProps) {
    const [content, setContent] = useState('');

    const handleSend = () => {
        if (!content.trim() || disabled) return;
        onSend(content.trim());
        setContent('');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="border-t px-4 py-3 flex items-end gap-2">
            <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type a message..."
                disabled={disabled}
                rows={1}
                className="flex-1 resize-none bg-muted rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[40px] max-h-[120px]"
            />
            <Button
                size="icon"
                onClick={handleSend}
                disabled={!content.trim() || disabled}
                className="shrink-0"
            >
                <Send className="h-4 w-4"/>
            </Button>
        </div>
    );
}
