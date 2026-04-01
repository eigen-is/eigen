import { useComments, useResolveComment } from '@workspace/lib/chat';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { MessageSquareOff, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../../button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../select';
import { Tabs, TabsList, TabsTrigger } from '../../tabs';
import { PropertiesPanel } from '../properties-panel';
import { TooltipButton } from '../toolbar/tooltip-button';
import { CommentThread } from './comment-thread';

type StatusFilter = 'open' | 'resolved' | 'all';

type CommentPanelProps = {
    ownerId: string;
    mountId: string;
    containerId: string;
    currentUserEmail: string;
    activeCommentIds: Set<string>;
    anchorTexts: Map<string, string>;
    onClose: () => void;
    onScrollToComment?: (chatName: string) => void;
};

export function CommentPanel({
    ownerId,
    mountId,
    containerId,
    currentUserEmail,
    activeCommentIds,
    anchorTexts,
    onClose,
    onScrollToComment,
}: CommentPanelProps) {
    const { data: comments = [] } = useComments(ownerId, mountId, containerId);
    const resolveComment = useResolveComment(ownerId, mountId, containerId);

    const [tab, setTab] = useState<'all' | 'mine'>('all');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
    const [expandedChat, setExpandedChat] = useState<string | null>(null);

    const filtered = useMemo(() => {
        return (comments as CommentEntry[]).filter((c) => {
            if (!activeCommentIds.has(c.chatName)) return false;
            if (statusFilter !== 'all' && c.status !== statusFilter) return false;
            if (tab === 'mine' && !c.mentions.includes(currentUserEmail)) return false;
            return true;
        });
    }, [comments, activeCommentIds, statusFilter, tab, currentUserEmail]);

    const handleResolve = (chatName: string) => {
        resolveComment.mutate({ chatName, status: 'resolved' });
    };

    const handleReopen = (chatName: string) => {
        resolveComment.mutate({ chatName, status: 'open' });
    };

    return (
        <PropertiesPanel className="w-80">
            <div className="px-3 py-2 border-b flex items-center justify-between">
                <span className="text-sm font-medium">Comments</span>
                <TooltipButton icon={X} tooltipText="Close" className="h-6 w-6" onClick={onClose} />
            </div>

            <div className="px-3 py-2 border-b space-y-2">
                <Tabs value={tab} onValueChange={(v) => setTab(v as 'all' | 'mine')}>
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
                    <SelectTrigger className="h-7 text-xs">
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
                <div className="divide-y">
                    {filtered.map((comment) => {
                        const isExpanded = expandedChat === comment.chatName;

                        return (
                            <div key={comment.chatName} className="px-3 py-3">
                                {isExpanded ? (
                                    <div>
                                        <div className="flex justify-end mb-1">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-6 text-xs"
                                                onClick={() => setExpandedChat(null)}
                                            >
                                                Collapse
                                            </Button>
                                        </div>
                                        <CommentThread
                                            ownerId={ownerId}
                                            mountId={mountId}
                                            comment={comment}
                                            anchorText={anchorTexts.get(comment.chatName)}
                                            onResolve={() => handleResolve(comment.chatName)}
                                            onReopen={() => handleReopen(comment.chatName)}
                                            onScrollToAnchor={
                                                onScrollToComment
                                                    ? () => onScrollToComment(comment.chatName)
                                                    : undefined
                                            }
                                        />
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="w-full text-left cursor-pointer"
                                        onClick={() => setExpandedChat(comment.chatName)}
                                    >
                                        <CommentThread
                                            ownerId={ownerId}
                                            mountId={mountId}
                                            comment={comment}
                                            anchorText={anchorTexts.get(comment.chatName)}
                                            compact
                                            onResolve={() => handleResolve(comment.chatName)}
                                            onReopen={() => handleReopen(comment.chatName)}
                                            onScrollToAnchor={
                                                onScrollToComment
                                                    ? () => onScrollToComment(comment.chatName)
                                                    : undefined
                                            }
                                        />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </PropertiesPanel>
    );
}
