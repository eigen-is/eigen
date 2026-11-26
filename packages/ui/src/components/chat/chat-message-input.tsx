// The composer under a chat room or a comment thread: the message box, the files staged with it, and the lists that
// complete an @-mention or a slash command. It clears as soon as a message goes, and the room's send handler decides
// where it goes. If that send fails, the text and files come back, and a slash command that runs in the browser
// leaves the files it had no use for.

import { rethrowUntoasted } from '@workspace/lib/api-error';
import { COMMANDS_HELP, commandNeedsSpace, SLASH_COMMANDS } from '@workspace/lib/chat';
import type { ChatAttachment, RoomMember } from '@workspace/lib/types/chat';
import { Paperclip, Send } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useFileDropTarget } from '../../hooks/use-file-drop-target';
import { useFilePasteTarget } from '../../hooks/use-file-paste-target';
import { useFitHeight } from '../../hooks/use-fit-height';
import { useSuggestions } from '../../hooks/use-suggestions';
import { AttachmentDraftChips } from '../attachment/attachment-draft-chips';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { ChatPlayerSuggest } from './chat-player-suggest';
import { ChatSlashSuggest } from './chat-slash-suggest';
import { getAtSuggestQuery, getSlashTargetQuery } from './chat-utils';

export type ChatMessageInputHandle = {
    addFiles: (files: File[]) => void;
};

type ChatMessageInputProps = {
    // Resolves to whether the send took the files.
    onSend: (rawContent: string, files?: File[]) => Promise<boolean>;
    disabled: boolean;
    readOnly: boolean;
    placeholder: string;
    roomMembers: readonly RoomMember[];
    currentUserEmail: string;
    // Each change hands the box the focus back, such as when the user's edit of a message ends.
    focusTrigger: number;
    onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>, content: string) => boolean | undefined;
    onAttachClick: () => void;
    driveAttachments: readonly ChatAttachment[];
    onRemoveDriveAttachment: (attachment: ChatAttachment) => void;
    // On, the box takes the focus as it opens. Off, it does so only after the user's own send or edit, such as in a
    // comment thread a link opened beside a document.
    autoFocus?: boolean;
};

