// The comment list in a document's side panel: one card per comment the document still anchors, narrowed by the
// comment filter, with a line saying how many the filter hides. Each card shows its title, its replies, status and
// assignee, and a dot while its thread holds an unread notification. A host may put a prefix before the title, such as
// another sheet's name. A card whose thread is gone shows the deleted state instead. Opening a card is the host's to
// handle.

import { useAuth } from '@workspace/lib/auth';
import { useUnreadCommentChatNames } from '@workspace/lib/chat';
import type { useCommentFilter } from '@workspace/lib/comments';
import { matchesCommentFilter } from '@workspace/lib/comments';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { MessageSquareOff } from 'lucide-react';
import { useMemo } from 'react';
import { PropertiesPanel } from '../properties-panel';
import { FilterSummary } from './comment-filter-summary';
import { CommentNoteCard } from './comment-note-card';

type CommentPanelProps = {
    cards: Readonly<Record<string, CommentCard>>;
    entries: readonly CommentEntry[];
    activeCardIds: ReadonlySet<string>;
    titlePrefixes?: ReadonlyMap<string, string>;
    isCardDeleted: (card: CommentCard) => boolean;
    pathId: string;
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
    titlePrefixes,
    isCardDeleted,
    pathId,
    currentUserEmail,
    filter,
    onCommentClick,
    onCommentContextMenu,
    className,
}: CommentPanelProps) {
    const { user } = useAuth();
    const unreadChatNames = useUnreadCommentChatNames(user?.id ?? '', pathId);
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
                    <div className="space-y-2 app-gutter-x py-2">
                        {visible.map(({ card, entry }) => {
                            const prefix = titlePrefixes?.get(card.id);
                            const title = card.title || 'Comment';
                            return (
                                <CommentNoteCard
                                    key={card.id}
                                    card={card}
                                    entry={entry}
                                    title={prefix ? `${prefix} · ${title}` : title}
                                    unread={!!card.chatName && unreadChatNames.has(card.chatName)}
                                    deleted={isCardDeleted(card)}
                                    onClick={() => onCommentClick?.(card.id)}
                                    onContextMenu={
                                        onCommentContextMenu ? (e) => onCommentContextMenu(e, card, entry) : undefined
                                    }
                                />
                            );
                        })}
                    </div>
                    {hidden > 0 && (
                        <div className="app-gutter-x pb-3 text-center text-[11px] text-muted-foreground">
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
