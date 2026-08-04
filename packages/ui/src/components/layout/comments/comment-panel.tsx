import { matchesCommentFilter, type useCommentFilter } from '@workspace/lib/comments';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { MessageSquareOff } from 'lucide-react';
import { useMemo } from 'react';
import { useAttachmentMeta } from '../attachment/use-attachment-meta';
import { NoteCard } from '../notes/note-card';
import { PropertiesPanel } from '../properties-panel';
import { FilterSummary } from './comment-filter-summary';

// Row component so each card gets its own useAttachmentMeta call (hooks can't run in the map).
function PanelCard({
    card,
    entry,
    title,
    onClick,
    onContextMenu,
}: {
    card: CommentCard;
    entry: CommentEntry | undefined;
    title: string;
    onClick?: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}) {
    const { coverThumbnailUrl, attachmentCount } = useAttachmentMeta(card.attachments);
    return (
        <NoteCard
            title={title}
            description={card.description}
            color={card.color}
            replyCount={entry?.messageCount}
            resolved={entry?.status === 'resolved'}
            coverThumbnailUrl={coverThumbnailUrl}
            attachmentCount={attachmentCount}
            assigneeEmail={entry?.assignee}
            onClick={onClick}
            onContextMenu={onContextMenu}
        />
    );
}

type CommentPanelProps = {
    cards: Record<string, CommentCard>;
    entries: CommentEntry[];
    activeCardIds: Set<string>;
    anchorTexts: Map<string, string>;
    currentUserEmail: string;
    filter: ReturnType<typeof useCommentFilter>;
    onCommentClick?: (cardId: string) => void;
    onCommentContextMenu?: (e: React.MouseEvent, card: CommentCard, entry: CommentEntry | undefined) => void;
    className?: string;
};

export function CommentPanel({
    cards,
    entries,
    activeCardIds,
    anchorTexts,
    currentUserEmail,
    filter,
    onCommentClick,
    onCommentContextMenu,
    className,
}: CommentPanelProps) {
    const { active, visible } = useMemo(() => {
        const byChatName = new Map(entries.map((e) => [e.chatName, e]));
        const all: { card: CommentCard; entry: CommentEntry | undefined }[] = [];
        const shown: { card: CommentCard; entry: CommentEntry | undefined }[] = [];
        for (const cardId of activeCardIds) {
            const card = cards[cardId];
            if (!card) continue;
            const entry = card.chatName ? byChatName.get(card.chatName) : undefined;
            all.push({ card, entry });
            if (matchesCommentFilter(card, entry, filter.filter, currentUserEmail)) shown.push({ card, entry });
        }
        return { active: all.length, visible: shown };
    }, [cards, entries, activeCardIds, filter.filter, currentUserEmail]);

    const hidden = active - visible.length;

    return (
        <PropertiesPanel className={className}>
            {filter.isActive && <FilterSummary filter={filter} onClear={filter.clear} />}

            {visible.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <MessageSquareOff className="mb-2 h-8 w-8 opacity-40" />
                    <p className="text-xs">No comments</p>
                    {filter.isActive && (
                        <button
                            type="button"
                            className="mt-2 text-xs text-primary hover:underline"
                            onClick={filter.clear}
                        >
                            Clear filters
                        </button>
                    )}
                </div>
            ) : (
                <>
                    <div className="space-y-2 p-2">
                        {visible.map(({ card, entry }) => (
                            <PanelCard
                                key={card.id}
                                card={card}
                                entry={entry}
                                title={anchorTexts.get(card.id) || card.title || 'Comment'}
                                onClick={() => onCommentClick?.(card.id)}
                                onContextMenu={
                                    onCommentContextMenu ? (e) => onCommentContextMenu(e, card, entry) : undefined
                                }
                            />
                        ))}
                    </div>
                    {hidden > 0 && (
                        <div className="px-3 pb-3 text-center text-[11px] text-muted-foreground">
                            {hidden} hidden ·{' '}
                            <button type="button" className="text-primary hover:underline" onClick={filter.clear}>
                                Clear filters
                            </button>
                        </div>
                    )}
                </>
            )}
        </PropertiesPanel>
    );
}
