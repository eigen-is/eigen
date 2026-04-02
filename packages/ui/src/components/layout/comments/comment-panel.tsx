import { useComments } from '@workspace/lib/chat';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { Check, Circle, MessageSquareOff, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import { Tabs, TabsList, TabsTrigger } from '../../tabs';
import { NoteCard } from '../notes/note-card';
import { PropertiesPanel } from '../properties-panel';
import { TooltipButton } from '../toolbar/tooltip-button';

type StatusFilter = 'open' | 'resolved' | 'all';

type CommentPanelProps = {
    ownerId: string;
    mountId: string;
    containerId: string;
    currentUserEmail: string;
    activeCommentIds: Set<string>;
    anchorTexts: Map<string, string>;
    onClose: () => void;
    onCommentClick?: (chatName: string) => void;
    onCommentContextMenu?: (e: React.MouseEvent, comment: CommentEntry) => void;
};

export function CommentPanel({
    ownerId,
    mountId,
    containerId,
    currentUserEmail,
    activeCommentIds,
    anchorTexts,
    onClose,
    onCommentClick,
    onCommentContextMenu,
}: CommentPanelProps) {
    const { data: comments = [] } = useComments(ownerId, mountId, containerId);

    const [tab, setTab] = useState<'all' | 'mine'>('all');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');

    const filtered = useMemo(() => {
        return (comments as CommentEntry[]).filter((c) => {
            if (!activeCommentIds.has(c.chatName)) return false;
            if (statusFilter !== 'all' && c.status !== statusFilter) return false;
            if (tab === 'mine' && !c.mentions.includes(currentUserEmail)) return false;
            return true;
        });
    }, [comments, activeCommentIds, statusFilter, tab, currentUserEmail]);

    return (
        <PropertiesPanel className="w-80">
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
                    <SelectTrigger className="h-8 text-xs w-auto gap-1">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="open">Open</SelectItem>
                        <SelectItem value="resolved">Resolved</SelectItem>
                        <SelectItem value="all">All</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <MessageSquareOff className="h-8 w-8 mb-2 opacity-40" />
                    <p className="text-xs">No comments</p>
                </div>
            ) : (
                <div className="p-2 space-y-2">
                    {filtered.map((comment) => (
                        <NoteCard
                            key={comment.chatName}
                            title={anchorTexts.get(comment.chatName) || comment.chatName}
                            description={
                                comment.lastAuthorEmail
                                    ? `Comment by ${comment.lastAuthorEmail.split('@')[0]}`
                                    : undefined
                            }
                            color={comment.color}
                            replyCount={comment.messageCount > 1 ? comment.messageCount - 1 : undefined}
                            statusIcon={
                                comment.status === 'resolved' ? (
                                    <Check className="h-3.5 w-3.5 opacity-50" />
                                ) : (
                                    <Circle className="h-2.5 w-2.5 fill-current opacity-40" />
                                )
                            }
                            onClick={() => onCommentClick?.(comment.chatName)}
                            onContextMenu={onCommentContextMenu ? (e) => onCommentContextMenu(e, comment) : undefined}
                        />
                    ))}
                </div>
            )}
        </PropertiesPanel>
    );
}
