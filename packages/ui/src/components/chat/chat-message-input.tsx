import { COMMANDS_HELP, commandNeedsSpace, SLASH_COMMANDS } from '@workspace/lib/chat';
import type { ChatAttachment, RoomMember } from '@workspace/lib/types/chat';
import { Paperclip, Send } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { useSuggestions } from '../../hooks/use-suggestions';
import { cn } from '../../lib/utils';
import { AttachmentDraftChips } from '../attachment/attachment-draft-chips';
import { Button } from '../button';
import { ChatPlayerSuggest } from './chat-player-suggest';
import { ChatSlashSuggest } from './chat-slash-suggest';
import { getAtSuggestQuery, getSlashTargetQuery } from './chat-utils';

export type ChatMessageInputHandle = {
    addFiles: (files: File[]) => void;
};

type ChatMessageInputProps = {
    onSend: (rawContent: string, files?: File[]) => void;
    disabled?: boolean;
    readOnly?: boolean;
    placeholder?: string;
    readOnlyMessage?: string;
    roomMembers?: RoomMember[];
    currentUserEmail?: string;
    messageCount?: number;
    className?: string;
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>, content: string) => boolean | undefined;
    // When omitted, the paperclip button is hidden (the input renders without file-attach support).
    onAttachClick?: () => void;
    driveAttachments?: ChatAttachment[];
    onRemoveDriveAttachment?: (attachment: ChatAttachment) => void;
};

