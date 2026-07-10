import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { MessageSquareOff, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import { Tabs, TabsList, TabsTrigger } from '../../tabs';
import { useAttachmentMeta } from '../attachment/use-attachment-meta';
import { NoteCard } from '../notes/note-card';
import { PropertiesPanel } from '../properties-panel';
import { TooltipButton } from '../toolbar/tooltip-button';

type StatusFilter = 'open' | 'resolved' | 'all';

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
    onClose: () => void;
    onCommentClick?: (cardId: string) => void;
    onCommentContextMenu?: (e: React.MouseEvent, card: CommentCard, entry: CommentEntry | undefined) => void;
};

export function CommentPanel({
    cards,
    entries,
    activeCardIds,
    anchorTexts,
    currentUserEmail,
    onClose,
    onCommentClick,
    onCommentContextMenu,
}: CommentPanelProps) {
    const [tab, setTab] = useState<'all' | 'mine'>('all');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');

    const visible = useMemo(() => {
        const byChatName = new Map(entries.map((e) => [e.chatName, e]));
        const out: { card: CommentCard; entry: CommentEntry | undefined }[] = [];
        for (const cardId of activeCardIds) {
            const card = cards[cardId];
            if (!card) continue;
            const entry = card.chatName ? byChatName.get(card.chatName) : undefined;
            // Treat missing entry as "open" so freshly-created cards show up before SSE round-trip.
            const status = entry?.status ?? 'open';
            if (statusFilter !== 'all' && status !== statusFilter) continue;
            if (tab === 'mine' && !entry?.mentions.includes(currentUserEmail)) continue;
            out.push({ card, entry });
        }
        return out;
    }, [cards, entries, activeCardIds, statusFilter, tab, currentUserEmail]);

    return (
        <PropertiesPanel>
            <div className="px-3 py-2 border-b flex items-center justify-between">
                <span className="text-sm font-medium">Comments</span>
                <TooltipButton icon={X} tooltipText="Close" className="h-6 w-6" onClick={onClose} />
            </div>

            <div className="px-3 py-2 border-b flex items-center gap-2">
                <Tabs value={tab} onValueChange={(v) => setTab(v as 'all' | 'mine')} className="flex-1">
                    <TabsList className="w-full">
                        <TabsTrigger value="all" className="flex-1 text-xs">
                            All
                        </TabsTrigger>
                        <TabsTrigger value="mine" className="flex-1 text-xs">
                            For you
                        </TabsTrigger>
                    </TabsList>
                </Tabs>

                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                    <SelectTrigger className="h-8 text-xs w-28 gap-1">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                        <SelectItem value="all">All</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {visible.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <MessageSquareOff className="h-8 w-8 mb-2 opacity-40" />
                    <p className="text-xs">No comments</p>
                </div>
            ) : (
                <div className="p-2 space-y-2">
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
            )}
        </PropertiesPanel>
    );
}
