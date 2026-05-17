import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { Check, Circle, MessageSquareOff, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import { Tabs, TabsList, TabsTrigger } from '../../tabs';
import { NoteCard } from '../notes/note-card';
import { PropertiesPanel } from '../properties-panel';
import { TooltipButton } from '../toolbar/tooltip-button';

type StatusFilter = 'open' | 'resolved' | 'all';

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
        const out: { card: CommentCard; entry: CommentEntry | undefined }[] = [];
        for (const cardId of activeCardIds) {
            const card = cards[cardId];
            if (!card) continue;
            const entry = card.chatName ? entries.find((e) => e.chatName === card.chatName) : undefined;
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
                        <NoteCard
                            key={card.id}
                            title={anchorTexts.get(card.id) || card.title || 'Comment'}
                            description={
                                entry?.lastAuthorEmail ? `Comment by ${entry.lastAuthorEmail.split('@')[0]}` : undefined
                            }
                            color={card.color}
                            replyCount={entry && entry.messageCount > 1 ? entry.messageCount - 1 : undefined}
                            statusIcon={
                                entry?.status === 'resolved' ? (
                                    <Check className="h-3.5 w-3.5 opacity-50" />
                                ) : (
                                    <Circle className="h-2.5 w-2.5 fill-current opacity-40" />
                                )
                            }
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
