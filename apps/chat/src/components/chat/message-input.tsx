import {useCallback, useEffect, useRef, useState} from 'react';
import {Button} from "@workspace/ui/components/button";
import {Paperclip, Send, X} from "lucide-react";
import {getAtSuggestQuery} from "../../lib/commands";
import {PlayerSuggest, type RoomMember} from "./player-suggest";

type MessageInputProps = {
    onSend: (rawContent: string, files?: File[]) => void;
    disabled?: boolean;
    readOnly?: boolean;
    chatName?: string;
    roomMembers?: RoomMember[];
    messageCount?: number;
}

export function MessageInput({onSend, disabled = false, readOnly = false, chatName, roomMembers = [], messageCount = 0}: MessageInputProps) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const [selectedSuggestIdx, setSelectedSuggestIdx] = useState(0);
    const suggestCountRef = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const focusTextarea = useCallback(() => {
        if (!readOnly) textareaRef.current?.focus();
    }, [readOnly]);

    useEffect(() => {
        focusTextarea();
    }, [focusTextarea]);

    useEffect(() => {
        focusTextarea();
    }, [messageCount, focusTextarea]);

    useEffect(() => {
        const onFocus = () => focusTextarea();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [focusTextarea]);

    const handleSend = () => {
        if ((!content.trim() && files.length === 0) || disabled) return;
        onSend(content.trim(), files.length > 0 ? files : undefined);
        setContent('');
        setFiles([]);
        setTimeout(focusTextarea, 0);
    };

    const atQuery = getAtSuggestQuery(content);
    const suggestVisible = atQuery !== null && suggestCountRef.current > 0;

    const handlePlayerSelect = useCallback((email: string) => {
        setContent(prev => {
            const atIdx = prev.lastIndexOf('@');
            if (atIdx === -1) return prev;
            if (atIdx > 0 && !/[\s,.]/.test(prev[atIdx - 1])) return prev;
            return prev.slice(0, atIdx) + email + ' ';
        });
        setSelectedSuggestIdx(0);
    }, []);

    const suggestEmailsRef = useRef<string[]>([]);

    const handleSuggestItemsChange = useCallback((count: number, emails: string[]) => {
        suggestCountRef.current = count;
        suggestEmailsRef.current = emails;
        if (count > 0) setSelectedSuggestIdx(prev => Math.min(prev, count - 1));
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (suggestVisible) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSuggestIdx(i => Math.min(i + 1, suggestCountRef.current - 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedSuggestIdx(i => Math.max(i - 1, 0));
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const email = suggestEmailsRef.current[selectedSuggestIdx];
                if (email) handlePlayerSelect(email);
                return;
            }
            if (e.key === 'Escape') {
                setContent(prev => {
                    const atIdx = prev.lastIndexOf('@');
                    return atIdx === -1 ? prev : prev.slice(0, atIdx);
                });
                return;
            }
        }
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

    if (readOnly) {
        return (
            <div className="border-t px-5 py-3">
                <p className="text-xs text-muted-foreground text-center py-2">You have read-only access to this chat</p>
            </div>
        );
    }

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
            <div className="flex items-center gap-2 relative">
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
                    className="shrink-0 h-10 w-10 text-muted-foreground hover:text-foreground"
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
                        selectedIndex={selectedSuggestIdx}
                        onItemsChange={handleSuggestItemsChange}
                    />
                    <textarea
                        ref={textareaRef}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={chatName ? `Message ${chatName}` : 'Type a message...'}
                        disabled={disabled}
                        rows={1}
                        className="w-full resize-none rounded-lg border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px] leading-[1.125]"
                    />
                </div>
                <Button
                    size="icon"
                    onClick={handleSend}
                    disabled={(!content.trim() && files.length === 0) || disabled}
                    className="shrink-0 h-10 w-10"
                >
                    <Send className="h-4 w-4"/>
                </Button>
            </div>
        </div>
    );
}