export const ChatMessageInput = forwardRef<ChatMessageInputHandle, ChatMessageInputProps>(function ChatMessageInput(
    {
        onSend,
        disabled = false,
        readOnly = false,
        placeholder = 'Type a message...',
        readOnlyMessage = 'You have read-only access to this chat',
        roomMembers = [],
        currentUserEmail = '',
        messageCount = 0,
        className,
        onKeyDown: onKeyDownProp,
        onAttachClick,
        driveAttachments,
        onRemoveDriveAttachment,
    },
    ref,
) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(ref, () => ({
        addFiles: (newFiles) => setFiles((prev) => [...prev, ...newFiles]),
    }));

    const hasDriveAttachments = !!driveAttachments && driveAttachments.length > 0;

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
        if ((!content.trim() && files.length === 0 && !hasDriveAttachments) || disabled) return;
        onSend(content.trim(), files.length > 0 ? files : undefined);
        setContent('');
        setFiles([]);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setTimeout(focusTextarea, 0);
    };

    // ── @ mention suggest ───────────────────────────────────────────────
    const atQuery = getAtSuggestQuery(content);
    const suggestOpen = atQuery !== null;

    const handlePlayerSelect = useCallback((email: string) => {
        setContent((prev) => {
            const atIdx = prev.lastIndexOf('@');
            if (atIdx === -1) return prev;
            if (atIdx > 0 && !/[\s,.]/.test(prev[atIdx - 1])) return prev;
            return `${prev.slice(0, atIdx) + email} `;
        });
    }, []);

    const closeSuggest = useCallback(() => {
        setContent((prev) => {
            const atIdx = prev.lastIndexOf('@');
            return atIdx === -1 ? prev : prev.slice(0, atIdx);
        });
    }, []);

    // acceptShiftEnter matches historic behaviour where shift+Enter also committed the
    // @-mention; the slash suggests below intentionally let shift+Enter through as a newline.
    // passthroughWhenEmpty lets `@foo` with no matches keep its text and send normally on
    // Enter, rather than being silently stripped by a commit on an empty list.
    const atSuggest = useSuggestions({
        visible: suggestOpen,
        onSelect: handlePlayerSelect,
        onEscape: closeSuggest,
        acceptShiftEnter: true,
        passthroughWhenEmpty: true,
    });

    // ── Slash command suggest ───────────────────────────────────────────
    const getSlashQuery = (): string | null => {
        const trimmed = content.trim();
        if (!trimmed.startsWith('/')) return null;
        if (trimmed.indexOf(' ') > 0) return null;
        return trimmed;
    };

    const slashQuery = getSlashQuery();
    const slashSuggestOpen = slashQuery !== null && slashQuery.length > 0 && !SLASH_COMMANDS.includes(slashQuery);

    const handleSlashSelect = useCallback((command: string) => {
        setContent(command + (commandNeedsSpace(command) ? ' ' : ''));
    }, []);

    const clearContent = useCallback(() => setContent(''), []);

    const slashSuggest = useSuggestions({
        visible: slashSuggestOpen,
        onSelect: handleSlashSelect,
        onEscape: clearContent,
        passthroughWhenEmpty: true,
    });

    // ── Slash target suggest (emote/whisper/invite targets) ─────────────
    const slashTarget = getSlashTargetQuery(content);
    const slashTargetOpen = slashTarget !== null && !slashSuggestOpen;

    const slashTargetMembers = useMemo(() => {
        if (!slashTarget) return [];
        if (slashTarget.mode === 'contacts') {
            // For /invite: show contacts not already in room (handled by ChatPlayerSuggest with includeContacts)
            return [];
        }
        // For emotes/whisper/inspect: room members minus self
        const selfEmail = currentUserEmail.toLowerCase();
        return roomMembers.filter((m) => m.email.toLowerCase() !== selfEmail);
    }, [slashTarget, roomMembers, currentUserEmail]);

    const handleSlashTargetSelect = useCallback(
        (email: string) => {
            const shouldAppendSpace = slashTarget?.appendSpace ?? false;
            setContent((prev) => {
                const spaceIdx = prev.indexOf(' ');
                if (spaceIdx <= 0) return prev;
                return prev.slice(0, spaceIdx + 1) + email + (shouldAppendSpace ? ' ' : '');
            });
        },
        [slashTarget?.appendSpace],
    );

    // Escape drops the target back to just the command (keep everything before the space).
    const clearSlashTarget = useCallback(
        () =>
            setContent((prev) => {
                const spaceIdx = prev.indexOf(' ');
                return spaceIdx > 0 ? prev.slice(0, spaceIdx) : prev;
            }),
        [],
    );

    const targetSuggest = useSuggestions({
        visible: slashTargetOpen,
        onSelect: handleSlashTargetSelect,
        onEscape: clearSlashTarget,
        passthroughWhenEmpty: true,
    });

    // ── Keyboard handling ───────────────────────────────────────────────
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Slash and target are mutually exclusive (target is gated on !slashSuggestOpen), but
        // target and @-mention can both match at once — e.g. typing `/whisper @al`. Target
        // takes precedence so Tab/Enter commits the member, not the @-prefixed username.
        if (slashSuggest.handleKeyDown(e)) return;
        if (targetSuggest.handleKeyDown(e)) return;
        if (atSuggest.handleKeyDown(e)) return;

        if (onKeyDownProp) {
            const handled = onKeyDownProp(e, content);
            if (handled) return;
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const removeFile = (index: number) => {
        setFiles((prev) => prev.filter((_, i) => i !== index));
    };

    const stageFiles = useCallback((staged: File[]) => setFiles((prev) => [...prev, ...staged]), []);
    const { targetProps } = useFileDropTarget(stageFiles, !disabled);
    const { onPaste } = useFilePasteTarget(stageFiles, !disabled);

    if (readOnly) {
        return (
            <div className={cn('border-t app-gutter-x py-3', className)}>
                <p className="text-xs text-muted-foreground text-center py-2">{readOnlyMessage}</p>
            </div>
        );
    }

    return (
        <div className={cn('border-t app-gutter-x py-3', className)} {...targetProps}>
            <AttachmentDraftChips
                items={[...(driveAttachments ?? []), ...files]}
                className="mb-2"
                onRemove={(i) => {
                    const driveLen = driveAttachments?.length ?? 0;
                    if (i < driveLen) onRemoveDriveAttachment?.((driveAttachments ?? [])[i]);
                    else removeFile(i - driveLen);
                }}
            />
            <div className="flex items-end gap-2 relative">
                {onAttachClick && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 h-10 w-10 text-muted-foreground hover:text-foreground"
                        onClick={onAttachClick}
                        disabled={disabled}
                    >
                        <Paperclip className="h-4 w-4" />
                    </Button>
                )}
                <ChatPlayerSuggest
                    query={atQuery || ''}
                    roomMembers={roomMembers}
                    onSelect={handlePlayerSelect}
                    visible={suggestOpen}
                    selectedIndex={atSuggest.selectedIndex}
                    onItemsChange={atSuggest.onItemsChange}
                    includeContacts={false}
                />
                {slashTargetOpen && slashTarget && (
                    <ChatPlayerSuggest
                        query={slashTarget.query}
                        roomMembers={slashTarget.mode === 'contacts' ? [] : slashTargetMembers}
                        onSelect={handleSlashTargetSelect}
                        visible
                        selectedIndex={targetSuggest.selectedIndex}
                        onItemsChange={targetSuggest.onItemsChange}
                        includeContacts={slashTarget.mode === 'contacts'}
                    />
                )}
                <ChatSlashSuggest
                    query={slashQuery || ''}
                    commandsHelp={COMMANDS_HELP}
                    onSelect={handleSlashSelect}
                    visible={slashSuggestOpen}
                    selectedIndex={slashSuggest.selectedIndex}
                    onItemsChange={slashSuggest.onItemsChange}
                />
                <textarea
                    ref={textareaRef}
                    value={content}
                    onChange={(e) => {
                        setContent(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                    }}
                    onKeyDown={handleKeyDown}
                    onPaste={onPaste}
                    placeholder={placeholder}
                    rows={1}
                    className="flex-1 min-w-0 resize-none rounded-lg border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px] leading-[1.125]"
                />
                <Button
                    size="icon"
                    onClick={handleSend}
                    disabled={(!content.trim() && files.length === 0 && !hasDriveAttachments) || disabled}
                    className="shrink-0 h-10 w-10"
                >
                    <Send className="h-4 w-4" />
                </Button>
            </div>
        </div>
    );
});
