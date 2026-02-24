import {useRef, useState} from 'react';
import {Button} from "@workspace/ui/components/button";
import {Paperclip, Send, X} from "lucide-react";
import {getAtSuggestQuery} from "../../lib/commands";
import {PlayerSuggest, type RoomMember} from "./player-suggest";

type MessageInputProps = {
    onSend: (rawContent: string, files?: File[]) => void;
    disabled?: boolean;
    chatName?: string;
    roomMembers?: RoomMember[];
}

export function MessageInput({onSend, disabled = false, chatName, roomMembers = []}: MessageInputProps) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleSend = () => {
        if ((!content.trim() && files.length === 0) || disabled) return;
        onSend(content.trim(), files.length > 0 ? files : undefined);
        setContent('');
        setFiles([]);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            setFiles(prev => [...prev, ...Array.from(e.target.files!)]);
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const removeFile = (index: number) => {
        setFiles(prev => prev.filter((_, i) => i !== index));
    };

    const atQuery = getAtSuggestQuery(content);

    const handlePlayerSelect = (email: string) => {
        const atIdx = content.lastIndexOf('@');
        if (atIdx === -1) return;
        setContent(content.slice(0, atIdx) + email + ' ');
    };

    return (
        <div className="border-t px-5 py-3">
            {files.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                    {files.map((file, i) => (
                        <div key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted text-xs border">
                            <Paperclip className="h-3 w-3 text-muted-foreground"/>
                            <span className="truncate max-w-[150px]">{file.name}</span>
                            <button onClick={() => removeFile(i)} className="text-muted-foreground hover:text-foreground">
                                <X className="h-3 w-3"/>
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <div className="flex items-end gap-2 relative">
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                />
                <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={disabled}
                >
                    <Paperclip className="h-4 w-4"/>
                </Button>
                <div className="flex-1 relative">
                    <PlayerSuggest
                        query={atQuery || ''}
                        roomMembers={roomMembers}
                        onSelect={handlePlayerSelect}
                        visible={atQuery !== null}
                    />
                    <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={chatName ? `Message ${chatName}` : 'Type a message...'}
                        disabled={disabled}
                        rows={1}
                        className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px]"
                    />
                </div>
                <Button
                    size="icon"
                    onClick={handleSend}
                    disabled={(!content.trim() && files.length === 0) || disabled}
                    className="shrink-0 h-9 w-9"
                >
                    <Send className="h-4 w-4"/>
                </Button>
            </div>
        </div>
    );
}