export const ChatMessageInput = forwardRef<ChatMessageInputHandle, ChatMessageInputProps>(function ChatMessageInput(
    {
        onSend,
        disabled,
        readOnly,
        placeholder,
        roomMembers,
        currentUserEmail,
        focusTrigger,
        onKeyDown: onKeyDownProp,
        onAttachClick,
        driveAttachments,
        onRemoveDriveAttachment,
        autoFocus = true,
    },
    ref,
) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState<File[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    const stageFiles = useCallback((staged: File[]) => setFiles((prev) => [...prev, ...staged]), []);

    useImperativeHandle(ref, () => ({ addFiles: stageFiles }), [stageFiles]);

    const canSend = (content.trim() !== '' || files.length > 0 || driveAttachments.length > 0) && !disabled;

    const focusTextarea = useCallback(() => {
        if (!readOnly) textareaRef.current?.focus();
    }, [readOnly]);

    // Never on a peer's message or as the window comes back, which would pull the focus from where the user is.
    useEffect(() => {
        if (autoFocus) focusTextarea();
    }, [autoFocus, focusTextarea]);
    const shownTrigger = useRef(focusTrigger);
    useEffect(() => {
        if (focusTrigger === shownTrigger.current) return;
        shownTrigger.current = focusTrigger;
        focusTextarea();
    }, [focusTrigger, focusTextarea]);

    useFitHeight(textareaRef, content);

    const handleSend = () => {
        if (!canSend) return;
        // The box cleared at once, so the user may have started the next message.
        const restoreFiles = () => setFiles((next) => (next.length > 0 ? next : files));
        onSend(content.trim(), files.length > 0 ? files : undefined)
            .then((filesTaken) => {
                if (!filesTaken) restoreFiles();
            })
            .catch((error: unknown) => {
                setContent((next) => next || content);
                restoreFiles();
                rethrowUntoasted(error);
            });
        setContent('');
        setFiles([]);
        setTimeout(focusTextarea, 0);
    };

    const atQuery = getAtSuggestQuery(content);

    const handlePlayerSelect = useCallback((email: string) => {
        setContent((prev) => {
            const atIdx = prev.lastIndexOf('@');
            if (atIdx === -1) return prev;
            if (atIdx > 0 && !/[\s,.]/.test(prev[atIdx - 1])) return prev;
            return `${prev.slice(0, atIdx) + email} `;
        });
    }, []);

    // Shift+Enter commits an @-mention but is a newline in the slash lists below. With no matches, Enter sends
    // `@foo` as typed, where a commit on the empty list would strip it.
    const atSuggest = useSuggestions({
        visible: atQuery !== null,
        onSelect: handlePlayerSelect,
        acceptShiftEnter: true,
        passthroughWhenEmpty: true,
    });

    const trimmedContent = content.trim();
    const slashQuery = trimmedContent.startsWith('/') && !trimmedContent.includes(' ') ? trimmedContent : null;
    const slashListVisible = slashQuery !== null && !SLASH_COMMANDS.includes(slashQuery);

    const handleSlashSelect = useCallback((command: string) => {
        setContent(command + (commandNeedsSpace(command) ? ' ' : ''));
    }, []);

    const slashSuggest = useSuggestions({
        visible: slashListVisible,
        onSelect: handleSlashSelect,
        passthroughWhenEmpty: true,
    });

    const slashTarget = getSlashTargetQuery(content);
    const targetListVisible = slashTarget !== null && !slashListVisible;

    const slashTargetMembers = useMemo(() => {
        if (!slashTarget || slashTarget.mode === 'contacts') return [];
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

    const targetSuggest = useSuggestions({
        visible: targetListVisible,
        onSelect: handleSlashTargetSelect,
        passthroughWhenEmpty: true,
    });

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // A target list and the @-mention list can both match, as in `/whisper @al`. The target goes first, so
        // Tab or Enter commits the member and not the @-prefixed username.
        if (slashSuggest.handleKeyDown(e)) return;
        if (targetSuggest.handleKeyDown(e)) return;
        if (atSuggest.handleKeyDown(e)) return;

        if (onKeyDownProp?.(e, content)) return;

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const { targetProps } = useFileDropTarget(stageFiles, !disabled);
    const { onPaste } = useFilePasteTarget(stageFiles, !disabled);

    if (readOnly) {
        return (
            <div className="border-t app-gutter-x py-3">
                <p className="text-xs text-muted-foreground text-center py-2">You have read-only access to this chat</p>
            </div>
        );
    }

    return (
        <div className="border-t app-gutter-x py-3" {...targetProps}>
            <AttachmentDraftChips
                items={[...driveAttachments, ...files]}
                className="mb-2"
                onRemove={(i) => {
                    if (i < driveAttachments.length) onRemoveDriveAttachment(driveAttachments[i]);
                    else setFiles((prev) => prev.filter((_, f) => f !== i - driveAttachments.length));
                }}
            />
            <div className="flex items-end gap-2 relative">
                {/* mb-1 centers it on a one-line box, 40px tall, and it stays at the bottom as the box grows. */}
                <TooltipButton
                    icon={Paperclip}
                    tooltipText="Add attachment"
                    className="mb-1 shrink-0"
                    onClick={onAttachClick}
                    disabled={disabled}
                />
                <ChatPlayerSuggest
                    query={atQuery || ''}
                    roomMembers={roomMembers}
                    onSelect={handlePlayerSelect}
                    visible={atSuggest.open}
                    selectedIndex={atSuggest.selectedIndex}
                    onItemsChange={atSuggest.onItemsChange}
                    includeContacts={false}
                />
                {targetSuggest.open && slashTarget && (
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
                    query={slashQuery ?? ''}
                    commandsHelp={COMMANDS_HELP}
                    onSelect={handleSlashSelect}
                    visible={slashSuggest.open}
                    selectedIndex={slashSuggest.selectedIndex}
                    onItemsChange={slashSuggest.onItemsChange}
                />
                <textarea
                    ref={textareaRef}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    role="combobox"
                    aria-expanded={slashSuggest.isActive || targetSuggest.isActive || atSuggest.isActive}
                    onKeyDown={handleKeyDown}
                    onPaste={onPaste}
                    placeholder={placeholder}
                    rows={1}
                    className="flex-1 min-w-0 resize-none rounded-lg border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[40px] max-h-[120px] leading-[1.125]"
                />
                <TooltipButton
                    icon={Send}
                    tooltipText="Send"
                    variant="default"
                    className="shrink-0 h-10 w-10"
                    onClick={handleSend}
                    disabled={!canSend}
                />
            </div>
        </div>
    );
});
