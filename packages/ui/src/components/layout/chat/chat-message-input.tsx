import {useCallback, useEffect, useRef, useState} from 'react';
import {Button} from "../../button";
import {Paperclip, Send, X} from "lucide-react";
import {cn} from "../../../lib/utils";
import {getAtSuggestQuery} from "./chat-utils";
import type {RoomMember} from "@workspace/lib/types/chat";
import {ChatPlayerSuggest} from "./chat-player-suggest";
import {ChatSlashSuggest} from "./chat-slash-suggest";
import {COMMANDS_HELP, SLASH_COMMANDS, commandNeedsSpace} from "@workspace/lib/chat";

type ChatMessageInputProps = {
    onSend: (rawContent: string, files?: File[]) => void;
    disabled?: boolean;
    readOnly?: boolean;
    placeholder?: string;
    readOnlyMessage?: string;
    roomMembers?: RoomMember[];
    messageCount?: number;
    className?: string;
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>, content: string) => boolean | void;
}

export function ChatMessageInput({
                                     onSend,
                                     disabled = false,
                                     readOnly = false,
                                     placeholder = 'Type a message...',
                                     readOnlyMessage = 'You have read-only access to this chat',
                                     roomMembers = [],
                                     messageCount = 0,
                                     className,
                                     onKeyDown: onKeyDownProp,
                                 }: ChatMessageInputProps) {
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
        const onFocus = () => focusTextarea();
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [messageCount, focusTextarea]);

    const handleSend = () => {
        if ((!content.trim() && files.length === 0) || disabled) return;
        onSend(content.trim(), files.length > 0 ? files : undefined);
        setContent('');
        setFiles([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setTimeout(focusTextarea, 0);
    };

    const atQuery = getAtSuggestQuery(content);
    const suggestOpen = atQuery !== null;

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

    const closeSuggest = useCallback(() => {
        setContent(prev => {
            const atIdx = prev.lastIndexOf('@');
            return atIdx === -1 ? prev : prev.slice(0, atIdx);
        });
        setSelectedSuggestIdx(0);
    }, []);

    const getSlashQuery = (): string | null => {
        const trimmed = content.trim();
        if (!trimmed.startsWith('/')) return null;
        if (trimmed.indexOf(' ') > 0) return null;
        return trimmed;
    };


    const slashQuery = getSlashQuery();
    const slashSuggestOpen = slashQuery !== null && slashQuery.length > 0 && !SLASH_COMMANDS.includes(slashQuery);

    const slashSuggestCountRef = useRef(0);
    const slashSuggestCmdsRef = useRef<string[]>([]);
    const [selectedSlashIdx, setSelectedSlashIdx] = useState(0);

    const handleSlashSelect = useCallback((command: string) => {
        setContent(command + (commandNeedsSpace(command) ? ' ' : ''));
        setSelectedSlashIdx(0);
    }, []);

    const handleSlashItemsChange = useCallback((count: number, cmds: string[]) => {
        slashSuggestCountRef.current = count;
        slashSuggestCmdsRef.current = cmds;
        if (count > 0) setSelectedSlashIdx(prev => Math.min(prev, count - 1));
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Slash suggest keyboard handling
        if (slashSuggestOpen && slashSuggestCountRef.current > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSlashIdx(i => Math.min(i + 1, slashSuggestCountRef.current - 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedSlashIdx(i => Math.max(i - 1, 0));
                return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                const cmd = slashSuggestCmdsRef.current[selectedSlashIdx];
                if (cmd) {
                    handleSlashSelect(cmd);
                }
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setContent('');
                setSelectedSlashIdx(0);
                return;
            }
        }

        if (suggestOpen) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (suggestCountRef.current > 0) {
                    setSelectedSuggestIdx(i => Math.min(i + 1, suggestCountRef.current - 1));
                }
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (suggestCountRef.current > 0) {
                    setSelectedSuggestIdx(i => Math.max(i - 1, 0));
                }
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const email = suggestEmailsRef.current[selectedSuggestIdx];
                if (email) {
                    handlePlayerSelect(email);
                } else {
                    closeSuggest();
                }
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSuggest();
                return;
            }
        }

        if (onKeyDownProp) {
            const handled = onKeyDownProp(e, content);
            if (handled) return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newFiles = e.target.files ? Array.from(e.target.files) : [];
        if (newFiles.length > 0) {
            setFiles(prev => [...prev, ...newFiles]);
        }
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const removeFile = (index: number) => {
        setFiles(prev => prev.filter((_, i) => i !== index));
    };

    if (readOnly) {
        return (
            <div className={cn("border-t px-5 py-3", className)}>
                <p className="text-xs text-muted-foreground text-center py-2">{readOnlyMessage}</p>
            </div>
        );
    }

    return (
        <div className={cn("border-t px-5 py-3", className)}>
            {files.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                    {files.map((file, i) => (
                        <div key={i}
                             className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted text-xs border">
                            <Paperclip className="h-3 w-3 text-muted-foreground"/>
                            <span className="truncate max-w-[150px]">{file.name}</span>
                            <button onClick={() => removeFile(i)}
                                    className="text-muted-foreground hover:text-foreground">
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
                    className="shrink-0 h-10 w-10 text-muted-foreground hover:text-foreground"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={disabled}
                >
                    <Paperclip className="h-4 w-4"/>
                </Button>
                <ChatPlayerSuggest
                    query={atQuery || ''}
                    roomMembers={roomMembers}
                    onSelect={handlePlayerSelect}
                    visible={atQuery !== null}
                    selectedIndex={selectedSuggestIdx}
                    onItemsChange={handleSuggestItemsChange}
                />
                <ChatSlashSuggest
                    query={slashQuery || ''}
                    commandsHelp={COMMANDS_HELP}
                    onSelect={handleSlashSelect}
                    visible={slashSuggestOpen}
                    selectedIndex={selectedSlashIdx}
                    onItemsChange={handleSlashItemsChange}
                />
                <textarea
                    ref={textareaRef}
                    value={content}
                    onChange={(e) => {
                        setContent(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    disabled={disabled}
                    rows={1}
                    className="flex-1 min-w-0 resize-none rounded-lg border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px] leading-[1.125]"
                />
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
